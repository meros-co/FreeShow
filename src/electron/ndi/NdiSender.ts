import { join } from "path"
import { Worker } from "worker_threads"
import { toApp } from ".."
import { CaptureHelper } from "../capture/CaptureHelper"

// Resources:
// https://www.npmjs.com/package/grandiose-mac
// https://github.com/Streampunk/grandiose
// https://github.com/rse/grandiose
// https://github.com/rse/vingester

// NDI sender proxy: delegates NDI encoding and dispatch to a worker thread (./ndiWorker)
// one readback of a shared render, fanned out to every member at that member's size and format
export type CaptureFrameOpts = {
    size: { width: number; height: number }
    ratio: number
    framerate: number
    memberFramerates?: { [id: string]: number }
    format: number // readback format of the main buffer (0 BGRA, 1 UYVY, 2 UYVA)
    mainFormat?: number // the format full-size members send in (differs from `format` only on the CPU-target path)
    transparent?: boolean
    dstW?: number
    dstH?: number
    seq?: number
    members?: string[]
    depth?: number
    omt?: boolean
    omtFramerate?: number
    omtMembers?: string[]
    omtFramerates?: { [id: string]: number }
    targets?: { width: number; height: number; format: number }[]
    memberTarget?: { [id: string]: number } // -1 = main buffer, else index into targets
    memberFormats?: { [id: string]: number }
    memberSizes?: { [id: string]: { width: number; height: number } }
    cpuTargets?: boolean // addon can't produce targets on the GPU here: main is BGRA and targets are CPU-derived
    rtmpMembers?: { [id: string]: { width: number; height: number } } // members streaming RTMP, at their broadcast size
    bmdMembers?: { [id: string]: { width: number; height: number; format: number; framerate: number } } // members on a Blackmagic device, at the card's mode
    webrtcMembers?: { [id: string]: { width: number; height: number } } // members streaming WebRTC: a BGRA frame at the output's size for the host window
}

export class NdiSender {
    private static worker: Worker | null = null
    private static readonly MAX_INFLIGHT_SENDS = 3

    static NDI: {
        [key: string]: {
            name: string
            groups?: string
            status?: string
            previousStatus?: string
            sender?: boolean
            inFlight?: number
            connections?: number
        }
    } = {}

    private static getWorker(): Worker | null {
        if (this.worker) return this.worker

        try {
            this.worker = new Worker(join(__dirname, "ndiWorker.js"), {
                env: { ...process.env, UV_THREADPOOL_SIZE: "32" }
            })
            this.worker.on("message", (msg: any) => this.onWorkerMessage(msg))
            this.worker.on("error", (err) => console.error("NDI worker error:", err))
            this.worker.on("exit", (code) => {
                if (code !== 0) console.error(`NDI worker exited with code ${code}`)
                this.worker = null
                this.NDI = {}
            })
        } catch (err) {
            console.error("Could not start NDI worker:", err)
            this.worker = null
        }

        return this.worker
    }

    // OMT proxy messages are routed to OmtSender through this handler rather than a direct import, avoiding a cycle
    static auxMessageHandler: ((msg: any) => void) | null = null
    // RTMP engine messages (status/notice/stopped) go to RtmpBridge the same way
    static rtmpMessageHandler: ((msg: any) => void) | null = null
    // Blackmagic output messages (device state, audio queue) go to BlackmagicBridge
    static bmdMessageHandler: ((msg: any) => void) | null = null
    // WebRTC host wiring (`webrtc*` messages from the worker's frame server)
    static webrtcMessageHandler: ((msg: any) => void) | null = null
    // live input composited into a capture (`video*` messages)
    static videoLayerHandler: ((msg: any) => void) | null = null

    private static onWorkerMessage(msg: any) {
        const t0 = process.env.FS_CAP_STATS ? performance.now() : 0
        try {
            this.onWorkerMessageBody(msg)
        } finally {
            if (t0) {
                const dt = performance.now() - t0
                this.mainDiag.msgMs += dt
                this.mainDiag.msgN++
                if (dt > this.mainDiag.msgMax) this.mainDiag.msgMax = dt
                const t = (this.mainDiag.byType[msg?.type || "?"] ||= { ms: 0, n: 0, max: 0 })
                t.ms += dt
                t.n++
                if (dt > t.max) t.max = dt
            }
        }
    }

    private static onWorkerMessageBody(msg: any) {
        if (!msg?.type) return
        if (String(msg.type).startsWith("rtmp")) {
            this.rtmpMessageHandler?.(msg)
            return
        }
        if (String(msg.type).startsWith("bmd")) {
            this.bmdMessageHandler?.(msg)
            return
        }
        if (String(msg.type).startsWith("webrtc")) {
            this.webrtcMessageHandler?.(msg)
            return
        }
        if (msg.type === "videoFrame" || msg.type === "videoLayerActive") {
            this.videoLayerHandler?.(msg)
            return
        }
        if (String(msg.type).endsWith("Omt")) {
            this.auxMessageHandler?.(msg)
            return
        }

        if (msg.type === "status") {
            const data = this.NDI[msg.id]
            if (!data) return

            data.status = msg.status
            data.connections = msg.connections
            const newStatus = String(msg.status) + String(msg.connections)
            if (newStatus !== data.previousStatus) {
                toApp("NDI", { channel: "SEND_DATA", data: { id: msg.id, status: msg.status, connections: msg.connections } })
                CaptureHelper.updateFramerate(msg.id)
                data.previousStatus = newStatus
            }
        } else if (msg.type === "createFailed") {
            delete this.NDI[msg.id]
        } else if (msg.type === "videoDone") {
            const data = this.NDI[msg.id]
            if (data) data.inFlight = Math.max(0, (data.inFlight ?? 0) - 1)
        } else if (msg.type === "releaseTexture") {
            // off-main capture: the GPU has consumed the shared texture -> release it (frees the frame pool)
            this.releaseTextureCallbacks[msg.id]?.(msg.seq)
        } else if (msg.type === "captureDone") {
            // off-main capture fully done -> a pipeline slot frees (the lifecycle may forward the next frame).
            // msg.tl = FS_CAP_STATS per-frame worker timeline (hop timestamps) for the [TIMELINE] attribution.
            this.captureDoneCallbacks[msg.id]?.(msg.seq, msg.tl)
        } else if (msg.type === "scaledFrame") {
            // the worker GPU-downscaled the 4K readback to a small BGRA (server/stage) and copied it here;
            // main wraps the small image once and fans it out to every group member's server/stage consumers
            CaptureHelper.Transmitter.receiveScaledFrame(msg.members || [msg.id], msg.buffer, msg.byteOffset, msg.byteLength, msg.size)
        }
    }

    // OMT senders share this worker (same readback per frame for NDI+OMT outputs)
    static getSharedWorker(): import("worker_threads").Worker | null {
        return this.getWorker()
    }

    static initNameNDI(name?: string, outputName?: string) {
        return name || `FreeShow NDI${outputName ? ` - ${outputName}` : ""}`
    }

    static isBusyNDI(id: string): boolean {
        return (this.NDI[id]?.inFlight ?? 0) >= this.MAX_INFLIGHT_SENDS
    }

    static async createSenderNDI(id: string, name = "", groups?: string) {
        if (this.NDI[id]) {
            this.stopSenderNDI(id)
        }

        const worker = this.getWorker()
        if (!worker) return

        this.NDI[id] = { name, groups, sender: true, status: "unconnected" }
        worker.postMessage({ type: "create", id, name, groups })
    }

    static stopSenderNDI(id: string) {
        if (!this.NDI[id]) return

        delete this.NDI[id]
        this.worker?.postMessage({ type: "destroy", id })
    }

    static sendVideoBufferNDI(id: string, buffer: Buffer, { size = { width: 1280, height: 720 }, ratio = 16 / 9, framerate = 1, transparent = true, format = 0 }: { size?: { width: number; height: number }; ratio?: number; framerate?: number; transparent?: boolean; format?: number } = {}) {
        const data = this.NDI[id]
        if (!data?.sender || !this.worker) return

        data.inFlight = (data.inFlight ?? 0) + 1

        let arrayBuffer: ArrayBuffer
        if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
            arrayBuffer = buffer.buffer as ArrayBuffer
        } else {
            arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
        }
        this.worker.postMessage({ type: "video", id, buffer: arrayBuffer, byteOffset: 0, byteLength: arrayBuffer.byteLength, opts: { size, ratio, framerate, transparent, format } }, [arrayBuffer])
    }

    // FS_CAP_STATS: how congested the MAIN JS thread is. lag = how late a 5ms timer fires (0 = idle);
    // paint/msg = synchronous time spent in the OSR paint handler and in worker-message handling per second.
    static mainDiag = { lagSum: 0, lagMax: 0, lagN: 0, paintMs: 0, paintN: 0, paintMax: 0, msgMs: 0, msgN: 0, msgMax: 0, lastTick: 0, started: false, byType: {} as { [type: string]: { ms: number; n: number; max: number } } }
    static startMainDiag() {
        if (this.mainDiag.started || !process.env.FS_CAP_STATS) return
        this.mainDiag.started = true
        const d = this.mainDiag
        d.lastTick = performance.now()
        setInterval(() => {
            const now = performance.now()
            const lag = Math.max(0, now - d.lastTick - 5)
            d.lastTick = now
            d.lagSum += lag
            d.lagN++
            if (lag > d.lagMax) d.lagMax = lag
        }, 5)
        setInterval(() => {
            if (!d.lagN) return
            const types = Object.entries(d.byType).map(([k, v]) => `${k}:n${v.n}/${v.ms.toFixed(0)}ms/max${v.max.toFixed(1)}`).join(" ")
            console.info(`[MAIN-LOOP] lag(mean=${(d.lagSum / d.lagN).toFixed(2)}ms max=${d.lagMax.toFixed(1)}ms) paint(n=${d.paintN} ${d.paintMs.toFixed(1)}ms/s max=${d.paintMax.toFixed(1)}ms) workerMsg(n=${d.msgN} ${d.msgMs.toFixed(1)}ms/s max=${d.msgMax.toFixed(1)}ms) ${types}`)
            d.lagSum = d.lagMax = d.lagN = d.paintMs = d.paintN = d.paintMax = d.msgMs = d.msgN = d.msgMax = 0
            d.byType = {}
        }, 1000)
    }

    static captureDoneCallbacks: { [id: string]: (seq: number, tl?: { recv: number; cS: number; cE: number; fS: number; fE: number; enq: number } | null) => void } = {}
    static releaseTextureCallbacks: { [id: string]: (seq: number) => void } = {}

    static captureFrameNDI(id: string, source: any, opts: CaptureFrameOpts) {
        // the render is shared: any member with an NDI sender, or any OMT sender in the shared worker
        // (opts.omt), keeps the capture going without an NDI sender on the renderer itself
        const anyNdi = (opts.members?.length ? opts.members : [id]).some((m) => this.NDI[m]?.sender)
        const anyWorkerConsumer = Object.keys(opts.webrtcMembers || {}).length > 0 || Object.keys(opts.rtmpMembers || {}).length > 0
        if ((!anyNdi && !opts.omt && !anyWorkerConsumer) || !this.getWorker()) return false
        this.worker!.postMessage({ type: "captureFrame", id, source, opts })
        return true
    }

    static async sendAudioBufferNDITarget(id: string, buffer: Buffer, { sampleRate, channelCount }: { sampleRate: number; channelCount: number }) {
        if (!this.NDI[id]?.sender || !this.worker || !buffer || buffer.length === 0) return

        this.worker.postMessage({ type: "audioTarget", id, buffer: buffer.buffer, byteOffset: buffer.byteOffset, byteLength: buffer.byteLength, opts: { sampleRate, channelCount } })
    }

    static async sendAudioBufferNDI(buffer: Buffer, { sampleRate, channelCount }: { sampleRate: number; channelCount: number }) {
        const hasSender = Object.values(this.NDI).some((s) => s?.sender)
        if (!hasSender || !this.worker || !buffer || buffer.length === 0) return

        this.worker.postMessage({ type: "audio", buffer: buffer.buffer, byteOffset: buffer.byteOffset, byteLength: buffer.byteLength, opts: { sampleRate, channelCount } })
    }
}
