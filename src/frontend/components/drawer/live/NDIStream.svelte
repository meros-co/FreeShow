<script lang="ts" context="module">
    let streamInstances = 0
</script>

<script lang="ts">
    import { onDestroy, onMount } from "svelte"
    import { NDI } from "../../../../types/Channels"
    import { outputs } from "../../../stores"
    import { destroy, receive, send } from "../../../utils/request"
    import { findMatchingOut } from "../../helpers/output"
    import Card from "../Card.svelte"
    import { StreamCanvasRenderer } from "./streamCanvas"
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
            if (!mirror) send(NDI, ["CAPTURE_STREAM"], { source: screen, outputId: Object.keys($outputs)[0] })
        } else send(NDI, ["RECEIVE_STREAM"], { source: screen })
    })

    const renderer = new StreamCanvasRenderer()
    $: if (frame && canvas) renderer.draw(canvas, frame)

    const receiveNDI = {
        RECEIVE_STREAM: (data: { id: string; frame: any; time: number }) => {
            if (data.id !== screen.id) return
            loaded = true

            let timeSinceSent = Date.now() - data.time
            if (timeSinceSent > 100) return // skip frames if overloaded

            frame = data.frame
        }
    }

    // The preload keeps one listener per id, so instances must not share one: two components showing
    // the same source (a drawer card and an output's preview, say) would collapse to a single listener
    // and whichever unmounted first would silence the other.
    const receiverId = `${screen.id}#${++streamInstances}`

    receive(NDI, receiveNDI, receiverId)
    onDestroy(() => {
        renderer.destroy()
        destroy(NDI, receiverId)
        if (background && !mirror) send(NDI, ["CAPTURE_DESTROY"], { id: screen.id, outputId: Object.keys($outputs)[0] })
    })

    let loaded = false
</script>

{#if background}
    <canvas bind:this={canvas} />
{:else}
    <!-- class="context #screen_card" -->
    <Card outlineColor={findMatchingOut(screen.id, $outputs)} active={findMatchingOut(screen.id, $outputs) !== null} on:click title={screen.name} label={screen.name} {loaded} icon="ndi" white showPlayOnHover>
        <SelectElem style="display: flex;" id="ndi" data={{ id: screen.id, type: "ndi", name: screen.name }} draggable>
            <canvas bind:this={canvas} />
        </SelectElem>
    </Card>
{/if}

<style>
    canvas {
        width: 100%;
        height: 100%;
        /* aspect-ratio: 1920/1080; */

        object-fit: contain;
    }
</style>
