// Output previews in the main window are drawn from the capture's downscaled frames, delivered on a
// MessagePort from the main process (see electron/capture/PreviewStream.ts). No decode happens here.

export type PreviewFrame = { width: number; height: number; data: Uint8Array }
type PreviewHandler = (frame: PreviewFrame) => void

const handlers: { [outputId: string]: Set<PreviewHandler> } = {}

if (typeof window !== "undefined") {
    window.addEventListener("message", (e: MessageEvent) => {
        if (e.data?.type !== "PREVIEW_PORT" || !e.ports?.length) return

        const port = e.ports[0]
        port.onmessage = (message: MessageEvent) => {
            const { ids, width, height, data } = message.data || {}
            if (!Array.isArray(ids) || !data) return
            const frame: PreviewFrame = { width, height, data }
            for (const id of ids) handlers[id]?.forEach((handler) => handler(frame))
        }
        port.start()
    })
}

export function onPreviewFrame(outputId: string, handler: PreviewHandler) {
    if (!handlers[outputId]) handlers[outputId] = new Set()
    handlers[outputId].add(handler)

    return () => {
        handlers[outputId]?.delete(handler)
    }
}
