<script lang="ts">
    import { onDestroy } from "svelte"
    import { OUTPUT } from "../../../../types/Channels"
    import { livePrepare, outputs, styles } from "../../../stores"
    import { onPreviewFrame } from "../../../utils/previewPort"
    import { send } from "../../../utils/request"
    import { StreamCanvasRenderer } from "../../drawer/live/streamCanvas"
    import Icon from "../../helpers/Icon.svelte"
    //import { currentWindow, outputs, styles } from "../../../stores"
    import { getResolution } from "../../helpers/output"
    import { getStyleResolution } from "../../slide/getStyleResolution"
    import StageLayout from "../../stage/StageLayout.svelte"
    import Output from "../Output.svelte"

    export let fullscreen = false
    export let disableTransitions = false
    export let disabled = false
    export let outputId = ""
    export let style = ""

    $: resolution = getResolution(null, [$outputs, $styles], false, outputId)
    let width = 0
    let height = 0

    $: stageOutput = $outputs[outputId]?.stageOutput

    // A captured output (NDI/OMT/streaming/Blackmagic) renders offscreen and is read back for its
    // senders; its preview is that readback, downscaled, so the preview never decodes the media again.
    $: output = $outputs[outputId]
    $: captured = !!output && !!(output.ndi || output.omt || output.webrtc || output.rtmp || output.blackmagic)

    let previewCanvas: HTMLCanvasElement | null = null
    const renderer = new StreamCanvasRenderer()
    let subscribedId = ""
    let unlisten: (() => void) | null = null
    // this preview instance, so main can size the frame to the widest preview actually drawn
    const subscriber = "p" + Math.random().toString(36).slice(2, 10)
    $: drawnWidth = Math.round(width * (window.devicePixelRatio || 1))
    $: if (subscribedId && drawnWidth) send(OUTPUT, ["PREVIEW_SIZE"], { id: subscribedId, subscriber, width: drawnWidth })

    // The preview must never be blank. Capture frames arrive only once the output's capture is running
    // (and only on the off-main capture path), so the mirrored output stays on screen until frames flow,
    // and comes back if they stop. "Stopped" is judged against the measured arrival interval, not a
    // fixed time: no frame for several measured intervals means the capture is not feeding us.
    let liveCapture = false
    let lastFrameAt = 0
    let frameInterval = 0
    let staleTimer: ReturnType<typeof setTimeout> | null = null
    function noteFrame() {
        const now = performance.now()
        if (lastFrameAt) {
            const gap = now - lastFrameAt
            frameInterval = frameInterval ? frameInterval * 0.8 + gap * 0.2 : gap
        }
        lastFrameAt = now
        if (frameInterval) {
            liveCapture = true
            if (staleTimer) clearTimeout(staleTimer)
            staleTimer = setTimeout(() => {
                liveCapture = false
                staleTimer = null
            }, frameInterval * 4)
        }
    }
    function resetLive() {
        liveCapture = false
        lastFrameAt = 0
        frameInterval = 0
        if (staleTimer) clearTimeout(staleTimer)
        staleTimer = null
    }

    $: subscribePreview(captured && !stageOutput ? outputId : "")
    function subscribePreview(id: string) {
        if (id === subscribedId) return
        if (subscribedId) {
            send(OUTPUT, ["PREVIEW_UNSUBSCRIBE"], { id: subscribedId, subscriber })
            unlisten?.()
            unlisten = null
        }
        subscribedId = id
        resetLive()
        if (!id) return
        send(OUTPUT, ["PREVIEW_SUBSCRIBE"], { id, subscriber, width: drawnWidth })
        unlisten = onPreviewFrame(id, (frame) => {
            noteFrame()
            if (previewCanvas) renderer.draw(previewCanvas, { xres: frame.width, yres: frame.height, data: frame.data, format: "bgra" })
        })
    }
    onDestroy(() => {
        subscribePreview("")
        renderer.destroy()
    })
</script>

<!-- class:fullscreen={fullscreen && !stageOutput} -->
<div class="center previewOutput" id={outputId} class:disabled style={style + ("; aspect-ratio: " + resolution.width + "/" + resolution.height + ";")} bind:offsetWidth={width} bind:offsetHeight={height}>
    {#if stageOutput}
        <StageLayout {outputId} stageId={stageOutput} preview={!disableTransitions} edit={false} />
    {:else}
        {#if captured}
            <canvas class="capturePreview" class:hidden={!liveCapture} bind:this={previewCanvas} />
        {/if}
        {#if !captured || !liveCapture}
            <Output {outputId} style={getStyleResolution(resolution, fullscreen ? width : resolution.width, fullscreen ? height : resolution.height, "fit")} mirror preview={!disableTransitions} />
        {/if}
    {/if}

    {#if !fullscreen && $livePrepare[outputId]}
        <div class="blackOverlay">
            <Icon id="hide" size={2.5} white />
        </div>
    {/if}
</div>

<style>
    .center {
        display: flex;
        align-items: center;
        justify-content: center;

        height: 100%;
        width: 100%;

        /* max-height: 50vh; */
    }
    /* .center.fullscreen {
        width: 100%;
        height: 100%;
    } */

    .center.disabled {
        opacity: 0.4;
    }

    .capturePreview {
        width: 100%;
        height: 100%;
        object-fit: contain;
        background-color: black;
    }
    .capturePreview.hidden {
        display: none;
    }

    .previewOutput :global(.main) {
        width: 100%;

        /* disable e.g. YouTube video controls on hover */
        pointer-events: none;
    }

    .blackOverlay {
        position: absolute;
        width: 100%;
        height: 100%;

        display: flex;
        align-items: center;
        justify-content: center;

        background-color: black;
        opacity: 0.3;
    }
</style>
