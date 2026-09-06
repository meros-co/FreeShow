import { MessageChannelMain, type BrowserWindow, type MessagePortMain } from "electron"
import { getMainWindow } from ".."

// The main window's output previews are fed from the capture, not from their own decode: the readback
// worker already produces a GPU-downscaled frame of each render, and that frame goes to the previewing
// window over a MessagePort. Main only relays the (small) message; it does no pixel work, and the
// preview costs no second video decode.
export class PreviewStream {
    private static refs: { [outputId: string]: number } = {}
    // widest pixel width any subscriber of an output currently draws its preview at (0 = unknown yet)
    private static widths: { [outputId: string]: { [subscriber: string]: number } } = {}
    private static port: MessagePortMain | null = null
    private static portWindow: BrowserWindow | null = null

    static subscribe(outputId: string, subscriber = "", width = 0) {
        this.refs[outputId] = (this.refs[outputId] || 0) + 1
        this.setWidth(outputId, subscriber, width)
        this.ensurePort()
    }

    static unsubscribe(outputId: string, subscriber = "") {
        const refs = (this.refs[outputId] || 0) - 1
        if (refs > 0) this.refs[outputId] = refs
        else delete this.refs[outputId]
        if (this.widths[outputId]) {
            delete this.widths[outputId][subscriber]
            if (!Object.keys(this.widths[outputId]).length) delete this.widths[outputId]
        }
    }

    // a subscriber's preview element was (re)sized: the frame it is sent need be no wider than that
    static setWidth(outputId: string, subscriber: string, width: number) {
        if (!width || !subscriber) return
        ;(this.widths[outputId] ||= {})[subscriber] = Math.round(width)
    }

    // the widest preview any subscriber of these outputs draws (0 = no size known yet)
    static requestedWidth(outputIds: string[]): number {
        let best = 0
        for (const id of outputIds) for (const w of Object.values(this.widths[id] || {})) if (w > best) best = w
        return best
    }

    static hasSubscribers(outputId?: string): boolean {
        if (outputId) return (this.refs[outputId] || 0) > 0
        return Object.keys(this.refs).length > 0
    }

    // called with the worker's downscaled BGRA frame for a render group's members
    static push(memberIds: string[], buffer: ArrayBuffer, byteOffset: number, byteLength: number, size: { width: number; height: number }) {
        if (!this.port) return
        const ids = memberIds.filter((id) => this.hasSubscribers(id))
        if (!ids.length) return
        this.port.postMessage({ ids, width: size.width, height: size.height, data: new Uint8Array(buffer, byteOffset, byteLength) })
    }

    private static ensurePort() {
        const window = getMainWindow()
        if (!window || window.isDestroyed()) return
        if (this.port && this.portWindow === window) return

        this.dropPort()
        const { port1, port2 } = new MessageChannelMain()
        window.webContents.postMessage("PREVIEW_PORT", null, [port2])
        port1.start()
        this.port = port1
        this.portWindow = window

        // a reloaded or closed window takes its end of the port with it: its components re-subscribe
        // when they mount again, which wires a fresh port
        const drop = () => {
            if (this.portWindow !== window) return
            this.dropPort()
            this.refs = {}
        }
        window.once("closed", drop)
        window.webContents.once("render-process-gone", drop)
        window.webContents.on("did-start-navigation", (details) => {
            if (details.isMainFrame && !details.isSameDocument) drop()
        })
    }

    private static dropPort() {
        try {
            this.port?.close()
        } catch {
            // already gone
        }
        this.port = null
        this.portWindow = null
    }
}
