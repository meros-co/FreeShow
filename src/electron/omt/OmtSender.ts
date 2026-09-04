import { toApp } from ".."
import { CaptureHelper } from "../capture/CaptureHelper"
import { NdiSender } from "../ndi/NdiSender"
import { ensureOmtCodecSearchPath } from "./omtModule"

// Resources:
// https://github.com/openmediatransport/libomtnet
// https://github.com/schplay/openmediatransport-node

// OMT sender proxy: delegates OMT encoding and dispatch to the shared NDI/OMT worker thread (../ndi/ndiWorker)

export class OmtSender {
    private static readonly MAX_INFLIGHT_SENDS = 3

    // main-side mirror of the worker's OMT senders
    static OMT: {
        [key: string]: {
            name: string
            quality?: number | string
            status?: string
            previousStatus?: string
            sender?: boolean
            inFlight?: number
            connections?: number
        }
    } = {}

    private static handlerRegistered = false
    private static getWorker() {
        if (!this.handlerRegistered) {
            NdiSender.auxMessageHandler = (msg: any) => this.onWorkerMessage(msg)
            this.handlerRegistered = true
        }
        return NdiSender.getSharedWorker()
    }

    private static onWorkerMessage(msg: any) {
        if (msg.type === "statusOmt") {
            const data = this.OMT[msg.id]
            if (!data) return

            data.status = msg.status
            data.connections = msg.connections
            const newStatus = String(msg.status) + String(msg.connections)
            if (newStatus !== data.previousStatus) {
                toApp("OMT", { channel: "SEND_DATA", data: { id: msg.id, status: msg.status, connections: msg.connections } })
                CaptureHelper.updateFramerate(msg.id)
                data.previousStatus = newStatus
            }
        } else if (msg.type === "createFailedOmt") {
            delete this.OMT[msg.id]
        } else if (msg.type === "videoDoneOmt") {
            const data = this.OMT[msg.id]
            if (data) data.inFlight = Math.max(0, (data.inFlight ?? 0) - 1)
        }
    }

    static initNameOMT(name?: string, outputName?: string) {
        return name || `FreeShow OMT${outputName ? ` - ${outputName}` : ""}`
    }

    static isBusyOMT(id: string): boolean {
        return (this.OMT[id]?.inFlight ?? 0) >= this.MAX_INFLIGHT_SENDS
    }

    static async createSenderOMT(id: string, name = "", quality?: number | string) {
        // let the worker retire a live sender as part of the create, so its port and discovery registration free up first
        delete this.OMT[id]

        // the worker cannot set this itself (its process.env is a copy), so do it here first
        ensureOmtCodecSearchPath()

        const worker = this.getWorker()
        if (!worker) return

        this.OMT[id] = { name, quality, sender: true, status: "unconnected" }
        worker.postMessage({ type: "createOmt", id, name, quality })
    }

    static stopSenderOMT(id: string) {
        if (!this.OMT[id]) return

        delete this.OMT[id]
        NdiSender.getSharedWorker()?.postMessage({ type: "destroyOmt", id })
    }

    // transferred zero-copy when the buffer owns its whole ArrayBuffer, copied otherwise (a transfer must never detach a pooled buffer)
    static sendVideoBufferOMT(id: string, buffer: Buffer, { size = { width: 1280, height: 720 }, ratio = 16 / 9, framerate = 1, transparent = true, format = 0 }: { size?: { width: number; height: number }; ratio?: number; framerate?: number; transparent?: boolean; format?: number } = {}) {
        const data = this.OMT[id]
        const worker = this.getWorker()
        if (!data?.sender || !worker) return

        data.inFlight = (data.inFlight ?? 0) + 1

        let arrayBuffer: ArrayBuffer
        if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
            arrayBuffer = buffer.buffer as ArrayBuffer
        } else {
            arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
        }
        worker.postMessage({ type: "videoOmt", id, buffer: arrayBuffer, byteOffset: 0, byteLength: arrayBuffer.byteLength, opts: { size, ratio, framerate, transparent, format } }, [arrayBuffer])
    }

    // planar Float32 LE (the processAudio contract) is OMT's FPA1 format directly; clone rather than transfer, as these may be pooled
    static async sendAudioBufferOMT(buffer: Buffer, { sampleRate, channelCount }: { sampleRate: number; channelCount: number }) {
        const hasSender = Object.values(this.OMT).some((s) => s?.sender)
        const worker = hasSender ? this.getWorker() : null
        if (!worker || !buffer || buffer.length === 0) return

        worker.postMessage({ type: "audioOmt", buffer: buffer.buffer, byteOffset: buffer.byteOffset, byteLength: buffer.byteLength, opts: { sampleRate, channelCount } })
    }
}
