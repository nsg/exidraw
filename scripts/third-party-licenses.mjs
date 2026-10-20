import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowed = new Set([
  "MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
  "CC0-1.0", "Unlicense", "Zlib", "MIT AND Zlib", "BlueOak-1.0.0", "Python-2.0",
]);

// Explicit audit allowlist: khroma omits metadata, DOMPurify permits an Apache
// election, and Excalidraw's npm tarball omits its upstream MIT LICENSE.
// Excalidraw text copied from upstream repository LICENSE (2020 Excalidraw).
const excalidrawLicense = `MIT License

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const normalizeLicense = (value) => typeof value === "string"
  ? value.trim().replace(/^\(([^()]+)\)$/, "$1")
  : undefined;

async function noticeFiles(directory, relative = "") {
  const result = [];
  const entries = await readdir(join(directory, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
    const path = join(relative, entry.name);
    if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) {
      result.push(...await noticeFiles(directory, path));
    } else if (entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(entry.name)
      && !/\.(?:[cm]?[jt]sx?|json|map)$/i.test(entry.name)) {
      result.push({ path, text: await readFile(join(directory, path), "utf8") });
    }
  }
  return result;
}

function packageLicense(pkg, notices) {
  // Older npm packages (e.g. fuzzy) use the legacy licenses metadata field.
  const legacy = pkg.licenses?.map((license) => typeof license === "string" ? license : license.type);
  const license = normalizeLicense(typeof pkg.license === "object" ? pkg.license?.type : pkg.license)
    ?? normalizeLicense(legacy?.join(" AND "));
  if (pkg.name === "khroma" && !license && notices.some(({ text }) =>
    text.includes("Permission is hereby granted, free of charge") &&
    text.includes('THE SOFTWARE IS PROVIDED "AS IS"'))) {
    return "MIT (from license file)";
  }
  if (pkg.name === "dompurify" && license === "MPL-2.0 OR Apache-2.0") {
    return "Apache-2.0 (elected from MPL-2.0 OR Apache-2.0)";
  }
  if (!allowed.has(license)) {
    throw new Error(`${pkg.name}@${pkg.version}: disallowed or unknown license ${JSON.stringify(license ?? "MISSING")}`);
  }
  return license;
}

async function generate(root, output) {
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  if (!lock.packages) throw new Error("A package-lock.json with a packages map (lockfile v2+) is required");
  const packages = new Map();
  const violations = [];
  // The only production workspaces are server, web, and their shared workspace.
  // npm marks dev-only lock entries with dev:true; devOptional entries can also
  // be production optional dependencies, so only dev:true is excluded here.
  for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => compare(a, b))) {
    if (entry.dev || entry.link || entry.extraneous || !path.includes("node_modules/")) continue;
    const directory = resolve(root, path);
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue; // Optional packages for other platforms aren't installed.
      throw error;
    }
    if (pkg.name?.startsWith("@exidraw/")) continue;
    if (!pkg.name || !pkg.version) throw new Error(`Missing name/version in ${path}/package.json`);
    const notices = await noticeFiles(directory);
    let license;
    try {
      license = packageLicense(pkg, notices);
    } catch (error) {
      violations.push(error.message);
      continue;
    }
    if (pkg.name === "@excalidraw/excalidraw" && !notices.some(({ path }) => /^licen[cs]e(?:$|[._-])/i.test(path))) {
      notices.push({ path: "LICENSE (upstream repository; absent from npm tarball)", text: excalidrawLicense });
    }
    const key = `${pkg.name}@${pkg.version}`;
    const previous = packages.get(key);
    if (previous) {
      if (previous.license !== license) violations.push(`${key}: conflicting licenses in installed copies`);
      for (const notice of notices) {
        if (!previous.notices.some(({ path, text }) => path === notice.path && text === notice.text)) previous.notices.push(notice);
      }
    } else {
      packages.set(key, { ...pkg, license, notices });
    }
  }
  if (violations.length) throw new Error(`Third-party license policy failed:\n${violations.sort(compare).map((line) => `  ${line}`).join("\n")}`);
  const sorted = [...packages.values()].sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
  if (!sorted.length) throw new Error("No installed production packages found; run npm ci before generating notices");
  const sections = sorted.map((pkg) => {
    const lines = [`Package: ${pkg.name}`, `Version: ${pkg.version}`, `License: ${pkg.license}`];
    const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    if (repository) lines.push(`Repository: ${repository}`);
    if (pkg.homepage) lines.push(`Homepage: ${pkg.homepage}`);
    for (const notice of pkg.notices.sort((a, b) => compare(a.path, b.path) || compare(a.text, b.text))) {
      lines.push(`\n--- ${notice.path} ---\n${notice.text}`);
    }
    if (!pkg.notices.length) lines.push("\nNo LICENSE/LICENCE/COPYING/NOTICE file is shipped in the installed package.");
    return lines.join("\n");
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `THIRD-PARTY LICENSES\nInstalled production dependencies of exidraw server and web.\nFont notices: web/dist/excalidraw-assets/fonts/LICENSES.txt and server/renderer-dist/fonts/LICENSES.txt\n(relative to the repository or /app in the container).\n\n${sections.join("\n\n" + "=".repeat(80) + "\n\n")}\n`);
  const counts = new Map();
  for (const pkg of sorted) counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);
  console.log(`Third-party licenses: ${sorted.length} packages -> ${output}`);
  for (const [license, count] of [...counts].sort(([a], [b]) => compare(a, b))) console.log(`  ${license}: ${count}`);
}

try {
  const [output, flag, fixtureRoot, ...extra] = process.argv.slice(2);
  // --root supports small, isolated policy fixtures without modifying node_modules.
  if (!output || (flag && (flag !== "--root" || !fixtureRoot)) || extra.length) {
    throw new Error("Usage: node scripts/third-party-licenses.mjs OUTPUT [--root FIXTURE_ROOT]");
  }
  await generate(fixtureRoot ? resolve(fixtureRoot) : repositoryRoot, resolve(output));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
