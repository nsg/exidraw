/**
 * Pure parts of the collaboration client (ARCHITECTURE.md § 8.7, § 8.9).
 *
 * Nothing here touches the DOM, the WebSocket or Excalidraw's runtime: the
 * Excalidraw functions that do the actual merging (`restoreElements`,
 * `reconcileElements`) are injected so this module is unit-testable in Node.
 */
import {
  TOMBSTONE_RETENTION_MS,
  WS_CLOSE,
  type CollaboratorInfo,
  type ConnId,
  type IdleState,
  type PointerTool,
  type SceneElement,
} from "@exidraw/shared";

// ---- Outgoing: which elements get broadcast ----------------------------------

/** Minimal element shape the tracker needs (the full SceneElement satisfies it). */
export interface VersionedElement {
  id: string;
  version: number;
  isDeleted: boolean;
  updated: number;
}

/**
 * Remembers, per element id, the highest version this client has either sent
 * to or received from the server. An element is sent again only once its
 * local version exceeds that.
 */
export class BroadcastTracker {
  private readonly versions = new Map<string, number>();

  /** Highest known version of `id`, or undefined if never sent/received. */
  get(id: string): number | undefined {
    return this.versions.get(id);
  }

  /**
   * Record versions of elements that are now known to the server (sent by us,
   * or received from it). Never lowers a recorded version: if we already sent
   * a newer one, receiving an older copy must not trigger a re-send.
   */
  record(elements: Iterable<Pick<VersionedElement, "id" | "version">>): void {
    for (const e of elements) {
      const known = this.versions.get(e.id);
      if (known === undefined || e.version > known) this.versions.set(e.id, e.version);
    }
  }

  clear(): void {
    this.versions.clear();
  }
}

export interface OutgoingOptions<T extends VersionedElement> {
  /** Excalidraw's `isInvisiblySmallElement`; such elements are not sent yet. */
  isInvisiblySmall: (element: T) => boolean;
  now?: number;
}

/**
 * Elements to put into the next incremental `scene_update` (§ 8.9): every
 * element whose version is above what the server already has from us.
 *
 * - Invisibly small live elements are held back (a shape being started).
 * - Tombstones of elements the server never saw (created and deleted locally
 *   in between two broadcasts) are not sent: nobody else has them.
 *
 * Does NOT record anything; call `tracker.record(result)` once actually sent.
 */
export function collectOutgoing<T extends VersionedElement>(
  elements: readonly T[],
  tracker: BroadcastTracker,
  opts: OutgoingOptions<T>,
): T[] {
  const out: T[] = [];
  for (const e of elements) {
    const known = tracker.get(e.id);
    if (known !== undefined && e.version <= known) continue;
    if (e.isDeleted) {
      if (known === undefined) continue;
    } else if (opts.isInvisiblySmall(e)) {
      continue;
    }
    out.push(e);
  }
  return out;
}

/**
 * Elements for the full resync sent right after every `scene_init` (§ 8.7):
 * all live elements plus tombstones newer than TOMBSTONE_RETENTION_MS.
 */
export function collectSyncAll<T extends VersionedElement>(
  elements: readonly T[],
  opts: OutgoingOptions<T>,
): T[] {
  const now = opts.now ?? Date.now();
  return elements.filter((e) =>
    e.isDeleted ? e.updated > now - TOMBSTONE_RETENTION_MS : !opts.isInvisiblySmall(e),
  );
}

// ---- Incoming: applying remote updates ----------------------------------------

/** Element fields needed to tell which side won a merge. */
export interface MergeableElement extends VersionedElement {
  versionNonce: number;
}

export interface MergeDeps<E, S> {
  /**
   * `restoreElements(remote, null)` from @excalidraw/excalidraw. Deliberately
   * WITHOUT local elements: given locals, Excalidraw bumps any remote element
   * that is older than its local copy above the local version (right for
   * upstream's peer-to-peer relay, wrong here), which would let a stale server
   * copy overwrite unsent local edits, e.g. offline edits after a reconnect.
   */
  restore: (remote: readonly SceneElement[]) => E[];
  /** `reconcileElements(local, remote, appState)` from @excalidraw/excalidraw */
  reconcile: (local: readonly E[], remote: readonly E[], appState: S) => E[];
}

export interface RemoteApplyResult<E> {
  /** The new scene to hand to `updateScene({ elements, captureUpdate: NEVER })`. */
  elements: E[];
  /**
   * Server elements that should have won but were kept out because the local
   * copy is being edited right now (Excalidraw never replaces an element under
   * the user's cursor). Re-apply them once editing ends, otherwise the stale
   * local copy can stick if the edit finishes without a version bump.
   */
  deferred: SceneElement[];
}

/**
 * Merge server elements into the local scene (§ 8.9) and record, BEFORE the
 * caller runs `updateScene`, the versions of received elements that won, so
 * the `onChange` that follows does not echo them back.
 *
 * Versions are taken from the wire, not from the merged objects: Excalidraw
 * may repair invalid fractional indices while restoring/reconciling, which
 * bumps the version. Such repairs are local changes the server has not seen,
 * so they stay eligible for sending. Remote elements that lost (local is
 * newer, or is being edited) are not recorded, so the local version is sent.
 *
 * `authoritative` (used for viewers on `scene_init`) replaces the local scene
 * with the server's instead of reconciling, and resets the tracker to exactly
 * the server's versions: a viewer has nothing local worth keeping, and stale
 * watermarks (e.g. from a send that crossed a demotion) must not survive.
 */
export function applyRemote<E extends MergeableElement, S>(
  local: readonly E[],
  remote: readonly SceneElement[],
  appState: S,
  tracker: BroadcastTracker,
  deps: MergeDeps<E, S>,
  authoritative = false,
): RemoteApplyResult<E> {
  const wire = new Map(remote.map((e) => [e.id, { version: e.version, versionNonce: e.versionNonce }]));
  const restored = deps.restore(remote);
  if (authoritative) {
    tracker.clear();
    tracker.record(remote);
    return { elements: restored, deferred: [] };
  }
  const merged = deps.reconcile(local, restored, appState);
  const won: Array<{ id: string; version: number }> = [];
  const deferred: SceneElement[] = [];
  const mergedById = new Map(merged.map((e) => [e.id, e]));
  for (const r of remote) {
    const m = mergedById.get(r.id);
    if (m && m.version === r.version && m.versionNonce === r.versionNonce) won.push(r);
    // Excalidraw's own rule says the remote should have won: it was held back by an edit in progress.
    else if (m && (r.version > m.version || (r.version === m.version && r.versionNonce < m.versionNonce))) deferred.push(r);
  }
  tracker.record(won);
  return { elements: merged, deferred };
}

// ---- Outgoing frames -------------------------------------------------------------

/** Budget per scene_update frame, in UTF-16 code units of JSON (≤ 3 bytes each). */
export const MAX_FRAME_CHARS = 2 * 1024 * 1024;
export const MAX_FRAME_ELEMENTS = 5_000;

/** Minimum gap between scene_update frames (server coalesces beyond 30/s). */
export const FRAME_SPACING_MS = 40;
/**
 * Sustained upload rate for scene frames, in JSON chars per ms (~1.5 MiB/s).
 * The server closes a connection exceeding 32 MiB or 2,000 frames per 10 s
 * (4429), so big frames (dragging a large selection) are spaced by size.
 */
export const FRAME_CHARS_PER_MS = 1_536;

/** How long to wait after sending a frame of `chars` before the next one. */
export function frameGapMs(chars: number): number {
  return Math.max(FRAME_SPACING_MS, Math.ceil(chars / FRAME_CHARS_PER_MS));
}

/**
 * Split outgoing elements into frames that stay well under the server's
 * MAX_WS_MESSAGE_BYTES (an oversized frame closes the socket with 4413, and
 * the resync after reconnect would send it again: an endless loop).
 */
export function chunkElements<T>(elements: readonly T[], maxChars = MAX_FRAME_CHARS, maxCount = MAX_FRAME_ELEMENTS): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const e of elements) {
    const len = JSON.stringify(e).length + 1;
    if (current.length > 0 && (size + len > maxChars || current.length >= maxCount)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(e);
    size += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ---- Connection lifecycle -------------------------------------------------------

export type CloseAction =
  | { kind: "reconnect" }
  | { kind: "stop" }
  | { kind: "fatal"; reason: "unauthenticated" | "forbidden" | "not_found" | "deleted" };

/** What to do after the socket closed with `code` (§ 8.7). */
export function classifyClose(code: number): CloseAction {
  switch (code) {
    case WS_CLOSE.NORMAL:
      return { kind: "stop" };
    case WS_CLOSE.UNAUTHENTICATED:
      return { kind: "fatal", reason: "unauthenticated" };
    case WS_CLOSE.FORBIDDEN:
      return { kind: "fatal", reason: "forbidden" };
    case WS_CLOSE.ROOM_NOT_FOUND:
      return { kind: "fatal", reason: "not_found" };
    case WS_CLOSE.ROOM_DELETED:
      return { kind: "fatal", reason: "deleted" };
    default:
      return { kind: "reconnect" };
  }
}

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * Exponential backoff with ±20 % jitter: ~1 s, 2 s, 4 s … capped at 30 s.
 * `attempt` is 0 for the first retry. `random` is injectable for tests.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 10));
  const jittered = base * (0.8 + 0.4 * random());
  return Math.round(Math.min(RECONNECT_MAX_MS, jittered));
}

// ---- Presence --------------------------------------------------------------------

export interface PointerState {
  x: number;
  y: number;
  tool: PointerTool;
  button: "up" | "down";
  selectedElementIds: string[];
}

/** Shape of an Excalidraw `Collaborator` (kept structural to stay DOM-free). */
export interface CollaboratorView {
  id: string;
  socketId: string;
  username: string;
  color: { background: string; stroke: string };
  userState: IdleState;
  isCurrentUser: boolean;
  pointer?: { x: number; y: number; tool: PointerTool };
  button?: "up" | "down";
  selectedElementIds?: Record<string, true>;
}

/**
 * Collaborators map for `updateScene({ collaborators })`, keyed by connId.
 * Pointer/selection come from the latest `pointer` message per connection;
 * idle state from the latest `idle` message (falls back to the presence list).
 * The receiver's own entry is included (Excalidraw shows it in the avatar
 * list) but never carries a pointer.
 */
export function buildCollaborators(
  presence: readonly CollaboratorInfo[],
  ownConnId: ConnId | null,
  pointers: ReadonlyMap<ConnId, PointerState>,
  idle: ReadonlyMap<ConnId, IdleState>,
): Map<string, CollaboratorView> {
  const out = new Map<string, CollaboratorView>();
  for (const c of presence) {
    const isCurrentUser = c.connId === ownConnId;
    const view: CollaboratorView = {
      id: c.userId,
      socketId: c.connId,
      username: c.name,
      color: c.color,
      userState: idle.get(c.connId) ?? c.idle,
      isCurrentUser,
    };
    const p = isCurrentUser ? undefined : pointers.get(c.connId);
    if (p) {
      view.pointer = { x: p.x, y: p.y, tool: p.tool };
      view.button = p.button;
      view.selectedElementIds = Object.fromEntries(p.selectedElementIds.map((id) => [id, true] as const));
    }
    out.set(c.connId, view);
  }
  return out;
}
