/**
 * Constants shared by server, web and tests. Numbers here are the contract;
 * change them here, never inline.
 */

/** Bumped on any incompatible WebSocket protocol change. Sent in `welcome`. */
export const PROTOCOL_VERSION = 1 as const;

// ---- URL space ---------------------------------------------------------------

export const API_PREFIX = "/api";
export const AUTH_PREFIX = "/auth";
export const WS_PATH = "/ws";
export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";
/** Renderer page + its assets, served by the server for the headless browser only. */
export const INTERNAL_RENDERER_PATH = "/_internal/renderer/";
/** Where the SPA serves the Excalidraw fonts from (window.EXCALIDRAW_ASSET_PATH). */
export const EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

/** SPA routes (served by the server with index.html fallback). */
export const SPA_ROUTES = {
  root: "/",
  folder: (folderId: string) => `/f/${folderId}`,
  room: (roomId: string) => `/r/${roomId}`,
  tokens: "/tokens",
  login: "/login",
} as const;

export const ROOT_FOLDER_ID = "root";

// ---- Auth --------------------------------------------------------------------

export const SESSION_COOKIE = "exidraw_session";
/** Short-lived cookie holding OIDC state/PKCE verifier/nonce during login. */
export const OIDC_FLOW_COOKIE = "exidraw_oidc";
/**
 * CSRF defence for cookie-authenticated mutating requests: the SPA must send
 * this header with this exact value on every non-GET request to /api and /auth.
 * Bearer (PAT) requests are exempt.
 */
export const CSRF_HEADER = "x-exidraw-csrf";
export const CSRF_HEADER_VALUE = "1";
export const PAT_PREFIX = "exi_";
/** Plaintext PAT = PAT_PREFIX + 43 chars base64url (32 random bytes). */
export const PAT_LENGTH = PAT_PREFIX.length + 43;
/** Characters of the plaintext token shown in the UI after creation (prefix + 8). */
export const PAT_DISPLAY_PREFIX_LENGTH = PAT_PREFIX.length + 8;
export const SESSION_TTL_DAYS_DEFAULT = 30;

// ---- Limits ------------------------------------------------------------------

export const MAX_NAME_LENGTH = 120;
export const MAX_FOLDER_DEPTH = 16;
export const MAX_ELEMENTS_PER_ROOM = 20_000;
/** Max size of a single WebSocket text frame (full scene syncs can be big). */
export const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES_DEFAULT = 4 * 1024 * 1024;
export const MAX_HTTP_JSON_BYTES = 16 * 1024 * 1024;
/** Server drops pointer messages beyond this per connection (client sends ~30/s). */
export const POINTER_RATE_LIMIT_PER_SEC = 40;
export const SCENE_UPDATE_RATE_LIMIT_PER_SEC = 30;
export const CLIENT_POINTER_THROTTLE_MS = 33;
/** Longest edge in px of a rendered PNG; larger requests are scaled down. */
export const RENDER_MAX_EDGE_PX = 8192;
export const RENDER_MAX_PIXELS = 24_000_000;
export const RENDER_DEFAULT_SCALE = 2;
export const RENDER_TIMEOUT_MS = 30_000;

// ---- Timing ------------------------------------------------------------------

/** Persist a dirty room this long after the last change ... */
export const SCENE_PERSIST_DEBOUNCE_MS = 500;
/** ... but never later than this after the first unpersisted change. */
export const SCENE_PERSIST_MAX_WAIT_MS = 5_000;
/** Tombstones (isDeleted) older than this are dropped when persisting. */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Unload a room from memory this long after its last connection closed. */
export const ROOM_IDLE_UNLOAD_MS = 10 * 60 * 1000;
export const WS_PING_INTERVAL_MS = 30_000;
export const WS_PONG_TIMEOUT_MS = 10_000;
/** Synthetic agent presence disappears this long after the agent's last write. */
export const AGENT_PRESENCE_TTL_MS = 10_000;
export const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const SNAPSHOT_AGENT_MIN_INTERVAL_MS = 60 * 1000;
export const SNAPSHOTS_KEEP_PER_ROOM = 100;
export const PAT_LAST_USED_WRITE_INTERVAL_MS = 60_000;

// ---- WebSocket close codes (application range) -------------------------------

export const WS_CLOSE = {
  /** Normal close by the client (leaving the room). */
  NORMAL: 1000,
  /** Server shutting down; the client should reconnect with backoff. */
  GOING_AWAY: 1001,
  UNAUTHENTICATED: 4401,
  FORBIDDEN: 4403,
  ROOM_NOT_FOUND: 4404,
  /** Wrong protocol version or malformed first message. */
  PROTOCOL_ERROR: 4400,
  MESSAGE_TOO_LARGE: 4413,
  RATE_LIMITED: 4429,
  /** The room was deleted while the client was connected. */
  ROOM_DELETED: 4410,
} as const;

/**
 * Deterministic collaborator colour palette. Server picks
 * COLLABORATOR_COLORS[fnv1a32(userId) % length]; agents use the same colour
 * as their owner. (background = cursor fill, stroke = cursor outline.)
 */
export const COLLABORATOR_COLORS: ReadonlyArray<{ background: string; stroke: string }> = [
  { background: "#ffc9c9", stroke: "#e03131" },
  { background: "#b2f2bb", stroke: "#2f9e44" },
  { background: "#a5d8ff", stroke: "#1971c2" },
  { background: "#ffec99", stroke: "#f08c00" },
  { background: "#d0bfff", stroke: "#6741d9" },
  { background: "#fcc2d7", stroke: "#c2255c" },
  { background: "#99e9f2", stroke: "#0c8599" },
  { background: "#e9ecef", stroke: "#495057" },
];

/** FNV-1a 32-bit hash of a string; used for colour assignment on both sides. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function collaboratorColor(userId: string): { background: string; stroke: string } {
  return COLLABORATOR_COLORS[fnv1a32(userId) % COLLABORATOR_COLORS.length]!;
}
