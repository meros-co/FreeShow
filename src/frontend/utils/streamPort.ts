// NDI/OMT frames reach this window on a MessagePort from the process that receives them, not over IPC.
//
// The preload hands the port to the page rather than dispatching frames itself. Crossing the
// contextBridge copies every frame a second time, and at 4K that copy pushed a frame's age past the
// 100ms freshness limit the stream components apply — so the output discarded every frame it was sent
// and showed nothing. Reading the port here keeps one copy out of the path entirely.

export type StreamFrameData = { id: string; frame: any; time: number }
type StreamHandler = (data: StreamFrameData) => void

const handlers: { [channel: string]: Set<StreamHandler> } = {}

// Two ways in. Output windows: the preload owns the socket and posts each frame here as a transferred
// ArrayBuffer read out of shared memory (see preload.ts); this side acks after dispatch so the sender
// keeps only what this window draws. The app window (small preview frames): a socket opened here, each
// frame a text header followed by one binary message read in place.
let socket: WebSocket | null = null
let pendingHeader: { ipcChannel: string; id: string; time: number; xres: number; yres: number; format: string } | null = null

function dispatch(ipcChannel: string, data: StreamFrameData) {
    handlers[ipcChannel]?.forEach((handler) => handler(data))
}

function connectStream(targetId: string, port: number, token: string) {
    if (socket) {
        try {
            socket.close()
        } catch {}
        socket = null
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.binaryType = "arraybuffer"
    socket = ws
    ws.onopen = () => ws.send(JSON.stringify({ token, targetId }))
    ws.onmessage = (message: MessageEvent) => {
        if (typeof message.data === "string") {
            try {
                pendingHeader = JSON.parse(message.data)
            } catch {
                pendingHeader = null
            }
            return
        }
        const header = pendingHeader
        pendingHeader = null
        if (!header || !(message.data instanceof ArrayBuffer)) return
        const frame = { xres: header.xres, yres: header.yres, format: header.format, data: new Uint8Array(message.data) }
        dispatch(header.ipcChannel, { id: header.id, frame, time: header.time })
        // ack after dispatch: the sender measures the round trip to size what it keeps in flight
        if (ws.readyState === WebSocket.OPEN) ws.send("1")
    }
    ws.onclose = () => {
        if (socket === ws) socket = null
    }
    ws.onerror = () => {}
}

if (typeof window !== "undefined") {
    window.addEventListener("message", (e: MessageEvent) => {
        const message = e.data
        if (message?.type === "STREAM_FRAME" && message.data instanceof ArrayBuffer) {
            const buffer: ArrayBuffer = message.data
            dispatch(message.ipcChannel, { id: message.id, frame: { xres: message.xres, yres: message.yres, format: message.format, data: new Uint8Array(buffer) }, time: message.time })
            // The components draw in Svelte's flush, a microtask they queued during dispatch; this one
            // runs after it, so the upload has read the buffer and it can go back to be refilled.
            queueMicrotask(() => window.postMessage({ type: "STREAM_ACK", slot: message.slot, data: buffer }, "*", [buffer]))
            return
        }
        if (message?.type === "STREAM_WS" && message.port && message.token) {
            connectStream(String(message.targetId || ""), Number(message.port), String(message.token))
            return
        }
        if (message?.type !== "STREAM_PORT" || !e.ports?.length) return

        const port = e.ports[0]
        port.onmessage = (portMessage: MessageEvent) => {
            const { ipcChannel, args } = portMessage.data || {}
            if (args?.channel === "RECEIVE_STREAM") dispatch(ipcChannel, args.data)

            // Ack even when nothing is listening yet: the sender only keeps a couple of frames in
            // flight, so a missing ack would stall this window's video rather than skip a frame.
            port.postMessage(1)
        }
        port.start()
    })
}

export function onStreamFrame(channel: string, handler: StreamHandler) {
    if (!handlers[channel]) handlers[channel] = new Set()
    handlers[channel].add(handler)

    return () => {
        handlers[channel]?.delete(handler)
    }
}
