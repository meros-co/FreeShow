// Native addons consumed from a git URL are installed as a tarball copy, so node_modules/<mod>/src can
// silently diverge from the checkout being edited and a rebuild compiles the stale copy. This compares
// the two and, with --sync, copies the checkout in. Checkout locations come from FS_NATIVE_SRC
// ("<module>=<path>", comma separated) or default to a sibling directory of this repo.
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

const repo = path.join(__dirname, "..")
const MODULES = { "osr-capture": "osr-capture", openmediatransport: "openmediatransport-node" }

function checkoutFor(mod) {
    for (const entry of (process.env.FS_NATIVE_SRC || "").split(",")) {
        const [name, dir] = entry.split("=")
        if (name && name.trim() === mod && dir) return path.resolve(dir.trim())
    }
    return path.join(repo, "..", MODULES[mod])
}

function hashDir(dir) {
    if (!fs.existsSync(dir)) return null
    const files = fs
        .readdirSync(dir)
        .filter((f) => /\.(c|cc|cpp|h|hpp|mm|gyp|gypi)$/.test(f))
        .sort()
    if (!files.length) return null
    const h = crypto.createHash("sha1")
    for (const f of files) {
        h.update(f)
        // normalise line endings: the checkout and the tarball copy can differ only by CRLF
        h.update(fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n"))
    }
    return h.digest("hex")
}

const sync = process.argv.includes("--sync")
let mismatched = []

for (const mod of Object.keys(MODULES)) {
    const installed = path.join(repo, "node_modules", mod, "src")
    const checkout = path.join(checkoutFor(mod), "src")
    const a = hashDir(installed)
    const b = hashDir(checkout)
    if (a === null || b === null) continue // not installed, or no local checkout to compare against
    if (a === b) continue
    if (!sync) {
        mismatched.push({ mod, installed, checkout })
        continue
    }
    for (const f of fs.readdirSync(checkout).filter((f) => /\.(c|cc|cpp|h|hpp|mm)$/.test(f))) {
        fs.copyFileSync(path.join(checkout, f), path.join(installed, f))
    }
    console.log(`native-src: synced ${mod} from ${checkout}`)
}

if (mismatched.length) {
    for (const m of mismatched) {
        console.error(`\nnative-src: ${m.mod} in node_modules does NOT match your checkout.`)
        console.error(`  installed: ${m.installed}`)
        console.error(`  checkout:  ${m.checkout}`)
    }
    console.error(`\nA rebuild would compile the stale copy and any measurement would be meaningless.`)
    console.error(`Run: npm run sync-native && npx electron-rebuild -f --only <module>\n`)
    process.exit(1)
}
