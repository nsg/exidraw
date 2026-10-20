import { bounds } from "./compact.js";
import { randomInt } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  compareElementOrder,
  computeSceneVersion,
  isElementEnvelope,
  remoteWins,
  MAX_ELEMENTS_PER_ROOM,
  MAX_STORED_ELEMENTS_PER_ROOM,
  ELEMENT_VERSION_MAX,
  SCENE_PERSIST_DEBOUNCE_MS,
  SCENE_PERSIST_MAX_WAIT_MS,
  TOMBSTONE_RETENTION_MS,
  ROOM_IDLE_UNLOAD_MS,
  SNAPSHOT_MIN_INTERVAL_MS,
  SNAPSHOT_AGENT_MIN_INTERVAL_MS,
  SNAPSHOTS_KEEP_PER_ROOM,
  AGENT_PRESENCE_TTL_MS,
  collaboratorColor,
} from "@exidraw/shared";
import type {
  SceneElement,
  CollaboratorInfo,
  ServerMessage,
  SnapshotInfo,
  SnapshotReason,
  SnapshotResponse,
  UserInfo,
} from "@exidraw/shared";
import type { Store } from "./db.js";
import { HttpError } from "./errors.js";
type Row = Record<string, any>;
export interface Peer {
  connId: string;
  presence: CollaboratorInfo;
  send: (message: ServerMessage) => void;
  close: (code: number) => void;
}
interface RoomState {
  elements: Map<string, SceneElement>;
  /** Server receipt time of each current deletion, independent of client updated. */
  tombstoneTimes: Map<string, number>;
  sceneVersion: number;
  dirtySince: number | null;
  timer?: NodeJS.Timeout;
  unload?: NodeJS.Timeout;
  peers: Map<string, Peer>;
  agents: Map<
    string,
    {
      presence: CollaboratorInfo;
      timer: NodeJS.Timeout;
    }
  >;
}
export function stamp(
  element: SceneElement,
  current?: SceneElement,
): SceneElement {
  const version = current?.version ?? 0;
  if (!Number.isInteger(version) || version < 0 || version >= ELEMENT_VERSION_MAX)
    throw new HttpError("conflict", "Element version exhausted");
  return {
    ...element,
    version: version + 1,
    versionNonce: randomInt(0, 2 ** 31),
    updated: Date.now(),
  };
}
export class RoomManager {
  readonly rooms = new Map<string, RoomState>();
  constructor(
    readonly store: Store,
    readonly onError: (error: unknown) => void = () => {},
  ) {}
  load(roomId: string): RoomState {
    let room = this.rooms.get(roomId);
    if (room) return room;
    const row = this.store.get<Row>(
      "SELECT s.* FROM scenes s JOIN rooms r ON r.id=s.room_id WHERE s.room_id=? AND r.deleted_at IS NULL",
      roomId,
    );
    if (!row) throw new HttpError("not_found", `room ${roomId}`);
    const elements = this.parseElements(JSON.parse(row.elements));
    const savedTimes = JSON.parse(row.tombstone_times) as Record<string, unknown>;
    const now = Date.now();
    const tombstoneTimes = new Map<string, number>();
    let missingTime = false;
    for (const e of elements)
      if (e.isDeleted) {
        const saved = savedTimes[e.id];
        if (typeof saved !== "number" || !Number.isFinite(saved)) missingTime = true;
        tombstoneTimes.set(e.id,
          typeof saved === "number" && Number.isFinite(saved) ? saved : now);
      }
    // Old scenes have no receipt metadata. Start their retention conservatively
    // once, and save it immediately so reopening cannot restart the clock.
    if (missingTime)
      this.store.run("UPDATE scenes SET tombstone_times=? WHERE room_id=?",
        JSON.stringify(Object.fromEntries(tombstoneTimes)), roomId);
    room = {
      elements: new Map(elements.map((e) => [e.id, e])),
      tombstoneTimes,
      sceneVersion: computeSceneVersion(elements),
      dirtySince: null,
      peers: new Map(),
      agents: new Map(),
    };
    this.rooms.set(roomId, room);
    this.scheduleUnload(roomId);
    return room;
  }
  private parseElements(value: unknown): SceneElement[] {
    if (!Array.isArray(value) || !value.every(isElementEnvelope))
      throw new HttpError("invalid", "Invalid element envelope");
    return value as SceneElement[];
  }
  elements(roomId: string): SceneElement[] {
    return [...this.load(roomId).elements.values()].sort(compareElementOrder);
  }
  searchElements(roomId: string): SceneElement[] {
    if (this.rooms.has(roomId)) return this.elements(roomId);
    const row = this.store.get<Row>(
      "SELECT elements FROM scenes WHERE room_id=?",
      roomId,
    );
    return row ? this.parseElements(JSON.parse(row.elements)) : [];
  }
  scene(roomId: string) {
    return {
      elements: this.elements(roomId),
      sceneVersion: this.load(roomId).sceneVersion,
    };
  }
  broadcast(roomId: string, message: ServerMessage, except?: string) {
    for (const peer of this.load(roomId).peers.values())
      if (peer.connId !== except) peer.send(message);
  }
  applyElements(
    roomId: string,
    incoming: SceneElement[],
    origin: string,
  ): {
    accepted: SceneElement[];
    rejected: SceneElement[];
  } {
    if (!Array.isArray(incoming) || !incoming.every(isElementEnvelope))
      throw new HttpError("invalid", "Invalid element envelope");
    const room = this.load(roomId),
      next = new Map(room.elements),
      tombstoneTimes = new Map(room.tombstoneTimes),
      accepted: SceneElement[] = [],
      rejected: SceneElement[] = [];
    for (const e of incoming) {
      const cur = next.get(e.id);
      if (remoteWins(cur, e)) {
        const copy = structuredClone(e);
        next.set(copy.id, copy);
        if (copy.isDeleted) {
          if (!cur?.isDeleted) tombstoneTimes.set(copy.id, Date.now());
        } else tombstoneTimes.delete(copy.id);
        accepted.push(copy);
      } else if (cur &&
        (cur.version !== e.version || cur.versionNonce !== e.versionNonce))
        rejected.push(cur);
    }
    if (
      [...next.values()].filter((e) => !e.isDeleted).length >
      MAX_ELEMENTS_PER_ROOM
    )
      throw new HttpError("too_large", "too_many_elements");
    if (next.size > MAX_STORED_ELEMENTS_PER_ROOM) {
      const oldest = [...next.values()].filter((e) => e.isDeleted).sort(
        (a, b) => (tombstoneTimes.get(a.id) ?? 0) - (tombstoneTimes.get(b.id) ?? 0) ||
          compareElementOrder(a, b));
      for (const e of oldest) {
        if (next.size <= MAX_STORED_ELEMENTS_PER_ROOM) break;
        next.delete(e.id);
        tombstoneTimes.delete(e.id);
      }
      if (next.size > MAX_STORED_ELEMENTS_PER_ROOM)
        throw new HttpError("too_large", "too_many_elements");
    }
    if (accepted.length) {
      const version = computeSceneVersion(next.values());
      room.elements = next;
      room.tombstoneTimes = tombstoneTimes;
      room.sceneVersion = version;
      this.markDirty(roomId);
      this.broadcast(
        roomId,
        {
          type: "scene_update",
          elements: accepted,
          sceneVersion: room.sceneVersion,
          origin,
        },
        origin,
      );
    }
    if (rejected.length)
      room.peers.get(origin)?.send({
        type: "scene_update",
        elements: rejected,
        sceneVersion: room.sceneVersion,
        origin: "server",
      });
    return { accepted, rejected };
  }
  private markDirty(roomId: string) {
    const room = this.load(roomId),
      now = Date.now();
    room.dirtySince ??= now;
    clearTimeout(room.timer);
    room.timer = setTimeout(
      () => {
        try {
          this.persist(roomId);
        } catch (error) {
          this.onError(error);
          room.timer = setTimeout(
            () => this.retryPersist(roomId),
            SCENE_PERSIST_DEBOUNCE_MS,
          );
        }
      },
      Math.max(
        0,
        Math.min(
          SCENE_PERSIST_DEBOUNCE_MS,
          SCENE_PERSIST_MAX_WAIT_MS - (now - room.dirtySince),
        ),
      ),
    );
    room.timer.unref();
  }
  private retryPersist(roomId: string) {
    try {
      this.persist(roomId);
    } catch (e) {
      this.onError(e);
      const room = this.rooms.get(roomId);
      if (room)
        room.timer = setTimeout(
          () => this.retryPersist(roomId),
          SCENE_PERSIST_DEBOUNCE_MS,
        );
    }
  }
  persist(roomId: string) {
    const room = this.load(roomId);
    if (room.dirtySince === null) return;
    const now = Date.now();
    const retained = this.elements(roomId).filter(
        (e) => !e.isDeleted ||
          (room.tombstoneTimes.get(e.id) ?? now) >= now - TOMBSTONE_RETENTION_MS,
      ),
      version = computeSceneVersion(retained);
    const tombstoneTimes = new Map(retained.filter((e) => e.isDeleted).map(
      (e) => [e.id, room.tombstoneTimes.get(e.id) ?? now]));
    this.store.transaction(() => {
      this.store.run(
        "UPDATE scenes SET elements=?,scene_version=?,updated_at=?,tombstone_times=? WHERE room_id=?",
        JSON.stringify(retained),
        version,
        now,
        JSON.stringify(Object.fromEntries(tombstoneTimes)),
        roomId,
      );
      this.store.run("UPDATE rooms SET updated_at=? WHERE id=?", now, roomId);
      const latest = this.store.get<Row>(
        "SELECT created_at,scene_version FROM snapshots WHERE room_id=? ORDER BY id DESC LIMIT 1",
        roomId,
      );
      if (
        (!latest || now - latest.created_at >= SNAPSHOT_MIN_INTERVAL_MS) &&
        latest?.scene_version !== version
      )
        this.insertSnapshot(roomId, retained, version, "auto", null);
    });
    room.elements = new Map(retained.map((e) => [e.id, e]));
    room.tombstoneTimes = tombstoneTimes;
    room.sceneVersion = version;
    room.dirtySince = null;
    clearTimeout(room.timer);
    room.timer = undefined;
    this.scheduleUnload(roomId);
  }
  flush() {
    for (const [roomId, room] of this.rooms)
      if (room.dirtySince !== null) {
        try {
          this.persist(roomId);
        } catch (error) {
          this.onError(error);
        }
      }
  }
  private scheduleUnload(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    clearTimeout(room.unload);
    if (room.peers.size) return;
    room.unload = setTimeout(() => {
      if (room.peers.size || room.dirtySince !== null) {
        this.scheduleUnload(roomId);
        return;
      }
      for (const agent of room.agents.values()) clearTimeout(agent.timer);
      this.rooms.delete(roomId);
    }, ROOM_IDLE_UNLOAD_MS);
    room.unload.unref();
  }
  join(roomId: string, peer: Peer) {
    const room = this.load(roomId);
    clearTimeout(room.unload);
    room.peers.set(peer.connId, peer);
  }
  leave(roomId: string, connId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.peers.delete(connId);
    this.presence(roomId);
    this.scheduleUnload(roomId);
  }
  collaborators(roomId: string): CollaboratorInfo[] {
    const room = this.load(roomId);
    return [...room.peers.values()]
      .map((p) => p.presence)
      .concat([...room.agents.values()].map((a) => a.presence));
  }
  presence(roomId: string) {
    this.broadcast(roomId, {
      type: "presence",
      collaborators: this.collaborators(roomId),
    });
  }
  agent(
    roomId: string,
    token: {
      id: string;
      name: string;
    },
    user: UserInfo,
    changed: SceneElement[],
  ) {
    const room = this.load(roomId),
      connId = `agent:${token.id}`;
    clearTimeout(room.agents.get(connId)?.timer);
    const presence: CollaboratorInfo = {
      connId,
      userId: user.id,
      name: /agent$/i.test(token.name) ? token.name : `${user.name}'s agent`,
      color: collaboratorColor(user.id),
      isAgent: true,
      idle: "active",
    };
    const timer = setTimeout(() => {
      room.agents.delete(connId);
      this.presence(roomId);
    }, AGENT_PRESENCE_TTL_MS);
    timer.unref();
    room.agents.set(connId, { presence, timer });
    this.presence(roomId);
    const box = bounds(changed, true);
    if (box) {
      const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
      this.broadcast(roomId, {
        type: "pointer",
        connId,
        x,
        y,
        tool: "pointer",
        button: "up",
        selectedElementIds: [],
      });
    }
  }
  private insertSnapshot(
    roomId: string,
    elements: SceneElement[],
    version: number,
    reason: SnapshotReason,
    userId: string | null,
  ): number {
    const result = this.store.run(
      "INSERT INTO snapshots(room_id,created_at,created_by,reason,scene_version,element_count,elements_gz) VALUES(?,?,?,?,?,?,?)",
      roomId,
      Date.now(),
      userId,
      reason,
      version,
      elements.filter((e) => !e.isDeleted).length,
      gzipSync(JSON.stringify(elements)),
    );
    this.store.run(
      "DELETE FROM snapshots WHERE room_id=? AND id NOT IN (SELECT id FROM snapshots WHERE room_id=? ORDER BY id DESC LIMIT ?)",
      roomId,
      roomId,
      SNAPSHOTS_KEEP_PER_ROOM,
    );
    return Number(result.lastInsertRowid);
  }
  snapshot(
    roomId: string,
    reason: SnapshotReason,
    userId: string | null,
  ): SnapshotInfo {
    const result = this.store.transaction(() =>
      this.insertSnapshot(
        roomId,
        this.elements(roomId),
        this.load(roomId).sceneVersion,
        reason,
        userId,
      ),
    );
    return this.snapshotInfo(
      this.store.get<Row>("SELECT * FROM snapshots WHERE id=?", result)!,
    );
  }
  beforeAgent(roomId: string, userId: string) {
    const last = this.store.get<Row>(
      "SELECT created_at FROM snapshots WHERE room_id=? AND reason='agent' ORDER BY id DESC LIMIT 1",
      roomId,
    );
    if (!last || Date.now() - last.created_at >= SNAPSHOT_AGENT_MIN_INTERVAL_MS)
      this.snapshot(roomId, "agent", userId);
  }
  snapshotInfo(row: Row): SnapshotInfo {
    const user = row.created_by
      ? this.store.get<Row>("SELECT * FROM users WHERE id=?", row.created_by)
      : undefined;
    return {
      id: row.id,
      roomId: row.room_id,
      createdAt: row.created_at,
      createdBy: user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            avatarUrl: user.avatar_url,
          }
        : null,
      reason: row.reason,
      elementCount: row.element_count,
      sceneVersion: row.scene_version,
    };
  }
  snapshots(roomId: string): SnapshotInfo[] {
    return this.store
      .all<Row>(
        "SELECT * FROM snapshots WHERE room_id=? ORDER BY id DESC",
        roomId,
      )
      .map((r) => this.snapshotInfo(r));
  }
  getSnapshot(roomId: string, sid: string | number): SnapshotResponse {
    const row = this.store.get<Row>(
      "SELECT * FROM snapshots WHERE room_id=? AND id=?",
      roomId,
      sid,
    );
    if (!row) throw new HttpError("not_found", "snapshot");
    return {
      info: this.snapshotInfo(row),
      elements: this.parseElements(JSON.parse(gunzipSync(row.elements_gz).toString())),
    };
  }
  restore(roomId: string, sid: string | number, userId: string): SnapshotInfo {
    const snapshot = this.getSnapshot(roomId, sid),
      room = this.load(roomId);
    const restored = new Map(
      snapshot.elements.map((e) => [
        e.id,
        stamp(e, { ...e, version: Math.max(e.version, room.elements.get(e.id)?.version ?? 0) }),
      ]),
    );
    for (const e of room.elements.values())
      if (!restored.has(e.id))
        restored.set(e.id, stamp({ ...e, isDeleted: true }, e));
    const before = this.snapshot(roomId, "restore", userId);
    this.applyElements(roomId, [...restored.values()], "server");
    this.persist(roomId);
    return before;
  }
  closeRoom(roomId: string, code: number) {
    const room = this.rooms.get(roomId);
    if (room) for (const peer of room.peers.values()) peer.close(code);
  }
  close() {
    this.flush();
    for (const room of this.rooms.values()) {
      clearTimeout(room.timer);
      clearTimeout(room.unload);
      for (const agent of room.agents.values()) clearTimeout(agent.timer);
      for (const peer of room.peers.values()) {
        try {
          peer.close(1001);
        } catch (error) {
          this.onError(error);
        }
      }
    }
  }
}
