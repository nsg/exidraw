/**
 * WebSocket collaboration protocol (JSON text frames, one message per frame).
 * Endpoint: GET /ws?room=<roomId>, authenticated by the session cookie.
 * See docs/ARCHITECTURE.md § Collaboration protocol for ordering and semantics.
 */
import type { SceneElement } from "./elements.js";
import type { Role } from "./roles.js";
import type { RoomInfo, UserInfo } from "./api.js";

/** Unique per WebSocket connection; also the key of the Excalidraw collaborators map. */
export type ConnId = string;

export type IdleState = "active" | "idle" | "away";
export type PointerTool = "pointer" | "laser";

export interface CollaboratorInfo {
  connId: ConnId;
  userId: string;
  name: string;
  color: { background: string; stroke: string };
  /** true for synthetic MCP/agent presence (connId starts with "agent:") */
  isAgent: boolean;
  idle: IdleState;
}

// ---- Client → Server ---------------------------------------------------------

/**
 * Elements whose version increased since the client last sent them (or all
 * elements after `scene_init`). Requires role >= editor; viewers get `error`
 * code `forbidden` (non-fatal). Server reconciles and broadcasts winners.
 */
export interface ClientSceneUpdate {
  type: "scene_update";
  elements: SceneElement[];
}

/** Cursor position in scene coordinates; throttle to CLIENT_POINTER_THROTTLE_MS. */
export interface ClientPointer {
  type: "pointer";
  x: number;
  y: number;
  tool: PointerTool;
  button: "up" | "down";
  /** ids currently selected by this user (shown as remote selection) */
  selectedElementIds: string[];
}

export interface ClientIdle {
  type: "idle";
  state: IdleState;
}

/** Ask for a fresh `scene_init` (e.g. after the client detects divergence). */
export interface ClientRequestScene {
  type: "request_scene";
}

export type ClientMessage = ClientSceneUpdate | ClientPointer | ClientIdle | ClientRequestScene;

// ---- Server → Client ---------------------------------------------------------

/** First message after upgrade. Always followed by `scene_init` then `presence`. */
export interface ServerWelcome {
  type: "welcome";
  protocolVersion: typeof import("./constants.js").PROTOCOL_VERSION;
  connId: ConnId;
  user: UserInfo;
  role: Role;
  room: RoomInfo;
  serverTime: number;
}

/** Full authoritative scene (including tombstones). */
export interface ServerSceneInit {
  type: "scene_init";
  elements: SceneElement[];
  sceneVersion: number;
}

/**
 * Elements that changed in the authoritative scene. Sent to every connection
 * in the room except the originator; also sent back to the originator
 * carrying the server's versions of elements it sent that LOST reconciliation
 * (so it converges) — in that case `origin` is "server".
 */
export interface ServerSceneUpdate {
  type: "scene_update";
  elements: SceneElement[];
  sceneVersion: number;
  /** connId of the originating connection, or "server" for MCP/REST/snapshot writes */
  origin: ConnId | "server";
}

/** Full list; sent on join/leave/agent presence change. Includes the receiver. */
export interface ServerPresence {
  type: "presence";
  collaborators: CollaboratorInfo[];
}

export interface ServerPointer {
  type: "pointer";
  connId: ConnId;
  x: number;
  y: number;
  tool: PointerTool;
  button: "up" | "down";
  selectedElementIds: string[];
}

export interface ServerIdle {
  type: "idle";
  connId: ConnId;
  state: IdleState;
}

/** The receiver's effective role changed (grants edited). Client toggles view mode. */
export interface ServerRole {
  type: "role";
  role: Role;
}

/** Room metadata changed (rename/move). */
export interface ServerRoomUpdated {
  type: "room_updated";
  room: RoomInfo;
}

export type WsErrorCode =
  | "unauthenticated"
  | "not_found"
  | "message_too_large"
  | "forbidden"
  | "invalid_message"
  | "too_many_elements"
  | "rate_limited"
  | "renderer_unavailable"
  | "internal";

/** `fatal: true` means the server closes the socket right after (see WS_CLOSE). */
export interface ServerError {
  type: "error";
  code: WsErrorCode;
  message: string;
  fatal: boolean;
}

export type ServerMessage =
  | ServerWelcome
  | ServerSceneInit
  | ServerSceneUpdate
  | ServerPresence
  | ServerPointer
  | ServerIdle
  | ServerRole
  | ServerRoomUpdated
  | ServerError;

export type ServerMessageType = ServerMessage["type"];
export type ClientMessageType = ClientMessage["type"];

/** connId prefix for synthetic agent presence. */
export const AGENT_CONN_PREFIX = "agent:";
export function isAgentConnId(connId: string): boolean {
  return connId.startsWith(AGENT_CONN_PREFIX);
}
