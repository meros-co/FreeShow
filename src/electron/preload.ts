// ----- FreeShow -----
// Expose protected methods that allow the renderer process to use the ipcRenderer without exposing the entire object

import type { IpcRendererEvent } from "electron"
import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { ValidChannels } from "../types/Channels"

// const maxInterval: number = 500
// const useTimeout: ValidChannels[] = ["STAGE", "REMOTE", "CONTROLLER", "OUTPUT_STREAM"]
// let lastChannel: string = ""

// wait to log messages until after intial load is done
let appLoaded = false
const LOG_MESSAGES: boolean = process.env.NODE_ENV !== "production"
const filteredChannelsData: string[] = ["PLAYING_VIDEO_STATE", "VISUALIZER_DATA", "STREAM", "BUFFER", "GET_THUMBNAIL", "ACTIVE_TIMERS", "RECEIVE_STREAM", "CHECK_RAM_USAGE", "TIMECODE_VALUE", "TIMECODE_AUDIO_DATA", "SPOTIFY_GET_STATE"]
const filteredChannels: ValidChannels[] = ["AUDIO"]

const storedReceivers: {
    [key: string]: (e: IpcRendererEvent, args: any) => void
} = {}

contextBridge.exposeInMainWorld("api", {
    send: (channel: ValidChannels, data: any, id?: string) => {
        if (LOG_MESSAGES && appLoaded && !filteredChannels.includes(channel) && !filteredChannelsData.includes(data?.channel)) console.info("TO ELECTRON [" + channel + "]: ", data)
        // if (useTimeout.includes(channel) && data.channel === lastChannel && data.id) return

        ipcRenderer.send(channel, data, id)

        // lastChannel = data.channel
        // setTimeout(() => (lastChannel = ""), maxInterval)
    },
    receive: (channel: ValidChannels, func: any, id?: string) => {
        const receiver = (_e: IpcRendererEvent, args: any, listenedId?: string) => {
            if (!appLoaded && channel === "MAIN" && args?.channel === "SHOWS") setTimeout(() => (appLoaded = true), 5000)
            if (LOG_MESSAGES && appLoaded && !filteredChannels.includes(channel) && !filteredChannelsData.includes(args?.channel)) console.info("TO CLIENT [" + channel + "]: ", args)

            func(args, listenedId)
        }

        if (id && storedReceivers[id]) {
            ipcRenderer.removeListener(channel, storedReceivers[id])
        }

        ipcRenderer.on(channel, receiver)
        if (id) storedReceivers[id] = receiver
    },
    removeListener: (channel: ValidChannels, id: string) => {
        if (!storedReceivers[id]) return

        ipcRenderer.removeListener(channel, storedReceivers[id])
        delete storedReceivers[id]
    },
    getListeners: () => {
        return ipcRenderer.eventNames().map((channel) => [channel.toString(), ipcRenderer.listenerCount(channel)])
    },
    // https://www.electronjs.org/blog/electron-32-0#breaking-changes
    showFilePath(file: File) {
        return webUtils.getPathForFile(file)
    }
})

// One port per window, handed over the first time the receiving process has a frame for it. It is
// forwarded straight into the page instead of being read here: dispatching from the preload copies
// every frame across the contextBridge again, which at 4K made frames arrive too old to be drawn.
ipcRenderer.on("PREVIEW_PORT", (event) => {
    window.postMessage({ type: "PREVIEW_PORT" }, "*", [event.ports[0]])
})

// Shared-memory frames (see streamReceiverProcess.ts). This window's frame socket lives here when the
// native module loads: each header names a ring slot, whose bytes are copied once into a fresh
// ArrayBuffer that is then transferred (not copied) to the page. The page acks after it has handed the
// frame to its drawing components, which frees the slot and paces the sender to this window.
let shmModule: any = null
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    shmModule = require("osr-capture")
    if (typeof shmModule?.shmRead !== "function") shmModule = null
} catch (err) {
    console.error("[stream] shared memory unavailable in this window:", err)
    shmModule = null
}

const streamDiag = { reads: 0, readMs: 0, ageMs: 0 }
if (process.env.FS_CAP_STATS) {
    setInterval(() => {
        if (!streamDiag.reads) return
        console.info(`[RX-WINDOW] frames=${streamDiag.reads} copy=${(streamDiag.readMs / streamDiag.reads).toFixed(1)}ms/frame age=${(streamDiag.ageMs / streamDiag.reads).toFixed(0)}ms`)
        streamDiag.reads = streamDiag.readMs = streamDiag.ageMs = 0
    }, 1000)
}
let streamSocket: WebSocket | null = null

let streamRing: { name: string; slotBytes: number } | null = null
function dropStreamRing() {
    if (!streamRing) return
    try {
        shmModule?.shmUnmap(streamRing.name)
    } catch {}
    streamRing = null
}
function connectSharedStream(targetId: string, port: number, token: string) {
    try {
        streamSocket?.close()
    } catch {}
    dropStreamRing()
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.binaryType = "arraybuffer"
    streamSocket = ws
    ws.onopen = () => ws.send(JSON.stringify({ token, targetId, shm: true }))
    ws.onmessage = (message: MessageEvent) => {
        if (typeof message.data !== "string") return
        let header: any = null
        try {
            header = JSON.parse(message.data)
        } catch {
            return
        }
        if (!header || header.slot === undefined) return
        if (header.shm && header.shm.name !== streamRing?.name) {
            dropStreamRing()
            try {
                shmModule.shmMap(header.shm.name, header.shm.slotBytes * header.shm.slots, false)
                streamRing = { name: header.shm.name, slotBytes: header.shm.slotBytes }
            } catch (err) {
                console.error("[stream] cannot map frame ring:", err)
            }
        }
        if (!streamRing) {
            if (ws.readyState === WebSocket.OPEN) ws.send("1:" + header.slot)
            return
        }
        // a buffer the page has handed back, or a new one; the copy runs on the thread pool so this
        // thread is free to draw the previous frame meanwhile
        const reuse = spareBuffers.findIndex((b) => b.byteLength === header.bytes)
        const data = reuse >= 0 ? spareBuffers.splice(reuse, 1)[0] : new ArrayBuffer(header.bytes)
        const tRead = performance.now()
        const ring = streamRing
        shmModule.shmReadAsync(ring.name, header.slot * ring.slotBytes, new Uint8Array(data)).then(
            () => {
                streamDiag.reads++
                streamDiag.readMs += performance.now() - tRead
                streamDiag.ageMs += Date.now() - header.time
                window.postMessage({ type: "STREAM_FRAME", ipcChannel: header.ipcChannel, id: header.id, time: header.time, xres: header.xres, yres: header.yres, format: header.format, slot: header.slot, data }, "*", [data])
            },
            (err: any) => {
                console.error("[stream] cannot read frame:", err)
                if (ws.readyState === WebSocket.OPEN) ws.send("1:" + header.slot)
            }
        )
    }
    ws.onclose = () => {
        if (streamSocket === ws) streamSocket = null
        dropStreamRing()
    }
    ws.onerror = () => {}
}
// buffers the page has finished with, transferred back to be filled again
const spareBuffers: ArrayBuffer[] = []
window.addEventListener("message", (e: MessageEvent) => {
    if (e.data?.type !== "STREAM_ACK") return
    if (e.data.data instanceof ArrayBuffer && e.data.data.byteLength && spareBuffers.length < 4) spareBuffers.push(e.data.data)
    if (streamSocket && streamSocket.readyState === WebSocket.OPEN) streamSocket.send("1:" + e.data.slot)
})

ipcRenderer.on("STREAM_WS", (_event, data) => {
    if (shmModule) connectSharedStream(String(data?.targetId || ""), Number(data?.port), String(data?.token))
    else window.postMessage({ type: "STREAM_WS", targetId: data?.targetId, port: data?.port, token: data?.token }, "*")
})

ipcRenderer.on("STREAM_PORT", (event) => {
    if (!event.ports?.length) return
    window.postMessage({ type: "STREAM_PORT" }, "*", [event.ports[0]])
})

ipcRenderer.on("AUDIO_PORT", (event, data) => {
    if (event.ports && event.ports.length > 0) {
        window.postMessage({ type: "AUDIO_PORT_RESPONSE", targetId: data?.targetId }, "*", [event.ports[0]])
    }
})
