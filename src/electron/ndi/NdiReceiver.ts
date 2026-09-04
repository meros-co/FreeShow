import { toApp } from ".."
import { NDI } from "../../types/Channels"
import { packStreamFrame, previewStreamFrame, type StreamFrameFormat } from "../capture/streamFrames"
import { OutputHelper } from "../output/OutputHelper"

let warned = false
const loadGrandiose = async () => {
    try {
        return await import("grandiose")
    } catch (err) {
        if (!warned) console.warn("NDI not available:", err.message)
        warned = true
        return null
    }
}

export class NdiReceiver {
    static ndiDisabled = false
    static NDI_RECEIVERS: { [key: string]: { frameRate: number; isReceiving?: boolean; shouldStop?: boolean; fetchInProgress?: boolean; source?: { name: string; urlAddress: string; id: string }; lowbandwidth?: boolean } } = {}

    private static findSourcesInterval: NodeJS.Timeout | null = null
    static allActiveReceivers: { [key: string]: any } = {}
    static sendToOutputs: string[] = []
    private static fourCCUyvy: number | null = null

    private static async createReceiver(source: { name: string; urlAddress: string }, lowbandwidth = false) {
        try {
            const grandiose = await loadGrandiose()
            if (!grandiose) return null

            // UYVY is half the bytes of RGBA and every one of them costs main-thread time in IPC; the
            // renderer converts it on the GPU. Sources with alpha still arrive as RGBA.
            this.fourCCUyvy = grandiose.FOURCC_UYVY
            const config: any = { source, colorFormat: grandiose.COLOR_FORMAT_UYVY_RGBA, allowVideoFields: false }
            if (lowbandwidth) config.bandwidth = grandiose.BANDWIDTH_LOWEST

            let timeout: NodeJS.Timeout | null = null
            try {
                const receiver = await Promise.race([
                    grandiose.receive(config),
                    new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(new Error("NDI receiver timeout")), 10000)
                    })
                ])
                return receiver
            } finally {
                if (timeout) clearTimeout(timeout)
            }
        } catch (err) {
            console.error("Failed to create NDI receiver:", err)
            return null
        }
    }

    static async findStreamsNDI(data: { groups?: string }): Promise<{ name: string; urlAddress: string }[]> {
        if (this.ndiDisabled) return []
        if (this.findSourcesInterval) clearInterval(this.findSourcesInterval)

        const grandiose = await loadGrandiose()
        if (!grandiose) return []

        const finder: any = await grandiose.find({ showLocalSources: true, groups: data.groups || "" })
        return new Promise<any[]>((resolve) => {
            // without the interval it only finds one source: https://github.com/emanspeaks/grandiose/commit/271cd73b5269ab827155a1a944c15d3b5fe4d564
            let previousLength = 0
            this.findSourcesInterval = setInterval(() => {
                const sources = finder.sources()
                if (previousLength === sources.length) {
                    clearInterval(this.findSourcesInterval!)
                    resolve(sources)
                }
                previousLength = sources.length
            }, 1000)
        })
    }

    static async receiveStreamFrameNDI({ source }: { source: { name: string; urlAddress: string; id: string } }) {
        if (this.ndiDisabled) return

        try {
            if (!this.allActiveReceivers[source.id]) {
                this.allActiveReceivers[source.id] = await this.createReceiver({ name: source.name, urlAddress: source.urlAddress || source.id }, true)
            }

            const receiver = this.allActiveReceivers[source.id]
            if (!receiver?.video) {
                delete this.allActiveReceivers[source.id]
                return
            }

            // For NDI-HX sources, start continuous reception for thumbnail generation
            if (!this.NDI_RECEIVERS[source.id]) {
                this.NDI_RECEIVERS[source.id] = { frameRate: 0.1, isReceiving: true, shouldStop: false, fetchInProgress: false, source, lowbandwidth: true }
                // Start lightweight frame loop for thumbnails only
                this.thumbnailLoop(source.id, this.NDI_RECEIVERS[source.id])
            }

            let rawFrame: any = null
            // If a fetch is already in progress for this source, skip this frame
            const receiverData = this.NDI_RECEIVERS[source.id]
            if (receiverData?.fetchInProgress) return

            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    if (receiverData) receiverData.fetchInProgress = true
                    rawFrame = await receiver.video(50)
                    break
                } catch (err: any) {
                    const msg = err.message || ""
                    if (msg.includes("Non-video data received")) {
                        if (attempt < 2) continue
                        return
                    }
                    if (msg.includes("source change") && attempt < 2) continue
                    delete this.allActiveReceivers[source.id]
                    return
                } finally {
                    if (receiverData) receiverData.fetchInProgress = false
                }
            }

            if (rawFrame?.data?.length === rawFrame.xres * rawFrame.yres * 4) {
                this.sendBuffer(source.id, rawFrame)
            }
        } catch (err) {
            console.error(err)
        }
    }

    private static handleError(err: any, consecutiveErrors: number): { shouldContinue: boolean; delay: number; newErrorCount: number } {
        const msg = err.message || ""

        if (msg.includes("Non-video data received")) return { shouldContinue: true, delay: 0, newErrorCount: Math.max(0, consecutiveErrors - 1) }
        if (msg.includes("No video data received")) return { shouldContinue: true, delay: 1, newErrorCount: consecutiveErrors }

        const newCount = consecutiveErrors + 1
        return {
            shouldContinue: newCount < 10,
            delay: Math.min(5 * Math.pow(1.5, newCount), 100),
            newErrorCount: newCount
        }
    }

    private static async frameLoop(sourceId: string, receiverData: any) {
        let consecutiveErrors = 0

        while (receiverData && !receiverData.shouldStop) {
            try {
                // Skip this iteration if another fetch is already in progress for this receiver
                if (receiverData.fetchInProgress) {
                    await new Promise((resolve) => setTimeout(resolve, 8))
                    continue
                }

                let receiver = this.allActiveReceivers[sourceId]
                if (!receiver) {
                    const source = receiverData.source
                    if (source) {
                        receiver = this.allActiveReceivers[sourceId] = await this.createReceiver({ name: source.name, urlAddress: source.urlAddress || source.id }, receiverData.lowbandwidth)
                    }
                }
                if (!receiver?.video) {
                    delete this.allActiveReceivers[sourceId]
                    throw new Error("No video data received")
                }

                receiverData.fetchInProgress = true
                try {
                    const rawFrame = await receiver.video(50)
                    if (rawFrame) {
                        this.sendBuffer(sourceId, rawFrame)
                        consecutiveErrors = 0

                        // video() already blocks until the next frame, so pace on the source: waiting
                        // after every frame pushes the next fetch past the frame after it
                        await new Promise((resolve) => setImmediate(resolve))
                        continue
                    }
                } finally {
                    receiverData.fetchInProgress = false
                }
            } catch (err: any) {
                const { shouldContinue, delay, newErrorCount } = this.handleError(err, consecutiveErrors)
                consecutiveErrors = newErrorCount

                if (!shouldContinue) {
                    console.error(`NDI source ${sourceId}: Too many errors, stopping`)
                    this.stopReceiversNDI({ id: sourceId })
                    return
                }

                await new Promise((resolve) => setTimeout(resolve, delay))
            }
        }
    }

    private static async thumbnailLoop(sourceId: string, receiverData: any) {
        let consecutiveErrors = 0

        while (receiverData && !receiverData.shouldStop) {
            try {
                // If another fetch is in progress, wait a short while and skip
                if (receiverData.fetchInProgress) {
                    await new Promise((resolve) => setTimeout(resolve, 50))
                    continue
                }

                let receiver = this.allActiveReceivers[sourceId]
                if (!receiver) {
                    const source = receiverData.source
                    if (source) {
                        receiver = this.allActiveReceivers[sourceId] = await this.createReceiver({ name: source.name, urlAddress: source.urlAddress || source.id }, receiverData.lowbandwidth)
                    }
                }
                if (!receiver?.video) {
                    delete this.allActiveReceivers[sourceId]
                    throw new Error("No video data received")
                }

                receiverData.fetchInProgress = true
                try {
                    const rawFrame = await receiver.video(50)
                    if (rawFrame) {
                        this.sendBuffer(sourceId, rawFrame)
                        consecutiveErrors = 0
                        // Slower rate for thumbnails - every 500ms
                        await new Promise((resolve) => setTimeout(resolve, 500))
                        continue
                    }
                } finally {
                    receiverData.fetchInProgress = false
                }
            } catch (err: any) {
                const { shouldContinue, delay, newErrorCount } = this.handleError(err, consecutiveErrors)
                consecutiveErrors = newErrorCount

                if (!shouldContinue) {
                    delete this.NDI_RECEIVERS[sourceId]
                    return
                }

                await new Promise((resolve) => setTimeout(resolve, delay))
            }
        }
    }

    // the app window draws this a few hundred pixels wide
    private static PREVIEW_MAX_WIDTH = 480

    static sendBuffer(id: string, frame: any) {
        if (!frame?.data) return

        const format: StreamFrameFormat = frame.fourCC === this.fourCCUyvy ? "uyvy" : "rgba"
        const packed = packStreamFrame(frame.data, frame.xres, frame.yres, frame.lineStrideBytes || 0, format)
        if (!packed) return

        // outputs render the stream itself and need every pixel
        const time = Date.now()
        this.sendToOutputs.forEach((outputId) => OutputHelper.Send.sendToWindow(outputId, { channel: "RECEIVE_STREAM", data: { id, frame: packed, time } }, NDI))

        // the app window only ever previews it (drawer card, output mirror), so it gets a small copy:
        // full frames here cost the main thread more than the rest of this path combined
        toApp(NDI, { channel: "RECEIVE_STREAM", data: { id, frame: previewStreamFrame(packed, this.PREVIEW_MAX_WIDTH), time } })
    }

    static async captureStreamNDI({ source, outputId }: { source: { name: string; urlAddress: string; id: string }; outputId: string }) {
        if (this.ndiDisabled) return
        if (!this.sendToOutputs.includes(outputId)) this.sendToOutputs.push(outputId)

        let receiver = this.allActiveReceivers[source.id]
        if (!receiver) {
            receiver = this.allActiveReceivers[source.id] = await this.createReceiver({ name: source.name, urlAddress: source.urlAddress || source.id })
        }

        // If thumbnail loop is running, stop it and upgrade to full capture
        if (this.NDI_RECEIVERS[source.id]) {
            this.NDI_RECEIVERS[source.id].shouldStop = true
            // Brief delay to let thumbnail loop exit cleanly
            await new Promise((resolve) => setTimeout(resolve, 100))
        }

        // Start full capture loop
        this.NDI_RECEIVERS[source.id] = { frameRate: 0.1, isReceiving: true, shouldStop: false, source, lowbandwidth: false }
        const receiverData = this.NDI_RECEIVERS[source.id]

        this.frameLoop(source.id, receiverData).catch((err) => {
            console.error(`NDI reception error for ${source.id}:`, err)
            this.stopReceiversNDI({ id: source.id })
        })
    }

    static stopReceiversNDI(data: { id: string; outputId?: string } | null = null) {
        if (data?.id) {
            if (data.outputId) this.sendToOutputs.splice(this.sendToOutputs.indexOf(data.outputId), 1)
            else this.sendToOutputs = []

            if (!this.sendToOutputs.length && this.NDI_RECEIVERS[data.id]) {
                this.NDI_RECEIVERS[data.id].shouldStop = true
                setTimeout(() => delete this.NDI_RECEIVERS[data.id], 100)
            }
            return
        }

        Object.keys(this.NDI_RECEIVERS).forEach((id) => {
            if (this.NDI_RECEIVERS[id]) this.NDI_RECEIVERS[id].shouldStop = true
        })
        setTimeout(() => (this.NDI_RECEIVERS = {}), 100)
    }
}
