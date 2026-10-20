import { mkdtempSync, rmSync, fsyncSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createBackend } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { OidcFlow } from "../src/oidc.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) };
});

function setup(dataDir = ":memory:") {
  const backend = createBackend(parseConfig({ AUTH_MODE: "dev", PUBLIC_URL: "http://localhost:5173", DATA_DIR: dataDir, RENDERER: "off", LOG_LEVEL: "silent", ADMIN_EMAILS: "alice@example.test" }));
  const login = backend.auth.login({ subject: "alice", email: "alice@example.test", name: "Alice" }, "dev");
  const auth = backend.auth.require(new Headers({ cookie: `exidraw_session=${login.sessionId}` }));
  return { backend, auth };
}

test("logout is idempotent with absent or expired sessions", async () => {
  const { backend } = setup();
  try {
    for (const cookie of [undefined, "exidraw_session=expired"]) {
      const response = await backend.app.request("/auth/logout", { method: "POST", headers: cookie ? { cookie } : {} });
      expect(response.status).toBe(204);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    }
  } finally { await backend.close(); }
});

test("Entra membership rejection renders a 403 page and clears the flow cookie", async () => {
  const backend = createBackend(parseConfig({ PUBLIC_URL: "https://draw.test", DATA_DIR: ":memory:", RENDERER: "off", LOG_LEVEL: "silent", ENTRA_TENANT_ID: "tenant", ENTRA_CLIENT_ID: "client", ENTRA_CLIENT_SECRET: "secret" }));
  const mock = vi.spyOn(OidcFlow.prototype, "callback").mockResolvedValue({ location: "/login?error=guest", cookies: ["exidraw_oidc=; Max-Age=0"], forbidden: true });
  try {
    const response = await backend.app.request("/auth/callback?code=code");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Access denied");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  } finally { mock.mockRestore(); await backend.close(); }
});

test("shutdown persists later rooms after the first persist fails and closes the renderer and database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "exidraw-close-"));
  const { backend, auth } = setup(directory);
  const first = backend.tree.createRoom(auth.subject, "root", "First");
  const second = backend.tree.createRoom(auth.subject, "root", "Second");
  const element = { id: "box", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false, updated: Date.now(), index: null } as any;
  backend.rooms.applyElements(first.id, [element], "server");
  backend.rooms.applyElements(second.id, [element], "server");
  const persist = backend.rooms.persist.bind(backend.rooms);
  vi.spyOn(backend.rooms, "persist").mockImplementation((roomId) => { if (roomId === first.id) throw new Error("disk failure"); persist(roomId); });
  const rendererClose = vi.spyOn(backend.renderer, "close");
  const storeClose = vi.spyOn(backend.store, "close");
  try {
    await backend.close();
    expect(rendererClose).toHaveBeenCalledOnce();
    expect(storeClose).toHaveBeenCalledOnce();
    const reopened = new Store(directory);
    try { expect(JSON.parse(reopened.get<any>("SELECT elements FROM scenes WHERE room_id=?", second.id).elements)).toEqual([element]); }
    finally { reopened.close(); }
  } finally { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); }
});

test("file upload fsyncs data and its directory before the metadata row is committed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "exidraw-fsync-"));
  const { backend, auth } = setup(directory);
  const room = backend.tree.createRoom(auth.subject, "root", "Files");
  const run = backend.store.run.bind(backend.store);
  vi.mocked(fsyncSync).mockClear();
  const spy = vi.spyOn(backend.store, "run").mockImplementation((sql, ...args) => {
    if (sql.startsWith("INSERT INTO files")) expect(fsyncSync).toHaveBeenCalledTimes(2);
    return run(sql, ...args);
  });
  try {
    backend.files.put(room.id, "image", "image/png", Buffer.from("image bytes"), auth.user.id);
    expect(backend.files.get(room.id, "image").bytes.toString()).toBe("image bytes");
  } finally { spy.mockRestore(); await backend.close(); rmSync(directory, { recursive: true, force: true }); }
});
