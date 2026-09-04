<script lang="ts">
    import { onDestroy, onMount } from "svelte"
    import { OMT } from "../../../../types/Channels"
    import { outputs } from "../../../stores"
    import { destroy, receive, send } from "../../../utils/request"
    import { findMatchingOut } from "../../helpers/output"
    import Card from "../Card.svelte"
    import SelectElem from "../../system/SelectElem.svelte"

    interface Screen {
        id: string
        name: string
    }
    export let screen: Screen
    let frame: any
    export let background = false
    export let mirror = false

    let canvas: HTMLCanvasElement | undefined

    onMount(() => {
        if (background) {
            if (!mirror) send(OMT, ["CAPTURE_STREAM"], { source: screen, outputId: Object.keys($outputs)[0] })
        } else send(OMT, ["RECEIVE_STREAM"], { source: screen })
    })

    $: if (frame) setCanvas()
    function setCanvas() {
        if (!canvas) return

        let ctx = canvas.getContext("2d")

        const WIDTH = frame.xres
        const HEIGHT = frame.yres
        canvas.width = WIDTH
        canvas.height = HEIGHT

        const pixels = new Uint8ClampedArray(frame.data)
        // frames arrive as BGRA: swapping channels in the main process would cost it a pass over every
        // pixel of every frame, so the swap happens here instead
        if (frame.format === "bgra") {
            const words = new Uint32Array(pixels.buffer)
            for (let i = 0; i < words.length; i++) {
                const p = words[i]
                words[i] = (p & 0xff00ff00) | ((p & 0x00ff0000) >>> 16) | ((p & 0x000000ff) << 16)
            }
        }

        const imageData = new ImageData(pixels, WIDTH, HEIGHT)
        ctx?.putImageData(imageData, 0, 0)
    }

    const receiveOMT = {
        RECEIVE_STREAM: (data: { id: string; frame: any; time: number }) => {
            if (data.id !== screen.id) return
            loaded = true

            let timeSinceSent = Date.now() - data.time
            if (timeSinceSent > 100) return // skip frames if overloaded

            frame = data.frame
        }
    }

    receive(OMT, receiveOMT, screen.id)
    onDestroy(() => {
        destroy(OMT, screen.id)
        if (background && !mirror) send(OMT, ["CAPTURE_DESTROY"], { id: screen.id, outputId: Object.keys($outputs)[0] })
    })

    let loaded = false
</script>

{#if background}
    <canvas bind:this={canvas} />
{:else}
    <Card outlineColor={findMatchingOut(screen.id, $outputs)} active={findMatchingOut(screen.id, $outputs) !== null} on:click title={screen.name} label={screen.name} {loaded} icon="omt" white showPlayOnHover>
        <SelectElem style="display: flex;" id="omt" data={{ id: screen.id, type: "omt", name: screen.name }} draggable>
            <canvas bind:this={canvas} />
        </SelectElem>
    </Card>
{/if}

<style>
    canvas {
        width: 100%;
        height: 100%;

        object-fit: contain;
    }
</style>
