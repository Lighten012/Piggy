#!/bin/sh
# Build from the checked-out revision on a developer machine.
set -eu
admin=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
cd "$admin/web"
npm ci --no-audit --no-fund
npm run build
mkdir -p "$out/web"
cp -R dist "$out/web/"
cd "$admin/.."
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
"$admin/web/node_modules/.bin/esbuild" server.ts --bundle --platform=node --target=node24 --format=esm \
  '--banner:js=import { createRequire as __createRequire } from "node:module";const require=__createRequire(import.meta.url);' \
  --outfile="$out/pi.mjs"
cd "$admin"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$out/piggy-admin" .
cp piggy-admin.service piggy-pi.service piggy-preview.service "$out/"
git rev-parse HEAD > "$out/REVISION"
