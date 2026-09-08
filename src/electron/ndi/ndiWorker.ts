import { parentPort } from "worker_threads"
import { loadOMT } from "../omt/omtModule"
import { RtmpStreamer, setRtmpNoticeListener, setRtmpStatusListener } from "../streaming/RtmpStreamer"
import { BlackmagicSender } from "../blackmagic/BlackmagicSender"
import { FrameServer, type ServedFrame } from "../capture/FrameServer"

// NDI engine in a worker_thread: colour-convert, padding and grandiose send-dispatch all run off the
// main thread. NdiSender on the main thread is a thin proxy that forwards messages here.

if (!parentPort) throw new Error("ndiWorker must be run as a worker_thread")
const port = parentPort

const BYTES_PER_FLOAT32 = 4
const CONNECTION_POLL_INTERVAL_MS = 250
const TIMECODE_DIVISOR = BigInt(100)

const timeStart = BigInt(Date.now()) * BigInt(1e6) - process.hrtime.bigint()

// grandiose (native NDI addon), loaded inside the worker
let grandioseModule: any | null = null
let grandiosePromise: Promise<any | null> | null = null
let warned = false
const loadGrandiose = async () => {
    if (grandioseModule) return grandioseModule
    if (grandiosePromise) return grandiosePromise

    grandiosePromise = import("grandiose")
        .then((imported) => {
            grandioseModule = imported
            return imported
        })
        .catch((err: any) => {
            if (!warned) console.warn("NDI not available:", err?.message || err)
            warned = true
            return null
        })
        .finally(() => {
            grandiosePromise = null
        })

    return grandiosePromise
}

type Sender = {
    name: string
    groups?: string
    status?: string
    previousStatus?: string
    sender?: any
    // protocol adapters, set at creation: NDI = grandiose sender.video/audio, OMT = libomt sender.send.
    // The pacer/queue machinery below is protocol-agnostic and only ever calls these.
    sendFrame?: (frame: any) => Promise<void> | void
    sendAudio?: (frame: any) => Promise<void> | void
    tsKey?: "timecode" | "timestamp" // frame field re-stamped at send time (NDI vs OMT naming)
    timer?: NodeJS.Timeout
    sendingVideo?: boolean
    pendingVideoFrame?: any
    sendingAudio?: boolean
    audioQueue?: any[]
    offMain?: boolean
    pendingReal?: boolean
    coalescedReal?: number
    sendMsSum?: number
    sentReal?: number
    sentRepeat?: number
    paceQueue?: { frame: any; pbuf: PacerBuf }[]
    lastPace?: { frame: any; pbuf: PacerBuf }
    paceTimer?: NodeJS.Timeout
    paceNextDue?: number
    paceInterval?: number
    pendingSlot?: number // a tick that found the encoder busy: its slot time, owed to the waiting frame
    paceCap?: number
    paceMisses?: number
    paceBusy?: number
    lastRealSendAt?: number
    realGaps?: number[]
    sendRejected?: number // sends the library accepted but did not put on the wire (OMT: encode failure)
    rejectLogged?: boolean
}
// FS_CAP_STATS: how congested this worker's JS thread is. Loop lag = how late a 5ms timer fires
// (0 = idle loop); copyMs/fanMs = synchronous time spent copying readbacks and fanning out frames.
const loopDiag = { lagSum: 0, lagMax: 0, lagN: 0, copyMs: 0, copyN: 0, fanMs: 0, lastTick: 0 }
if (process.env.FS_CAP_STATS) {
    loopDiag.lastTick = performance.now()
    setInterval(() => {
        const now = performance.now()
        const lag = Math.max(0, now - loopDiag.lastTick - 5)
        loopDiag.lastTick = now
        loopDiag.lagSum += lag
        loopDiag.lagN++
        if (lag > loopDiag.lagMax) loopDiag.lagMax = lag
    }, 5)
}

const NDI: { [id: string]: Sender } = {}
// OMT senders live in the same worker, so an NDI+OMT output shares one readback per frame
const OMTS: { [id: string]: Sender } = {}

if (process.env.FS_CAP_STATS) {
    let lastCpu = process.cpuUsage()
    let lastCpuAt = Date.now()
    setInterval(() => {
        const nowCpu = process.cpuUsage()
        const nowAt = Date.now()
        const cpuCores = (nowCpu.user + nowCpu.system - lastCpu.user - lastCpu.system) / 1000 / Math.max(1, nowAt - lastCpuAt)
        lastCpu = nowCpu
        lastCpuAt = nowAt
        const rb = loadOsrCapture()?._readbackBackend?.() ?? "?"
        if (loopDiag.lagN) {
            console.info(`[WORKER-LOOP] lag(mean=${(loopDiag.lagSum / loopDiag.lagN).toFixed(2)}ms max=${loopDiag.lagMax.toFixed(1)}ms) copy(n=${loopDiag.copyN} ${loopDiag.copyN ? (loopDiag.copyMs / loopDiag.copyN).toFixed(2) : "0"}ms each) fanOut=${loopDiag.fanMs.toFixed(1)}ms/s cpuCores=${cpuCores.toFixed(2)}`)
            loopDiag.lagSum = loopDiag.lagMax = loopDiag.lagN = loopDiag.copyMs = loopDiag.copyN = loopDiag.fanMs = 0
        }
        const statSenders: [string, Sender][] = [...Object.entries(NDI), ...Object.entries(OMTS).map(([id, s]): [string, Sender] => [`omt#${id}`, s])]
        for (const [id, s] of statSenders) {
            if (!s?.sender) continue
            const sends = (s.sentReal || 0) + (s.sentRepeat || 0)
            const avg = sends ? Math.round((s.sendMsSum || 0) / sends) : 0
            let gapMean = 0
            let gapP95 = 0
            const gaps = s.realGaps || []
            if (gaps.length) {
                gapMean = gaps.reduce((a, b) => a + b, 0) / gaps.length
                const sorted = [...gaps].sort((a, b) => a - b)
                gapP95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
            }
            console.info(`[SEND-STATS ${id}] sentReal=${s.sentReal || 0} sentRepeat=${s.sentRepeat || 0} coalescedReal=${s.coalescedReal || 0} paceQ=${s.paceQueue?.length || 0} paceMisses=${s.paceMisses || 0} paceBusy=${s.paceBusy || 0} wireGap(mean=${Math.round(gapMean)} p95=${Math.round(gapP95)}) avgSendMs=${avg} rejected=${s.sendRejected || 0} rb=${rb} cpuCores=${cpuCores.toFixed(2)}`)
            s.sentReal = 0
            s.sentRepeat = 0
            s.coalescedReal = 0
            s.sendRejected = 0
            s.paceMisses = 0
            s.paceBusy = 0
            s.sendMsSum = 0
            gaps.length = 0
        }
    }, 1000)
}

async function createSender(id: string, name: string, groups?: string) {
    // replace an existing sender instead of skipping the create
    if (NDI[id]) stopSender(id)

    NDI[id] = { name, groups }
    console.info("NDI - creating sender: " + name, groups ? `; In group: ${groups}` : "")

    try {
        const grandiose = await loadGrandiose()
        if (!grandiose) {
            delete NDI[id]
            port.postMessage({ type: "createFailed", id })
            return
        }

        /* eslint @typescript-eslint/await-thenable: 0 */
        const sender = await grandiose.send({ name, groups, clockVideo: false, clockAudio: false })

        // if stopSender was called while `await grandiose.send` was in progress, the entry is gone —
        // destroy the freshly created sender instead of leaking it
        if (!NDI[id]) {
            try {
                sender.destroy()
            } catch {}
            return
        }

        NDI[id].sender = sender
        NDI[id].sendFrame = (frame: any) => sender.video(frame)
        NDI[id].sendAudio = (frame: any) => sender.audio(frame)
        NDI[id].tsKey = "timecode"
    } catch (err) {
        console.error("Could not create NDI sender:", err)
        delete NDI[id]
        port.postMessage({ type: "createFailed", id })
        return
    }

    NDI[id].timer = setInterval(() => {
        if (!NDI[id]?.sender) return
        const conns: number = NDI[id].sender?.connections() || 0
        if (!NDI[id]) return
        NDI[id].status = conns > 0 ? "connected" : "unconnected"

        const newStatus = String(NDI[id].status) + conns.toString()
        if (newStatus !== NDI[id].previousStatus) {
            port.postMessage({ type: "status", id, status: NDI[id].status, connections: conns })
            NDI[id].previousStatus = newStatus
            if (NDI[id].status === "connected") console.log(`[NDI] Reconnected for ${id}`)
        }
    }, CONNECTION_POLL_INTERVAL_MS)
}

function stopSender(id: string) {
    // tear down even when the timer/sender never got assigned (e.g. destroy arriving while createSender
    // is still awaiting grandiose.send — deleting the entry makes createSender's race guard fire)
    if (!NDI[id]) return
    console.info("NDI - stopping sender: " + (NDI[id].name || id))
    if (NDI[id].timer) clearInterval(NDI[id].timer)

    if (NDI[id].sender) {
        try {
            NDI[id].sender.destroy()
        } catch (err) {
            console.error("ERROR", err)
        }
    }

    // pacer teardown: stop the tick, release every ref this sender holds (queue entries + the lastPace pin).
    // An in-flight paceSend holds its own ref and releases it in its finally — releasePacerRef only recycles
    // at refcount 0 and only into a still-existing pool, so nothing is recycled or leaked mid-send.
    const s = NDI[id]
    if (s.paceTimer) clearTimeout(s.paceTimer)
    for (const entry of s.paceQueue || []) releasePacerRef(entry.pbuf)
    s.paceQueue = []
    const pin = s.lastPace
    if (pin) {
        releasePacerRef(pin.pbuf)
        s.lastPace = undefined
    }
    delete pacerPools[id] // renderer's pacer free list (members never own one); unreturned bufs just GC
    delete NDI[id]
    releaseReadbackResources(id)
}

// free the worker's reused readback buffers for an output — shared by the NDI and OMT sides, so only
// release once both senders for the id are gone. Off-main uses per-seq slotted keys, so release every slot.
function releaseReadbackResources(id: string) {
    if (NDI[id] || OMTS[id]) return
    try {
        const osr = loadOsrCapture()
        osr?.releasePool?.(id)
        const allocated = readbackSlots[id]?.next ?? 0
        for (let s = 0; s < allocated; s++) osr?.releasePool?.(`${id}#${s}`)
    } catch {
        // ignore
    }
    delete readbackSlots[id]
}

// OMT's send() returns the bytes written. With a receiver connected, 0 means the library dropped the
// frame (its encoder refused it): the receiver stays connected but never gets video. Count it and log
// the first offender's shape. With nobody connected 0 is the normal idle result.
function noteSendResult(senderData: Sender, id: string, frame: any, sent: unknown) {
    if (sent !== 0) return
    if (!((senderData.sender?.connections || 0) > 0)) return
    senderData.sendRejected = (senderData.sendRejected || 0) + 1
    if (senderData.rejectLogged) return
    senderData.rejectLogged = true
    console.error(`OMT sender ${id} rejected a video frame: ${frame.width}x${frame.height} stride=${frame.stride} codec=${frame.codec} flags=${frame.flags} bytes=${frame.data?.length}`)
}

async function sendQueuedVideoFrame(reg: { [id: string]: Sender }, id: string, doneType: string) {
    const senderData = reg[id]
    if (!senderData?.sender || senderData.sendingVideo) return

    const frame = senderData.pendingVideoFrame
    if (!frame) return

    // claim frame + meta ATOMICALLY (before any await) so a concurrent enqueue can't desync them
    const wasReal = senderData.pendingReal === true
    senderData.pendingVideoFrame = undefined
    senderData.pendingReal = undefined
    senderData.sendingVideo = true

    const sendT0 = process.env.FS_CAP_STATS ? Date.now() : 0
    try {
        noteSendResult(senderData, id, frame, await (senderData.sendFrame ? senderData.sendFrame(frame) : senderData.sender.video(frame)))
    } catch (err) {
        console.error("Error sending video frame:", err)
    } finally {
        if (sendT0) {
            senderData.sendMsSum = (senderData.sendMsSum || 0) + (Date.now() - sendT0)
            if (wasReal) senderData.sentReal = (senderData.sentReal || 0) + 1
            else senderData.sentRepeat = (senderData.sentRepeat || 0) + 1
        }
        senderData.sendingVideo = false
        // videoDone only drives the MAIN-path in-flight counter; the off-main capture path uses captureDone
        // instead, so posting videoDone for it just floods the main thread (~100 useless msgs/s at 2 outputs).
        if (!senderData.offMain) port.postMessage({ type: doneType, id })
        if (senderData.pendingVideoFrame) void sendQueuedVideoFrame(reg, id, doneType)
    }
}

// native BGRA->UYVY/UYVA converter from osr-capture (an order of magnitude faster than the JS loops
// below, which stay as a fallback for older builds / platforms without it). Loaded lazily in the worker.
let osrCaptureModule: any = null
function loadOsrCapture(): any {
    if (osrCaptureModule !== null) return osrCaptureModule
    try {
        const m = require("osr-capture")
        osrCaptureModule = typeof m?.convertBgraToUyvy === "function" ? m : false
    } catch {
        osrCaptureModule = false
    }
    return osrCaptureModule
}

// integer/fixed-point BGRA -> UYVY packed 4:2:2 (BT.601 full range, coefficients scaled by 256).
// Integer math + inline clamping avoids the per-pixel float work, which dominated the JS conversion time.
function bgraToUyvy(bgra: Buffer, width: number, height: number): Buffer {
    const out = Buffer.allocUnsafe(width * 2 * height)
    const rowIn = width * 4
    const rowOut = width * 2
    for (let y = 0; y < height; y++) {
        let si = y * rowIn
        let di = y * rowOut
        for (let x = 0; x < width; x += 2) {
            const b0 = bgra[si],
                g0 = bgra[si + 1],
                r0 = bgra[si + 2]
            const b1 = bgra[si + 4],
                g1 = bgra[si + 5],
                r1 = bgra[si + 6]
            let u = ((-43 * r0 - 85 * g0 + 128 * b0) >> 8) + 128
            let v = ((128 * r0 - 107 * g0 - 21 * b0) >> 8) + 128
            out[di] = u < 0 ? 0 : u > 255 ? 255 : u // U
            out[di + 1] = (77 * r0 + 150 * g0 + 29 * b0) >> 8 // Y0 (0..255, no clamp needed)
            out[di + 2] = v < 0 ? 0 : v > 255 ? 255 : v // V
            out[di + 3] = (77 * r1 + 150 * g1 + 29 * b1) >> 8 // Y1
            si += 8
            di += 4
        }
    }
    return out
}

// BGRA -> UYVA = UYVY colour plane (width*2*height) immediately followed by a full-res alpha plane
// (width*height). Keeps transparency while still skipping the SDK's BGRA->UYVY conversion.
function bgraToUyva(bgra: Buffer, width: number, height: number): Buffer {
    const uyvySize = width * 2 * height
    const out = Buffer.allocUnsafe(uyvySize + width * height)
    const rowIn = width * 4
    const rowUyvy = width * 2
    for (let y = 0; y < height; y++) {
        let si = y * rowIn
        let di = y * rowUyvy
        let ai = uyvySize + y * width
        for (let x = 0; x < width; x += 2) {
            const b0 = bgra[si],
                g0 = bgra[si + 1],
                r0 = bgra[si + 2],
                a0 = bgra[si + 3]
            const b1 = bgra[si + 4],
                g1 = bgra[si + 5],
                r1 = bgra[si + 6],
                a1 = bgra[si + 7]
            let u = ((-43 * r0 - 85 * g0 + 128 * b0) >> 8) + 128
            let v = ((128 * r0 - 107 * g0 - 21 * b0) >> 8) + 128
            out[di] = u < 0 ? 0 : u > 255 ? 255 : u // U
            out[di + 1] = (77 * r0 + 150 * g0 + 29 * b0) >> 8 // Y0
            out[di + 2] = v < 0 ? 0 : v > 255 ? 255 : v // V
            out[di + 3] = (77 * r1 + 150 * g1 + 29 * b1) >> 8 // Y1
            out[ai] = a0 // alpha px0
            out[ai + 1] = a1 // alpha px1
            si += 8
            di += 4
            ai += 2
        }
    }
    return out
}

// format: 0 = BGRA (convert here), 1 = UYVY (already converted, opaque), 2 = UYVA (already converted, alpha)
async function sendVideoBuffer(id: string, buffer: Buffer, { size, ratio, framerate, transparent, format = 0 }: { size: { width: number; height: number }; ratio: number; framerate: number; transparent: boolean; format?: number }) {
    const senderData = NDI[id]
    if (!senderData?.sender) return
    senderData.offMain = false

    const grandiose = await loadGrandiose()
    if (!grandiose) return

    // NDI's wire format is UYVY 4:2:2; sending it directly skips the SDK's (slow, esp. at 4K) BGRA->UYVY
    // conversion. If osr-capture already converted on the GPU (format 1/2) send as-is; otherwise convert the
    // BGRA here (native osr-capture, JS fallback) to UYVA (transparent) / UYVY (opaque).
    const useAlpha = transparent !== false
    let data: Buffer
    let fourCC: number
    if (format === 2 || format === 1) {
        data = buffer
        fourCC = format === 2 ? grandiose.FOURCC_UYVA : grandiose.FOURCC_UYVY
    } else {
        const osr = loadOsrCapture()
        if (useAlpha) {
            data = osr ? osr.convertBgraToUyva(buffer, size.width, size.height) : bgraToUyva(buffer, size.width, size.height)
            fourCC = grandiose.FOURCC_UYVA
        } else {
            data = osr ? osr.convertBgraToUyvy(buffer, size.width, size.height) : bgraToUyvy(buffer, size.width, size.height)
            fourCC = grandiose.FOURCC_UYVY
        }
    }

    // main-path frames are always real; count the loss if we overwrite a pending unsent real frame
    if (senderData.pendingVideoFrame && senderData.pendingReal) senderData.coalescedReal = (senderData.coalescedReal || 0) + 1
    senderData.pendingReal = true
    senderData.pendingVideoFrame = {
        timecode: (timeStart + process.hrtime.bigint()) / TIMECODE_DIVISOR,
        xres: size.width,
        yres: size.height,
        frameRateN: framerate * 1000,
        frameRateD: 1000,
        pictureAspectRatio: ratio,
        frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE,
        lineStrideBytes: size.width * 2,
        fourCC,
        data
    }

    void sendQueuedVideoFrame(NDI, id, "videoDone")
}

function mapOmtQuality(omt: any, quality?: number | string): number {
    if (typeof quality === "number") return quality
    const q = omt.Quality
    switch (String(quality || "").toLowerCase()) {
        case "low":
            return q.Low
        case "medium":
            return q.Medium
        case "high":
            return q.High
        default:
            return q.Default
    }
}

async function createOmtSender(id: string, name: string, quality?: number | string) {
    // replacing a live sender (a quality change): let the old one's socket and discovery registration
    // go away first, so the replacement rebinds the same port and receivers find it again
    const replacing = !!OMTS[id]
    if (replacing) stopOmtSender(id)
    if (replacing) await new Promise((resolve) => setTimeout(resolve, 250))

    OMTS[id] = { name }
    console.info("OMT - creating sender: " + name)

    try {
        const omt = await loadOMT()
        if (!omt) {
            delete OMTS[id]
            port.postMessage({ type: "createFailedOmt", id })
            return
        }

        const sender = new omt.Sender(name, mapOmtQuality(omt, quality))

        // destroyOmt arriving while the create was in progress: destroy instead of leaking
        if (!OMTS[id]) {
            try {
                sender.destroy()
            } catch {}
            return
        }

        OMTS[id].sender = sender
        // the encode runs on the thread pool, so this worker stays free for the readback pipeline and
        // several senders encode in parallel; the sync send is the fallback for an older addon
        const sendAsync = typeof sender.sendAsync === "function"
        OMTS[id].sendFrame = sendAsync ? (frame: any) => sender.sendAsync(frame) : (frame: any) => sender.send(frame)
        OMTS[id].sendAudio = sendAsync ? (frame: any) => sender.sendAsync(frame) : (frame: any) => sender.send(frame)
        OMTS[id].tsKey = "timestamp"
    } catch (err) {
        console.error("Could not create OMT sender:", err)
        delete OMTS[id]
        port.postMessage({ type: "createFailedOmt", id })
        return
    }

    OMTS[id].timer = setInterval(() => {
        if (!OMTS[id]?.sender) return
        const conns: number = OMTS[id].sender?.connections || 0
        OMTS[id].status = conns > 0 ? "connected" : "unconnected"

        const newStatus = String(OMTS[id].status) + conns.toString()
        if (newStatus !== OMTS[id].previousStatus) {
            port.postMessage({ type: "statusOmt", id, status: OMTS[id].status, connections: conns })
            OMTS[id].previousStatus = newStatus
            if (OMTS[id].status === "connected") console.log(`[OMT] Reconnected for ${id}`)
        }
    }, CONNECTION_POLL_INTERVAL_MS)
}

function stopOmtSender(id: string) {
    if (!OMTS[id]) return
    console.info("OMT - stopping sender: " + (OMTS[id].name || id))
    if (OMTS[id].timer) clearInterval(OMTS[id].timer)

    if (OMTS[id].sender) {
        try {
            OMTS[id].sender.destroy()
        } catch (err) {
            console.error("ERROR", err)
        }
    }

    const s = OMTS[id]
    if (s.paceTimer) clearTimeout(s.paceTimer)
    for (const entry of s.paceQueue || []) releasePacerRef(entry.pbuf)
    s.paceQueue = []
    if (s.lastPace) {
        releasePacerRef(s.lastPace.pbuf)
        s.lastPace = undefined
    }
    delete pacerPools[`omt#${id}`]
    delete OMTS[id]
    releaseReadbackResources(id)
}

// builds the OMT video frame template (the timestamp is re-stamped at send time by the pacer/queue)
// format: 0 = BGRA, 1 = UYVY, 2 = UYVA (the readback formats osr-capture produces). YUV costs half the
// bytes of BGRA over the bus and is what the encoder wants anyway, so it is the normal case.
function makeOmtVideoFrame(omt: any, buffer: Buffer, size: { width: number; height: number }, ratio: number, framerate: number, transparent: boolean, format: number) {
    const uyvy = format === 1 || format === 2
    const hasAlpha = format === 2 || (format === 0 && transparent)
    return {
        type: omt.FrameType.Video,
        timestamp: (timeStart + process.hrtime.bigint()) / TIMECODE_DIVISOR,
        codec: uyvy ? (format === 2 ? omt.Codec.UYVA : omt.Codec.UYVY) : omt.Codec.BGRA,
        width: size.width,
        height: size.height,
        stride: size.width * (uyvy ? 2 : 4),
        flags: hasAlpha ? omt.VideoFlags.Alpha : omt.VideoFlags.None,
        frameRateN: Math.round(framerate * 1000),
        frameRateD: 1000,
        aspectRatio: ratio,
        colorSpace: omt.ColorSpace.Undefined,
        data: buffer
    }
}

// main-path OMT video (mixed outputs that stay on the main capture path): latest-wins pending slot
async function sendOmtVideoBuffer(id: string, buffer: Buffer, { size, ratio, framerate, transparent, format = 0 }: { size: { width: number; height: number }; ratio: number; framerate: number; transparent: boolean; format?: number }) {
    const senderData = OMTS[id]
    if (!senderData?.sender) return
    senderData.offMain = false

    const omt = await loadOMT()
    if (!omt) return

    if (senderData.pendingVideoFrame && senderData.pendingReal) senderData.coalescedReal = (senderData.coalescedReal || 0) + 1
    senderData.pendingReal = true
    senderData.pendingVideoFrame = makeOmtVideoFrame(omt, buffer, size, ratio, framerate, transparent, format)

    void sendQueuedVideoFrame(OMTS, id, "videoDoneOmt")
}

// broadcast planar Float32 (FPA1) audio to every OMT sender, via each sender's serial audio queue
async function sendOmtAudioBuffer(buffer: Buffer, { sampleRate, channelCount }: { sampleRate: number; channelCount: number }) {
    const hasSender = Object.values(OMTS).some((s) => s?.sender)
    if (!hasSender || !buffer || buffer.length === 0) return

    const omt = await loadOMT()
    if (!omt) return

    const samplesPerChannel = Math.trunc(buffer.byteLength / channelCount / BYTES_PER_FLOAT32)
    if (samplesPerChannel <= 0) return

    const frame = {
        type: omt.FrameType.Audio,
        timestamp: (timeStart + process.hrtime.bigint()) / TIMECODE_DIVISOR,
        codec: omt.Codec.FPA1,
        sampleRate,
        channels: channelCount,
        samplesPerChannel,
        data: buffer
    }

    Object.keys(OMTS).forEach((id) => {
        const senderData = OMTS[id]
        if (!senderData?.sender) return

        if (!senderData.audioQueue) senderData.audioQueue = []
        senderData.audioQueue.push({ ...frame })
        void sendQueuedAudioFrame(OMTS, id)
    })
}
// ---- end OMT ---------------------------------------------------------------------------------------------

// Pool of readback slots per output
const readbackSlots: { [id: string]: { free: number[]; next: number } } = {}
function acquireReadbackSlot(id: string): number {
    const pool = (readbackSlots[id] ||= { free: [], next: 0 })
    return pool.free.length ? pool.free.pop()! : pool.next++
}
function releaseReadbackSlot(id: string, slot: number) {
    const pool = (readbackSlots[id] ||= { free: [], next: 0 })
    if (!pool.free.includes(slot)) pool.free.push(slot)
}

// Send-side pacer: ensures frames are dispatched to NDI at steady intervals.
// Holds queued frames in refcounted recycled buffers and sends repeats if no new frame arrives in time.
type PacerBuf = { buf: Buffer; refs: number; owner: string }
const pacerPools: { [rendererId: string]: Buffer[] } = {}
function acquirePacerBuf(owner: string, length: number): PacerBuf {
    const pool = (pacerPools[owner] ||= [])
    const idx = pool.findIndex((b) => b.byteLength === length)
    if (idx >= 0) return { buf: pool.splice(idx, 1)[0], refs: 0, owner }
    pool.length = 0
    return { buf: Buffer.allocUnsafe(length), refs: 0, owner }
}
function releasePacerRef(pb: PacerBuf) {
    pb.refs--
    if (pb.refs > 0) return
    const pool = pacerPools[pb.owner]
    if (pool && !pool.includes(pb.buf)) pool.push(pb.buf)
}

// BGRA -> planar I420 (BT.601 limited range), the CPU path for platforms whose GPU readback has no I420 target
function bgraToI420(bgra: Buffer, w: number, h: number): Buffer {
    const cw = Math.floor(w / 2)
    const ch = Math.floor(h / 2)
    const out = Buffer.allocUnsafe(w * h + 2 * cw * ch)
    const uOff = w * h
    const vOff = uOff + cw * ch
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4
            const b = bgra[i]
            const g = bgra[i + 1]
            const r = bgra[i + 2]
            out[y * w + x] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16
        }
    }
    for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
            let r = 0
            let g = 0
            let b = 0
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    const i = ((cy * 2 + dy) * w + cx * 2 + dx) * 4
                    b += bgra[i]
                    g += bgra[i + 1]
                    r += bgra[i + 2]
                }
            }
            r >>= 2
            g >>= 2
            b >>= 2
            out[uOff + cy * cw + cx] = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128
            out[vOff + cy * cw + cx] = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128
        }
    }
    return out
}

function startPacer(reg: { [id: string]: Sender }, id: string) {
    const s = reg[id]
    if (!s || s.paceTimer) return
    s.paceNextDue = Date.now() + (s.paceInterval || 1000 / 30)
    schedulePaceTick(reg, id)
}
function schedulePaceTick(reg: { [id: string]: Sender }, id: string) {
    const s = reg[id]
    if (!s) return
    const delay = Math.max(0, (s.paceNextDue || 0) - Date.now())
    s.paceTimer = setTimeout(() => {
        const sd = reg[id]
        if (!sd) return // stopped
        const interval = sd.paceInterval || 1000 / 30
        sd.paceNextDue = (sd.paceNextDue || Date.now()) + interval
        if (sd.paceNextDue < Date.now()) sd.paceNextDue = Date.now() + interval // resync, don't burst
        paceTick(reg, id)
        schedulePaceTick(reg, id)
    }, delay)
}

// Every send belongs to a slot on the sender's nominal timeline (one per pace interval) and carries
// that slot's time as its timestamp, so the receiver sees an even timeline even when an encode finishes
// late. schedulePaceTick advances paceNextDue before calling paceTick, so this tick's slot is one
// interval back.
function paceTick(reg: { [id: string]: Sender }, id: string) {
    const s = reg[id]
    if (!s?.sender) return
    const slot = (s.paceNextDue || Date.now()) - (s.paceInterval || 1000 / 30)
    if (s.sendingVideo) {
        s.paceBusy = (s.paceBusy || 0) + 1
        s.pendingSlot = slot // the waiting frame is owed this slot; paceSend's completion sends it
        return
    }
    s.pendingSlot = undefined
    const entry = s.paceQueue?.shift()
    if (entry) {
        void paceSend(reg, id, entry, true, slot)
        return
    }
    if (s.lastPace) {
        s.paceMisses = (s.paceMisses || 0) + 1
        s.lastPace.pbuf.refs++
        void paceSend(reg, id, s.lastPace, false, slot)
    }
}

// slotMs (Date.now() epoch) -> the protocols' 100ns-since-epoch timestamp
function slotTimestamp(slotMs: number): bigint {
    return BigInt(Math.round(slotMs)) * BigInt(10000)
}

async function paceSend(reg: { [id: string]: Sender }, id: string, entry: { frame: any; pbuf: PacerBuf }, real: boolean, slotMs: number) {
    const senderData = reg[id]
    if (!senderData?.sender) {
        releasePacerRef(entry.pbuf)
        return
    }
    senderData.sendingVideo = true
    if (real) {
        const now = Date.now()
        if (process.env.FS_CAP_STATS && senderData.lastRealSendAt) (senderData.realGaps ||= []).push(now - senderData.lastRealSendAt)
        senderData.lastRealSendAt = now
    }
    const frame = { ...entry.frame, [senderData.tsKey || "timecode"]: slotTimestamp(slotMs) }
    const sendT0 = process.env.FS_CAP_STATS ? Date.now() : 0
    try {
        noteSendResult(senderData, id, frame, await (senderData.sendFrame ? senderData.sendFrame(frame) : senderData.sender.video(frame)))
    } catch (err) {
        console.error("Error sending video frame:", err)
    } finally {
        if (sendT0) {
            senderData.sendMsSum = (senderData.sendMsSum || 0) + (Date.now() - sendT0)
            if (real) senderData.sentReal = (senderData.sentReal || 0) + 1
            else senderData.sentRepeat = (senderData.sentRepeat || 0) + 1
        }
        senderData.sendingVideo = false
        releasePacerRef(entry.pbuf)
        // a tick found this sender busy and left its frame waiting: send it now, stamped with the slot
        // it was owed, rather than idling until the next tick (the timeline stays even; only arrival is late)
        const owed = senderData.pendingSlot
        if (owed !== undefined && senderData.paceQueue?.length) {
            senderData.pendingSlot = undefined
            const next = senderData.paceQueue.shift()!
            void paceSend(reg, id, next, true, owed)
        }
    }
}

async function captureAndSend(id: string, source: any, opts: { size: { width: number; height: number }; ratio: number; framerate: number; memberFramerates?: { [id: string]: number }; format: number; mainFormat?: number; transparent?: boolean; dstW?: number; dstH?: number; seq?: number; members?: string[]; depth?: number; omt?: boolean; omtFramerate?: number; omtMembers?: string[]; omtFramerates?: { [id: string]: number }; targets?: { width: number; height: number; format: number }[]; memberTarget?: { [id: string]: number }; memberFormats?: { [id: string]: number }; memberSizes?: { [id: string]: { width: number; height: number } }; cpuTargets?: boolean; rtmpMembers?: { [id: string]: { width: number; height: number } }; bmdMembers?: { [id: string]: { width: number; height: number; format: number; framerate: number } }; webrtcMembers?: { [id: string]: { width: number; height: number } } }) {
    // seq identifies this in-flight capture; the osr-capture key is slotted so concurrent readbacks
    // for one output use independent pool entries
    const seq = opts.seq ?? 0
    const senderData = NDI[id]
    const osr = loadOsrCapture()
    const membersAll = opts.members?.length ? opts.members : [id]
    const ndiMembers = membersAll.filter((m) => NDI[m]?.sender)
    const omtMembers = (opts.omtMembers?.length ? opts.omtMembers : opts.omt ? [id] : []).filter((m) => OMTS[m]?.sender)
    const grandiose = ndiMembers.length ? await loadGrandiose() : null
    const hasNdi = ndiMembers.length > 0 && !!grandiose
    const hasOmt = omtMembers.length > 0
    const rtmpMembers = Object.keys(opts.rtmpMembers || {}).filter((m) => RtmpStreamer.isRunning(m))
    const hasRtmp = rtmpMembers.length > 0
    const bmdMembers = Object.keys(opts.bmdMembers || {}).filter((m) => !!BlackmagicSender.playbackData[m]?.playback)
    const hasBmd = bmdMembers.length > 0
    const webrtcMembers = Object.keys(opts.webrtcMembers || {})
    const hasWebrtc = webrtcMembers.length > 0
    if ((!hasNdi && !hasOmt && !hasRtmp && !hasBmd && !hasWebrtc) || !osr?.readback) {
        port.postMessage({ type: "releaseTexture", id, seq })
        port.postMessage({ type: "captureDone", id, seq })
        return
    }
    const { size, ratio, framerate, format, dstW = 0, dstH = 0 } = opts
    // FS_CAP_STATS: per-frame hop timestamps posted back with captureDone (worker_threads share the
    const tl = process.env.FS_CAP_STATS ? { recv: Date.now(), cS: 0, cE: 0, fS: 0, fE: 0, enq: 0 } : null
    const members = membersAll
    const wantScaled = dstW > 0 && dstH > 0
    const slot = acquireReadbackSlot(id)
    const rbKey = `${id}#${slot}`
    if (senderData) senderData.offMain = true
    for (const m of omtMembers) OMTS[m]!.offMain = true
    // the live frame this output is showing, composited under the page by the addon
    const layer = videoLayers[id]
    const layerBuf = layer?.current && layer.width && layer.height ? layer.current : null
    const video = layerBuf ? { width: layer!.width, height: layer!.height, format: layer!.format, data: layerBuf.buf.subarray(0, layerBuf.bytes) } : null
    if (layerBuf) layerBuf.inUse = true

    const twoPhase = typeof osr.readbackConsume === "function" && typeof osr.readbackFinish === "function"
    const singleDispatch = !twoPhase && typeof osr.readbackOnce === "function"
    let textureReleased = false
    const releaseTexture = () => {
        if (textureReleased) return
        textureReleased = true
        port.postMessage({ type: "releaseTexture", id, seq })
    }
    // Every member sends at its own size and format. Full-size members in the main format share the main
    // readback buffer; each other (size, format) gets a target: produced on the GPU in the same pass when the
    // addon supports it, else derived on this thread from a BGRA main. All buffers are refcounted pacer
    // buffers: the addon writes straight into them and no frame is copied here on the GPU path.
    const targets = opts.targets || []
    const mainFormat = opts.mainFormat ?? format
    const bytesFor = (w: number, h: number, f: number) => (f === 1 ? w * h * 2 : f === 2 ? w * h * 3 : f === 4 ? w * h + 2 * (Math.floor(w / 2) * Math.floor(h / 2)) : w * h * 4)
    const gpuTargets = twoPhase && targets.length > 0 && !opts.cpuTargets && !!osr.targetsSupported
    const framePbuf = twoPhase ? acquirePacerBuf(id, bytesFor(size.width, size.height, format)) : null
    const targetPbufs: PacerBuf[] = gpuTargets ? targets.map((t, i) => acquirePacerBuf(`${id}#t${i}`, bytesFor(t.width, t.height, t.format))) : []
    const heldBufs: PacerBuf[] = [] // every pacer buffer this frame took; unqueued ones go back to their pools
    if (framePbuf) heldBufs.push(framePbuf)
    heldBufs.push(...targetPbufs)
    const queued = new Set<PacerBuf>()
    try {
        let buffer: Buffer
        let scaled: Buffer | undefined
        if (singleDispatch) {
            if (tl) tl.cS = Date.now()
            const onRelease = () => {
                if (tl && !tl.cE) tl.cE = tl.fS = Date.now()
                releaseTexture()
            }
            const res = await osr.readbackOnce(source, size.width, size.height, format, rbKey, wantScaled ? dstW : 0, wantScaled ? dstH : 0, onRelease)
            if (tl) {
                tl.fE = Date.now()
                if (!tl.cE) tl.cE = tl.fS = tl.fE
            }
            releaseTexture()
            if (wantScaled && res && res.main) {
                buffer = res.main
                scaled = res.scaled
            } else {
                buffer = res
            }
        } else if (twoPhase) {
            if (tl) tl.cS = Date.now()
            await osr.readbackConsume(source, size.width, size.height, format, rbKey, wantScaled ? dstW : 0, wantScaled ? dstH : 0, gpuTargets ? targets : undefined, video || undefined)
            if (video && !videoLayerReported.has(id)) {
                videoLayerReported.add(id)
                port.postMessage({ type: "videoLayerActive", id })
            }
            if (tl) tl.cE = Date.now()
            releaseTexture()
            if (tl) tl.fS = Date.now()
            const res = await osr.readbackFinish(rbKey, size.width, size.height, format, wantScaled ? dstW : 0, wantScaled ? dstH : 0, framePbuf!.buf, gpuTargets ? targets : undefined, gpuTargets ? targetPbufs.map((p) => p.buf) : undefined)
            if (tl) tl.fE = Date.now()
            if (res && res.main) {
                buffer = res.main
                scaled = res.scaled
            } else {
                buffer = res
            }
        } else {
            if (tl) tl.cS = Date.now()
            buffer = await osr.readback(source, size.width, size.height, format, rbKey)
            if (tl) tl.cE = tl.fS = tl.fE = Date.now()
            releaseTexture()
        }

        if (scaled && scaled.length) {
            port.postMessage({ type: "scaledFrame", id, members, buffer: scaled.buffer, byteOffset: scaled.byteOffset, byteLength: scaled.byteLength, size: { width: dstW, height: dstH } })
        }

        const tFan = performance.now()
        type FrameBuf = { pbuf: PacerBuf; width: number; height: number; format: number }
        const convertBgra = (bgra: Buffer, w: number, h: number, f: number): Buffer => {
            if (f === 2) return osr.convertBgraToUyva ? osr.convertBgraToUyva(bgra, w, h) : bgraToUyva(bgra, w, h)
            if (f === 1) return osr.convertBgraToUyvy ? osr.convertBgraToUyvy(bgra, w, h) : bgraToUyvy(bgra, w, h)
            if (f === 4) return bgraToI420(bgra, w, h)
            return bgra
        }
        const intoPacerBuf = (owner: string, data: Buffer): PacerBuf => {
            const tCopy = performance.now()
            const pb = acquirePacerBuf(owner, data.length)
            data.copy(pb.buf, 0, 0, data.length)
            loopDiag.copyMs += performance.now() - tCopy
            loopDiag.copyN++
            heldBufs.push(pb)
            return pb
        }

        // main buffer, in the format full-size members send in
        let main: FrameBuf
        if (format === 0 && mainFormat !== 0) {
            // CPU-target path (or legacy single-phase): the readback is BGRA; convert once for the full-size members
            main = { pbuf: intoPacerBuf(`${id}#m`, convertBgra(buffer, size.width, size.height, mainFormat)), width: size.width, height: size.height, format: mainFormat }
        } else if (framePbuf && buffer === framePbuf.buf) {
            main = { pbuf: framePbuf, width: size.width, height: size.height, format }
        } else {
            main = { pbuf: intoPacerBuf(id, buffer), width: size.width, height: size.height, format }
        }

        // per-target buffers
        const targetBufs: FrameBuf[] = []
        if (gpuTargets) {
            targets.forEach((t, i) => targetBufs.push({ pbuf: targetPbufs[i], width: t.width, height: t.height, format: t.format }))
        } else if (targets.length && format === 0 && typeof osr.downscaleBgra === "function") {
            for (const t of targets) {
                const small: Buffer = osr.downscaleBgra(buffer, size.width, size.height, t.width, t.height)
                targetBufs.push({ pbuf: intoPacerBuf(`${id}#t`, convertBgra(small, t.width, t.height, t.format)), width: t.width, height: t.height, format: t.format })
            }
        }
        const bufFor = (m: string): FrameBuf => {
            const ti = opts.memberTarget?.[m] ?? -1
            return ti >= 0 && targetBufs[ti] ? targetBufs[ti] : main
        }
        const enqueue = (reg: { [id: string]: Sender }, m: string, frame: any, pbuf: PacerBuf, interval: number) => {
            const md = reg[m]!
            md.offMain = true
            md.paceInterval = interval
            if (md.paceTimer && md.paceNextDue && md.paceNextDue > Date.now() + md.paceInterval) {
                clearTimeout(md.paceTimer)
                md.paceTimer = undefined
                startPacer(reg, m)
            }
            md.paceCap = Math.max(2, (opts.depth ?? 1) + 1)
            const queue = (md.paceQueue ||= [])
            while (queue.length >= md.paceCap) {
                const dropped = queue.shift()!
                releasePacerRef(dropped.pbuf)
                md.coalescedReal = (md.coalescedReal || 0) + 1
            }
            pbuf.refs++ // queue entry's ref
            queue.push({ frame, pbuf })
            pbuf.refs++ // lastPace pin's ref (repeats only fire when the queue is empty, i.e. this
            if (md.lastPace) releasePacerRef(md.lastPace.pbuf) // frame has already been sent or dropped)
            md.lastPace = { frame, pbuf }
            queued.add(pbuf)
            startPacer(reg, m)
        }

        if (hasNdi) {
            for (const m of ndiMembers) {
                let b = bufFor(m)
                if (b.format === 0) {
                    // NDI never takes BGRA: convert this member's buffer (only reachable on the legacy readback path)
                    const f = opts.transparent !== false ? 2 : 1
                    b = { pbuf: intoPacerBuf(`${id}#ndi`, convertBgra(b.pbuf.buf, b.width, b.height, f)), width: b.width, height: b.height, format: f }
                }
                const mfr = Math.max(1, opts.memberFramerates?.[m] || framerate)
                NDI[m]!.tsKey ||= "timecode"
                const frame = {
                    timecode: (timeStart + process.hrtime.bigint()) / TIMECODE_DIVISOR,
                    xres: b.width,
                    yres: b.height,
                    frameRateN: mfr * 1000,
                    frameRateD: 1000,
                    pictureAspectRatio: b.height ? b.width / b.height : ratio,
                    frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE,
                    lineStrideBytes: b.width * 2,
                    fourCC: b.format === 2 ? grandiose.FOURCC_UYVA : grandiose.FOURCC_UYVY,
                    data: b.pbuf.buf
                }
                enqueue(NDI, m, frame, b.pbuf, 1000 / mfr)
            }
        }

        if (hasOmt) {
            const omt = await loadOMT()
            if (omt) {
                for (const m of omtMembers) {
                    const b = bufFor(m)
                    const ofr = Math.max(1, opts.omtFramerates?.[m] || opts.omtFramerate || framerate)
                    const frame = makeOmtVideoFrame(omt, b.pbuf.buf, { width: b.width, height: b.height }, b.height ? b.width / b.height : ratio, ofr, opts.transparent !== false, b.format)
                    enqueue(OMTS, m, frame, b.pbuf, 1000 / ofr)
                }
            }
        }
        // RTMP: ffmpeg takes a planar I420 frame at the broadcast size (1.5 bytes/px, no swscale in the
        // encoder). The engine borrows the pacer buffer (one ref) and releases it when a newer frame
        // replaces it, so no copy is made on this thread
        for (const m of rtmpMembers) {
            const want = opts.rtmpMembers![m]
            const ti = targetBufs.findIndex((t) => t.width === want.width && t.height === want.height && (t.format === 4 || t.format === 0))
            const b = ti >= 0 ? targetBufs[ti] : main.format === 0 && main.width === want.width && main.height === want.height ? main : null
            if (!b) continue
            const pb = b.pbuf
            const bytes = bytesFor(b.width, b.height, b.format)
            pb.refs++
            queued.add(pb)
            RtmpStreamer.updateFrame(m, pb.buf.length === bytes ? pb.buf : pb.buf.subarray(0, bytes), { width: b.width, height: b.height }, () => releasePacerRef(pb), b.format === 4 ? "yuv420p" : "bgra")
        }
        // WebRTC: the host window draws a BGRA frame at the output's size, served over shared memory
        // (FrameServer); the server holds a pacer reference while it keeps or copies the frame
        if (hasWebrtc) {
            const server = webrtcFrames()
            const now = Date.now()
            for (const m of webrtcMembers) {
                const want = opts.webrtcMembers![m]
                const ti = targetBufs.findIndex((t) => t.width === want.width && t.height === want.height && t.format === 0)
                const b = ti >= 0 ? targetBufs[ti] : main.format === 0 && main.width === want.width && main.height === want.height ? main : null
                if (!b) continue
                const bytes = bytesFor(b.width, b.height, 0)
                const frame: ServedFrame = { xres: b.width, yres: b.height, format: "bgra", data: b.pbuf.buf.length === bytes ? b.pbuf.buf : b.pbuf.buf.subarray(0, bytes) }
                servedPacer.set(frame, b.pbuf)
                // the buffer is the server's to release once it retained it; without a window it stays
                // unqueued and returns to its pool below
                server.deliver(m, "WEBRTC", m, frame, now)
                if (b.pbuf.refs > 0) queued.add(b.pbuf)
            }
        }
        // Blackmagic: the card's scheduler retains what it is given, so it gets its own copy of the frame at
        // the card's mode (UYVY straight in when the card takes it raw, else BGRA converted by the sender)
        for (const m of bmdMembers) {
            const want = opts.bmdMembers![m]
            if (!BlackmagicSender.canAcceptFrame(m)) continue
            const ti = targetBufs.findIndex((t) => t.width === want.width && t.height === want.height && t.format === want.format)
            const b = ti >= 0 ? targetBufs[ti] : main.width === want.width && main.height === want.height && main.format === want.format ? main : null
            if (!b) continue
            const bytes = bytesFor(b.width, b.height, b.format)
            const marker = BlackmagicSender.audioQueueLength > 0 ? BMD_AUDIO_MARKER : null
            BlackmagicSender.scheduleFrame(m, Buffer.from(b.pbuf.buf.subarray(0, bytes)), marker, want.framerate, b.format === 1)
        }
        loopDiag.fanMs += performance.now() - tFan
        if (tl) tl.enq = Date.now() // pacer enqueue complete (memcpy + fan-out done) — nonzero = clean path
    } catch (err) {
        console.error("Worker readback error:", err)
    } finally {
        // buffers no member queued (error, or a target/main nobody used): return them to their pools
        for (const pb of heldBufs) {
            if (queued.has(pb) || pb.refs !== 0) continue
            const pool = pacerPools[pb.owner]
            if (pool && !pool.includes(pb.buf)) pool.push(pb.buf)
        }
        if (layerBuf) layerBuf.inUse = false
        releaseTexture() // safety: ensure the texture is released even on error
        releaseReadbackSlot(id, slot)
        // capture fully done -> this pipeline slot frees (main may forward another frame for this output)
        port.postMessage({ type: "captureDone", id, seq, tl })
    }
}

// ---- audio -----------------------------------------------------------------------------------------------
// Buffers arrive already as planar/float32/little-endian PCM (the renderer converts); frames carry no
// timecode and NDI stamps them at send time. Each sender has its own FIFO audioQueue drained by a serial
// send loop, with a hard cap so a stalled sender can't accumulate unbounded memory/latency.
async function sendQueuedAudioFrame(reg: { [id: string]: Sender }, id: string) {
    const senderData = reg[id]
    if (!senderData?.sender || senderData.sendingAudio) return

    senderData.sendingAudio = true

    try {
        while (senderData.audioQueue && senderData.audioQueue.length > 0) {
            if (!reg[id]?.sender) break

            // Limit queue to prevent excessive memory/latency if sending is falling behind
            if (senderData.audioQueue.length > 50) {
                senderData.audioQueue.splice(0, senderData.audioQueue.length - 20)
            }

            const frame = senderData.audioQueue.shift()
            if (frame) {
                await (senderData.sendAudio ? senderData.sendAudio(frame) : senderData.sender.audio(frame))
            }
        }
    } catch (err) {
        console.error("Error sending audio frame:", err)
    } finally {
        senderData.sendingAudio = false
        if (reg[id]?.sender && senderData.audioQueue && senderData.audioQueue.length > 0) {
            void sendQueuedAudioFrame(reg, id)
        }
    }
}

async function makeAudioFrame(buffer: Buffer, sampleRate: number, channelCount: number) {
    if (!buffer || buffer.length === 0) return null

    const grandiose = await loadGrandiose()
    if (!grandiose) return null

    const noSamples = Math.trunc(buffer.length / (channelCount * BYTES_PER_FLOAT32))
    if (noSamples <= 0) return null

    return {
        sampleRate,
        noChannels: channelCount,
        noSamples,
        channelStrideBytes: noSamples * BYTES_PER_FLOAT32,
        fourCC: grandiose.FOURCC_FLTp,
        data: buffer
    }
}

async function sendAudioBufferTarget(id: string, buffer: Buffer, { sampleRate, channelCount }: { sampleRate: number; channelCount: number }) {
    const senderData = NDI[id]
    if (!senderData?.sender) return

    const frame = await makeAudioFrame(buffer, sampleRate, channelCount)
    if (!frame || !NDI[id]?.sender) return

    if (!senderData.audioQueue) senderData.audioQueue = []
    senderData.audioQueue.push(frame)
    void sendQueuedAudioFrame(NDI, id)
}

async function sendAudioBuffer(buffer: Buffer, { sampleRate, channelCount }: { sampleRate: number; channelCount: number }) {
    const hasSender = Object.values(NDI).some((s) => s?.sender)
    if (!hasSender) return

    const frame = await makeAudioFrame(buffer, sampleRate, channelCount)
    if (!frame) return

    Object.keys(NDI).forEach((id) => {
        const senderData = NDI[id]
        if (!senderData?.sender) return

        if (!senderData.audioQueue) senderData.audioQueue = []
        senderData.audioQueue.push({ ...frame })
        void sendQueuedAudioFrame(NDI, id)
    })
}
// ---- end audio -------------------------------------------------------------------------------------------

// This thread carries every sender: an unhandled error from one child process or callback must not
// take all outputs down with it. Log it and keep running.
process.on("uncaughtException", (err) => console.error("[capture worker] uncaught exception:", err))
process.on("unhandledRejection", (err) => console.error("[capture worker] unhandled rejection:", err))

// RTMP engine lives here (RtmpBridge on main proxies control and mirrors status)
setRtmpStatusListener((outputId, destinations) => port.postMessage({ type: "rtmpStatus", outputId, destinations }))
setRtmpNoticeListener((message) => port.postMessage({ type: "rtmpNotice", message }))
const rtmpStopWatch = new Set<string>()
setInterval(() => {
    // the engine stops on its own when destinations vanish or the encoder gives up: tell main
    for (const id of [...rtmpStopWatch]) {
        if (RtmpStreamer.isRunning(id)) continue
        rtmpStopWatch.delete(id)
        port.postMessage({ type: "rtmpStopped", outputId: id })
    }
}, 1000)

// Live input composited into a captured output: the frame comes straight from the receive process over
// the same shared-memory transport the windows use, and osr-capture blends it under the captured page in
// the convert pass. That keeps the video out of the browser's GPU thread, which is what caps a 4K60 input
// at about half rate when the page uploads it.
type VideoBuf = { buf: Buffer; bytes: number; inUse: boolean }
type VideoLayerState = { bufs: VideoBuf[]; current: VideoBuf | null; width: number; height: number; format: number; ws: any; ring: { name: string; slotBytes: number } | null }
const videoLayers: { [outputId: string]: VideoLayerState } = {}
// outputs whose page has been told the composite is running (so it can stop drawing the frame itself)
const videoLayerReported = new Set<string>()
const VIDEO_BUFS = 3

function connectVideoSource(targetId: string, outputId: string, wsPort: number, token: string) {
    const osr = loadOsrCapture()
    if (!osr || typeof osr.shmReadAsync !== "function" || !osr.videoLayerSupported) return
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WebSocket = require("ws")
    const existing = videoLayers[outputId]
    try {
        existing?.ws?.close()
    } catch {}
    const state: VideoLayerState = { bufs: [], current: null, width: 0, height: 0, format: 0, ws: null, ring: null }
    videoLayers[outputId] = state
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`)
    state.ws = ws
    ws.on("open", () => ws.send(JSON.stringify({ token, targetId, shm: true })))
    ws.on("message", (raw: any, isBinary: boolean) => {
        if (isBinary) return
        let header: any = null
        try {
            header = JSON.parse(raw.toString())
        } catch {
            return
        }
        if (!header || header.slot === undefined) return
        const done = () => {
            try {
                ws.send("1:" + header.slot)
            } catch {}
        }
        if (header.shm && header.shm.name !== state.ring?.name) {
            try {
                if (state.ring) osr.shmUnmap(state.ring.name)
                osr.shmMap(header.shm.name, header.shm.slotBytes * header.shm.slots, false)
                state.ring = { name: header.shm.name, slotBytes: header.shm.slotBytes }
            } catch {
                state.ring = null
            }
        }
        // every format the receive process produces composites; anything else stays with the page's draw
        const format = header.format === "uyvy" ? 1 : header.format === "bgra" ? 0 : header.format === "rgba" ? 3 : -1
        if (!state.ring || format < 0) return done()

        let slot = state.bufs.find((b) => !b.inUse && b.buf.length >= header.bytes)
        if (!slot && state.bufs.length < VIDEO_BUFS) {
            slot = { buf: Buffer.allocUnsafeSlow(header.bytes), bytes: 0, inUse: false }
            state.bufs.push(slot)
        }
        if (!slot) return done() // every buffer is in a readback: drop this frame, the next one is close
        const target = slot
        target.inUse = true
        osr.shmReadAsync(state.ring.name, header.slot * state.ring.slotBytes, target.buf.subarray(0, header.bytes)).then(
            () => {
                target.bytes = header.bytes
                target.inUse = false
                state.width = header.xres
                state.height = header.yres
                state.format = format
                state.current = target
                done()
            },
            () => {
                target.inUse = false
                done()
            }
        )
    })
    ws.on("close", () => {
        videoLayerReported.delete(outputId)
        port.postMessage({ type: "videoLayerActive", id: outputId, active: false })
        if (videoLayers[outputId] === state) {
            try {
                if (state.ring) osr.shmUnmap(state.ring.name)
            } catch {}
            delete videoLayers[outputId]
        }
    })
    ws.on("error", () => {})
}

// Blackmagic output lives here too (BlackmagicBridge on main mirrors device state)
const BMD_AUDIO_MARKER = Buffer.from([1])
function bmdReportState(outputId: string) {
    const d = BlackmagicSender.playbackData[outputId]
    port.postMessage({ type: "bmdState", outputId, ready: !!d?.playback, displayMode: d?.displayMode || "", pixelFormat: d?.pixelFormat || "", enableKeying: !!d?.enableKeying, colorSpace: d?.colorSpace || "", targetSize: d?.targetSize || null, stable: BlackmagicSender.isDeviceStable(outputId) })
}
setInterval(() => {
    if (Object.keys(BlackmagicSender.playbackData).length) port.postMessage({ type: "bmdAudioQueued", length: BlackmagicSender.audioQueueLength })
}, 250)

// WebRTC host window: frames leave here over the shared-memory transport (see capture/FrameServer.ts);
// main relays the socket details to the window and nothing else
const servedPacer = new WeakMap<ServedFrame, PacerBuf>()
let webrtcServer: FrameServer | null = null
function webrtcFrames() {
    if (webrtcServer) return webrtcServer
    webrtcServer = new FrameServer({
        log: (text) => console.info("[webrtc frames]", text),
        onListening: (info) => port.postMessage({ type: "webrtcWs", port: info.port, token: info.token }),
        onNeedTarget: (targetId) => port.postMessage({ type: "webrtcNeedTarget", targetId }),
        retain: (frame) => {
            const pb = servedPacer.get(frame)
            if (pb) pb.refs++
        },
        release: (frame) => {
            const pb = servedPacer.get(frame)
            if (pb) releasePacerRef(pb)
        },
        stats: !!process.env.FS_CAP_STATS
    })
    return webrtcServer
}

port.on("message", (msg: any) => {
    switch (msg?.type) {
        case "webrtcReset":
            // the host window went away or (re)loaded: forget its targets so the next frame asks again
            if (webrtcServer) for (const m of Object.keys(webrtcServer.targets())) webrtcServer.drop(m)
            break
        case "videoSource":
            connectVideoSource(msg.targetId, msg.outputId, msg.port, msg.token)
            break
        case "bmdInit":
            void BlackmagicSender.initialize(msg.outputId, msg.deviceIndex, msg.displayMode, msg.pixelFormat, msg.enableKeying, msg.audioChannels, msg.colorSpace).then(
                () => bmdReportState(msg.outputId),
                (err) => {
                    console.error("Blackmagic init failed:", err)
                    bmdReportState(msg.outputId)
                }
            )
            break
        case "bmdStop":
            BlackmagicSender.stop(msg.outputId)
            bmdReportState(msg.outputId)
            break
        case "bmdStopAll":
            BlackmagicSender.stopAll()
            break
        case "bmdShutdown":
            BlackmagicSender.shutdown()
            break
        case "bmdReset":
            BlackmagicSender.resetProblematicDevice(msg.outputId)
            break
        case "bmdAudio":
            BlackmagicSender.sendAudioBuffer(Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength), msg.opts)
            break
        case "bmdFrame": {
            const marker = BlackmagicSender.audioQueueLength > 0 ? BMD_AUDIO_MARKER : null
            BlackmagicSender.scheduleFrame(msg.outputId, Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength), marker, msg.framerate, !!msg.preConverted)
            break
        }
        case "rtmpUpdate":
            rtmpStopWatch.add(msg.outputId)
            RtmpStreamer.update(msg.outputId, msg.config, msg.destinations, { ffmpegPath: msg.ffmpegPath, encoderId: msg.encoderId })
            break
        case "rtmpStop":
            rtmpStopWatch.delete(msg.outputId)
            RtmpStreamer.stop(msg.outputId)
            break
        case "rtmpStopAll":
            rtmpStopWatch.clear()
            RtmpStreamer.stopAll()
            break
        case "rtmpAudio":
            RtmpStreamer.updateAudio(msg.outputId, Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength), msg.sampleRate)
            break
        case "rtmpFrame":
            RtmpStreamer.updateFrame(msg.outputId, Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength), msg.size)
            break
        case "create":
            void createSender(msg.id, msg.name, msg.groups)
            break
        case "video":
            sendVideoBuffer(msg.id, Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength), msg.opts)
            break
        case "captureFrame":
            void captureAndSend(msg.id, msg.source, msg.opts)
            break
        case "audio":
            void sendAudioBuffer(Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength), msg.opts)
            break
        case "audioTarget":
            void sendAudioBufferTarget(msg.id, Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength), msg.opts)
            break
        case "destroy":
            stopSender(msg.id)
            break
        case "createOmt":
            void createOmtSender(msg.id, msg.name, msg.quality)
            break
        case "videoOmt":
            void sendOmtVideoBuffer(msg.id, Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength), msg.opts)
            break
        case "audioOmt":
            void sendOmtAudioBuffer(Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength), msg.opts)
            break
        case "destroyOmt":
            stopOmtSender(msg.id)
            break
    }
})
