/**
 * WebSocket collaboration client (ARCHITECTURE.md § 8.9): glues the protocol
 * to an Excalidraw instance. Merge/broadcast decisions live in ./core.ts.
 */
import {
  CaptureUpdateAction,
  isInvisiblySmallElement,
  reconcileElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { AppState, Collaborator, ExcalidrawImperativeAPI, SocketId } from "@excalidraw/excalidraw/types";
import {
  CLIENT_POINTER_THROTTLE_MS,
  PROTOCOL_VERSION,
  WS_PATH,
  roleAtLeast,
  type ClientMessage,
  type CollaboratorInfo,
  type ConnId,
  type IdleState,
  type Role,
  type RoomInfo,
  type SceneElement,
  type ServerMessage,
} from "@exidraw/shared";
import {
  BroadcastTracker,
  applyRemote,
  buildCollaborators,
  classifyClose,
  collectOutgoing,
  collectSyncAll,
  chunkElements,
  frameGapMs,
  reconnectDelay,
  type MergeDeps,
  type PointerState,
} from "./core";
import { FileSync } from "./files";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting";
export type FatalReason = "unauthenticated" | "forbidden" | "not_found" | "deleted";

export interface CollabCallbacks {
  onStatus: (status: ConnectionStatus) => void;
  onRole: (role: Role) => void;
  onRoom: (room: RoomInfo) => void;
  onPresence: (collaborators: CollaboratorInfo[], ownConnId: ConnId | null) => void;
  /** First `scene_init` of this session has been applied. */
  onSynced: () => void;
  onFatal: (reason: FatalReason) => void;
  /** Non-fatal problems worth a toast. */
  onWarning: (message: string) => void;
}

/** Local edits are flushed at most this often (server allows 30 scene_updates/s). */
const FLUSH_INTERVAL_MS = 50;
const IDLE_AFTER_MS = 60_000;
const RESYNC_AFTER_RATE_LIMIT_MS = 1_000;

const mergeDeps: MergeDeps<OrderedExcalidrawElement, AppState> = {
  restore: (remote) => restoreElements(remote, null),
  reconcile: (local, remote, appState) =>
    reconcileElements(local, remote as readonly RemoteExcalidrawElement[], appState) as OrderedExcalidrawElement[],
};

export class CollabClient {
  private ws: WebSocket | null = null;
  private readonly tracker = new BroadcastTracker();
  private readonly files: FileSync;
  private connId: ConnId | null = null;
  private role: Role;
  /** True once the current socket delivered `scene_init`; edits are sent only then. */
  private synced = false;
  private everSynced = false;
  private attempt = 0;
  private stopped = false;
  private reconnectTimer: number | null = null;
  private flushTimer: number | null = null;
  private lastFlush = 0;
  private resyncTimer: number | null = null;
  /** Frames waiting to be sent (large batches are split and paced). */
  private readonly outbox: SceneElement[][] = [];
  private outboxTimer: number | null = null;
  /** Earliest time the next scene frame may go out (see frameGapMs). */
  private nextFrameAt = 0;
  /** A flush was requested while frames were still queued; run it once drained. */
  private flushAfterDrain = false;
  /** Server winners Excalidraw kept out while the element was being edited. */
  private readonly deferred = new Map<string, SceneElement>();

  private presence: CollaboratorInfo[] = [];
  private readonly pointers = new Map<ConnId, PointerState>();
  private readonly idle = new Map<ConnId, IdleState>();

  private pointerTimer: number | null = null;
  private lastPointerSent = 0;
  private pendingPointer: Omit<PointerState, "selectedElementIds"> | null = null;
  private idleState: IdleState = "active";
  private idleTimer: number | null = null;

  constructor(
    private readonly roomId: string,
    private readonly excalidraw: ExcalidrawImperativeAPI,
    role: Role,
    private readonly callbacks: CollabCallbacks,
  ) {
    this.role = role;
    this.files = new FileSync(roomId, excalidraw, () => this.canEdit(), callbacks.onWarning);
  }

  // ---- lifecycle ----------------------------------------------------------------

  start(): void {
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
    this.markActive();
    this.connect();
  }

  stop(): void {
    // Leaving (navigation/unmount): push out what is still pending, best effort.
    while (this.outbox.length > 0 && this.sendFrame(this.outbox.shift()!));
    if (this.synced && this.canEdit()) {
      const out = collectOutgoing(this.excalidraw.getSceneElementsIncludingDeleted(), this.tracker, {
        isInvisiblySmall: isInvisiblySmallElement,
      });
      for (const frame of chunkElements(out)) this.sendFrame(frame);
    }
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onOnline);
    for (const t of [this.reconnectTimer, this.flushTimer, this.resyncTimer, this.pointerTimer, this.idleTimer, this.outboxTimer]) {
      if (t !== null) window.clearTimeout(t);
    }
    this.files.stop();
    this.ws?.close(1000, "leaving");
    this.ws = null;
  }

  get currentRole(): Role {
    return this.role;
  }

  private connect(): void {
    if (this.stopped) return;
    this.callbacks.onStatus(this.everSynced ? "reconnecting" : "connecting");
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}${WS_PATH}?room=${encodeURIComponent(this.roomId)}`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.synced = false;
      this.connId = null;
      // Unsent frames are covered by the syncAll after the next scene_init.
      this.outbox.length = 0;
      this.flushAfterDrain = false;
      this.deferred.clear();
      this.presence = [];
      this.pointers.clear();
      this.idle.clear();
      this.publishCollaborators();
      if (this.stopped) return;
      const action = classifyClose(ev.code);
      if (action.kind === "fatal") {
        this.stopped = true;
        this.callbacks.onFatal(action.reason);
      } else if (action.kind === "reconnect") {
        this.callbacks.onStatus("reconnecting");
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = reconnectDelay(this.attempt++);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onOnline = () => {
    // Network is back: skip the remaining backoff.
    if (this.reconnectTimer !== null && !this.ws) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.connect();
    }
  };

  private send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private canEdit(): boolean {
    return roleAtLeast(this.role, "editor");
  }

  // ---- incoming ------------------------------------------------------------------

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.callbacks.onWarning("The server runs a different version; please reload the page.");
        }
        this.connId = msg.connId;
        this.attempt = 0;
        this.setRole(msg.role, false);
        this.callbacks.onRoom(msg.room);
        return;
      case "scene_init": {
        this.files.resetFailures();
        this.applyRemoteElements(msg.elements, !this.canEdit());
        this.synced = true;
        this.callbacks.onStatus("connected");
        if (this.canEdit()) this.syncAll();
        if (!this.everSynced) {
          this.everSynced = true;
          this.callbacks.onSynced();
        }
        this.sendIdle(this.idleState, true);
        return;
      }
      case "scene_update":
        if (this.synced) this.applyRemoteElements(msg.elements, false);
        return;
      case "presence":
        this.presence = msg.collaborators;
        for (const id of [...this.pointers.keys()]) {
          if (!msg.collaborators.some((c) => c.connId === id)) this.pointers.delete(id);
        }
        this.publishCollaborators();
        return;
      case "pointer":
        this.pointers.set(msg.connId, msg);
        this.publishCollaborators();
        return;
      case "idle":
        this.idle.set(msg.connId, msg.state);
        this.publishCollaborators();
        return;
      case "role":
        this.setRole(msg.role, true);
        return;
      case "room_updated":
        this.callbacks.onRoom(msg.room);
        return;
      case "error":
        if (msg.fatal) return; // the close code that follows decides what to do
        if (msg.code === "rate_limited") {
          // The dropped update is already recorded as sent; a fresh scene_init
          // triggers a full syncAll, which re-sends it.
          this.scheduleResync();
        } else if (msg.code === "message_too_large") {
          this.callbacks.onWarning("That change was too large to sync; try smaller edits.");
        } else if (msg.code === "too_many_elements") {
          this.callbacks.onWarning("This drawing has reached the element limit; your last change was not saved.");
        } else if (msg.code !== "forbidden") {
          this.callbacks.onWarning(`Server: ${msg.message}`);
        }
        return;
    }
  }

  private setRole(role: Role, changed: boolean): void {
    const wasEditor = this.canEdit();
    this.role = role;
    this.callbacks.onRole(role);
    // Demoted: drop unsent local state by re-reading the authoritative scene.
    if (changed && wasEditor && !this.canEdit()) this.send({ type: "request_scene" });
  }

  private scheduleResync(): void {
    if (this.resyncTimer !== null) return;
    this.resyncTimer = window.setTimeout(() => {
      this.resyncTimer = null;
      this.send({ type: "request_scene" });
    }, RESYNC_AFTER_RATE_LIMIT_MS);
  }

  private applyRemoteElements(remote: SceneElement[], authoritative: boolean): void {
    const { elements, deferred } = applyRemote(
      this.excalidraw.getSceneElementsIncludingDeleted(),
      remote,
      this.excalidraw.getAppState(),
      this.tracker,
      mergeDeps,
      authoritative,
    );
    for (const d of deferred) this.deferred.set(d.id, d);
    this.excalidraw.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    this.files.scheduleDownloads();
  }

  private publishCollaborators(): void {
    const map = buildCollaborators(this.presence, this.connId, this.pointers, this.idle);
    this.excalidraw.updateScene({ collaborators: map as unknown as Map<SocketId, Collaborator> });
    this.callbacks.onPresence(this.presence, this.connId);
  }

  // ---- outgoing ------------------------------------------------------------------

  /** Excalidraw `onChange`: batch and send local changes. */
  onLocalChange(): void {
    if (this.flushTimer !== null) return;
    const wait = Math.max(0, this.lastFlush + FLUSH_INTERVAL_MS - Date.now());
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.lastFlush = Date.now();
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (!this.canEdit()) return;
    this.files.checkUploads();
    if (!this.synced) return; // syncAll after the next scene_init covers it
    if (this.outbox.length > 0) {
      // Still sending: collect once drained, so only the latest state goes out.
      this.flushAfterDrain = true;
      return;
    }
    this.replayDeferred();
    const out = collectOutgoing(this.excalidraw.getSceneElementsIncludingDeleted(), this.tracker, {
      isInvisiblySmall: isInvisiblySmallElement,
    });
    this.enqueue(out);
  }

  private syncAll(): void {
    const all = collectSyncAll(this.excalidraw.getSceneElementsIncludingDeleted(), {
      isInvisiblySmall: isInvisiblySmallElement,
    });
    this.enqueue(all);
    this.files.checkUploads();
  }

  /** Once the user stops editing, apply server winners that were held back. */
  private replayDeferred(): void {
    if (this.deferred.size === 0) return;
    const s = this.excalidraw.getAppState();
    if (s.editingTextElement || s.resizingElement || s.newElement) return;
    const pending = [...this.deferred.values()];
    this.deferred.clear();
    this.applyRemoteElements(pending, false);
  }

  /**
   * Queue elements for sending, split into size-bounded frames. Versions are
   * recorded now so the next flush does not queue them again; if the socket
   * drops first, the syncAll after reconnect re-sends everything.
   */
  private enqueue(elements: SceneElement[]): void {
    if (elements.length === 0) return;
    this.tracker.record(elements);
    this.outbox.push(...chunkElements(elements));
    this.pumpOutbox();
  }

  private pumpOutbox(): void {
    if (this.outboxTimer !== null) return;
    if (this.outbox.length === 0) {
      if (this.flushAfterDrain) {
        this.flushAfterDrain = false;
        this.onLocalChange();
      }
      return;
    }
    const wait = this.nextFrameAt - Date.now();
    if (wait <= 0) {
      this.sendFrame(this.outbox.shift()!);
      this.pumpOutbox();
      return;
    }
    this.outboxTimer = window.setTimeout(() => {
      this.outboxTimer = null;
      this.pumpOutbox();
    }, wait);
  }

  private sendFrame(elements: SceneElement[]): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const data = JSON.stringify({ type: "scene_update", elements } satisfies ClientMessage);
    this.ws.send(data);
    this.nextFrameAt = Date.now() + frameGapMs(data.length);
    return true;
  }

  /** Excalidraw `onPointerUpdate`, throttled to CLIENT_POINTER_THROTTLE_MS. Viewers send too. */
  onPointerUpdate(payload: { pointer: { x: number; y: number; tool: "pointer" | "laser" }; button: "up" | "down" }): void {
    this.markActive();
    this.pendingPointer = { ...payload.pointer, button: payload.button };
    if (this.pointerTimer !== null) return;
    const wait = Math.max(0, this.lastPointerSent + CLIENT_POINTER_THROTTLE_MS - Date.now());
    this.pointerTimer = window.setTimeout(() => {
      this.pointerTimer = null;
      const p = this.pendingPointer;
      if (!p || !this.synced) return;
      this.pendingPointer = null;
      this.lastPointerSent = Date.now();
      const selected = Object.keys(this.excalidraw.getAppState().selectedElementIds);
      this.send({ type: "pointer", x: p.x, y: p.y, tool: p.tool, button: p.button, selectedElementIds: selected });
    }, wait);
  }

  // ---- idle detection ------------------------------------------------------------

  private onVisibility = () => {
    if (document.hidden) this.sendIdle("away");
    else this.markActive();
  };

  private markActive(): void {
    if (this.idleState !== "active") this.sendIdle("active");
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.sendIdle("idle"), IDLE_AFTER_MS);
  }

  private sendIdle(state: IdleState, force = false): void {
    if (state === this.idleState && !force) return;
    this.idleState = state;
    if (this.synced) this.send({ type: "idle", state });
  }
}
