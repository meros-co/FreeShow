#!/usr/bin/env bash
# Build and load the Linux osr-capture backend in WSL, so Linux changes are compiled and their GLSL is
# validated before anyone is asked to test a Linux build.
#
# Run from Windows:  wsl -d omt-resolute -- bash /mnt/c/Users/David/Dropbox/Work/FreeShow/scripts/wsl-linux-check.sh
#
# Loading the module runs the addon's GL init, which compiles every shader program and fails init if any
# one of them fails — so a reported backend of "egl-gles3" rather than "cpu"/"none" is a real check that
# the shaders compile on a live driver.
set -u

SRC=${OSR_SRC:-/mnt/c/Users/David/Dropbox/Work/osr-capture}
APP=${FS_LINUX_CHECKOUT:-~/work/FreeShow}
APP=$(eval echo "$APP")
NODE_BUILD=~/.cache/osr-linux-check

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -d "$SRC/src" ] || fail "no osr-capture source at $SRC"
[ -d "$APP/node_modules/osr-capture" ] || fail "no osr-capture in $APP/node_modules"

echo "== syncing source into the checkout's node_modules =="
cp "$SRC"/src/*.cc "$SRC"/src/*.h "$APP/node_modules/osr-capture/src/" || fail "copy failed"
cp -r "$SRC"/third_party "$APP/node_modules/osr-capture/" 2>/dev/null

echo "== syntax-only pass (fast, no node needed) =="
for f in readback_linux.cc readback_linux_gpu.cc; do
    g++ -std=c++17 -fsyntax-only -I"$SRC/src" -I"$SRC/third_party/khronos" "$SRC/src/$f" || fail "$f does not compile"
    echo "  ok  $f"
done

echo "== node build (compiles every source file, and lets us LOAD it) =="
rm -rf "$NODE_BUILD"; mkdir -p "$NODE_BUILD"
cp -r "$SRC/src" "$SRC/third_party" "$SRC/binding.gyp" "$SRC/package.json" "$NODE_BUILD"/ || fail "copy failed"
cd "$NODE_BUILD" || fail "cd failed"
npm install --no-audit --no-fund --silent node-addon-api node-gyp >/dev/null 2>&1
npx node-gyp rebuild 2>&1 | tail -6
[ -f build/Release/osr_readback.node ] || fail "node-gyp build produced no module"

echo "== loading the module (this compiles the GLSL) =="
node -e '
const a = require("./build/Release/osr_readback.node")
const backend = typeof a._readbackBackend === "function" ? a._readbackBackend() : "n/a"
console.log("backend:", backend)
if (backend !== "egl-gles3") { console.error("GPU path did not come up: shaders may have failed to compile"); process.exit(1) }
' || fail "module load / GL init failed"

echo "== capability parity (the same contract every platform must meet) =="
# check the contract against the module just built here, not whatever the checkout happens to hold
OSR_MODULE="$NODE_BUILD/build/Release/osr_readback.node" node "$(dirname "$0")/capability-check.cjs" || fail "the Linux backend does not meet the capability contract"

echo "== electron build in the checkout (what the app actually loads) =="
cd "$APP" || fail "cd failed"
npx electron-rebuild -f --only osr-capture 2>&1 | tail -3

echo "OK"
