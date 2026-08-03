import os from "os"
import { toApp } from ".."
import { CaptureHelper } from "../capture/CaptureHelper"
import util from "../ndi/vingester-util"

// Dynamic import for the "openmediatransport" ES module (same pattern as grandiose/NDI)
let warned = false
let omtModule: any | null = null
let omtPromise: Promise<any | null> | null = null
const loadOMT = async () => {
    if (omtModule) return omtModule
    if (omtPromise) return omtPromise

    omtPromise = import("openmediatransport")
        .then((imported) => {
            omtModule = imported
            return imported
        })
        .catch((err: any) => {
            if (!warned) console.warn("OMT not available:", err?.message || err)
            warned = true
            return null
        })
        .finally(() => {
            omtPromise = null
        })

    return omtPromise
}

// Resources:
// https://github.com/openmediatransport/libomtnet
// https://github.com/schplay/openmediatransport-node

export class OmtSender {
    private static readonly BYTES_PER_FLOAT32 = 4
    private static readonly CONNECTION_POLL_INTERVAL_MS = 1000
    private static readonly TIMESTAMP_DIVISOR = BigInt(100) // OMT timestamp unit: 1 second = 10,000,000 (100ns)

    static timeStart = BigInt(Date.now()) * BigInt(1e6) - process.hrtime.bigint()

    static OMT: {
        [key: string]: {
            name: string
            quality?: number
            sender?: any
            timer?: NodeJS.Timeout
            status?: string
            previousStatus?: string
        }
    } = {}

    private static getTimestamp(): bigint {
        return (this.timeStart + process.hrtime.bigint()) / this.TIMESTAMP_DIVISOR
    }

    static initNameOMT(name?: string, outputName?: string) {
        return name || `FreeShow OMT${outputName ? ` - ${outputName}` : ""}`
    }

    private static mapQuality(omt: any, quality?: number | string): number {
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

    static async createSenderOMT(id: string, name = "", quality?: number | string) {
        if (this.OMT[id]) return

        this.OMT[id] = { name }
        console.info("OMT - creating sender: " + name)

        try {
            const omt = await loadOMT()
            if (!omt) return

            const qualityValue = this.mapQuality(omt, quality)
            this.OMT[id].quality = qualityValue
            this.OMT[id].sender = new omt.Sender(name, qualityValue)
        } catch (err) {
            console.error("Could not create OMT sender:", err)
            delete this.OMT[id]
            return
        }

        this.OMT[id].timer = setInterval(() => {
            /*  poll OMT for connections  */
            const conns: number = this.OMT[id]?.sender?.connections || 0
            this.OMT[id].status = conns > 0 ? "connected" : "unconnected"

            const newStatus = String(this.OMT[id].status) + conns.toString()
            if (newStatus !== this.OMT[id].previousStatus) {
                toApp("OMT", { channel: "SEND_DATA", data: { id, status: this.OMT[id].status, connections: conns } })
                CaptureHelper.updateFramerate(id)

                this.OMT[id].previousStatus = newStatus

                if (this.OMT[id].status === "connected") {
                    console.log(`[OMT] Reconnected for ${id}`)
                }
            }
        }, this.CONNECTION_POLL_INTERVAL_MS)
    }

    static stopSenderOMT(id: string) {
        if (!this.OMT[id]?.timer) return

        console.info("OMT - stopping sender: " + this.OMT[id].name)
        clearInterval(this.OMT[id].timer)

        try {
            this.OMT[id].sender?.destroy()
        } catch (err) {
            console.error("ERROR", err)
        }

        delete this.OMT[id]
    }

    static async sendVideoBufferOMT(id: string, buffer: Buffer, { size = { width: 1280, height: 720 }, ratio = 16 / 9, framerate = 1, transparent = true }) {
        const senderData = this.OMT[id]
        if (!senderData?.sender) return

        const omt = await loadOMT()
        if (!omt) return

        // Electron's toBitmap() gives BGRA on little-endian, which matches OMT's BGRA codec directly.
        if (os.endianness() === "BE") util.ImageBufferAdjustment.ARGBtoBGRA(buffer)

        // Without the Alpha flag OMT treats BGRA as opaque BGRX
        const flags = transparent ? omt.VideoFlags.Alpha : omt.VideoFlags.None

        try {
            senderData.sender.send({
                type: omt.FrameType.Video,
                timestamp: this.getTimestamp(),
                codec: omt.Codec.BGRA,
                width: size.width,
                height: size.height,
                stride: size.width * 4,
                flags,
                frameRateN: Math.round(framerate * 1000),
                frameRateD: 1000,
                aspectRatio: ratio,
                colorSpace: omt.ColorSpace.Undefined,
                data: buffer
            })
        } catch (err) {
            console.error("Error sending OMT video frame:", err)
        }
    }

    // `buffer` is planar Float32 LE (the processAudio contract), which is OMT's FPA1 format directly
    static async sendAudioBufferOMT(buffer: Buffer, { sampleRate, channelCount }: { sampleRate: number; channelCount: number }) {
        const activeSender = Object.values(this.OMT).find((s) => s?.sender)
        if (!activeSender || !buffer || buffer.length === 0) return

        const omt = await loadOMT()
        if (!omt) return

        const samplesPerChannel = Math.trunc(buffer.byteLength / channelCount / this.BYTES_PER_FLOAT32)
        if (samplesPerChannel <= 0) return

        const frame = {
            type: omt.FrameType.Audio,
            timestamp: this.getTimestamp(),
            codec: omt.Codec.FPA1,
            sampleRate,
            channels: channelCount,
            samplesPerChannel,
            data: buffer
        }

        Object.values(this.OMT).forEach((data) => {
            if (!data?.sender) return

            try {
                data.sender.send(frame)
            } catch (err) {
                console.error("Error sending OMT audio frame:", err)
            }
        })
    }
}
