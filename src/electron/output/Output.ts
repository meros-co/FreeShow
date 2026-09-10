import type { BrowserWindow, Rectangle } from "electron"
import type { RtmpData } from "../../types/Output"
import type { CaptureOptions } from "../capture/CaptureOptions"

export class Output {
    window!: BrowserWindow
    // A displayed output's window cannot be offscreen, so while such an output is captured it gets a
    // hidden offscreen surface rendering the same content, and that is what the capture reads. It is not
    // created when another output is already rendering this content: see `presenter`.
    captureWindow?: BrowserWindow
    // This output shows on a monitor but renders nothing: another output's render of the same content is
    // read back once and this window draws it. Unlike a follower it owns its window - it just never puts
    // content in it. One render, one readback, however many outputs show it.
    presenter?: boolean
    osr?: boolean // captured via offscreen paint events instead of the capturePage poll
    // shared-render (FS_SHARE_RENDER): this output is a FOLLOWER sharing `renderGroupRenderer`'s window +
    // capture (pixel-identical content). It owns no window and is fed by the renderer's fan-out.
    follower?: boolean
    renderGroupRenderer?: string
    invisible?: boolean
    boundsLocked?: boolean
    screen?: string | null
    intendedBounds?: Rectangle
    // the resolution this output SENDS at (its configured size). A shared render runs at the largest
    // member's size; smaller members are downscaled to their sendSize in the same readback pass.
    sendSize?: { width: number; height: number }
    transparent?: boolean
    webrtcData?: any
    rtmpData?: RtmpData
    // previewWindow: BrowserWindow
    captureOptions?: CaptureOptions
    /*
    previewBounds?: {
        x: number
        y: number
        width: number
        height: number
    }*/
}
