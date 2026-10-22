import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  MAX_WS_MESSAGE_BYTES,
  type GrantInput,
  type SceneElement,
  type ServerMessage,
} from "@exidraw/shared";
import { createBackend } from "../src/app.js";
import { parseConfig } from "../src/config.js";
const origin = "http://localhost:5173";
// Listen as soon as the connection is constructed: welcome, scene and close
// frames can arrive in one turn, before a test starts awaiting any of them.
class Peer {
  readonly socket: WebSocket;
  readonly closed: Promise<number>;
  private messages: ServerMessage[] = [];
  private listeners = new Set<() => void>();
  constructor(url: string, cookie: string) {
    this.socket = new WebSocket(url, { origin, headers: { Cookie: cookie } });
    this.socket.on("error", () => {});
    this.socket.on("message", (data) => {
      this.messages.push(JSON.parse(data.toString()));
      for (const notify of this.listeners) notify();
    });
    this.closed = new Promise((resolve) =>
      this.socket.once("close", (code) => resolve(code)),
    );
  }
  next<T extends ServerMessage["type"]>(
    type: T,
    matches: (
      message: Extract<
        ServerMessage,
        {
          type: T;
        }
      >,
    ) => boolean = () => true,
  ) {
    return new Promise<
      Extract<
        ServerMessage,
        {
          type: T;
        }
      >
    >((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(
          new Error(
            `Timed out waiting for ${type}; buffered: ${JSON.stringify(this.messages)}`,
          ),
        );
      }, 3000);
      const check = () => {
        const index = this.messages.findIndex(
          (message) =>
            message.type === type &&
            matches(
              message as Extract<
                ServerMessage,
                {
                  type: T;
                }
              >,
            ),
        );
        if (index < 0) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(
          this.messages.splice(index, 1)[0] as Extract<
            ServerMessage,
            {
              type: T;
            }
          >,
        );
      };
      this.listeners.add(check);
      check();
    });
  }
  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }
}
function rectangle(
  id: string,
  overrides: Record<string, unknown> = {},
): SceneElement {
  return {
    id,
    type: "rectangle",
    x: 10,
    y: 20,
    width: 100,
    height: 60,
    angle: 0,
    version: 1,
    versionNonce: 100,
    isDeleted: false,
    updated: Date.now(),
    index: "a0",
    boundElements: null,
    frameId: null,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    groupIds: [],
    locked: false,
    ...overrides,
  } as SceneElement;
}
describe("backend over HTTP, WebSocket and MCP", () => {
  let directory: string;
  let backend: ReturnType<typeof createBackend>;
  let base: string;
  let peers: Peer[];
  let clients: Client[];
  async function start() {
    backend = createBackend(
      parseConfig({
        ...process.env,
        AUTH_MODE: "dev",
        ADMIN_EMAILS: "alice@example.test",
        DATA_DIR: directory,
        PUBLIC_URL: origin,
        PORT: "0",
        HOST: "127.0.0.1",
        RENDERER: "off",
        WEB_DIST_DIR: directory,
        LOG_LEVEL: "silent",
        ALLOWED_ORIGINS: "",
        DEV_USERS: undefined,
      }),
    );
    base = `http://127.0.0.1:${(await backend.start()).port}`;
  }
  beforeEach(async () => {
    peers = [];
    clients = [];
    directory = await mkdtemp(join(tmpdir(), "exidraw-integration-"));
    await start();
  });
  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    for (const peer of peers) peer.socket.terminate();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  });
  function request(
    path: string,
    cookie = "",
    method = "GET",
    body?: unknown,
    csrf = true,
  ) {
    const headers = new Headers({ Cookie: cookie });
    if (csrf) headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    return fetch(base + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function json(
    path: string,
    cookie: string,
    method = "GET",
    body?: unknown,
    status = 200,
  ): Promise<any> {
    const response = await request(path, cookie, method, body);
    expect(response.status, await response.clone().text()).toBe(status);
    return response.json();
  }
  async function login(userId: string) {
    const response = await request("/auth/dev/login", "", "POST", { userId });
    expect(response.status).toBe(204);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  }
  async function room(cookie: string, name = "Drawing", folderId = "root") {
    return json("/api/rooms", cookie, "POST", { name, folderId }, 201);
  }
  async function grant(cookie: string, roomId: string, grants: GrantInput[]) {
    return json(`/api/nodes/room/${roomId}/grants`, cookie, "PUT", { grants });
  }
  function connect(cookie: string, roomId: string) {
    const peer = new Peer(
      base.replace("http:", "ws:") + `/ws?room=${roomId}`,
      cookie,
    );
    peers.push(peer);
    return peer;
  }
  async function ready(cookie: string, roomId: string) {
    const peer = connect(cookie, roomId);
    await peer.next("scene_init");
    return peer;
  }
  async function mcp(cookie: string) {
    const token = await json(
      "/api/tokens",
      cookie,
      "POST",
      { name: "integration agent" },
      201,
    );
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${token.token}` } },
      }),
    );
    return client;
  }
  test("serves SPA deep links and immutable assets while preserving reserved route errors", async () => {
    const html = "<!doctype html><html><body>exidraw</body></html>";
    await Promise.all([
      mkdir(join(directory, "assets")),
      mkdir(join(directory, "excalidraw-assets")),
    ]);
    await Promise.all([
      writeFile(join(directory, "index.html"), html),
      writeFile(join(directory, "assets/foo.js"), "export const ready = true;"),
      writeFile(join(directory, "excalidraw-assets/font.woff2"), "font bytes"),
    ]);
    const deep = await request("/r/deep");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe(html);
    expect(deep.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(deep.headers.get("cache-control")).toBe("no-cache");
    expect(deep.headers.get("x-content-type-options")).toBe("nosniff");
    expect(deep.headers.get("x-frame-options")).toBe("DENY");
    expect(deep.headers.get("referrer-policy")).toBe("same-origin");
    for (const [path, type, contents] of [
      [
        "/assets/foo.js",
        "text/javascript; charset=utf-8",
        "export const ready = true;",
      ],
      ["/excalidraw-assets/font.woff2", "font/woff2", "font bytes"],
    ]) {
      const asset = await request(path!);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toBe(type);
      expect(asset.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(await asset.text()).toBe(contents);
    }
    const alice = await login("alice");
    for (const path of [
      "/assets/missing.js",
      "/excalidraw-assets/missing.woff2",
      "/api/missing",
      "/auth/missing",
      "/_internal/missing",
    ]) {
      const missing = await request(path, alice);
      expect(missing.status, path).toBe(404);
      expect(missing.headers.get("content-type")).toContain("application/json");
      expect(await missing.text()).not.toBe(html);
    }
  });

  test("closes oversized text frames with 4413 and binary frames with 4400", async () => {
    const alice = await login("alice");
    const drawing = await room(alice);
    const oversized = await ready(alice, drawing.id);
    oversized.socket.send(Buffer.alloc(MAX_WS_MESSAGE_BYTES + 1), {
      binary: false,
    });
    expect(await oversized.closed).toBe(4413);
    const binary = await ready(alice, drawing.id);
    binary.socket.send(Buffer.from("{}"));
    expect(await binary.closed).toBe(4400);
  });

  test("logout closes only sockets for that session with 4401", async () => {
    const alice = await login("alice"), otherSession = await login("alice");
    const drawing = await room(alice);
    const revoked = await ready(alice, drawing.id);
    const remaining = await ready(otherSession, drawing.id);
    expect((await request("/auth/logout", alice, "POST")).status).toBe(204);
    expect(await revoked.next("error")).toMatchObject({ fatal: true });
    expect(await revoked.closed).toBe(4401);
    remaining.send({ type: "request_scene" });
    expect((await remaining.next("scene_init")).elements).toEqual([]);
    expect(remaining.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("an expired session cannot send scene updates over an existing socket", async () => {
    const alice = await login("alice"), observerSession = await login("alice");
    const drawing = await room(alice);
    const expired = await ready(alice, drawing.id);
    const sessionId = alice.slice(alice.indexOf("=") + 1);
    backend.store.run("UPDATE sessions SET expires_at=? WHERE id=?", Date.now() - 1, sessionId);
    expired.send({ type: "scene_update", elements: [rectangle("expired-write")] });
    expect(await expired.next("error")).toMatchObject({ fatal: true });
    expect(await expired.closed).toBe(4401);
    expect((await json(`/api/rooms/${drawing.id}/scene`, observerSession)).elements).toEqual([]);
    expect(backend.store.get("SELECT id FROM sessions WHERE id=?", sessionId)).toBeUndefined();
  });

  test("enforces cookie CSRF, accepts PATs without CSRF, and excludes cookies from MCP", async () => {
    expect((await request("/api/me")).status).toBe(401);
    expect(
      (await request("/auth/dev/login", "", "POST", { userId: "alice" }, false))
        .status,
    ).toBe(403);
    const alice = await login("alice");
    expect((await json("/api/me", alice)).via).toBe("session");
    const rejected = await request(
      "/api/rooms",
      alice,
      "POST",
      { folderId: "root", name: "Blocked" },
      false,
    );
    expect(rejected.status).toBe(403);
    expect((await rejected.json()).error.code).toBe("csrf");
    const crossOrigin = await fetch(base + "/api/rooms", {
      method: "POST",
      headers: {
        Cookie: alice,
        Origin: "https://attacker.example",
        [CSRF_HEADER]: CSRF_HEADER_VALUE,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ folderId: "root", name: "Blocked" }),
    });
    expect(crossOrigin.status).toBe(403);
    const cookieMcp = await request("/mcp", alice, "POST", {});
    expect(cookieMcp.status).toBe(401);
    expect(cookieMcp.headers.get("www-authenticate")).toBe(
      'Bearer realm="exidraw"',
    );
    const token = await json(
      "/api/tokens",
      alice,
      "POST",
      { name: "API automation" },
      201,
    );
    const headers = {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
    };
    const me = await fetch(base + "/api/me", { headers });
    expect((await me.json()).via).toBe("token");
    const created = await fetch(base + "/api/rooms", {
      method: "POST",
      headers,
      body: JSON.stringify({ folderId: "root", name: "PAT created" }),
    });
    expect(created.status).toBe(201);
    expect(
      (await request(`/api/tokens/${token.info.id}`, alice, "DELETE")).status,
    ).toBe(204);
    expect((await fetch(base + "/api/me", { headers })).status).toBe(401);
  });
  test("exposes only traversable folders, links grants at first login, and protects stored files", async () => {
    const alice = await login("alice"),
      bob = await login("bob"),
      carol = await login("carol");
    const projects = await json(
      "/api/folders",
      alice,
      "POST",
      { parentId: "root", name: "Projects" },
      201,
    );
    const bridge = await json(
      "/api/folders",
      alice,
      "POST",
      { parentId: projects.id, name: "Bridge" },
      201,
    );
    const drawing = await room(alice, "Plan", bridge.id);
    await room(alice, "Private", projects.id);
    await grant(alice, drawing.id, [
      { kind: "user", email: "bob@example.test", role: "viewer" },
      { kind: "user", email: "DAVE@example.test", role: "editor" },
    ]);
    expect((await request(`/api/rooms/${drawing.id}`, carol)).status).toBe(404);
    const listing = await json("/api/tree", bob);
    expect(listing.folders).toEqual([
      expect.objectContaining({ id: projects.id, role: null }),
    ]);
    const nested = await json(`/api/tree?folderId=${projects.id}`, bob);
    expect(nested.folders).toEqual([
      expect.objectContaining({ id: bridge.id, role: null }),
    ]);
    expect(nested.rooms).toEqual([]);
    expect((await json(`/api/tree?folderId=${bridge.id}`, bob)).rooms).toEqual([
      expect.objectContaining({ id: drawing.id, role: "viewer" }),
    ]);
    expect(
      (
        await request(`/api/rooms/${drawing.id}`, bob, "PATCH", {
          name: "Denied",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/rooms", bob, "POST", {
          folderId: bridge.id,
          name: "Denied",
        })
      ).status,
    ).toBe(404);
    const before = await json(`/api/nodes/room/${drawing.id}/grants`, alice);
    expect(
      before.grants.find((g: any) => g.principal.email === "dave@example.test")
        .principal.userId,
    ).toBeNull();
    const dave = await login("dave");
    const daveId = (await json("/api/me", dave)).user.id;
    const after = await json(`/api/nodes/room/${drawing.id}/grants`, alice);
    expect(
      after.grants.find((g: any) => g.principal.email === "dave@example.test")
        .principal.userId,
    ).toBe(daveId);
    expect((await json(`/api/rooms/${drawing.id}`, dave)).role).toBe("editor");
    const bytes = Buffer.from("89504e470d0a1a0a", "hex");
    const path = `/api/rooms/${drawing.id}/files/image_1`;
    const upload = (cookie: string, body: Buffer) =>
      fetch(base + path, {
        method: "PUT",
        headers: {
          Cookie: cookie,
          [CSRF_HEADER]: CSRF_HEADER_VALUE,
          "Content-Type": "image/png",
        },
        body,
      });
    expect((await upload(bob, bytes)).status).toBe(403);
    expect((await upload(dave, bytes)).status).toBe(201);
    expect((await upload(dave, Buffer.from("replacement"))).status).toBe(200);
    const download = await request(path, bob);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(download.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    expect((await request(path, carol)).status).toBe(404);
  });
  test("lists who has access to owners only, in the tree and in search", async () => {
    const alice = await login("alice"),
      bob = await login("bob"),
      carol = await login("carol");
    const projects = await json(
      "/api/folders",
      alice,
      "POST",
      { parentId: "root", name: "Projects" },
      201,
    );
    await json(`/api/nodes/folder/${projects.id}/grants`, alice, "PUT", {
      grants: [{ kind: "all", role: "viewer" }],
    });
    const plan = await room(alice, "Plan", projects.id);
    await grant(alice, plan.id, [
      { kind: "user", email: "bob@example.test", role: "editor" },
      { kind: "user", email: "carol@example.test", role: "owner" },
    ]);
    const tree = await json(`/api/tree?folderId=${projects.id}`, alice);
    expect(tree.folder.access).toEqual([
      { principal: { kind: "all" }, role: "viewer", from: null },
    ]);
    expect(tree.rooms[0].access).toEqual([
      expect.objectContaining({
        principal: expect.objectContaining({ email: "carol@example.test" }),
        role: "owner",
        from: null,
      }),
      {
        principal: {
          kind: "user",
          email: "bob@example.test",
          userId: (await json("/api/me", bob)).user.id,
          displayName: "Bob Builder",
        },
        role: "editor",
        from: null,
      },
      {
        principal: { kind: "all" },
        role: "viewer",
        from: { kind: "folder", id: projects.id, name: "Projects" },
      },
    ]);
    const bobTree = await json(`/api/tree?folderId=${projects.id}`, bob);
    expect(bobTree.folder).not.toHaveProperty("access");
    expect(bobTree.rooms[0]).not.toHaveProperty("access");
    expect((await json("/api/search?q=plan", carol)).rooms[0].access).toHaveLength(3);
    expect((await json("/api/search?q=plan", bob)).rooms[0]).not.toHaveProperty("access");
    // A linked grant follows the user's current e-mail.
    backend.store.run(
      "UPDATE users SET email=? WHERE email=?",
      "bob.builder@example.test",
      "bob@example.test",
    );
    expect(
      (await json(`/api/tree?folderId=${projects.id}`, alice)).rooms[0].access[1]
        .principal.email,
    ).toBe("bob.builder@example.test");
  });
  test("summarises access of a deep, heavily shared tree quickly", () => {
    const admin = { userId: "admin", email: "admin@example.test", isAdmin: true };
    let parent = "root";
    backend.store.transaction(() => {
      for (let level = 0; level < 16; level++) {
        parent = backend.tree.createFolder(admin, parent, `Level ${level}`).id;
        for (let i = 0; i < 500; i++)
          backend.store.run(
            "INSERT INTO grants(node_kind,node_id,principal_kind,principal_email,principal_user_id,role,created_at,created_by) VALUES('folder',?,'user',?,NULL,'viewer',0,'admin')",
            parent,
            `user${level}-${i}@example.test`,
          );
      }
      for (let i = 0; i < 50; i++)
        backend.store.run(
          "INSERT INTO rooms(id,folder_id,name,created_at,updated_at,created_by) VALUES(?,?,?,0,0,'admin')",
          `room-${i}`,
          parent,
          `Room ${i}`,
        );
    });
    const started = performance.now();
    const listing = backend.tree.list(admin, parent);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(listing.rooms).toHaveLength(50);
    expect(listing.rooms[0]!.access).toHaveLength(16 * 500);
  });
  test("converges clients, echoes rejected versions, resyncs reconnects and changes roles live", async () => {
    const alice = await login("alice"),
      bob = await login("bob"),
      carol = await login("carol");
    const drawing = await room(alice);
    const bobGrant: GrantInput = {
      kind: "user",
      email: "bob@example.test",
      role: "editor",
    };
    const carolGrant: GrantInput = {
      kind: "user",
      email: "carol@example.test",
      role: "viewer",
    };
    await grant(alice, drawing.id, [bobGrant, carolGrant]);
    const a = await ready(alice, drawing.id),
      b = await ready(bob, drawing.id),
      viewer = await ready(carol, drawing.id);
    const presence = await a.next(
      "presence",
      (message) => message.collaborators.length === 3,
    );
    expect(presence.collaborators.map((c) => c.name).sort()).toEqual([
      "Alice Architect",
      "Bob Builder",
      "Carol Viewer",
    ]);
    const first = rectangle("box", { version: 2 });
    const other = rectangle("other", { index: "a1" });
    a.send({ type: "scene_update", elements: [first] });
    b.send({ type: "scene_update", elements: [other] });
    expect((await b.next("scene_update")).elements).toEqual([first]);
    expect((await a.next("scene_update")).elements).toEqual([other]);
    a.send({ type: "request_scene" });
    b.send({ type: "request_scene" });
    expect((await a.next("scene_init")).elements).toEqual([first, other]);
    expect((await b.next("scene_init")).elements).toEqual([first, other]);
    const winner = { ...first, version: 3, x: 80 };
    b.send({ type: "scene_update", elements: [winner] });
    expect((await a.next("scene_update")).elements).toEqual([winner]);
    a.send({ type: "scene_update", elements: [first] });
    expect(await a.next("scene_update")).toMatchObject({
      origin: "server",
      elements: [winner],
    });
    viewer.send({ type: "scene_update", elements: [rectangle("forbidden")] });
    expect(await viewer.next("error")).toMatchObject({
      code: "forbidden",
      fatal: false,
    });
    b.send({
      type: "pointer",
      x: 15,
      y: 30,
      tool: "pointer",
      button: "up",
      selectedElementIds: ["box"],
    });
    expect(await a.next("pointer")).toMatchObject({
      x: 15,
      y: 30,
      selectedElementIds: ["box"],
    });
    b.socket.close();
    await b.closed;
    const reconnected = connect(bob, drawing.id);
    expect((await reconnected.next("scene_init")).elements).toEqual([
      winner,
      other,
    ]);
    // A reconnect's syncAll can carry offline edits newer than the server copy.
    const offline = { ...winner, version: 4, x: 120 };
    reconnected.send({ type: "scene_update", elements: [offline] });
    expect((await a.next("scene_update")).elements).toEqual([offline]);
    await grant(alice, drawing.id, [
      { ...bobGrant, role: "viewer" },
      carolGrant,
    ]);
    expect(await reconnected.next("role")).toMatchObject({ role: "viewer" });
    reconnected.send({ type: "scene_update", elements: [rectangle("denied")] });
    expect(await reconnected.next("error")).toMatchObject({
      code: "forbidden",
      fatal: false,
    });
    await grant(alice, drawing.id, [carolGrant]);
    expect(await reconnected.closed).toBe(4403);
    expect(
      (await json(`/api/rooms/${drawing.id}/scene`, alice)).elements,
    ).toEqual([offline, other]);
  });
  test("rejects untrusted origins and closes unauthenticated, invisible, missing and deleted rooms with protocol codes", async () => {
    const alice = await login("alice"),
      bob = await login("bob");
    const drawing = await room(alice);
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(
        base.replace("http:", "ws:") + `/ws?room=${drawing.id}`,
        {
          origin: "https://attacker.example",
          headers: { Cookie: alice },
        },
      );
      socket.on("error", () => {});
      socket.once("open", () => {
        socket.terminate();
        reject(new Error("Untrusted origin upgraded"));
      });
      socket.once("unexpected-response", (request, response) => {
        resolve(response.statusCode!);
        response.resume();
        request.destroy();
      });
    });
    expect(status).toBe(403);
    expect(await connect("", drawing.id).closed).toBe(4401);
    expect(await connect(alice, "missing").closed).toBe(4404);
    expect(await connect(bob, drawing.id).closed).toBe(4403);
    const connected = await ready(alice, drawing.id);
    expect(
      (await request(`/api/rooms/${drawing.id}`, alice, "DELETE")).status,
    ).toBe(204);
    expect(await connected.closed).toBe(4410);
    expect(await connect(alice, drawing.id).closed).toBe(4404);
  });
  test("restores snapshots above live versions, tombstones later elements, and flushes scene changes on restart", async () => {
    const alice = await login("alice");
    const drawing = await room(alice);
    const writer = await ready(alice, drawing.id),
      observer = await ready(alice, drawing.id);
    const original = rectangle("original", { version: 3 });
    writer.send({ type: "scene_update", elements: [original] });
    await observer.next("scene_update");
    const snapshot = await json(
      `/api/rooms/${drawing.id}/snapshots`,
      alice,
      "POST",
      {},
      201,
    );
    expect(snapshot).toMatchObject({
      reason: "manual",
      elementCount: 1,
      sceneVersion: 3,
    });
    expect(
      (await json(`/api/rooms/${drawing.id}/snapshots/${snapshot.id}`, alice))
        .elements,
    ).toEqual([original]);
    writer.send({
      type: "scene_update",
      elements: [
        { ...original, x: 900, version: 7 },
        rectangle("later", { index: "a1" }),
      ],
    });
    await observer.next("scene_update");
    const before = await json(
      `/api/rooms/${drawing.id}/snapshots/${snapshot.id}/restore`,
      alice,
      "POST",
    );
    expect(before).toMatchObject({ reason: "restore", sceneVersion: 8 });
    const restored = await observer.next("scene_update");
    expect(restored.elements.find((e) => e.id === "original")).toMatchObject({
      x: original.x,
      version: 8,
      isDeleted: false,
    });
    expect(restored.elements.find((e) => e.id === "later")).toMatchObject({
      version: 2,
      isDeleted: true,
    });
    expect(
      (await json(`/api/rooms/${drawing.id}/snapshots`, alice)).snapshots.map(
        (s: any) => s.reason,
      ),
    ).toContain("restore");
    // Stop before the debounce expires, so shutdown must persist the last edit.
    const final = { ...original, version: 12, x: 321 };
    writer.send({ type: "scene_update", elements: [final] });
    await observer.next("scene_update");
    await backend.close();
    expect(await writer.closed).toBe(1001);
    await start();
    const scene = await json(`/api/rooms/${drawing.id}/scene`, alice);
    expect(
      scene.elements.find((e: SceneElement) => e.id === "original"),
    ).toEqual(final);
    expect(
      scene.elements.find((e: SceneElement) => e.id === "later"),
    ).toMatchObject({ isDeleted: true });
    expect(
      (await connect(alice, drawing.id).next("scene_init")).elements,
    ).toEqual(scene.elements);
  });
  test("MCP SDK creates rooms, reads scenes, moves bound labels and cleans bindings on delete with current permissions", async () => {
    const alice = await login("alice"),
      bob = await login("bob");
    const client = await mcp(alice);
    const who = await client.callTool({ name: "whoami", arguments: {} });
    expect(who.structuredContent).toMatchObject({
      user: { email: "alice@example.test" },
      isAdmin: true,
    });
    const created = await client.callTool({
      name: "create_room",
      arguments: { folderId: "root", name: "Agent room" },
    });
    expect(created.isError).not.toBe(true);
    const roomId = (created.structuredContent as any).room.id;
    await grant(alice, roomId, [
      { kind: "user", email: "bob@example.test", role: "viewer" },
    ]);
    const writer = await ready(alice, roomId),
      observer = await ready(alice, roomId);
    writer.send({
      type: "scene_update",
      elements: [
        rectangle("box", {
          boundElements: [
            { id: "label", type: "text" },
            { id: "arrow", type: "arrow" },
          ],
        }),
        rectangle("label", {
          type: "text",
          index: "a1",
          text: "API",
          containerId: "box",
        }),
        rectangle("arrow", {
          type: "arrow",
          index: "a2",
          startBinding: { elementId: "box" },
          endBinding: null,
          points: [
            [0, 0],
            [100, 60],
          ],
          startArrowhead: null,
          endArrowhead: "arrow",
        }),
      ],
    });
    await observer.next("scene_update");
    const read = await client.callTool({
      name: "read_scene",
      arguments: { roomId },
    });
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
    const compact = (read.structuredContent as any).elements;
    expect(compact.find((e: any) => e.id === "box")).toMatchObject({
      label: "API",
    });
    expect(compact.some((e: any) => e.id === "label")).toBe(false);
    const moved = await client.callTool({
      name: "move_elements",
      arguments: { roomId, ids: ["box"], dx: 5, dy: -2 },
    });
    expect(moved.structuredContent).toMatchObject({
      moved: ["box"],
      notFound: [],
    });
    const update = await observer.next("scene_update");
    expect(
      update.elements.filter((e) => e.id === "box" || e.id === "label"),
    ).toEqual([
      expect.objectContaining({ id: "box", x: 15, y: 18, version: 2 }),
      expect.objectContaining({ id: "label", x: 15, y: 18, version: 2 }),
    ]);
    const viewer = await mcp(bob);
    const denied = await viewer.callTool({
      name: "move_elements",
      arguments: { roomId, ids: ["box"], dx: 1, dy: 0 },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: { code: "forbidden" },
    });
    const deleted = await client.callTool({
      name: "delete_elements",
      arguments: { roomId, ids: ["box"] },
    });
    expect(deleted.isError).not.toBe(true);
    const full = await client.callTool({
      name: "read_scene",
      arguments: { roomId, format: "full", includeDeleted: true },
    });
    const elements = (full.structuredContent as any).elements as SceneElement[];
    expect(elements.find((e) => e.id === "box")).toMatchObject({
      isDeleted: true,
      version: 3,
      boundElements: [{ id: "arrow", type: "arrow" }],
    });
    expect(elements.find((e) => e.id === "label")).toMatchObject({
      isDeleted: true,
      version: 3,
    });
    expect(elements.find((e) => e.id === "arrow")).toMatchObject({
      startBinding: null,
      isDeleted: false,
      // Moving its bound shape rerouted the arrow once; deletion unbinds it.
      version: 3,
    });
    await grant(alice, roomId, []);
    const invisible = await viewer.callTool({
      name: "read_scene",
      arguments: { roomId },
    });
    expect(invisible.isError).toBe(true);
    expect(invisible.structuredContent).toMatchObject({
      error: { code: "not_found" },
    });
  });
});
