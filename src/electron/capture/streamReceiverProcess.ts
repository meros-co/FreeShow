// Runs in an Electron utilityProcess: owns every NDI/OMT receive loop, the frame packing and the
// preview downscale, and posts frames straight to the renderers that draw them over MessagePorts.
//
// Video must never touch the main thread. Receiving in the main process cost it ~15ms of event-loop
// lag per 4K source (the IPC write alone is ~17ms per 8MB frame), which is what made the UI crawl
// while a stream was live. From here the main process only brokers ports and control messages: it
// never sees a frame, and its lag stays around 1ms no matter how many 4K sources are running.

import { ensureOmtCodecSearchPath } from "../omt/omtModule"
import { packStreamFrame, previewStreamFrame, type StreamFrame, type StreamFrameFormat } from "./streamFrames"

const parentPort: any = (process as any).parentPort

// ----- frame transport: a loopback WebSocket from this process straight into the drawing window -----
//
// A MessagePort clone of a 16MB frame cost ~30ms to serialize here and ~30ms to deserialize in the
// renderer (Mojo chunks it), which capped 4K delivery at 12-14fps; a binary WebSocket message took
// Chromium ~110ms to hand to the page. So full-size frames go through shared memory instead: this
// process writes each frame into a slot of a ring the window has mapped too (osr-capture shmMap), and the
// socket carries only a small header naming the slot, plus the window's ack that frees it. The app
// window's small preview frames still travel as binary messages. Main is never in the path: it only
// tells a window the port and the token.
import http from "http"
import { randomBytes } from "crypto"
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WebSocketServer } = require("ws")
let shmModule: any = null
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    shmModule = require("osr-capture")
    if (typeof shmModule?.shmMap !== "function") shmModule = null
} catch {
    shmModule = null
}

// slots per window: enough that a frame can be written while the previous ones are still being read
const SHM_SLOTS = 3

// Frame buffers are pooled and reference counted: the OMT receiver decodes straight into a pooled
// buffer (receive(..., into)), each window that still needs the frame (waiting, or being copied into
// shared memory on the thread pool) holds a reference, and the buffer goes back to the pool when the
// last one lets go. No frame is copied on this thread; a fresh 16MB buffer per frame cost more in page
// faults than the copy itself.
const pooled = new Map<Buffer, number>()
const freeBuffers: Buffer[] = []
function acquireBuffer(bytes: number): Buffer {
    const i = freeBuffers.findIndex((b) => b.length >= bytes)
    const buf = i >= 0 ? freeBuffers.splice(i, 1)[0] : Buffer.allocUnsafeSlow(bytes)
    pooled.set(buf, 1)
    return buf
}
function poolBufferOf(data: Buffer): Buffer | null {
    for (const b of pooled.keys()) if (b.buffer === data.buffer) return b
    return null
}
function holdFrame(frame: StreamFrame) {
    const b = poolBufferOf(frame.data)
    if (b) pooled.set(b, (pooled.get(b) || 0) + 1)
}
function releaseFrame(frame: StreamFrame) {
    const b = poolBufferOf(frame.data)
    if (!b) return
    const n = (pooled.get(b) || 1) - 1
    if (n > 0) {
        pooled.set(b, n)
        return
    }
    pooled.delete(b)
    freeBuffers.push(b)
}
let shmSeq = 0
type ShmRing = { name: string; slotBytes: number; slots: number; busy: boolean[]; announced: boolean }
function createRing(slotBytes: number): ShmRing | null {
    if (!shmModule) return null
    const name = `fs-${process.pid}-${++shmSeq}`
    try {
        shmModule.shmMap(name, slotBytes * SHM_SLOTS, true)
        return { name, slotBytes, slots: SHM_SLOTS, busy: new Array(SHM_SLOTS).fill(false), announced: false }
    } catch (err: any) {
        log("shared memory unavailable: " + err?.message)
        shmModule = null
        return null
    }
}
function dropRing(ring: ShmRing | null | undefined) {
    if (!ring) return
    try {
        shmModule?.shmUnmap(ring.name)
    } catch {}
}
const wsToken = randomBytes(24).toString("hex")
let wsPort = 0
const wsServer = http.createServer((_req, res) => {
    res.statusCode = 404
    res.end()
})
const wss = new WebSocketServer({ server: wsServer, perMessageDeflate: false })
wsServer.listen(0, "127.0.0.1", () => {
    const address = wsServer.address()
    wsPort = typeof address === "object" && address ? address.port : 0
    toMain({ type: "wsInfo", port: wsPort, token: wsToken })
})
wss.on("connection", (ws: any) => {
    let targetId = ""
    ws.on("message", (raw: any, isBinary: boolean) => {
        if (isBinary) return
        const text = raw.toString()
        if (!targetId) {
            // handshake: { token, targetId, shm }: shm = the window can map shared memory
            let hello: any = null
            try {
                hello = JSON.parse(text)
            } catch {
                hello = null
            }
            if (!hello || hello.token !== wsToken || typeof hello.targetId !== "string") {
                ws.close()
                return
            }
            targetId = hello.targetId
            if (process.env.FS_CAP_STATS) log(`window ${targetId} connected, shared memory: ${!!hello.shm && !!shmModule} (window ${!!hello.shm}, here ${!!shmModule})`)
            requestedPorts.delete(targetId)
            if (subscribers[targetId]?.ws !== ws) dropSubscriber(targetId)
            subscribers[targetId] = { ws, inFlight: 0, sentAt: [], roundTrips: [], pending: null, roundTrip: 0, frameInterval: 0, lastFrameAt: 0, wantsShm: !!hello.shm && !!shmModule, ring: null }
            return
        }
        if (text === "1") onAck(targetId, -1)
        else if (text.startsWith("1:")) onAck(targetId, Number(text.slice(2)))
    })
    ws.on("close", () => {
        if (targetId && subscribers[targetId]?.ws === ws) dropSubscriber(targetId)
    })
    ws.on("error", () => {})
})

// ----- transport -----

// the app window draws previews a few hundred pixels wide
const PREVIEW_MAX_WIDTH = 480
const APP_TARGET = "app"

// How many frames a window may have in flight is measured, not chosen: a frame's round trip (post to
// ack) divided by the source's frame interval is how many must overlap to keep the transport busy on
// this machine. A 4K frame's round trip is ~100ms, so at 17fps it takes two; a 1080p frame's is
// shorter, so one. Beyond that the newest frame waits its turn, replacing whatever was waiting: the
// window is never sent a frame it will have to catch up on. A window that goes away is dropped by
// the main process (see StreamReceiverHost), so no timeout is needed to notice one either.
type Pending = { ipcChannel: string; id: string; frame: StreamFrame; time: number }
type Subscriber = {
    ws: any
    inFlight: number
    sentAt: number[]
    roundTrips: number[] // recent post->ack samples, ms
    pending: Pending | null
    roundTrip: number // the window's round trip when it is keeping up: the minimum of the recent samples
    frameInterval: number // measured arrival spacing, ms (smoothed)
    lastFrameAt: number
    wantsShm: boolean
    ring: ShmRing | null
}

// smoothing weight for the two measurements above; a weight, not a machine-dependent threshold
const SMOOTHING = 0.2

function smooth(previous: number, sample: number) {
    return previous ? previous + (sample - previous) * SMOOTHING : sample
}

// How many frames to keep in flight so the window is never idle: round trip / frame interval. The
// round trip used is the best recent one, not the average: a window that falls behind reports longer
// and longer round trips, and sizing the depth on those would feed the backlog that caused them.
// One more than the round trip needs, so the next frame is already there when the window finishes
// the current one (frames arrive in bursts; one in flight alone left the window idle between them).
const ROUND_TRIP_SAMPLES = 32
function allowedInFlight(subscriber: Subscriber) {
    if (!subscriber.roundTrip || !subscriber.frameInterval) return 1
    const depth = Math.ceil(subscriber.roundTrip / subscriber.frameInterval) + 1
    return subscriber.ring ? Math.min(depth, subscriber.ring.slots) : depth
}
const subscribers: { [targetId: string]: Subscriber } = {}
const requestedPorts = new Set<string>()

// FS_CAP_STATS: per-window delivery, once a second. acked = frames the window took (it acks after
// dispatching the frame to its drawing components), so acked/s is the rate the window actually drew.
const rxStats: { [targetId: string]: { offered: number; posted: number; acked: number; replaced: number } } = {}
function rxStat(targetId: string) {
    return (rxStats[targetId] ||= { offered: 0, posted: 0, acked: 0, replaced: 0 })
}
const loopStats = { frames: 0, empty: 0, recvMs: 0, sendMs: 0, shmMs: 0, previewMs: 0 }
if (process.env.FS_CAP_STATS) {
    setInterval(() => {
        if (loopStats.frames || loopStats.empty) {
            log(`[RX-LOOP] frames=${loopStats.frames} empty=${loopStats.empty} recv=${loopStats.recvMs.toFixed(0)}ms send=${loopStats.sendMs.toFixed(0)}ms (shm=${loopStats.shmMs.toFixed(0)}ms preview=${loopStats.previewMs.toFixed(0)}ms)`)
            loopStats.frames = loopStats.empty = loopStats.recvMs = loopStats.sendMs = loopStats.shmMs = loopStats.previewMs = 0
        }
        for (const [targetId, st] of Object.entries(rxStats)) {
            const sub = subscribers[targetId]
            if (!st.offered && !st.acked) continue
            log(`[RX-STATS ${targetId}] offered=${st.offered} posted=${st.posted} acked=${st.acked} replaced=${st.replaced} inFlight=${sub?.inFlight ?? 0}/${sub ? allowedInFlight(sub) : 0} rtt=${sub ? Math.round(sub.roundTrip) : 0}ms interval=${sub ? Math.round(sub.frameInterval) : 0}ms`)
            st.offered = st.posted = st.acked = st.replaced = 0
        }
    }, 1000)
}

function toMain(message: any) {
    parentPort?.postMessage(message)
}

function log(text: string) {
    toMain({ type: "log", text })
}

// A port is only asked for when there is actually a frame to deliver, so nothing is wired up for
// outputs that never show a stream.
function needPort(targetId: string, preview: boolean) {
    if (subscribers[targetId] || requestedPorts.has(targetId)) return
    requestedPorts.add(targetId)
    toMain({ type: "needPort", targetId, preview })
}

// Sending faster than a window draws only grows a backlog, and the frames then arrive later and
// later, which looks like a stall rather than a dropped frame. So one frame is in flight at a time
// and the newest replaces whatever was waiting: live video wants the newest frame, not every frame.
function deliver(targetId: string, ipcChannel: string, id: string, frame: StreamFrame, time: number) {
    const subscriber = subscribers[targetId]
    if (!subscriber) return

    if (subscriber.lastFrameAt) subscriber.frameInterval = smooth(subscriber.frameInterval, time - subscriber.lastFrameAt)
    subscriber.lastFrameAt = time

    rxStat(targetId).offered++
    holdFrame(frame)
    if (!canPost(subscriber)) {
        if (subscriber.pending) {
            rxStat(targetId).replaced++
            releaseFrame(subscriber.pending.frame)
        }
        subscriber.pending = { ipcChannel, id, frame, time }
        return
    }

    post(targetId, subscriber, { ipcChannel, id, frame, time })
}

// Shared memory: the frame is copied into a free ring slot and the header names the slot. Otherwise
// two WebSocket messages per frame: the header, then the pixels as one binary message.
function freeSlot(ring: ShmRing) {
    return ring.busy.indexOf(false)
}
function canPost(subscriber: Subscriber) {
    if (subscriber.inFlight >= allowedInFlight(subscriber)) return false
    return !subscriber.ring || freeSlot(subscriber.ring) >= 0 || subscriber.ring.slotBytes < (subscriber.pending?.frame.data.length || 0)
}
function post(targetId: string, subscriber: Subscriber, next: Pending) {
    try {
        const header: any = { ipcChannel: next.ipcChannel, id: next.id, time: next.time, xres: next.frame.xres, yres: next.frame.yres, format: next.frame.format }
        if (subscriber.wantsShm) {
            const bytes = next.frame.data.length
            if (!subscriber.ring || subscriber.ring.slotBytes < bytes) {
                // a ring for this frame size; the window maps the new one and lets go of the old
                dropRing(subscriber.ring)
                subscriber.ring = createRing(bytes)
                if (!subscriber.ring) subscriber.wantsShm = false
            }
            const ring = subscriber.ring
            if (ring) {
                const slot = freeSlot(ring)
                if (slot < 0) {
                    subscriber.pending = next
                    return
                }
                ring.busy[slot] = true
                header.slot = slot
                header.bytes = bytes
                if (!ring.announced) {
                    header.shm = { name: ring.name, slotBytes: ring.slotBytes, slots: ring.slots }
                    ring.announced = true
                }
                subscriber.inFlight++
                rxStat(targetId).posted++
                subscriber.sentAt.push(Date.now())
                // the copy runs on the thread pool; the header goes out once the slot holds the frame
                const tShm = performance.now()
                const ws = subscriber.ws
                shmModule.shmWriteAsync(ring.name, slot * ring.slotBytes, next.frame.data).then(
                    () => {
                        loopStats.shmMs += performance.now() - tShm
                        releaseFrame(next.frame)
                        if (subscribers[targetId]?.ws === ws) ws.send(JSON.stringify(header))
                    },
                    () => {
                        releaseFrame(next.frame)
                        if (subscribers[targetId]?.ws === ws) onAck(targetId, slot)
                    }
                )
                return
            }
        }
        subscriber.inFlight++
        rxStat(targetId).posted++
        subscriber.sentAt.push(Date.now())
        subscriber.ws.send(JSON.stringify(header))
        subscriber.ws.send(next.frame.data, { binary: true }, () => releaseFrame(next.frame))
    } catch {
        releaseFrame(next.frame)
        dropSubscriber(targetId)
    }
}

function dropSubscriber(targetId: string) {
    const sub = subscribers[targetId]
    if (!sub) return
    if (sub.pending) releaseFrame(sub.pending.frame)
    dropRing(sub.ring)
    try {
        sub.ws?.close()
    } catch {}
    delete subscribers[targetId]
    requestedPorts.delete(targetId)
}

// the window took a frame: measure the round trip, then send whatever arrived meanwhile, newest only
function onAck(targetId: string, slot: number) {
    const subscriber = subscribers[targetId]
    if (!subscriber) return
    rxStat(targetId).acked++
    if (slot >= 0 && subscriber.ring && slot < subscriber.ring.slots) subscriber.ring.busy[slot] = false

    subscriber.inFlight = Math.max(0, subscriber.inFlight - 1)
    const sentAt = subscriber.sentAt.shift()
    if (sentAt) {
        subscriber.roundTrips.push(Date.now() - sentAt)
        if (subscriber.roundTrips.length > ROUND_TRIP_SAMPLES) subscriber.roundTrips.shift()
        subscriber.roundTrip = Math.min(...subscriber.roundTrips)
    }

    const next = subscriber.pending
    if (!next || !canPost(subscriber)) return

    subscriber.pending = null
    post(targetId, subscriber, next)
}

// Outputs render the stream itself and need every pixel; the app window only ever previews it (drawer
// card, output mirror) so it gets a small copy of every frame, which keeps the preview as smooth as
// the output without paying full frame size for it.
function sendFrame(ipcChannel: string, id: string, outputIds: string[], packed: StreamFrame) {
    const time = Date.now()

    outputIds.forEach((outputId) => {
        needPort(outputId, false)
        deliver(outputId, ipcChannel, id, packed, time)
    })
    // the receiver's own hold (acquireBuffer) ends here; windows that took the frame keep theirs
    releaseFrame(packed)

    needPort(APP_TARGET, true)
    if (subscribers[APP_TARGET]) {
        const tPreview = performance.now()
        const preview = previewStreamFrame(packed, PREVIEW_MAX_WIDTH)
        loopStats.previewMs += performance.now() - tPreview
        deliver(APP_TARGET, ipcChannel, id, preview, time)
    }
}

type ReceiverState = {
    shouldStop?: boolean
    source: any
    lowbandwidth?: boolean
}

// ----- NDI -----

let grandioseModule: any = null
let grandioseWarned = false
async function loadGrandiose() {
    if (grandioseModule) return grandioseModule
    try {
        grandioseModule = await import("grandiose")
        return grandioseModule
    } catch (err: any) {
        if (!grandioseWarned) log("NDI not available: " + err.message)
        grandioseWarned = true
        return null
    }
}

class Ndi {
    static receivers: { [id: string]: ReceiverState } = {}
    static active: { [id: string]: any } = {}
    static outputs: string[] = []
    static fourCCUyvy: number | null = null
    private static findInterval: NodeJS.Timeout | null = null

    static async createReceiver(source: { name: string; urlAddress: string }, lowbandwidth = false) {
        try {
            const grandiose = await loadGrandiose()
            if (!grandiose) return null

            // UYVY is half the bytes of RGBA and every one of them costs time in the copy to the
            // renderer; the renderer converts it on the GPU. Sources with alpha still arrive as RGBA.
            this.fourCCUyvy = grandiose.FOURCC_UYVY
            const config: any = {
                source,
                colorFormat: grandiose.COLOR_FORMAT_UYVY_RGBA,
                allowVideoFields: false
            }
            if (lowbandwidth) config.bandwidth = grandiose.BANDWIDTH_LOWEST

            let timeout: NodeJS.Timeout | null = null
            try {
                return await Promise.race([
                    grandiose.receive(config),
                    new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(new Error("NDI receiver timeout")), 10000)
                    })
                ])
            } catch (err: any) {
                log("Failed to create NDI receiver: " + err.message)
                return null
            } finally {
                if (timeout) clearTimeout(timeout)
            }
        } catch (err: any) {
            log("Failed to create NDI receiver: " + err.message)
            return null
        }
    }

    static async findStreams(data: { groups?: string }) {
        if (this.findInterval) clearInterval(this.findInterval)

        const grandiose = await loadGrandiose()
        if (!grandiose) return []

        const finder: any = await grandiose.find({
            showLocalSources: true,
            groups: data.groups || ""
        })
        return new Promise<any[]>((resolve) => {
            // without the interval it only finds one source: https://github.com/emanspeaks/grandiose/commit/271cd73b5269ab827155a1a944c15d3b5fe4d564
            let previousLength = 0
            this.findInterval = setInterval(() => {
                const sources = finder.sources()
                if (previousLength === sources.length) {
                    clearInterval(this.findInterval!)
                    resolve(sources)
                }
                previousLength = sources.length
            }, 1000)
        })
    }

    static handleError(err: any, consecutiveErrors: number) {
        const msg = err.message || ""
        if (msg.includes("Non-video data received"))
            return {
                shouldContinue: true,
                delay: 0,
                newErrorCount: Math.max(0, consecutiveErrors - 1)
            }
        if (msg.includes("No video data received"))
            return {
                shouldContinue: true,
                delay: 1,
                newErrorCount: consecutiveErrors
            }

        const newCount = consecutiveErrors + 1
        return {
            shouldContinue: newCount < 10,
            delay: Math.min(5 * Math.pow(1.5, newCount), 100),
            newErrorCount: newCount
        }
    }

    static async frameLoop(sourceId: string, thumbnail: boolean) {
        let consecutiveErrors = 0

        while (this.receivers[sourceId] && !this.receivers[sourceId].shouldStop) {
            const state = this.receivers[sourceId]
            try {
                let receiver = this.active[sourceId]
                if (!receiver) {
                    const source = state.source
                    receiver = this.active[sourceId] = await this.createReceiver({ name: source.name, urlAddress: source.urlAddress || source.id }, state.lowbandwidth)
                }
                if (!receiver?.video) {
                    delete this.active[sourceId]
                    throw new Error("No video data received")
                }

                const rawFrame = await receiver.video(50)
                if (rawFrame) {
                    this.sendBuffer(sourceId, rawFrame)
                    consecutiveErrors = 0

                    // video() already blocks until the next frame, so pace on the source: waiting
                    // after every frame pushes the next fetch past the frame after it
                    if (thumbnail) await new Promise((resolve) => setTimeout(resolve, 500))
                    else await new Promise((resolve) => setImmediate(resolve))
                    continue
                }
            } catch (err: any) {
                const { shouldContinue, delay, newErrorCount } = this.handleError(err, consecutiveErrors)
                consecutiveErrors = newErrorCount

                if (!shouldContinue) {
                    log("NDI source " + sourceId + ": too many errors, stopping")
                    this.stop({ id: sourceId })
                    return
                }

                await new Promise((resolve) => setTimeout(resolve, delay))
            }
        }
    }

    static sendBuffer(id: string, frame: any) {
        if (!frame?.data) return

        const format: StreamFrameFormat = frame.fourCC === this.fourCCUyvy ? "uyvy" : "rgba"
        const packed = packStreamFrame(frame.data, frame.xres, frame.yres, frame.lineStrideBytes || 0, format)
        if (!packed) return

        sendFrame("NDI", id, this.outputs, packed)
    }

    static async thumbnail({ source }: { source: any }) {
        if (this.receivers[source.id]) return
        this.receivers[source.id] = {
            shouldStop: false,
            source,
            lowbandwidth: true
        }
        this.frameLoop(source.id, true).catch((err) => log("NDI thumbnail error for " + source.id + ": " + err.message))
    }

    static async capture({ source, outputId }: { source: any; outputId: string }) {
        if (!this.outputs.includes(outputId)) this.outputs.push(outputId)

        // if a thumbnail loop is running, upgrade it to full capture
        if (this.receivers[source.id]) {
            this.receivers[source.id].shouldStop = true
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
        delete this.active[source.id]

        this.receivers[source.id] = {
            shouldStop: false,
            source,
            lowbandwidth: false
        }
        this.frameLoop(source.id, false).catch((err) => {
            log("NDI reception error for " + source.id + ": " + err.message)
            this.stop({ id: source.id })
        })
    }

    static stop(data: { id: string; outputId?: string } | null = null) {
        if (data?.id) {
            if (data.outputId) {
                const index = this.outputs.indexOf(data.outputId)
                if (index >= 0) this.outputs.splice(index, 1)
            } else this.outputs = []

            if (!this.outputs.length && this.receivers[data.id]) {
                this.receivers[data.id].shouldStop = true
                setTimeout(() => {
                    delete this.active[data.id]
                    delete this.receivers[data.id]
                }, 100)
            }
            return
        }

        Object.keys(this.receivers).forEach((id) => (this.receivers[id].shouldStop = true))
        setTimeout(() => {
            this.active = {}
            this.receivers = {}
        }, 100)
    }
}

// ----- OMT -----

let omtModule: any = null
let omtWarned = false
async function loadOmt() {
    if (omtModule) return omtModule
    try {
        // the codec DLL lives beside the addon; this process has its own environment, so the search
        // path set here is the one its loader actually uses
        ensureOmtCodecSearchPath()
        omtModule = await import("openmediatransport")
        return omtModule
    } catch (err: any) {
        if (!omtWarned) log("OMT not available: " + err.message)
        omtWarned = true
        return null
    }
}

// One loop per source. The loop is the only thing that ever calls receive() or destroy() on its
// instance, and it destroys the instance itself after its final receive() has settled: the addon runs
// receive() on the libuv threadpool holding the raw libomt pointer, so a destroy from anywhere else
// while one is in flight is a use-after-free. A loop ends when it is stopped or its record is replaced,
// checked after every await; callers that need the instance gone await the loop, not a timer.
type OmtLoop = {
    source: any
    lowbandwidth: boolean
    frameBytes: number
    stopped: boolean
    receiver: any
    done: Promise<void>
    wake: (() => void) | null
}

class Omt {
    // Reference count per output: an output's two crossfade layers each mount a stream component for
    // the same source and output, so a plain list would let the first one to unmount stop a live
    // stream that the other still shows.
    private static outputRefs: { [outputId: string]: number } = {}
    static codecs: any = null
    private static loops: { [sourceId: string]: OmtLoop } = {}

    private static get outputs() {
        return Object.keys(this.outputRefs)
    }

    private static readonly RECEIVE_TIMEOUT_MS = 50
    private static readonly FULL_LOOP_DELAY_MS = 16 // ~60fps ceiling
    private static readonly THUMBNAIL_LOOP_DELAY_MS = 500

    static async createReceiver(address: string, lowbandwidth = false) {
        try {
            const omt = await loadOmt()
            if (!omt) return null
            this.codecs = omt.Codec

            // UYVY where the source allows it; the renderer converts on the GPU. Sources with alpha still arrive as BGRA.
            const flags = lowbandwidth ? omt.ReceiveFlags.Preview : omt.ReceiveFlags.None
            return new omt.Receiver(address, omt.FrameType.Video, omt.PreferredVideoFormat.UYVYorBGRA, flags)
        } catch (err: any) {
            log("Failed to create OMT receiver: " + err.message)
            return null
        }
    }

    static async findStreams() {
        const omt = await loadOmt()
        if (!omt) return []

        // discovery populates over time (DNS-SD); poll briefly until we have results
        let addresses: string[] = []
        for (let attempt = 0; attempt < 4; attempt++) {
            addresses = omt.getAddresses() || []
            if (addresses.length) break
            await new Promise((resolve) => setTimeout(resolve, 400))
        }

        return addresses.map((address) => ({ name: address, urlAddress: address }))
    }

    static async thumbnail({ source }: { source: any }) {
        const existing = this.loops[source.id]
        if (existing) {
            if (!existing.stopped) return
            await this.stopLoop(existing)
        }
        this.startLoop(source, true, this.THUMBNAIL_LOOP_DELAY_MS)
    }

    static async capture({ source, outputId }: { source: any; outputId: string }) {
        this.outputRefs[outputId] = (this.outputRefs[outputId] || 0) + 1

        // a running full-quality loop already serves this source; a thumbnail loop holds a
        // low-bandwidth instance and a stopping loop still holds its instance, so either is ended and
        // awaited before the full-quality one starts
        const existing = this.loops[source.id]
        if (existing) {
            if (!existing.lowbandwidth && !existing.stopped) return
            await this.stopLoop(existing)
        }

        this.startLoop(source, false, this.FULL_LOOP_DELAY_MS)
    }

    private static startLoop(source: any, lowbandwidth: boolean, delayMs: number) {
        const loop: OmtLoop = { source, lowbandwidth, frameBytes: 0, stopped: false, receiver: null, done: Promise.resolve(), wake: null }
        this.loops[source.id] = loop
        loop.done = this.frameLoop(source.id, loop, delayMs).catch((err) => log("OMT reception error for " + source.id + ": " + err.message))
    }

    // ends the loop and resolves once it has destroyed its instance
    private static stopLoop(loop: OmtLoop) {
        loop.stopped = true
        loop.wake?.()
        return loop.done
    }

    // a sleep that ends early when the loop is stopped, so a stop never waits out a thumbnail interval
    private static pause(loop: OmtLoop, ms: number) {
        return new Promise<void>((resolve) => {
            const timer = setTimeout(finish, ms)
            function finish() {
                clearTimeout(timer)
                loop.wake = null
                resolve()
            }
            loop.wake = finish
        })
    }

    private static async frameLoop(sourceId: string, loop: OmtLoop, delayMs: number) {
        let consecutiveErrors = 0

        try {
            // a replaced record belongs to a newer loop for the same source: this one is finished
            while (!loop.stopped && this.loops[sourceId] === loop) {
                try {
                    if (!loop.receiver) {
                        loop.receiver = await this.createReceiver(loop.source.urlAddress || loop.source.id, loop.lowbandwidth)
                        if (!loop.receiver) throw new Error("Could not create receiver")
                        if (loop.stopped) break
                    }

                    // decode into a pooled buffer sized from the last frame (a bigger frame arrives in
                    // its own buffer, which sizes the next one); sendBuffer takes over the hold
                    const into = loop.lowbandwidth || !loop.frameBytes ? null : acquireBuffer(loop.frameBytes)
                    const tRecv = performance.now()
                    let frame: any = null
                    try {
                        frame = await loop.receiver.receive(this.RECEIVE_TIMEOUT_MS, 2 /* Video */, into || undefined)
                    } finally {
                        if (into && !(frame?.data && frame.data.buffer === into.buffer)) releaseFrame({ data: into } as StreamFrame)
                    }
                    const tGot = performance.now()
                    loopStats.recvMs += tGot - tRecv
                    if (loop.stopped) break
                    if (frame?.data) {
                        loopStats.frames++
                        loop.frameBytes = Math.max(loop.frameBytes, frame.data.length)
                        this.sendBuffer(sourceId, frame)
                        loopStats.sendMs += performance.now() - tGot
                        consecutiveErrors = 0
                    } else loopStats.empty++

                    // receive() already blocks until the next frame, so pace on the source rather than a timer.
                    // Idle (no frame) still backs off, and thumbnails keep their slow rate.
                    if (frame?.data && delayMs < this.THUMBNAIL_LOOP_DELAY_MS) await new Promise((resolve) => setImmediate(resolve))
                    else await this.pause(loop, delayMs)
                } catch (err: any) {
                    consecutiveErrors++
                    // the failed receive() has settled, so this loop's instance can be dropped and recreated
                    this.destroyInstance(loop)

                    if (consecutiveErrors >= 10) {
                        log("OMT source " + sourceId + ": too many errors, stopping")
                        loop.stopped = true
                        break
                    }

                    await this.pause(loop, Math.min(5 * Math.pow(1.5, consecutiveErrors), 100))
                }
            }
        } finally {
            // every receive() this loop issued has settled by now, so nothing can still be using it
            this.destroyInstance(loop)
            if (this.loops[sourceId] === loop) delete this.loops[sourceId]
        }
    }

    private static destroyInstance(loop: OmtLoop) {
        const receiver = loop.receiver
        loop.receiver = null
        if (!receiver) return
        try {
            receiver.destroy()
        } catch (err: any) {
            log("Error destroying OMT receiver: " + err.message)
        }
    }

    static sendBuffer(id: string, frame: any) {
        if (!frame?.data) return

        const format: StreamFrameFormat = frame.codec === this.codecs?.UYVY ? "uyvy" : "bgra"
        const packed = packStreamFrame(frame.data, frame.width, frame.height, frame.stride || 0, format)
        if (!packed) return

        sendFrame("OMT", id, this.outputs, packed)
    }

    static stop(data: { id: string; outputId?: string } | null = null): Promise<void> {
        if (data?.id) {
            if (data.outputId) {
                const refs = (this.outputRefs[data.outputId] || 0) - 1
                if (refs > 0) this.outputRefs[data.outputId] = refs
                else delete this.outputRefs[data.outputId]
            } else this.outputRefs = {}

            const loop = this.loops[data.id]
            if (!this.outputs.length && loop) return this.stopLoop(loop)
            return Promise.resolve()
        }

        return Promise.all(Object.values(this.loops).map((loop) => this.stopLoop(loop))).then(() => undefined)
    }
}

// ----- control channel -----

const HANDLERS: { [type: string]: (data: any) => any } = {
    "ndi:find": (data) => Ndi.findStreams(data || {}),
    "ndi:thumbnail": (data) => Ndi.thumbnail(data),
    "ndi:capture": (data) => Ndi.capture(data),
    "ndi:stop": (data) => Ndi.stop(data),
    "omt:find": () => Omt.findStreams(),
    "omt:thumbnail": (data) => Omt.thumbnail(data),
    "omt:capture": (data) => Omt.capture(data),
    "omt:stop": (data) => Omt.stop(data)
}

parentPort.on("message", async (e: any) => {
    const message = e.data
    if (!message) return

    if (message.type === "dropPort") {
        dropSubscriber(message.targetId)
        requestedPorts.delete(message.targetId)
        return
    }

    const handler = HANDLERS[message.type]
    if (!handler) return

    try {
        const value = await handler(message.data)
        if (message.requestId) toMain({ type: "result", requestId: message.requestId, value })
    } catch (err: any) {
        if (message.requestId)
            toMain({
                type: "result",
                requestId: message.requestId,
                value: null,
                error: err.message
            })
        else log(message.type + " failed: " + err.message)
    }
})
