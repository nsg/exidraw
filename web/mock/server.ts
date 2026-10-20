/**
 * Minimal in-memory stand-in for the backend, ONLY for UI work before the real
 * server exists (`npm run mock -w web`, then `npm run dev -w web`). One fixed
 * user who owns everything; no persistence, no permissions. E2E tests target
 * the real server, never this.
 */
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  ROOT_FOLDER_ID,
  collaboratorColor,
  compareElementOrder,
  computeSceneVersion,
  remoteWins,
  type ClientMessage,
  type CollaboratorInfo,
  type FolderInfo,
  type RoomInfo,
  type SceneElement,
  type ServerMessage,
  type TokenInfo,
  type UserInfo,
} from "@exidraw/shared";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:5173";
const user: UserInfo = { id: "alice", email: "alice@example.test", name: "Alice Architect", avatarUrl: null };
const id = (n = 9) => randomBytes(n).toString("base64url");
const now = () => Date.now();

const folders = new Map<string, FolderInfo>([
  [ROOT_FOLDER_ID, { id: ROOT_FOLDER_ID, parentId: null, name: "Root", role: "owner", createdAt: now(), updatedAt: now() }],
]);
const rooms = new Map<string, RoomInfo>();
const scenes = new Map<string, Map<string, SceneElement>>();
const files = new Map<string, { type: string; bytes: Buffer }>();
const tokens = new Map<string, TokenInfo>();

const app = new Hono();
const err = (code: string, message: string) => ({ error: { code, message } });

app.get("/api/auth/providers", (c) =>
  c.json({ mode: "dev", loginUrl: "/auth/dev/login", users: [{ id: user.id, email: user.email, name: user.name }] }),
);
app.post("/auth/dev/login", (c) => c.body(null, 204));
app.post("/auth/logout", (c) => c.body(null, 204));
app.get("/api/me", (c) => c.json({ user, isAdmin: true, authMode: "dev", via: "session" }));
app.get("/api/users", (c) => c.json({ users: [user] }));

app.get("/api/tree", (c) => {
  const folder = folders.get(c.req.query("folderId") ?? ROOT_FOLDER_ID);
  if (!folder) return c.json(err("not_found", "folder"), 404);
  const breadcrumbs: Array<{ id: string; name: string }> = [];
  for (let p = folder.parentId; p; p = folders.get(p)?.parentId ?? null) {
    breadcrumbs.unshift({ id: p, name: folders.get(p)!.name });
  }
  return c.json({
    folder,
    breadcrumbs,
    folders: [...folders.values()].filter((f) => f.parentId === folder.id),
    rooms: [...rooms.values()].filter((r) => r.folderId === folder.id),
  });
});
app.get("/api/search", (c) => {
  const q = (c.req.query("q") ?? "").toLowerCase();
  return c.json({
    folders: [...folders.values()].filter((f) => f.id !== ROOT_FOLDER_ID && f.name.toLowerCase().includes(q)),
    rooms: [...rooms.values()].filter((r) => r.name.toLowerCase().includes(q)),
  });
});
app.post("/api/folders", async (c) => {
  const body = await c.req.json<{ parentId: string; name: string }>();
  const f: FolderInfo = { id: id(), parentId: body.parentId, name: body.name, role: "owner", createdAt: now(), updatedAt: now() };
  folders.set(f.id, f);
  return c.json(f, 201);
});
app.patch("/api/folders/:id", async (c) => {
  const f = folders.get(c.req.param("id"));
  if (!f) return c.json(err("not_found", "folder"), 404);
  Object.assign(f, await c.req.json(), { updatedAt: now() });
  return c.json(f);
});
app.delete("/api/folders/:id", (c) => {
  folders.delete(c.req.param("id"));
  return c.body(null, 204);
});
app.post("/api/rooms", async (c) => {
  const body = await c.req.json<{ folderId: string; name: string }>();
  const rid = id();
  const r: RoomInfo = { id: rid, folderId: body.folderId, name: body.name, role: "owner", createdAt: now(), updatedAt: now(), url: `${PUBLIC_URL}/r/${rid}` };
  rooms.set(r.id, r);
  scenes.set(r.id, new Map());
  return c.json(r, 201);
});
app.get("/api/rooms/:id", (c) => {
  const r = rooms.get(c.req.param("id"));
  return r ? c.json(r) : c.json(err("not_found", "room"), 404);
});
app.patch("/api/rooms/:id", async (c) => {
  const r = rooms.get(c.req.param("id"));
  if (!r) return c.json(err("not_found", "room"), 404);
  Object.assign(r, await c.req.json(), { updatedAt: now() });
  broadcast(r.id, { type: "room_updated", room: r });
  return c.json(r);
});
app.delete("/api/rooms/:id", (c) => {
  rooms.delete(c.req.param("id"));
  return c.body(null, 204);
});
app.get("/api/rooms/:id/files/:fileId", (c) => {
  const f = files.get(`${c.req.param("id")}/${c.req.param("fileId")}`);
  if (!f) return c.json(err("not_found", "file"), 404);
  return c.body(new Uint8Array(f.bytes), 200, { "content-type": f.type });
});
app.put("/api/rooms/:id/files/:fileId", async (c) => {
  const key = `${c.req.param("id")}/${c.req.param("fileId")}`;
  const existed = files.has(key);
  const bytes = Buffer.from(await c.req.arrayBuffer());
  const type = c.req.header("content-type") ?? "application/octet-stream";
  if (!existed) files.set(key, { type, bytes });
  return c.json({ fileId: c.req.param("fileId"), mimeType: type, sizeBytes: bytes.length, createdAt: now() }, existed ? 200 : 201);
});
app.get("/api/nodes/:kind/:id/grants", (c) =>
  c.json({ node: { kind: c.req.param("kind"), id: c.req.param("id"), name: "node" }, grants: [], inherited: [], effective: "owner" }),
);
app.put("/api/nodes/:kind/:id/grants", (c) =>
  c.json({ node: { kind: c.req.param("kind"), id: c.req.param("id"), name: "node" }, grants: [], inherited: [], effective: "owner" }),
);
app.get("/api/tokens", (c) => c.json({ tokens: [...tokens.values()] }));
app.post("/api/tokens", async (c) => {
  const body = await c.req.json<{ name: string; expiresInDays?: number }>();
  const token = `exi_${randomBytes(32).toString("base64url")}`;
  const info: TokenInfo = {
    id: id(),
    name: body.name,
    prefix: token.slice(0, 12),
    createdAt: now(),
    expiresAt: body.expiresInDays ? now() + body.expiresInDays * 86_400_000 : null,
    lastUsedAt: null,
  };
  tokens.set(info.id, info);
  return c.json({ token, info }, 201);
});
app.delete("/api/tokens/:id", (c) => {
  tokens.delete(c.req.param("id"));
  return c.body(null, 204);
});
app.get("/api/rooms/:id/snapshots", (c) => c.json({ snapshots: [] }));
app.get("/healthz", (c) => c.json({ ok: true, renderer: "disabled", uptimeSec: 0, version: "mock" }));

// ---- WebSocket ------------------------------------------------------------------

interface Conn {
  ws: WebSocket;
  connId: string;
  roomId: string;
  idle: CollaboratorInfo["idle"];
}
const conns = new Set<Conn>();

function send(conn: Conn, msg: ServerMessage) {
  conn.ws.send(JSON.stringify(msg));
}
function broadcast(roomId: string, msg: ServerMessage, except?: Conn) {
  for (const c of conns) if (c.roomId === roomId && c !== except) send(c, msg);
}
function sceneOf(roomId: string) {
  const scene = scenes.get(roomId)!;
  const elements = [...scene.values()].sort(compareElementOrder);
  return { elements, sceneVersion: computeSceneVersion(elements) };
}
function presence(roomId: string) {
  // Every connection is "Alice"; suffix the connId so two tabs are distinguishable.
  const collaborators: CollaboratorInfo[] = [...conns]
    .filter((c) => c.roomId === roomId)
    .map((c) => ({ connId: c.connId, userId: user.id, name: `${user.name} ${c.connId.slice(0, 3)}`, color: collaboratorColor(c.connId), isAgent: false, idle: c.idle }));
  broadcast(roomId, { type: "presence", collaborators });
}

const server = serve({ fetch: app.fetch, port: PORT }, () => console.log(`mock server on :${PORT}`));
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  const roomId = url.searchParams.get("room") ?? "";
  if (url.pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = rooms.get(roomId);
    if (!room) return ws.close(4404, "not found");
    const conn: Conn = { ws, connId: id(6), roomId, idle: "active" };
    conns.add(conn);
    send(conn, { type: "welcome", protocolVersion: PROTOCOL_VERSION, connId: conn.connId, user, role: "owner", room, serverTime: now() });
    send(conn, { type: "scene_init", ...sceneOf(roomId) });
    presence(roomId);
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as ClientMessage;
      const scene = scenes.get(roomId)!;
      if (msg.type === "scene_update") {
        const accepted: SceneElement[] = [];
        const rejected: SceneElement[] = [];
        for (const e of msg.elements) {
          const cur = scene.get(e.id);
          if (remoteWins(cur, e)) {
            scene.set(e.id, e);
            accepted.push(e);
          } else if (cur) rejected.push(cur);
        }
        const sceneVersion = sceneOf(roomId).sceneVersion;
        if (accepted.length) broadcast(roomId, { type: "scene_update", elements: accepted, sceneVersion, origin: conn.connId }, conn);
        if (rejected.length) send(conn, { type: "scene_update", elements: rejected, sceneVersion, origin: "server" });
      } else if (msg.type === "pointer") {
        broadcast(roomId, { ...msg, connId: conn.connId }, conn);
      } else if (msg.type === "idle") {
        conn.idle = msg.state;
        broadcast(roomId, { type: "idle", connId: conn.connId, state: msg.state }, conn);
      } else if (msg.type === "request_scene") {
        send(conn, { type: "scene_init", ...sceneOf(roomId) });
      }
    });
    ws.on("close", () => {
      conns.delete(conn);
      presence(roomId);
    });
  });
});
