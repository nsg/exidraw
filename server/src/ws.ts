import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { setTimeout, clearTimeout, setInterval, clearInterval } from "node:timers";
import {
  PROTOCOL_VERSION,
  REQUIRED_ROLE,
  roleAtLeast,
  collaboratorColor,
  MAX_WS_MESSAGE_BYTES,
  MAX_ELEMENTS_PER_ROOM,
  SESSION_COOKIE,
  POINTER_RATE_LIMIT_PER_SEC,
  SCENE_UPDATE_RATE_LIMIT_PER_SEC,
  WS_PING_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  WS_CLOSE,
  isElementEnvelope,
  remoteWins,
} from "@exidraw/shared";
import type { ServerMessage, Role, SceneElement, WsErrorCode } from "@exidraw/shared";
import { cookieValue, type AuthService, type AuthContext } from "./auth.js";
import type { Config } from "./config.js";
import { Tree, id } from "./tree.js";
import { RoomManager } from "./rooms.js";
import { HttpError } from "./errors.js";
const ABUSE_WINDOW_MS = 10_000;
const MAX_WINDOW_BYTES = 32 * 1024 * 1024;
// Normal drawing with a moving cursor reaches ~550 frames per window; keep a
// wide margin so only genuine floods are cut off.
export const MAX_WINDOW_FRAMES = 2_000;
const COALESCE_MS = 100;

interface Connection {
  socket: WebSocket;
  roomId: string;
  auth: AuthContext;
  sessionId: string;
  sessionHeaders: Headers;
  role: Role;
  connId: string;
  window: number;
  pointers: number;
  updates: number;
  budget: { at: number; bytes: number }[];
  budgetBytes: number;
  forbiddenUpdates: number[];
  pending: Map<string, SceneElement>;
  pendingTimer?: NodeJS.Timeout;
  requestAt: number;
  pongTimer?: NodeJS.Timeout;
}
export class Collaboration {
  readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_MESSAGE_BYTES,
  });
  readonly connections = new Map<string, Connection>();
  private ping: NodeJS.Timeout;
  constructor(
    server: Server,
    readonly config: Config,
    readonly auth: AuthService,
    readonly tree: Tree,
    readonly rooms: RoomManager,
  ) {
    server.on("upgrade", (req, socket, head) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", config.publicUrl);
      } catch {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      if (url.pathname !== "/ws") {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      const origins = [
        new URL(config.publicUrl).origin,
        ...config.allowedOrigins,
      ];
      if (!req.headers.origin || !origins.includes(req.headers.origin)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const headers = new Headers();
      if (req.headers.cookie) headers.set("cookie", req.headers.cookie);
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.connect(ws, url.searchParams.get("room") ?? "", headers),
      );
    });
    this.ping = setInterval(() => {
      for (const c of this.connections.values()) {
        if (c.socket.readyState !== WebSocket.OPEN || !this.validateSession(c))
          continue;
        if (c.pongTimer) continue;
        c.socket.ping();
        c.pongTimer = setTimeout(
          () => c.socket.terminate(),
          WS_PONG_TIMEOUT_MS,
        );
        c.pongTimer.unref();
      }
    }, WS_PING_INTERVAL_MS);
    this.ping.unref();
  }
  private send(socket: WebSocket, message: ServerMessage) {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  }
  private fail(socket: WebSocket, code: number, message: string) {
    this.send(socket, {
      type: "error",
      code:
        code === WS_CLOSE.UNAUTHENTICATED ? "unauthenticated" :
        code === WS_CLOSE.ROOM_NOT_FOUND ? "not_found" :
        code === WS_CLOSE.MESSAGE_TOO_LARGE ? "message_too_large" :
        code === WS_CLOSE.RATE_LIMITED ? "rate_limited" : "forbidden",
      message,
      fatal: true,
    });
    socket.close(code);
  }
  private connect(socket: WebSocket, roomId: string, headers: Headers) {
    // ws normally uses 1009 for maxPayload; our protocol specifies 4413.
    const close = socket.close.bind(socket);
    socket.close = ((code?: number, data?: string | Buffer) => {
      if (code !== undefined && [4401, 4403, 4404, 4410].includes(code)) {
        const connection = [...this.connections.values()].find((c) => c.socket === socket);
        if (connection) this.discardPending(connection);
      }
      if (code === 1009) {
        this.send(socket, {
          type: "error", code: "message_too_large",
          message: "WebSocket message exceeds the size limit", fatal: true,
        });
        return close(WS_CLOSE.MESSAGE_TOO_LARGE, data);
      }
      return close(code, data);
    }) as typeof socket.close;
    socket.on("error", () => {});
    let auth: AuthContext | null;
    try {
      auth = this.auth.authenticate(headers);
    } catch {
      auth = null;
    }
    if (!auth || auth.via !== "session") {
      this.fail(socket, 4401, "Authentication required");
      return;
    }
    try {
      this.tree.row("room", roomId);
    } catch {
      this.fail(socket, 4404, "Room not found");
      return;
    }
    const role = this.tree.role(auth.subject, "room", roomId);
    if (!roleAtLeast(role, REQUIRED_ROLE.viewNode)) {
      this.fail(socket, 4403, "Room access denied");
      return;
    }
    const connId = id(),
      c: Connection = {
        socket,
        roomId,
        auth,
        sessionId: cookieValue(headers, SESSION_COOKIE)!,
        sessionHeaders: new Headers(headers),
        role: role!,
        connId,
        window: Date.now(),
        pointers: 0,
        updates: 0,
        budget: [],
        budgetBytes: 0,
        forbiddenUpdates: [],
        pending: new Map(),
        requestAt: 0,
      };
    this.connections.set(connId, c);
    const presence = {
      connId,
      userId: auth.user.id,
      name: auth.user.name,
      color: collaboratorColor(auth.user.id),
      isAgent: false,
      idle: "active" as const,
    };
    this.rooms.join(roomId, {
      connId,
      presence,
      send: (m) => this.send(socket, m),
      close: (code) => socket.close(code),
    });
    this.send(socket, {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      connId,
      user: auth.user,
      role: role!,
      room: this.tree.room(auth.subject, roomId),
      serverTime: Date.now(),
    });
    this.send(socket, { type: "scene_init", ...this.rooms.scene(roomId) });
    this.rooms.presence(roomId);
    socket.on("ping", (data) => this.recordFrame(c, data.byteLength));
    socket.on("pong", (data) => {
      this.recordFrame(c, data.byteLength);
      clearTimeout(c.pongTimer);
      c.pongTimer = undefined;
    });
    socket.on("close", (code) => {
      if ([4401, 4403, 4404, 4410].includes(code)) this.discardPending(c);
      else this.flushConnection(c);
      clearTimeout(c.pongTimer);
      this.connections.delete(connId);
      this.rooms.leave(roomId, connId);
    });
    socket.on("message", (data, binary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const bytes = Array.isArray(data)
        ? data.reduce((sum, part) => sum + part.byteLength, 0)
        : data.byteLength;
      // Account for every message, regardless of its JSON/type/permissions.
      if (!this.recordFrame(c, bytes)) return;
      if (bytes > MAX_WS_MESSAGE_BYTES) {
        this.fail(socket, WS_CLOSE.MESSAGE_TOO_LARGE, "WebSocket message exceeds the size limit");
        return;
      }
      if (!this.validateSession(c)) return;
      if (binary) {
        socket.close(WS_CLOSE.PROTOCOL_ERROR);
        return;
      }
      try {
        this.message(c, JSON.parse(data.toString()));
      } catch (error) {
        this.sendError(c, error);
      }
    });
  }
  private sendError(c: Connection, error: unknown) {
    let code: WsErrorCode = "invalid_message";
    if (error instanceof HttpError) {
      if (error.message === "too_many_elements") code = "too_many_elements";
      else if (error.code === "too_large") code = "message_too_large";
      else if (["forbidden", "unauthenticated", "not_found", "rate_limited", "internal"].includes(error.code))
        code = error.code as WsErrorCode;
    }
    this.send(c.socket, {
      type: "error", code,
      message: error instanceof Error ? error.message : "Invalid message",
      fatal: false,
    });
  }
  private recordFrame(c: Connection, bytes: number): boolean {
    const now = Date.now();
    while (c.budget.length && c.budget[0]!.at <= now - ABUSE_WINDOW_MS)
      c.budgetBytes -= c.budget.shift()!.bytes;
    c.budget.push({ at: now, bytes });
    c.budgetBytes += bytes;
    if (c.budget.length > MAX_WINDOW_FRAMES || c.budgetBytes > MAX_WINDOW_BYTES) {
      this.fail(c.socket, WS_CLOSE.RATE_LIMITED, "WebSocket traffic budget exceeded");
      return false;
    }
    return true;
  }
  private discardPending(c: Connection) {
    clearTimeout(c.pendingTimer);
    c.pendingTimer = undefined;
    c.pending.clear();
  }
  private flushConnection(c: Connection) {
    const elements = [...c.pending.values()];
    this.discardPending(c);
    if (!elements.length) return;
    try {
      // Authorization can change while an update waits for the coalescing timer.
      if (!this.validateSession(c)) return;
      this.tree.require(c.auth.subject, "room", c.roomId, "writeScene");
      this.rooms.applyElements(c.roomId, elements, c.connId);
    } catch (error) {
      this.sendError(c, error);
    }
  }
  private queueElements(c: Connection, elements: SceneElement[]) {
    // Preserve per-message capacity decisions: a later overflowing batch must
    // not prevent an earlier valid buffered batch from being accepted.
    const current = this.rooms.load(c.roomId).elements;
    const prospective = new Map<string, SceneElement>();
    let liveCount = 0;
    for (const element of current.values()) if (!element.isDeleted) liveCount++;
    for (const element of [...c.pending.values(), ...elements]) {
      const previous = prospective.get(element.id) ?? current.get(element.id);
      if (remoteWins(previous, element)) {
        if (previous && !previous.isDeleted) liveCount--;
        if (!element.isDeleted) liveCount++;
        prospective.set(element.id, element);
      }
    }
    if (liveCount > MAX_ELEMENTS_PER_ROOM) {
      this.flushConnection(c);
      this.rooms.applyElements(c.roomId, elements, c.connId);
      return;
    }
    for (const element of elements) {
      if (remoteWins(c.pending.get(element.id), element))
        c.pending.set(element.id, element);
    }
    c.pendingTimer ??= setTimeout(() => this.flushConnection(c), COALESCE_MS);
    c.pendingTimer.unref();
  }
  flushPending() {
    for (const c of this.connections.values()) this.flushConnection(c);
  }
  private message(c: Connection, m: any) {
    if (!m || typeof m !== "object")
      throw new HttpError("invalid", "Invalid message");
    this.tree.require(c.auth.subject, "room", c.roomId, "viewNode");
    const now = Date.now();
    if (now - c.window >= 1000) {
      c.window = now;
      c.pointers = 0;
      c.updates = 0;
    }
    switch (m.type) {
      case "scene_update":
        try {
          this.tree.require(c.auth.subject, "room", c.roomId, "writeScene");
        } catch (error) {
          if (error instanceof HttpError && error.code === "forbidden") {
            c.forbiddenUpdates = c.forbiddenUpdates.filter((at) => at > now - ABUSE_WINDOW_MS);
            c.forbiddenUpdates.push(now);
            if (c.forbiddenUpdates.length >= 20) {
              this.fail(c.socket, WS_CLOSE.FORBIDDEN, "Repeated forbidden scene updates");
              return;
            }
          }
          throw error;
        }
        if (!Array.isArray(m.elements))
          throw new HttpError("invalid", "Invalid scene update elements");
        if (m.elements.length > MAX_ELEMENTS_PER_ROOM)
          throw new HttpError("too_large", "too_many_elements");
        if (!m.elements.every(isElementEnvelope))
          throw new HttpError("invalid", "Invalid element envelope");
        if (++c.updates > SCENE_UPDATE_RATE_LIMIT_PER_SEC || c.pending.size) {
          this.queueElements(c, m.elements);
        } else {
          this.rooms.applyElements(c.roomId, m.elements, c.connId);
        }
        break;
      case "pointer":
        if (++c.pointers > POINTER_RATE_LIMIT_PER_SEC) return;
        if (
          !Number.isFinite(m.x) ||
          !Number.isFinite(m.y) ||
          !["pointer", "laser"].includes(m.tool) ||
          !["up", "down"].includes(m.button) ||
          !Array.isArray(m.selectedElementIds) ||
          m.selectedElementIds.length > MAX_ELEMENTS_PER_ROOM ||
          !m.selectedElementIds.every(
            (v: unknown) => typeof v === "string" && v.length <= 64,
          )
        )
          throw new HttpError("invalid", "Invalid pointer");
        this.rooms.broadcast(
          c.roomId,
          {
            type: "pointer",
            connId: c.connId,
            x: m.x,
            y: m.y,
            tool: m.tool,
            button: m.button,
            selectedElementIds: m.selectedElementIds,
          },
          c.connId,
        );
        break;
      case "idle":
        if (!["active", "idle", "away"].includes(m.state))
          throw new HttpError("invalid", "Invalid idle state");
        this.rooms.load(c.roomId).peers.get(c.connId)!.presence.idle = m.state;
        this.rooms.broadcast(
          c.roomId,
          { type: "idle", connId: c.connId, state: m.state },
          c.connId,
        );
        break;
      case "request_scene":
        if (now - c.requestAt < 1000) return;
        this.flushConnection(c);
        c.requestAt = now;
        this.send(c.socket, {
          type: "scene_init",
          ...this.rooms.scene(c.roomId),
        });
        break;
      default:
        throw new HttpError("invalid", "Unknown message");
    }
  }
  private validateSession(c: Connection): boolean {
    let current: AuthContext | null;
    try {
      current = this.auth.authenticate(c.sessionHeaders);
    } catch {
      current = null;
    }
    if (
      !current ||
      current.via !== "session" ||
      current.user.id !== c.auth.user.id
    ) {
      this.fail(c.socket, 4401, "Session expired or revoked");
      return false;
    }
    c.auth = current;
    return true;
  }
  revokeSession(sessionId: string | null): void {
    if (!sessionId) return;
    for (const c of this.connections.values()) {
      if (c.sessionId === sessionId && c.socket.readyState === WebSocket.OPEN)
        this.fail(c.socket, 4401, "Session revoked");
    }
  }
  refreshRoles() {
    for (const c of this.connections.values()) {
      let role: Role | null = null;
      try {
        role = this.tree.role(c.auth.subject, "room", c.roomId);
      } catch {}
      if (!roleAtLeast(role, REQUIRED_ROLE.viewNode)) {
        this.fail(c.socket, 4403, "Room access revoked");
        continue;
      }
      if (!roleAtLeast(role, REQUIRED_ROLE.writeScene)) this.discardPending(c);
      if (role !== c.role) {
        c.role = role!;
        this.send(c.socket, { type: "role", role: role! });
      }
    }
  }
  roomUpdated(roomId: string) {
    for (const c of this.connections.values())
      if (c.roomId === roomId) {
        try {
          this.send(c.socket, {
            type: "room_updated",
            room: this.tree.room(c.auth.subject, roomId),
          });
        } catch {}
      }
    this.refreshRoles();
  }
  close() {
    this.flushPending();
    clearInterval(this.ping);
    for (const c of this.connections.values()) {
      clearTimeout(c.pongTimer);
      c.socket.close(1001);
    }
    this.wss.close();
  }
  terminate() {
    for (const c of this.connections.values()) c.socket.terminate();
  }
}
