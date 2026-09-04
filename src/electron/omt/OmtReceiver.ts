import { toApp } from ".."
import { OMT } from "../../types/Channels"
import { packStreamFrame, previewStreamFrame, type StreamFrameFormat } from "../capture/streamFrames"
import { loadOMT } from "./omtModule"
import { OutputHelper } from "../output/OutputHelper"

type Source = { name: string; urlAddress?: string; id: string }

// One loop per source. The loop is the only thing that ever calls receive() or destroy() on its
// instance, and it destroys the instance itself after its final receive() has settled: the addon runs
// receive() on the libuv threadpool holding the raw libomt pointer, so a destroy from anywhere else
// while one is in flight is a use-after-free in libomt (an access violation, or a Napi::Error thrown
// from the completion on the main thread, which is fatal). Stopping or replacing a record ends its loop
// at the next check, and callers that need the instance gone await the loop rather than a timer.
type Loop = {
    source: Source
    lowbandwidth: boolean
    stopped: boolean
    receiver: any
    done: Promise<void>
    wake: (() => void) | null
}

export class OmtReceiver {
    static omtDisabled = false
    static sendToOutputs: string[] = []
    private static loops: { [sourceId: string]: Loop } = {}
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

            // UYVY where the source allows it; the renderer converts on the GPU. Sources with alpha still arrive as BGRA.
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
        if (this.loops[source.id]) return

        this.startLoop(source, true, this.THUMBNAIL_LOOP_DELAY_MS)
    }

    // Full reception for output/background
    static async captureStreamOMT({ source, outputId }: { source: Source; outputId: string }) {
        if (this.omtDisabled) return
        if (!this.sendToOutputs.includes(outputId)) this.sendToOutputs.push(outputId)

        // a thumbnail loop holds a low-bandwidth instance: end it, and wait until it has released
        // that instance, before starting the full-quality one
        const existing = this.loops[source.id]
        if (existing) {
            if (!existing.lowbandwidth) return
            await this.stopLoop(existing)
        }

        this.startLoop(source, false, this.FULL_LOOP_DELAY_MS)
    }

    private static startLoop(source: Source, lowbandwidth: boolean, delayMs: number) {
        const loop: Loop = { source, lowbandwidth, stopped: false, receiver: null, done: Promise.resolve(), wake: null }
        this.loops[source.id] = loop
        loop.done = this.frameLoop(source.id, loop, delayMs).catch((err) => {
            console.error(`OMT reception error for ${source.id}:`, err)
        })
    }

    // ends the loop and resolves once it has destroyed its instance
    private static stopLoop(loop: Loop) {
        loop.stopped = true
        loop.wake?.()
        return loop.done
    }

    // a sleep that ends early when the loop is stopped, so a stop never waits out a thumbnail interval
    private static pause(loop: Loop, ms: number) {
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

    private static async frameLoop(sourceId: string, loop: Loop, delayMs: number) {
        let consecutiveErrors = 0

        try {
            // a replaced record belongs to a newer loop for the same source: this one is finished
            while (!loop.stopped && this.loops[sourceId] === loop) {
                try {
                    if (!loop.receiver) {
                        loop.receiver = await this.createReceiver(this.getAddress(loop.source), loop.lowbandwidth)
                        if (!loop.receiver) throw new Error("Could not create receiver")
                        if (loop.stopped) break
                    }

                    const frame = await loop.receiver.receive(this.RECEIVE_TIMEOUT_MS, 2 /* Video */)
                    if (loop.stopped) break
                    if (frame?.data) {
                        this.sendBuffer(sourceId, frame)
                        consecutiveErrors = 0
                    }

                    // receive() already blocks until the next frame, so pace on the source rather than a timer.
                    // Idle (no frame) still backs off, and thumbnails keep their slow rate.
                    if (frame?.data && delayMs < this.THUMBNAIL_LOOP_DELAY_MS) await new Promise((resolve) => setImmediate(resolve))
                    else await this.pause(loop, delayMs)
                } catch (err: any) {
                    consecutiveErrors++
                    // the failed receive() has settled, so this loop's instance can be dropped and recreated
                    this.destroyInstance(loop)

                    if (consecutiveErrors >= 10) {
                        console.error(`OMT source ${sourceId}: too many errors, stopping`)
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

    private static destroyInstance(loop: Loop) {
        const receiver = loop.receiver
        loop.receiver = null
        if (!receiver) return
        try {
            receiver.destroy()
        } catch (err) {
            console.error("Error destroying OMT receiver:", err)
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

        // the app window only ever previews it (drawer card, output mirror), so it gets a small copy of every frame
        toApp(OMT, { channel: "RECEIVE_STREAM", data: { id, frame: previewStreamFrame(packed, this.PREVIEW_MAX_WIDTH), time } })
    }

    static stopReceiversOMT(data: { id: string; outputId?: string } | null = null): Promise<void> {
        if (data?.id) {
            if (data.outputId) {
                const index = this.sendToOutputs.indexOf(data.outputId)
                if (index >= 0) this.sendToOutputs.splice(index, 1)
            } else {
                this.sendToOutputs = []
            }

            const loop = this.loops[data.id]
            if (!this.sendToOutputs.length && loop) return this.stopLoop(loop)
            return Promise.resolve()
        }

        return Promise.all(Object.values(this.loops).map((loop) => this.stopLoop(loop))).then(() => undefined)
    }
}
