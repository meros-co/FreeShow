import { toApp } from ".."
import { OMT } from "../../types/Channels"
import { packStreamFrame, previewStreamFrame, type StreamFrameFormat } from "../capture/streamFrames"
import { loadOMT } from "./omtModule"
import { OutputHelper } from "../output/OutputHelper"

type Source = { name: string; urlAddress?: string; id: string }

export class OmtReceiver {
    static omtDisabled = false
    static OMT_RECEIVERS: { [key: string]: { shouldStop?: boolean; source?: Source; lowbandwidth?: boolean } } = {}
    static allActiveReceivers: { [key: string]: any } = {}
    static sendToOutputs: string[] = []
    private static codecs: any = null

    private static readonly RECEIVE_TIMEOUT_MS = 50
    private static readonly FULL_LOOP_DELAY_MS = 16 // ~60fps ceiling
    private static readonly THUMBNAIL_LOOP_DELAY_MS = 500

    private static getAddress(source: Source) {
        return source.urlAddress || source.id
    }

    private static async createReceiver(address: string, lowbandwidth = false) {
        try {
            const omt = await loadOMT()
            if (!omt) return null

            this.codecs = omt.Codec

            // UYVY is half the bytes of BGRA and every one of them costs main-thread time in IPC;
            // the renderer converts it on the GPU. Sources with alpha still arrive as BGRA.
            const flags = lowbandwidth ? omt.ReceiveFlags.Preview : omt.ReceiveFlags.None
            return new omt.Receiver(address, omt.FrameType.Video, omt.PreferredVideoFormat.UYVYorBGRA, flags)
        } catch (err) {
            console.error("Failed to create OMT receiver:", err)
            return null
        }
    }

    static async findStreamsOMT(): Promise<{ name: string; urlAddress: string }[]> {
        if (this.omtDisabled) return []

        const omt = await loadOMT()
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

    // Thumbnail reception for drawer cards (low bandwidth preview)
    static async receiveStreamFrameOMT({ source }: { source: Source }) {
        if (this.omtDisabled) return
        if (this.OMT_RECEIVERS[source.id]) return

        this.OMT_RECEIVERS[source.id] = { shouldStop: false, source, lowbandwidth: true }
        this.frameLoop(source.id, this.THUMBNAIL_LOOP_DELAY_MS).catch((err) => {
            console.error(`OMT thumbnail error for ${source.id}:`, err)
            this.stopReceiversOMT({ id: source.id })
        })
    }

    // Full reception for output/background
    static async captureStreamOMT({ source, outputId }: { source: Source; outputId: string }) {
        if (this.omtDisabled) return
        if (!this.sendToOutputs.includes(outputId)) this.sendToOutputs.push(outputId)

        // if a thumbnail loop is running, upgrade it to full capture
        if (this.OMT_RECEIVERS[source.id]) {
            this.OMT_RECEIVERS[source.id].shouldStop = true
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
        // drop the low-bandwidth preview receiver so we recreate at full quality
        this.destroyReceiver(source.id)

        this.OMT_RECEIVERS[source.id] = { shouldStop: false, source, lowbandwidth: false }
        this.frameLoop(source.id, this.FULL_LOOP_DELAY_MS).catch((err) => {
            console.error(`OMT reception error for ${source.id}:`, err)
            this.stopReceiversOMT({ id: source.id })
        })
    }

    private static async frameLoop(sourceId: string, delayMs: number) {
        let consecutiveErrors = 0

        while (this.OMT_RECEIVERS[sourceId] && !this.OMT_RECEIVERS[sourceId].shouldStop) {
            try {
                let receiver = this.allActiveReceivers[sourceId]
                if (!receiver) {
                    const receiverData = this.OMT_RECEIVERS[sourceId]
                    const address = this.getAddress(receiverData.source!)
                    receiver = this.allActiveReceivers[sourceId] = await this.createReceiver(address, receiverData.lowbandwidth)
                    if (!receiver) throw new Error("Could not create receiver")
                }

                const frame = await receiver.receive(this.RECEIVE_TIMEOUT_MS, 2 /* Video */)
                if (frame?.data) {
                    this.sendBuffer(sourceId, frame)
                    consecutiveErrors = 0
                }

                // receive() already blocks until the next frame, so pace on the source rather than on a
                // timer: sleeping after every frame pushed the next receive past the frame after it and
                // cost real frames. Idle (no frame) still backs off, and thumbnails keep their slow rate.
                if (frame?.data && delayMs < this.THUMBNAIL_LOOP_DELAY_MS) await new Promise((resolve) => setImmediate(resolve))
                else await new Promise((resolve) => setTimeout(resolve, delayMs))
            } catch (err: any) {
                consecutiveErrors++
                this.destroyReceiver(sourceId)

                if (consecutiveErrors >= 10) {
                    console.error(`OMT source ${sourceId}: too many errors, stopping`)
                    this.stopReceiversOMT({ id: sourceId })
                    return
                }

                await new Promise((resolve) => setTimeout(resolve, Math.min(5 * Math.pow(1.5, consecutiveErrors), 100)))
            }
        }
    }

    // the app window draws this a few hundred pixels wide
    private static PREVIEW_MAX_WIDTH = 480

    static sendBuffer(id: string, frame: any) {
        if (!frame?.data) return

        const format: StreamFrameFormat = frame.codec === this.codecs?.UYVY ? "uyvy" : "bgra"
        const packed = packStreamFrame(frame.data, frame.width, frame.height, frame.stride || 0, format)
        if (!packed) return

        // outputs render the stream itself and need every pixel
        const time = Date.now()
        this.sendToOutputs.forEach((outputId) => OutputHelper.Send.sendToWindow(outputId, { channel: "RECEIVE_STREAM", data: { id, frame: packed, time } }, OMT))

        // the app window only ever previews it (drawer card, output mirror), so it gets a small copy of
        // every frame: full frames here saturated the main thread, but a downscaled one is cheap enough
        // to keep the preview as smooth as the output
        toApp(OMT, { channel: "RECEIVE_STREAM", data: { id, frame: previewStreamFrame(packed, this.PREVIEW_MAX_WIDTH), time } })
    }

    private static destroyReceiver(sourceId: string) {
        const receiver = this.allActiveReceivers[sourceId]
        if (!receiver) return
        try {
            receiver.destroy()
        } catch (err) {
            console.error("Error destroying OMT receiver:", err)
        }
        delete this.allActiveReceivers[sourceId]
    }

    static stopReceiversOMT(data: { id: string; outputId?: string } | null = null) {
        if (data?.id) {
            if (data.outputId) {
                const index = this.sendToOutputs.indexOf(data.outputId)
                if (index >= 0) this.sendToOutputs.splice(index, 1)
            } else {
                this.sendToOutputs = []
            }

            if (!this.sendToOutputs.length && this.OMT_RECEIVERS[data.id]) {
                this.OMT_RECEIVERS[data.id].shouldStop = true
                setTimeout(() => {
                    this.destroyReceiver(data.id)
                    delete this.OMT_RECEIVERS[data.id]
                }, 100)
            }
            return
        }

        Object.keys(this.OMT_RECEIVERS).forEach((id) => {
            if (this.OMT_RECEIVERS[id]) this.OMT_RECEIVERS[id].shouldStop = true
        })
        setTimeout(() => {
            Object.keys(this.allActiveReceivers).forEach((id) => this.destroyReceiver(id))
            this.OMT_RECEIVERS = {}
        }, 100)
    }
}
