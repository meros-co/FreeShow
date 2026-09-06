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
    $: subscribePreview(captured && !stageOutput ? outputId : "")
    function subscribePreview(id: string) {
        if (id === subscribedId) return
        if (subscribedId) {
            send(OUTPUT, ["PREVIEW_UNSUBSCRIBE"], { id: subscribedId })
            unlisten?.()
            unlisten = null
        }
        subscribedId = id
        if (!id) return
        send(OUTPUT, ["PREVIEW_SUBSCRIBE"], { id })
        unlisten = onPreviewFrame(id, (frame) => {
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
    {:else if captured}
        <canvas class="capturePreview" bind:this={previewCanvas} />
    {:else}
        <Output {outputId} style={getStyleResolution(resolution, fullscreen ? width : resolution.width, fullscreen ? height : resolution.height, "fit")} mirror preview={!disableTransitions} />
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
