// Copies the Excalidraw fonts into public/excalidraw-assets/fonts so the SPA
// serves them itself (window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/").
// Without this, Excalidraw falls back to fetching fonts from esm.sh.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFontNotices } from "../../scripts/font-notices.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The package's `exports` map hides package.json, so walk up node_modules dirs.
function findPackageDir(name) {
  for (let dir = join(here, ".."); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`${name} not found in any node_modules`);
  }
}
const pkgDir = findPackageDir("@excalidraw/excalidraw");
const src = join(pkgDir, "dist", "prod", "fonts");
const dest = join(here, "..", "public", "excalidraw-assets", "fonts");

if (!existsSync(src)) {
  console.error(`copy-excalidraw-assets: ${src} not found`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
writeFontNotices(dest);
console.log(`copy-excalidraw-assets: ${src} -> ${dest}`);
