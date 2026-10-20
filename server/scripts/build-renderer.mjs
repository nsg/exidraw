import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const server = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(server, "renderer-dist");
const require = createRequire(import.meta.url);
const packageDir = dirname(
  dirname(dirname(require.resolve("@excalidraw/excalidraw"))),
);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: [resolve(server, "renderer/renderer.ts")],
  outdir: output,
  bundle: true,
  splitting: true,
  platform: "browser",
  format: "esm",
  target: "chrome120",
  conditions: ["production"],
  minify: true,
  loader: { ".woff2": "file", ".ttf": "file" },
  define: {
    "process.env.IS_PREACT": "false",
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "warning",
});
await cp(resolve(server, "renderer/index.html"), resolve(output, "index.html"));
await cp(resolve(packageDir, "dist/prod/fonts"), resolve(output, "fonts"), {
  recursive: true,
});
