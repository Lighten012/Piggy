#!/bin/sh
# Build from the checked-out revision on a developer machine.
set -eu
environment=${2:-staging}
case "$environment" in
    staging|production) ;;
    *) echo 'Expected staging or production' >&2; exit 2 ;;
esac
export VITE_PIGGY_ENVIRONMENT="$environment"
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
  "--define:process.env.PIGGY_RELEASE_ENVIRONMENT=\"$environment\"" \
  '--banner:js=import { createRequire as __createRequire } from "node:module";const require=__createRequire(import.meta.url);' \
  --outfile="$out/pi.mjs"
mkdir -p "$out/skills"
cp -R skills/. "$out/skills/"
cd "$admin"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.releaseEnvironment=$environment" -o "$out/piggy-admin" .
if [ "$environment" = production ]; then
    cp piggy-admin.service piggy-pi.service nginx.conf.example "$out/"
else
    for service in admin pi; do
        sed -e 's|/projects/Piggy/|/projects/Piggy-staging/|g' \
            -e 's/piggy-pi\.service/piggy-staging-pi.service/g' \
            -e 's/piggy-journal/piggy-staging-journal/g' \
            -e 's/PORT=18889/PORT=18989/' \
            -e '/^ProtectHome=yes/a\
InaccessiblePaths=-/lighten012/projects/Piggy -/var/lib/piggy-journal -/var/lib/private/piggy-journal
' "piggy-$service.service" > "$out/piggy-staging-$service.service"
    done
    sed -e 's/listen 8888 /listen 8889 /' -e 's/127.0.0.1:18888/127.0.0.1:18988/g' \
        nginx.conf.example > "$out/nginx.conf.example"
fi
printf '%s\n' "$environment" > "$out/ENVIRONMENT"
git rev-parse HEAD > "$out/REVISION"
