// The osr-capture capability contract, asserted against the addon built for THIS platform.
//
// Every capability the app relies on is listed here once. A capability added for one backend has to be
// added to this list, and this check then fails on the other two until they have it as well — which is
// the point: parity is a gate rather than an intention. Run under Electron so the addon's ABI matches
// the one the app loads:  npm run check-capabilities
//
// It is also run by scripts/wsl-linux-check.sh, so the Linux backend is checked from Windows.

const REQUIRED = {
    // two-phase shared-texture readback: consume (GPU, releases the texture) then finish (copy out)
    readbackConsume: "function",
    readbackFinish: "function",
    readbackOnce: "function",
    readback: "function",
    releasePool: "function",

    // per-consumer targets: every consumer's size and format produced in the one GPU pass
    targetsSupported: "boolean",
    // live input composited under the page inside that same pass
    videoLayerSupported: "boolean",
    // how many readbacks the backend can have in flight, so the pipeline depth is bounded by the backend
    maxConcurrentReadbacks: "number",

    // CPU conversions, for the frame no GPU pass produced one for
    convertBgraToUyvy: "function",
    convertBgraToUyva: "function",
    convertBgraToI420: "function",
    downscaleBgra: "function",
    // the small RGBA copy of a received stream the app window draws
    previewFrame: "function",

    // shared-memory frame transport between processes
    shmMap: "function",
    shmUnmap: "function",
    shmRead: "function",
    shmWrite: "function",
    shmReadAsync: "function",
    shmWriteAsync: "function"
}

// capabilities that must be true, not merely present
const MUST_BE_TRUE = ["targetsSupported", "videoLayerSupported"]

function check() {
    // OSR_MODULE points the check at a specific build (the WSL Linux check uses it to check the module it
    // just compiled); by default it is whatever the app itself would load
    const target = process.env.OSR_MODULE || "osr-capture"
    let osr
    try {
        osr = require(target)
    } catch (err) {
        console.error(`FAIL: ${target} will not load on ${process.platform}: ${err.message}`)
        return 1
    }

    const missing = []
    for (const [name, type] of Object.entries(REQUIRED)) {
        const actual = typeof osr[name]
        if (actual !== type) missing.push(`${name}: expected ${type}, got ${actual}`)
    }
    for (const name of MUST_BE_TRUE) {
        if (osr[name] === false) missing.push(`${name} is false on this backend`)
    }
    if (typeof osr.maxConcurrentReadbacks === "number" && !(osr.maxConcurrentReadbacks > 0)) {
        missing.push(`maxConcurrentReadbacks is ${osr.maxConcurrentReadbacks}, which would stall every output`)
    }

    const backend = typeof osr._readbackBackend === "function" ? osr._readbackBackend() : "unknown"
    console.log(`platform ${process.platform}, backend ${backend}, ${Object.keys(REQUIRED).length - missing.length}/${Object.keys(REQUIRED).length} capabilities`)

    if (missing.length) {
        console.error(`\nFAIL: this backend is behind the others:`)
        for (const m of missing) console.error(`  - ${m}`)
        console.error(`\nA capability is not done until every backend has it. Either implement it here or,`)
        console.error(`if the app no longer needs it, remove it from REQUIRED in scripts/capability-check.cjs.`)
        return 1
    }
    console.log("OK: every capability the app relies on is present on this platform")
    return 0
}

const code = check()
if (typeof process.versions.electron === "string") {
    // under Electron the process needs telling to go
    require("electron").app.whenReady().then(() => require("electron").app.exit(code))
} else {
    process.exit(code)
}
