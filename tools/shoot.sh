#!/bin/bash
# Takes the three screenshots from the real page in headless Chrome at 1440x900, device scale 1, then
# re-encodes each losslessly into the 300-350 KB window. Run from the repository root after main.ts.
#   1-board.png    the ranked board, default sort
#   2-detail.png   rank 1's detail view: the working, its peers and the farm plan
#   3-filtered.png the board filtered to one category, sorted by days with no token
set -euo pipefail
cd "$(dirname "$0")/.."
SNAP="${1:-../kit/tr/token-radar-01-kit/input/snapshot.json}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input "$SNAP" >/dev/null
TOP=$(node -e 'const b=require("./out/board.json");console.log(b.rows[0].slug)')
shoot() {
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1440,900 \
    --virtual-time-budget=3000 --screenshot="screenshots/$1" "file://$PWD/out/dashboard/index.html#$2" >/dev/null 2>&1
  node tools/fit-png.mjs "screenshots/$1"
}
rm -f screenshots/*.png
shoot 1-board.png ''
shoot 2-detail.png "p=$TOP"
shoot 3-filtered.png 'cat=RWA&sort=days'
MAKEFUN_OUTPUT_DIR=out node main.ts --input "$SNAP"
