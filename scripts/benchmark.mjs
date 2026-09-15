// The acceptance gate for output performance work.
//
// Runs the real app, puts content on the outputs, attaches a real receiver to EVERY enabled NDI and OMT
// output, and reports the unique frames per second each one actually delivered. Repeat filler gets no
// credit, and the rate the SOURCE delivered is always reported next to it: an output can only be judged
// short once the input is proven to have arrived faster than the output left.
//
//   node scripts/benchmark.mjs                          # 4K60 clip from media.json, 25s
//   node scripts/benchmark.mjs --seconds=40
//   node scripts/benchmark.mjs --source="SHIFU (DrawLive TestSrc)"   # live OMT input instead of a clip
//   node scripts/benchmark.mjs --media="C:\\clip.mp4"
//   node scripts/benchmark.mjs --no-launch              # use an app that is already running
//
// With --no-launch the app must have been started with FS_CAP_STATS=1, and --log=<path> must point at
// its output, because the per-stage telemetry is only on stdout.

import { spawn } from "child_process"
import { createRequire } from "module"
import fs from "fs"
import os from "os"
import path from "path"

const require = createRequire(import.meta.url)
const REST = "http://localhost:5506"

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, ...rest] = a.replace(/^--/, "").split("=")
        return [k, rest.length ? rest.join("=") : true]
    })
)
const SECONDS = Number(args.seconds || 25)
const LAUNCH = !args["no-launch"]

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- app

let child = null
let logPath = args.log || path.join(os.tmpdir(), "freeshow-benchmark.log")
let logStream = null

function launch() {
    logStream = fs.createWriteStream(logPath)
    child = spawn("npm", ["start"], { env: { ...process.env, FS_CAP_STATS: "1" }, shell: true })
    child.stdout.on("data", (d) => logStream.write(d))
    child.stderr.on("data", (d) => logStream.write(d))
    log(`launched the app, telemetry -> ${logPath}`)
}

async function post(body) {
    const res = await fetch(REST, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error("REST " + res.status)
}

async function waitForRest(timeoutMs) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
        try {
            // any HTTP answer means the server is up; an unknown action still gets a response
            await fetch(REST, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
            return true
        } catch {
            await sleep(2000)
        }
    }
    return false
}

// ---------------------------------------------------------------- content

function defaultMedia() {
    const file = path.join(os.homedir(), "AppData", "Roaming", "FreeShow", "media.json")
    try {
        const raw = fs.readFileSync(file, "utf8")
        const m = raw.match(/[A-Za-z]:\\\\[^"]*?\.(?:mp4|mov|mkv)/)
        if (m) return m[0].replace(/\\\\/g, "\\")
    } catch {}
    return null
}

// ---------------------------------------------------------------- receivers

async function omtOutputs() {
    try {
        const omt = require(path.join(process.cwd(), "node_modules", "openmediatransport"))
        const all = (await omt.getAddresses()) || []
        return all.filter((n) => n.includes("FreeShow"))
    } catch (err) {
        log("  (no OMT module: " + err.message + ")")
        return []
    }
}

async function ndiOutputs() {
    try {
        const grandiose = require("grandiose")
        const finder = await grandiose.find({ showLocalSources: true })
        let sources = []
        for (let i = 0; i < 8; i++) {
            try {
                await finder.wait(1000)
            } catch {}
            sources = await finder.sources()
            if (sources.some((s) => (s.name || "").includes("FreeShow"))) break
        }
        return sources.filter((s) => (s.name || "").includes("FreeShow"))
    } catch (err) {
        log("  (no NDI module: " + err.message + ")")
        return []
    }
}

// Each receiver runs to the end of the measurement window. Their own frame counts are reported next to
// the sender's, because a receiver that cannot keep up would otherwise look like a sender that is slow.
function receiveOmt(name, seconds) {
    const state = { name, frames: 0, kind: "omt" }
    ;(async () => {
        const omt = require(path.join(process.cwd(), "node_modules", "openmediatransport"))
        const receiver = new omt.Receiver(name, omt.FrameType.Video, omt.PreferredVideoFormat.UYVYorBGRA, 0)
        const until = Date.now() + seconds * 1000
        while (Date.now() < until) {
            try {
                const f = await receiver.receive(200, 2)
                if (f?.data) state.frames++
            } catch {}
        }
        try {
            receiver.destroy()
        } catch {}
    })().catch((err) => log("  omt receiver " + name + ": " + err.message))
    return state
}

function receiveNdi(source, seconds) {
    const state = { name: source.name, frames: 0, kind: "ndi" }
    ;(async () => {
        const grandiose = require("grandiose")
        const receiver = await grandiose.receive({ source, colorFormat: grandiose.COLOR_FORMAT_UYVY_BGRA, bandwidth: grandiose.BANDWIDTH_HIGHEST })
        const until = Date.now() + seconds * 1000
        while (Date.now() < until) {
            try {
                const f = await receiver.video(500)
                if (f) state.frames++
            } catch {}
        }
    })().catch((err) => log("  ndi receiver " + source.name + ": " + err.message))
    return state
}

// The live source's own delivered rate, so a shortfall is never blamed on the app without proof.
function measureSource(name, seconds) {
    const state = { name, frames: 0 }
    ;(async () => {
        const omt = require(path.join(process.cwd(), "node_modules", "openmediatransport"))
        const receiver = new omt.Receiver(name, omt.FrameType.Video, omt.PreferredVideoFormat.UYVYorBGRA, 0)
        const until = Date.now() + seconds * 1000
        while (Date.now() < until) {
            try {
                const f = await receiver.receive(200, 2)
                if (f?.data) state.frames++
            } catch {}
        }
        try {
            receiver.destroy()
        } catch {}
    })().catch(() => {})
    return state
}

// ---------------------------------------------------------------- telemetry

function readTelemetry(from) {
    let text = ""
    try {
        text = fs.readFileSync(logPath, "utf8").slice(from)
    } catch {
        return null
    }
    const senders = {}
    for (const m of text.matchAll(/\[SEND-STATS ([^\]]+)\] sentReal=(\d+) sentRepeat=(\d+)/g)) {
        const id = m[1]
        senders[id] ||= { real: [], repeat: [] }
        senders[id].real.push(Number(m[2]))
        senders[id].repeat.push(Number(m[3]))
    }
    const paints = [...text.matchAll(/\[CAP-STATS [^\]]+\][^\n]*?paints=(\d+)/g)].map((m) => Number(m[1]))
    const offered = [...text.matchAll(/\[RX-STATS worker:[^\]]+\] offered=(\d+)/g)].map((m) => Number(m[1]))
    const cores = [...text.matchAll(/cpuCores=([\d.]+)/g)].map((m) => Number(m[1]))
    return { senders, paints, offered, cores, size: text.length }
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)

// ---------------------------------------------------------------- run

async function main() {
    if (LAUNCH) launch()
    else log(`using the running app, telemetry <- ${logPath}`)

    if (!(await waitForRest(LAUNCH ? 180000 : 15000))) {
        log("FAIL: the REST API on 5506 never answered")
        return finish(1)
    }

    const liveSource = typeof args.source === "string" ? args.source : null
    if (liveSource) {
        log(`content: live OMT source ${liveSource}`)
        await post({ action: "show_live_source", id: liveSource, type: "omt" })
    } else {
        const media = typeof args.media === "string" ? args.media : defaultMedia()
        if (!media) {
            log("FAIL: no media file given and none found in media.json (pass --media=<path>)")
            return finish(1)
        }
        log(`content: ${media}`)
        await post({ action: "play_media", path: media })
    }

    // let the pipeline settle before anything is counted
    await sleep(10000)

    log("attaching receivers...")
    const omtNames = await omtOutputs()
    const ndiSources = await ndiOutputs()
    if (!omtNames.length && !ndiSources.length) {
        log("FAIL: no FreeShow NDI or OMT output is advertising, so nothing can be measured")
        return finish(1)
    }
    omtNames.forEach((n) => log("  OMT  " + n))
    ndiSources.forEach((s) => log("  NDI  " + s.name))

    const receivers = [...omtNames.map((n) => receiveOmt(n, SECONDS)), ...ndiSources.map((s) => receiveNdi(s, SECONDS))]
    const source = liveSource ? measureSource(liveSource, SECONDS) : null

    // receivers connect and the senders come up to rate before the window opens
    await sleep(5000)
    const mark = (() => {
        try {
            return fs.readFileSync(logPath, "utf8").length
        } catch {
            return 0
        }
    })()

    log(`measuring for ${SECONDS}s with every output receiving...`)
    await sleep(SECONDS * 1000)

    const t = readTelemetry(mark)
    log("")
    log("=== unique frames per second, repeats excluded ===")
    if (t && Object.keys(t.senders).length) {
        for (const [id, v] of Object.entries(t.senders)) {
            log(`  ${id.padEnd(26)} real ${String(median(v.real)).padStart(3)}   repeat ${String(median(v.repeat)).padStart(3)}`)
        }
    } else log("  no sender telemetry found (was the app started with FS_CAP_STATS=1?)")

    log("")
    log("=== what each receiver actually got ===")
    for (const r of receivers) log(`  ${r.kind.toUpperCase()} ${r.name.padEnd(40)} ${(r.frames / SECONDS).toFixed(1)}/s`)
    if (source) log(`  SOURCE ${source.name.padEnd(38)} ${(source.frames / SECONDS).toFixed(1)}/s   <- the ceiling for this run`)

    log("")
    log("=== pipeline ===")
    log(`  paints/s ${median(t?.paints || [])}   into worker/s ${median(t?.offered || []) ?? "n/a"}   worker cores ${median(t?.cores || []) ?? "n/a"}`)
    log("")
    log(`outputs measured: ${receivers.length}`)
    if (source) log(`NOTE: the source delivered ${(source.frames / SECONDS).toFixed(1)}/s, so no output can beat that.`)
    finish(0)
}

function finish(code) {
    try {
        child?.kill()
    } catch {}
    setTimeout(() => process.exit(code), 500)
}

main().catch((err) => {
    log("FAIL: " + err.message)
    finish(1)
})
