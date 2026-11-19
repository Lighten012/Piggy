import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import * as core from "@earendil-works/pi-agent-core";

const outdir = resolve(process.argv[2] ?? "../android/app/build/generated/piggy/assets");
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: ["runtime.js"], outfile: resolve(outdir, "piggy.js"),
  platform: "browser", format: "iife", target: "chrome115", bundle: true, minify: true,
  define: { EXPECTED_CORE_EXPORTS: JSON.stringify(Object.keys(core).sort()) },
});
