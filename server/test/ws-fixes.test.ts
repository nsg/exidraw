import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MAX_ELEMENTS_PER_ROOM, MAX_WS_MESSAGE_BYTES, type SceneElement, type ServerMessage } from "@exidraw/shared";
import { createBackend } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { MAX_WINDOW_FRAMES } from "../src/ws.js";

const origin = "http://localhost:5173";
const element = (id: string, version = 1, x = version): SceneElement => ({
  id, type: "rectangle", version, versionNonce: 10, updated: Date.now(),
  isDeleted: false, index: null, x, y: 0, width: 100, height: 80,
}) as SceneElement;
class Peer {
  readonly socket: WebSocket;
  readonly closed: Promise<number>;
  readonly messages: ServerMessage[] = [];
  constructor(url: string, cookie: string) {
    this.socket = new WebSocket(url, { origin, headers: { cookie } });
    this.socket.on("error", () => {});
    this.socket.on("message", (data) => this.messages.push(JSON.parse(data.toString())));
    this.closed = new Promise((resolve) => this.socket.once("close", resolve));
  }
  async next(type: ServerMessage["type"]) {
    for (let i = 0; i < 300; i++) {
      const index = this.messages.findIndex((m) => m.type === type);
      if (index >= 0) return this.messages.splice(index, 1)[0]!;
      await delay(10);
    }
    throw new Error(`No ${type}; messages: ${JSON.stringify(this.messages)}`);
  }
  send(message: unknown) { this.socket.send(JSON.stringify(message)); }
}
let directory: string;
let backend: ReturnType<typeof createBackend>;
let base: string;
let cookie: string;
let roomId: string;
let peers: Peer[];
async function start() {
  backend = createBackend(parseConfig({
    AUTH_MODE: "dev", PUBLIC_URL: origin, DATA_DIR: directory, RENDERER: "off",
    ADMIN_EMAILS: "alice@example.test", LOG_LEVEL: "silent", PORT: "0", HOST: "127.0.0.1",
  }));
  base = `ws://127.0.0.1:${(await backend.start()).port}`;
}
beforeEach(async () => {
  peers = [];
  directory = await mkdtemp(join(tmpdir(), "exidraw-ws-fixes-"));
  await start();
  const login = backend.auth.login({ subject: "alice", email: "alice@example.test", name: "Alice" }, "dev");
  cookie = `exidraw_session=${login.sessionId}`;
  roomId = backend.tree.createRoom(backend.auth.require(new Headers({ cookie })).subject, "root", "WebSocket regression").id;
});
afterEach(async () => {
  for (const peer of peers) peer.socket.terminate();
  await backend.close();
  await rm(directory, { force: true, recursive: true });
});
async function connect(session = cookie, room = roomId) {
  const peer = new Peer(`${base}/ws?room=${room}`, session);
  peers.push(peer);
  await peer.next("scene_init");
  return peer;
}
function viewerCookie(role: "viewer" | "editor" = "viewer") {
  const login = backend.auth.login({ subject: "bob", email: "bob@example.test", name: "Bob" }, "dev");
  const alice = backend.auth.require(new Headers({ cookie }));
  backend.tree.putGrants(alice.subject, "room", roomId, [{ kind: "user", email: "bob@example.test", role }]);
  return `exidraw_session=${login.sessionId}`;
}

test("two 60 Hz drags coalesce without losing reconciliation winners or disconnecting", async () => {
  const peer = await connect();
  const observer = await connect();
  let version = 0;
  async function drag() {
    const started = performance.now();
    for (let i = 0; i < 120; i++) {
      version++;
      peer.send({ type: "scene_update", elements: [element("drag", version)] });
      // A later equal-version higher nonce must not replace this winner.
      if (i === 119) peer.send({ type: "scene_update", elements: [{ ...element("drag", version, -1), versionNonce: 20 }] });
      await delay(Math.max(0, started + (i + 1) * 1000 / 60 - performance.now()));
    }
  }
  await drag();
  await delay(2000);
  await drag();
  await delay(150);
  expect(peer.socket.readyState).toBe(WebSocket.OPEN);
  expect(peer.messages.filter((m) => m.type === "error")).toEqual([]);
  expect(backend.rooms.elements(roomId)).toMatchObject([{ id: "drag", version: 240, x: 240 }]);
  expect(observer.messages).toContainEqual(expect.objectContaining({
    type: "scene_update", elements: [expect.objectContaining({ id: "drag", version: 240, x: 240 })],
  }));
}, 12_000);

test("coalesced editor updates survive disconnect and shutdown", async () => {
  const peer = await connect();
  for (let version = 1; version <= 31; version++)
    peer.send({ type: "scene_update", elements: [element("disconnect", version)] });
  peer.socket.close();
  await peer.closed;
  expect(backend.rooms.elements(roomId)).toMatchObject([{ id: "disconnect", version: 31 }]);
  const other = await connect();
  for (let version = 1; version <= 31; version++)
    other.send({ type: "scene_update", elements: [element("shutdown", version)] });
  for (let i = 0; i < 100; i++) {
    if ([...backend.collaboration!.connections.values()].some((connection) => connection.pending.has("shutdown"))) break;
    await delay(1);
  }
  expect([...backend.collaboration!.connections.values()].some((connection) => connection.pending.has("shutdown"))).toBe(true);
  await backend.close();
  await start();
  expect(backend.rooms.elements(roomId)).toMatchObject([
    { id: "disconnect", version: 31 }, { id: "shutdown", version: 31 },
  ]);
});

test.each(["session expiry", "session revocation", "role downgrade", "permission change without refresh", "room deletion"] as const)(
  "buffered updates are discarded after %s",
  async (change) => {
    const editorCookie = viewerCookie("editor");
    const peer = await connect(editorCookie);
    for (let version = 1; version <= 31; version++)
      peer.send({ type: "scene_update", elements: [element("revoked", version)] });
    for (let i = 0; i < 100; i++) {
      if ([...backend.collaboration!.connections.values()].some((c) => c.pending.has("revoked"))) break;
      await delay(1);
    }
    const connection = [...backend.collaboration!.connections.values()].find((c) => c.pending.has("revoked"));
    expect(connection).toBeDefined();
    if (change === "session expiry") {
      backend.store.run("UPDATE sessions SET expires_at=? WHERE id=?", Date.now() - 1, connection!.sessionId);
      // Exercise the timer's authorization check without a revocation signal.
    } else if (change === "session revocation") {
      backend.auth.logout(new Headers({ cookie: editorCookie }));
      backend.collaboration!.revokeSession(connection!.sessionId);
    } else if (change === "role downgrade" || change === "permission change without refresh") {
      const alice = backend.auth.require(new Headers({ cookie }));
      backend.tree.putGrants(alice.subject, "room", roomId, [{ kind: "user", email: "bob@example.test", role: "viewer" }]);
      if (change === "role downgrade") backend.collaboration!.refreshRoles();
    } else {
      const alice = backend.auth.require(new Headers({ cookie }));
      backend.tree.delete(alice.subject, "room", roomId);
      backend.rooms.closeRoom(roomId, 4410);
    }
    await delay(150);
    expect(backend.rooms.rooms.get(roomId)!.elements.get("revoked")!.version).toBe(30);
    expect(connection!.pending.size).toBe(0);
    if (change === "session expiry" || change === "session revocation")
      expect(await peer.closed).toBe(4401);
    else if (change === "room deletion") expect(await peer.closed).toBe(4410);
    else expect(peer.socket.readyState).toBe(WebSocket.OPEN);
  },
);

test("viewers exhaust the byte budget even when sending non-edit frames", async () => {
  const peer = await connect(viewerCookie());
  const frame = JSON.stringify({ type: "idle", state: "active", padding: "x".repeat(7 * 1024 * 1024) });
  for (let i = 0; i < 5; i++) peer.socket.send(frame);
  expect(await peer.closed).toBe(4429);
  expect(peer.messages).toContainEqual(expect.objectContaining({ type: "error", code: "rate_limited", fatal: true }));
});

test("twenty forbidden viewer writes close with 4403 after nonfatal forbidden responses", async () => {
  const peer = await connect(viewerCookie());
  for (let i = 0; i < 20; i++) peer.send({ type: "scene_update", elements: [] });
  expect(await peer.closed).toBe(4403);
  expect(peer.messages.filter((m) => m.type === "error" && !m.fatal)).toHaveLength(19);
  expect(peer.messages).toContainEqual(expect.objectContaining({ type: "error", code: "forbidden", fatal: true }));
});

test("all message types share a frame budget that expires after a clean window", async () => {
  const peer = await connect();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    for (let i = 0; i < 300; i++) peer.send({ type: "request_scene" });
    peer.send({ type: "ack-invalid" });
    await peer.next("error");
    clock.mockReturnValue(now + 10_001);
    for (let i = 0; i < MAX_WINDOW_FRAMES - 1; i++) peer.send({ type: "request_scene" });
    peer.send({ type: "ack-invalid" });
    await peer.next("error");
    expect(peer.socket.readyState).toBe(WebSocket.OPEN);
    peer.send({ type: "request_scene" });
    expect(await peer.closed).toBe(4429);
  } finally {
    clock.mockRestore();
  }
});

test("invalid huge versions are nonfatal and cannot brick a persisted room", async () => {
  const peer = await connect();
  peer.send({ type: "scene_update", elements: [element("unsafe", 2 ** 53 + 2)] });
  expect(await peer.next("error")).toMatchObject({ code: "invalid_message", fatal: false });
  peer.send({ type: "scene_update", elements: [element("safe")] });
  peer.send({ type: "request_scene" });
  expect(await peer.next("scene_init")).toMatchObject({ elements: [{ id: "safe" }] });
  await backend.close();
  await start();
  expect(backend.rooms.elements(roomId)).toMatchObject([{ id: "safe", version: 1 }]);
});

test("buffering preserves the last valid batch when a later batch exceeds capacity", async () => {
  backend.rooms.applyElements(roomId, Array.from({ length: MAX_ELEMENTS_PER_ROOM - 1 }, (_, i) => element(`e${i}`)), "server");
  const peer = await connect();
  for (let version = 2; version <= 31; version++)
    peer.send({ type: "scene_update", elements: [element("e0", version)] });
  peer.send({ type: "scene_update", elements: [element("last-valid")] });
  peer.send({ type: "scene_update", elements: [element("overflow")] });
  expect(await peer.next("error")).toMatchObject({ code: "too_many_elements", fatal: false });
  expect(backend.rooms.elements(roomId).some((e) => e.id === "last-valid")).toBe(true);
  expect(backend.rooms.elements(roomId).some((e) => e.id === "overflow")).toBe(false);
});

test("element count and oversized frame errors use specific protocol codes", async () => {
  const peer = await connect();
  peer.send({ type: "scene_update", elements: Array.from({ length: MAX_ELEMENTS_PER_ROOM + 1 }, (_, i) => element(`e${i}`)) });
  expect(await peer.next("error")).toMatchObject({ code: "too_many_elements", fatal: false });
  backend.rooms.applyElements(roomId, Array.from({ length: MAX_ELEMENTS_PER_ROOM }, (_, i) => element(`e${i}`)), "server");
  peer.send({ type: "scene_update", elements: [element("overflow")] });
  expect(await peer.next("error")).toMatchObject({ code: "too_many_elements", fatal: false });
  peer.socket.send("x".repeat(MAX_WS_MESSAGE_BYTES + 1));
  expect(await peer.closed).toBe(4413);
  expect(peer.messages).toContainEqual(expect.objectContaining({ type: "error", code: "message_too_large", fatal: true }));
});

test("fatal authentication and missing room errors identify their actual cause", async () => {
  for (const [session, room, code, close] of [["", roomId, "unauthenticated", 4401], [cookie, "missing", "not_found", 4404]] as const) {
    const peer = new Peer(`${base}/ws?room=${room}`, session);
    peers.push(peer);
    expect(await peer.next("error")).toMatchObject({ code, fatal: true });
    expect(await peer.closed).toBe(close);
  }
});
