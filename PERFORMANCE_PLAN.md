# FreeShow video pipeline: full-performance plan for all platforms

Branch `feature/input-performance`. Written 2026-09-08 from a four-part audit of this repo and
`osr-capture` at the current working state.

Target, unchanged: several concurrent 4K60 outputs at the source rate, with real receivers attached,
on Windows, macOS and Linux. Unique frames per second is the only metric. Repeat filler gets no
credit.

---

## Part 1 — What the audit found

### 1.1 The rules that are currently broken

| Rule | State |
|---|---|
| No video frame touches the main process | Held **only** on the GPU shared-texture path. Every fallback path routes full frames through main. |
| No CPU work on frames when a GPU is present | Broken on macOS and Linux for **every** multi-size or multi-format output, on every frame. |
| No hard-coded machine-varying constants | Roughly forty in the video path. |
| Full performance on all platforms | Four GPU capabilities are Windows-only. |

### 1.2 CPU work on frames with a healthy GPU

Ranked by cost.

1. **Per-consumer scaled targets do not exist off Windows.** `TargetsSupported()` returns false in
   `readback_mac.mm:557` and `readback_linux.cc:195`. That makes `OutputLifecycle.ts:793` set
   `cpuTargets`, which forces the main readback to uncompressed BGRA (`:798`), and then
   `ndiWorker.ts:895-899` runs a native CPU box downscale plus a CPU colour convert **per target per
   frame**, with a further full-frame CPU convert of the main buffer at `:884`. On any Mac or Linux
   box with a working GPU, every mixed-resolution output group is scaled and converted on CPU cores.
2. **I420 exists only in HLSL.** `ndiWorker.ts:618-654` is a pure JavaScript two-pass YUV conversion
   with no native or GPU alternative off Windows, so every RTMP frame on macOS and Linux is converted
   pixel by pixel in JavaScript.
3. **Fallbacks latch and never recover.** One paint without a texture sets `cpuFallback` for the life
   of that output (`OutputLifecycle.ts:927-935`). Three consecutive EGL import failures demote the
   whole Linux process permanently (`readback_linux_gpu.cc:1000-1006`). One WebGL failure latches the
   renderer to its CPU path (`streamCanvas.ts:100`). None of the three ever re-probes.
4. **Blackmagic 10-bit, 12-bit, keyed, RGB and BT.709 modes convert on the main thread**
   (`BlackmagicSender.ts:966-1053` with `ImageBufferConverter.ts`). Only the exact 8-bit 4:2:2 BT.601
   case escapes.
5. **The input preview is a floating-point per-pixel loop** run for every frame of every source in the
   receive process (`streamFrames.ts:22-63`).
6. **`convertToRGBA` runs on the main thread** for stage, server and WebRTC
   (`CaptureTransmitter.ts:536-539`, called from four sites).
7. **macOS drops to a ~12ms per frame CPU path** whenever width is not a multiple of four
   (`readback_mac.mm:221`), which display scaling produces in normal use.

### 1.3 Frames on the main process

The shared-texture path is clean: main sees a handle, never pixels. Every other path is not.

- `CaptureTransmitter.ts` is the concentration. Per frame per consumer it does `toBitmap` (a fresh
  33MB allocation each, at seven call sites), `resize`, `convertToRGBA`, and for stage clients a full
  `toJPEG` encode, all synchronously on the main thread.
- `OutputLifecycle.ts:972-990` resolves a full-resolution readback **into main** whenever `canOffMain`
  is false, which includes any server-only or preview-only output.
- `CaptureLifecycle.ts:141-157` is a main-process `capturePage` loop with a main-process `resize`.
- `PreviewStream.ts:54` structured-clones a whole preview frame per frame because the buffer is not
  transferred.
- `servers.ts:209-215` runs `capturePage` plus a PNG encode plus base64, paced by a remote client.
- Frame-signature hashing (`CaptureTransmitter.ts:167-257`) reads thousands of scattered bytes across
  a 33MB buffer, per channel per frame, on the main thread, and it does so **after** the readback and
  after `toBitmap`, so the work it exists to skip has already been paid for.

Below that there is a second tier of per-frame main-thread bookkeeping: a `setImmediate` per frame per
output, a full rebuild of the member and target plan on every admitted frame, admission timers created
and cleared on nearly every frame, and a self-rescheduling send timer per output at up to 60Hz that
fires whether or not a new frame exists.

### 1.4 Transport

- **Redundant copies.** Main copies the same frame once per consumer (`CaptureTransmitter.ts:407`,
  `:417`, `:427`, `:435`). `convert.cc` allocates a vector and then copies again into a fresh N-API
  buffer, so a single conversion costs three traversals. `readback_win.cc:1562` fills an intermediate
  vector on the BGRA path that the UYVY path does not need. The video-layer `CopyResource` at
  `readback_win.cc:1534` is unconditional, so outputs with no live input pay a full GPU-to-GPU frame
  copy for a feature they are not using.
- **Serialisation.** `shm.cc` uses one process-global mutex and the synchronous variants hold it
  across the full-frame memcpy, so every ring in the process serialises. On Linux every consume and
  finish for every output funnels through a single GL thread with an uncapped queue
  (`readback_linux_gpu.cc:288-333`). `readback_win.cc:1457` busy-spins a libuv thread on the classic
  D3D11 path.
- **Fan-out.** Targets are submitted in one pass but each re-reads the whole source texture, so N
  consumers cost N full source reads of GPU bandwidth.
- **Waste.** At 60fps render with 30fps admission, half of all compositor paints are discarded after
  the GPU has already done the work (`OutputLifecycle.ts:958`). A shared render runs at the largest
  member's size, so every smaller member is read back large and then scaled down.
- **Stalls with no timeout.** If a page never acks, `inFlight` never drops and that target stalls
  forever. There is no ack timeout anywhere.

### 1.5 Platform capability matrix

| Capability | Windows | macOS | Linux |
|---|---|---|---|
| Shared-texture capture | full | full | full |
| GPU convert BGRA to UYVY / UYVA / RGBA | full | full | full |
| GPU downscale (single scaled output) | full | full | full |
| **Per-consumer scaled targets** | full | written, needs a Mac | builds + shaders compile (WSL) |
| **I420 target (RTMP)** | full | written, needs a Mac | builds + shaders compile (WSL) |
| **Video-layer composite (live input)** | full | written, needs a Mac | builds + shaders compile (WSL) |
| Two-phase consume/finish | unconditional | unconditional | unconditional |
| Conversion-correctness harness | full | absent | absent |

Two-phase is now installed on every platform. Each backend already degraded to its own CPU path
internally, so the conditional install bought nothing and cost a great deal: when the exports were
absent FreeShow demoted the whole render group to a main-process readback, which is the one thing that
must never happen.

Windows was also dropping the layer for two of its four main formats: a BGRA readback went through a
plain copy and an RGBA one through a swizzle, and neither composited, so an output whose readback
landed on either showed the transparent page over black. Both now run the compositing pass. That was a
live bug in shipped behaviour, found by review rather than by testing.

### 1.6 The two connection gates

- `752b299e` produces preview frames only for connected viewers.
- Admission drops to 10 frames per second when nothing is attached.

Both stay. Skipping work for inactive outputs is a legitimate efficiency measure. What is forbidden is
reporting a number obtained that way: every measurement in this plan is taken with all outputs active
and receivers attached to all of them, and the unmitigated path has to be fast enough on its own.

---

## Part 2 — The plan

Ordering is not arbitrary. Phase 0 exists because I produced false measurements without it. Phase 1
comes before Phase 2 because the main-process paths in Phase 2 exist precisely to cover the
capabilities macOS and Linux are missing, and they cannot be deleted until those exist.

### Phase 0 — Make results trustworthy

Nothing else in this plan is believable until this is done.

**0.1 Fix the addon build.** `package.json` pins `osr-capture` to a GitHub commit, so
`node_modules/osr-capture` is a tarball copy whose source silently diverges from the working repo.
Rebuilds compile the copy. Make it a file or workspace dependency, and add a preflight step that
compares a hash of the working repo's `src` against `node_modules/osr-capture/src` and fails loudly on
mismatch. Do the same for the OMT fork.

**0.2 One benchmark command.** A script that launches the real app, drives N concurrent 4K60 outputs
through the REST API with receivers attached to every one, and prints unique frames per second per
output plus the per-stage telemetry. Multi-output with receivers is the only configuration that
counts. This becomes the acceptance gate for every later phase, and every phase records its numbers
before and after.

**0.3 Make the rules enforceable by the code.** A debug mode that reports whenever a per-pixel CPU
conversion runs while a GPU is present, whenever frame-sized data is handled in main, and whenever a
latched fallback engages. Rules I have to remember are rules I have broken repeatedly; this turns
three of them into something the build tells us about.

**0.4 Decide the fate of the uncommitted experiment.** The working tree holds a page-frame cache and a
paint-independent repeat path that measured worse than the last commit. It should be reverted to
`a364ec63` and re-approached as part of Phase 3. I am blocked from reverting it; it needs one command
from you, or your go-ahead for me to run it.

### Phase 1 — Platform parity in the addon

The goal is that the capability matrix has no gaps, so no platform has a reason to fall back.

**1.1 Per-consumer targets on Metal and GLES.** Port `ScaleConvertToStaging` to both backends. This
single item removes the largest CPU violation, deletes the `cpuTargets` branch, and restores the GPU
convert on the main frame for mac and Linux.

**1.2 I420 on Metal and GLES.** Port `kScaleI420HLSL`. Then delete `bgraToI420` from the worker
entirely rather than leaving it as a fallback.

**1.3 Video-layer composite on Metal and GLES.** Port the layer upload and the `overVideo` blend into
the Metal and GLES kernels, including the downscale kernel. Without it, live input on mac and Linux
still crosses the browser GPU thread, which is the exact cost that took the Windows path from 22fps to
54fps.

**1.4 Stop latching.** `cpuFallback` re-probes on the next paint that carries a texture. Linux
demotion becomes a re-probe with backoff instead of a permanent process-wide decision. `streamCanvas`
retries the GPU path rather than pinning `ctx2d` forever.

**1.5 macOS alignment.** Pad or align surfaces whose width is not a multiple of four rather than
dropping the frame to the CPU path. Display scaling makes this a normal case, not an edge case.

**1.6 Make two-phase unconditional everywhere.** Match the Windows approach: install the exports
always and degrade internally, so the JavaScript probe can never demote a whole group to the
main-thread loop.

**1.7 A conversion-correctness harness for Metal and GLES,** matching the Windows one, including the
documented float-versus-integer rounding difference between the GPU and CPU downscale.

### Phase 2 — Delete the main-process frame paths — DONE except 2.9

With Phase 1 done, these paths have no remaining justification. 2.1-2.8 are implemented and verified:
a 45-second run at 4K60 with an OutputShow client, the app-window preview and the display window all
live produced one `[RULE-CHECK]` line, at startup, before the off-main pipeline engaged.

**2.1 One capture path.** The shared-texture off-main path becomes the only path for captured outputs.
Remove the `hasGpuDownscale` demotion and the `canOffMain` branch that resolves a full readback into
main.

**2.2 Dismantle `CaptureTransmitter`'s pixel work.** Stage, server, WebRTC and RTMP consumers each get
a GPU target at exactly the size and format they need, produced in the worker's existing pass and
delivered from the worker. That deletes the seven `toBitmap` sites, every main-thread `resize`, every
`convertToRGBA` call, and the per-consumer `Buffer.from` copies.

**2.3 Stage JPEG encode moves off main,** onto the libuv pool in the worker, fed by a GPU-sized target
rather than a main-thread resize.

**2.4 Blackmagic conversion moves into the worker,** and every format expressible as a GPU target
becomes one. The remaining exotic formats convert in the worker, never in main.

**2.5 Delete frame-signature hashing.** It costs a scattered read across a 33MB buffer per channel per
frame on the main thread, and it runs after the readback and the `toBitmap` it exists to avoid, so it
adds cost and saves nothing. Skipping unchanged frames is fine in principle; this implementation is
not the way to do it.

**2.6 Transfer, do not clone, the preview frame** in `PreviewStream.ts`.

**2.7 Remove the remote-client `capturePage` path** in `servers.ts` in favour of the worker-produced
target.

**2.8 Reduce per-frame main-thread bookkeeping.** The member and target plan should be built when the
group changes, not per frame. Retire the per-frame `setImmediate`, the admission timer churn, and the
always-on send timer that fires with no new frame.

**2.9 OutputShow's wire format.** The browser view is sent raw RGBA over socket.io: 1280x720x4 =
3.5MB a frame, ~77 MB/s, and the socket's ack gate holds it to 22fps against a 30fps target. StageShow
already sends JPEG. Encoding this too should reach full rate at a fraction of the bandwidth, but it
changes `src/server/output_stream` as well as the sender, so it is its own piece of work.

### Phase 3 — Transport — DONE (3.3 unverified on macOS)

**3.1 One copy per frame per destination.** Give `convert.cc` an into-buffer form so it stops
allocating twice. Remove the BGRA intermediate in `readback_win.cc`. Make the video-layer
`CopyResource` conditional on a layer actually being present.

**3.2 Per-mapping locks in `shm.cc`** so rings stop serialising, and hold no lock across a memcpy.

**3.3 Single-pass fan-out.** Produce all targets from one source read, or from a mip chain, instead of
re-reading the full source per target.

**3.4 The preview downscale becomes a GPU target** rather than a floating-point loop in the receive
process.

**3.5 Not needed. Removed.** This item existed because the output sat at 37 frames per second against a
source I believed was running at 60. It was not. See the measurements section: the output path reaches
the source rate on both paths, and the page paint rate is not a limiter.

**3.6 Bound every queue and time out every wait.** The Linux GL job queue is uncapped, and a target
whose page stops acking stalls permanently.

**3.7 DONE — the render rate follows the admission rate.** The note that a sub-native `setFrameRate`
made Chromium clump paints no longer reproduces; it dated from the main-thread-bound pipeline. A 4K NDI
output at 30fps now paints 30/s instead of 60/s and discards nothing, delivering the same 30 unique
frames with the same 33ms mean gap.

### Phase 4 — Constants and pacing

**4.1 Keep the connection gates, and never benchmark through them.** The Phase 0 command attaches a
receiver to every output so the gates are inactive while measuring.

**4.2 Replace the constant inventory.** Roughly forty values across `OutputLifecycle.ts`,
`CaptureTransmitter.ts`, `CaptureLifecycle.ts`, `FrameServer.ts`, `ndiWorker.ts`,
`streamReceiverProcess.ts`, `readback_win.cc` and `readback_linux_gpu.cc`. Each becomes derived from
measurement, or the design changes so no threshold is needed. The worst offenders are the pixel-count
to fps lookup, the memory-to-fps backpressure table, the fixed ring slot count that caps the derived
depth, and the fixed pool ceilings duplicated in both C++ and JavaScript.

**4.3 Fix framerate derivation.** The generic framerate currently comes from the NDI setting even for
outputs that have no NDI member, and the render rate ignores any configured value between 1 and 60.

### Phase 5 — Parity as a gate, not an aspiration

**5.1 DONE.** `scripts/capability-check.cjs` holds the contract - every capability the app relies on,
listed once - and asserts it against the addon built for the platform it runs on. `npm run
check-capabilities` runs it under Electron so the ABI matches the app's; `scripts/wsl-linux-check.sh`
runs it against the Linux build. Both pass 19/19 today. A capability added for one backend has to be
added to the list, and the check then fails on the others until they have it. Verified failing: adding
an entry the addon does not export exits 1 and names it.

**5.2 The Phase 0 benchmark runs on all three platforms** for each phase, with numbers recorded. You
have a second Windows box and a Mac; Linux needs a target machine identified.

**5.3 DONE.** Every platform now unpacks the same set of native modules: `osr-capture` (which was named
nowhere and left to auto-detection, though the preload and the capture worker both map it),
`openmediatransport`, `grandiose` and `libltc-wrapper` (Linux only before), `macadam`, and `sharp`
(a native module the capture worker started using for stage and thumbnail encodes). `libspotifyctl`
stays Windows-only, being an optional dependency. Not verified by a packaged build.

**5.4 Audited; the documentation is reconciled, and NO workaround was retired.** Each Linux-only path was
checked against what Phases 1 and 3 actually changed, and none of them is made unnecessary by that work:

| Linux-only path | Why it exists | Still needed |
|---|---|---|
| `applyLinuxSwitches()` unthrottle switches | Chromium OSR starves paints without a begin-frame source | yes - nothing in Phase 1 or 3 touches paint delivery |
| `updateOsrPaintDrive` (invalidate timer) | same starvation, driven explicitly | yes, same reason |
| `avoidLinuxDisplaySizeShrink` | X11 subtracts 1px from a window matching a monitor exactly, giving an odd width the encoder refuses | yes - a window-manager behaviour, unrelated |
| `kImportFailDemotion` (CPU after 3 dmabuf import failures) | a real fallback, not a workaround | yes |
| dmabuf planes vs a shared-texture handle | the platform's texture representation, not a workaround | keep |

Phase 1 did retire one: the two-phase `readbackConsume`/`readbackFinish` install used to be conditional,
and a backend without it demoted the whole render group to a main-process readback. It is unconditional
everywhere now.

The documentation claim is corrected. `READBACK_REWORK_PLAN.md` said the compositor switches live in
`src/electron/index.ts` (they are in `src/electron/utils/commandLineSwitches.ts`) and listed
`run-all-compositor-stages-before-draw` among them, which is applied nowhere in the code.

One thing worth TESTING for removal rather than assuming: `disable-gpu-vsync` and
`disable-frame-rate-limit` are global, so they also unthrottle the main window and any displayed output
window. Phase 3.7 now sets the offscreen render rate explicitly, so the reason for disabling the limit
globally is weaker than when it was added. Listed below rather than changed blind.

---

## Part 2b — What still needs real hardware

Everything below is written and builds, but could not be exercised on this machine. Grouped so one pass
covers it.

**macOS**
- Build, then `npm run check-capabilities` - it must report every capability present (Windows and Linux
  both pass 19/19).
- Open OutputShow and look at the picture. The shared scale source (3.3) is written for Metal but has
  never been compiled, let alone run. `FS_SHARED_SCALE=0` disables it, so if the picture is wrong, that
  says whether the shared source is the cause.
- An output preview, a stage display and an NDI/OMT output: all four consumers now come from the worker.

**Linux**
- `scripts/wsl-linux-check.sh` already covers compiling, loading, shader compilation and the capability
  contract. What it cannot cover is the app's GPU path, since WSL reports software-only compositing.
- On real hardware: the same OutputShow / preview / stage / sender check as macOS.
- The GL thread's wedge timeout (3.6) has never been triggered - it needs a driver that actually hangs.
- Try removing `disable-gpu-vsync` and `disable-frame-rate-limit` (see 5.4) and confirm paints/s holds.

**Blackmagic (any platform)**
- Playback through a card: the conversion runs in the worker and the main-process path is now reachable
  only as a fallback, so a card that works proves the worker path.
- The memory-based backpressure table is gone (Phase 4); the card's own buffer depth is the gate. Worth
  a long run to confirm nothing grows.

**Every platform**
- `scripts/benchmark.mjs` with receivers attached, numbers recorded (5.2).

## Part 3 — Measured on Windows, 2026-09-08

Test box: RX 6900 XT, 32 logical cores. Real app, `FS_CAP_STATS=1`, receiver attached via the OMT
fork's `cross-receive.mjs`. Unique frames per second, repeats excluded.

| configuration | into the worker | out on the wire | paints |
|---|---|---|---|
| 4K60 clip on a 4K OMT output | n/a | 60 | 60 |
| 1080p60 live OMT input on a 4K OMT output | 60 | 54-60 | 55-60 |
| 4K60 live OMT input on a 4K OMT output | 38-40 | 35-39 | 36-40 |

The third row is not a FreeShow limit. The synthetic 4K sender encodes on the CPU on the same machine
and only produced 36-39 frames per second while FreeShow was running; FreeShow passed on essentially
every frame it was given. An earlier report of "37 against a 60 source" was this artifact, and it very
nearly cost a large and pointless rebuild of the capture pipeline.

Also ruled out by measurement: pipeline depth. Forcing the derived depth from 2 to 4 changed nothing
(36-39 either way), so in-flight readback occupancy is not a limiter either.

**Test rig rule.** Never measure the input path with a synthetic 4K sender running on the same machine.
Use a hardware source, a second machine, or a locally decoded clip, and always report what the source
actually delivered alongside what came out.

**Two concurrent 4K60 outputs, NDI and OMT, receivers attached to both, playing the 4K60 clip:**

| output | unique fps sent | receiver saw |
|---|---|---|
| NDI 1 | 53-59 | 49-59 |
| Output 1 (OMT) | 53-58 | ~58 |

Paints 57-60, round trip 15ms, about 7.4 cores.

With a real 4K60 live OMT source instead of the clip, everything on this one machine settles at about
32 frames per second end to end: the source app itself drops to 31 while FreeShow encodes two 4K
outputs. FreeShow forwarded 31-33 unique while 32-33 arrived, so its own loss is still near zero. The
NDI receiver's apparent 58 per second was mostly repeat filler and gets no credit. Proving 4K60 live
input into two 4K60 outputs needs the source and the receivers off this box.

---

## Part 4 — Acceptance

Every phase reports, from the Phase 0 command, on each platform:

- unique frames per second per output, with receivers attached to all outputs
- number of outputs held at 4K60 simultaneously
- main process CPU and event-loop lag
- worker CPU
- whether any CPU-frame or main-frame assertion fired

A phase is done when its numbers are recorded and no assertion fires. Not before.
