// Run with node --test scripts/third-party-licenses.test.mjs. --root isolates
// these policy checks from the real lockfile and installed dependencies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./third-party-licenses.mjs", import.meta.url));

async function fixture(t, packages) {
  const root = await mkdtemp(join(tmpdir(), "exidraw-license-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = { lockfileVersion: 3, packages: {} };
  for (const { path, manifest, dev = false, extraneous = false, link = false, installed = true, notices = {} } of packages) {
    lock.packages[path] = { version: manifest.version, dev, extraneous, link };
    if (!installed) continue;
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, "package.json"), JSON.stringify(manifest));
    for (const [name, content] of Object.entries(notices)) {
      await mkdir(join(root, path, name, ".."), { recursive: true });
      await writeFile(join(root, path, name), content);
    }
  }
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
  const output = join(root, "notices.txt");
  return { output, run: () => spawnSync(process.execPath, [script, output, "--root", root], { encoding: "utf8" }) };
}

test("production notices include full texts, dedupe copies, and skip dev/uninstalled/workspace packages", async (t) => {
  const a = { name: "a", version: "1.0.0", license: "MIT", repository: { url: "https://example.test/a" } };
  const f = await fixture(t, [
    { path: "node_modules/z", manifest: { name: "z", version: "2.0.0", licenses: [{ type: "ISC" }] }, notices: { "LiCeNcE.md": "full ISC notice" } },
    { path: "node_modules/a", manifest: a, notices: { "LICENSE-MIT": "full MIT notice", "sub/NOTICE": "nested notice", "license-update.mjs": "unrelated source code" } },
    { path: "node_modules/z/node_modules/a", manifest: a, notices: { "LICENSE-MIT": "full MIT notice" } },
    { path: "node_modules/dev", manifest: { name: "dev", version: "1", license: "GPL-3.0" }, dev: true },
    { path: "node_modules/extraneous", manifest: { name: "extraneous", version: "1", license: "GPL-3.0" }, extraneous: true },
    { path: "node_modules/link", manifest: { name: "link", version: "1", license: "GPL-3.0" }, link: true },
    { path: "node_modules/optional", manifest: { name: "optional", version: "1" }, installed: false },
    { path: "node_modules/@exidraw/shared", manifest: { name: "@exidraw/shared", version: "1" } },
  ]);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(f.output, "utf8");
  assert.deepEqual([...text.matchAll(/^Package: (.+)$/gm)].map((match) => match[1]), ["a", "z"]);
  for (const content of ["full MIT notice", "nested notice", "full ISC notice", "https://example.test/a"]) assert.ok(text.includes(content));
  assert.equal((text.match(/full MIT notice/g) ?? []).length, 1);
  assert.ok(!text.includes("unrelated source code"));
  const repeat = f.run();
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(await readFile(f.output, "utf8"), text);
});

for (const license of ["GPL-3.0", undefined]) {
  test(`rejects ${license ?? "missing"} production licenses without writing output`, async (t) => {
    const f = await fixture(t, [{ path: "node_modules/fake", manifest: { name: "fake", version: "1.0.0", license } }]);
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Third-party license policy failed/);
    assert.ok(result.stderr.includes(`fake@1.0.0: disallowed or unknown license "${license ?? "MISSING"}"`));
    await assert.rejects(readFile(f.output), { code: "ENOENT" });
    console.log(result.stderr.trim());
  });
}

test("audited exceptions elect Apache, retain khroma's MIT, and restore Excalidraw's missing text", async (t) => {
  const f = await fixture(t, [
    { path: "node_modules/dompurify", manifest: { name: "dompurify", version: "1", license: "(MPL-2.0 OR Apache-2.0)" } },
    { path: "node_modules/khroma", manifest: { name: "khroma", version: "1" }, notices: { license: 'Permission is hereby granted, free of charge\nTHE SOFTWARE IS PROVIDED "AS IS"' } },
    { path: "node_modules/@excalidraw/excalidraw", manifest: { name: "@excalidraw/excalidraw", version: "1", license: "MIT" } },
  ]);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(f.output, "utf8");
  assert.ok(text.includes("License: Apache-2.0 (elected from MPL-2.0 OR Apache-2.0)"));
  assert.ok(text.includes("License: MIT (from license file)"));
  assert.ok(text.includes("Copyright (c) 2020 Excalidraw"));
  assert.ok(text.includes("THE SOFTWARE IS PROVIDED"));
});
