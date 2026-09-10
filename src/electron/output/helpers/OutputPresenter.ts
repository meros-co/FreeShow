import type { BrowserWindow } from "electron"
import { OUTPUT } from "../../../types/Channels"
import { NdiSender } from "../../ndi/NdiSender"
import { OutputHelper } from "../OutputHelper"

// A captured output that is also shown on a monitor must render its content ONCE. The render is the
// offscreen surface the capture reads; the on-screen window draws that same frame instead of rendering
// the content a second time. Frames reach it from the capture worker over the shared-memory transport
// (capture/FrameServer.ts in the worker, streamLink.ts in the window's preload) — main relays only the
// socket details and never a pixel.
export class OutputPresenter {
    private static wsInfo: { port: number; token: string } | null = null
    private static presenting = new Set<string>()
    private static wanted = new Set<string>()
    private static hooked = false

    static isPresenting(id: string) {
        return this.presenting.has(id)
    }

    private static hook() {
        if (this.hooked) return
        this.hooked = true
        NdiSender.presentMessageHandler = (msg) => {
            if (msg.type === "presentWs") {
                this.wsInfo = { port: msg.port, token: msg.token }
                for (const id of [...this.wanted]) this.wire(id)
            } else if (msg.type === "presentNeedTarget") {
                this.wire(msg.targetId)
            }
        }
    }

    // the window draws the capture from now on: it stops rendering the content itself
    static start(id: string, window: BrowserWindow) {
        this.hook()
        if (this.presenting.has(id)) return
        this.presenting.add(id)
        if (!window.isDestroyed()) window.webContents.send(OUTPUT, { channel: "PRESENT", data: { id, active: true } })
        this.wire(id)
    }

    static stop(id: string) {
        if (!this.presenting.delete(id)) return
        this.wanted.delete(id)
        const window = OutputHelper.getOutput(id)?.window
        if (window && !window.isDestroyed()) window.webContents.send(OUTPUT, { channel: "PRESENT", data: { id, active: false } })
        NdiSender.postToWorker({ type: "presentReset" })
    }

    // the worker asks once per target, so an output wired before the socket existed is remembered
    private static wire(id: string) {
        if (!this.presenting.has(id) || !this.wsInfo) {
            this.wanted.add(id)
            return
        }
        const window = OutputHelper.getOutput(id)?.window
        if (!window || window.isDestroyed()) {
            this.wanted.add(id)
            return
        }
        this.wanted.delete(id)
        window.webContents.send("STREAM_WS", { targetId: id, port: this.wsInfo.port, token: this.wsInfo.token })
    }
}
