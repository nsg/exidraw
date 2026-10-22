/**
 * REST API contract: DTOs (TypeScript) and request-body validators (zod).
 * Route list and semantics: docs/ARCHITECTURE.md § REST API.
 *
 * All timestamps are epoch milliseconds. All ids are opaque strings.
 */
import { z } from "zod";
import type { SceneElement } from "./elements.js";
import type { Grant, NodeKind, Role } from "./roles.js";
import { MAX_ELEMENTS_PER_ROOM, MAX_NAME_LENGTH } from "./constants.js";

// ---- Errors ------------------------------------------------------------------

export type ApiErrorCode =
  | "unauthenticated" // 401
  | "forbidden" // 403
  | "csrf" // 403 (missing CSRF header on cookie-authenticated mutation)
  | "not_found" // 404
  | "conflict" // 409 (e.g. deleting a non-empty folder, duplicate file)
  | "invalid" // 400 (validation; `details` carries zod issues)
  | "too_large" // 413
  | "rate_limited" // 429
  | "renderer_unavailable" // 503
  | "internal"; // 500

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

// ---- Auth / users ------------------------------------------------------------

export type AuthMode = "entra" | "dev";

export interface UserInfo {
  id: string;
  /** lower-cased e-mail/UPN */
  email: string;
  name: string;
  avatarUrl: string | null;
}

/** GET /api/me */
export interface MeResponse {
  user: UserInfo;
  isAdmin: boolean;
  authMode: AuthMode;
  /** how this request was authenticated */
  via: "session" | "token";
}

/** GET /api/auth/providers (public, no auth) */
export type AuthProvidersResponse =
  | { mode: "entra"; loginUrl: string }
  | { mode: "dev"; loginUrl: string; users: Array<{ id: string; email: string; name: string }> };

/** POST /auth/dev/login (dev mode only) */
export const DevLoginBody = z.object({ userId: z.string().min(1).max(100) });
export type DevLoginBody = z.infer<typeof DevLoginBody>;

/** GET /api/users?q= — directory of known users for grant pickers */
export interface UsersResponse {
  users: UserInfo[];
}

// ---- Folders / rooms ---------------------------------------------------------

export interface FolderInfo {
  id: string;
  parentId: string | null; // null only for the root folder
  name: string;
  /** effective role of the caller; null = traversal-only (a descendant is visible) */
  role: Role | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoomInfo {
  id: string;
  folderId: string;
  name: string;
  /** effective role of the caller (never null in responses: invisible rooms are omitted) */
  role: Role;
  createdAt: number;
  /** last metadata OR scene change */
  updatedAt: number;
  /** absolute URL of the room page (PUBLIC_URL + /r/<id>) */
  url: string;
}

/** GET /api/tree?folderId=<id> (default root) */
export interface TreeResponse {
  folder: FolderInfo;
  /** root … parent, excluding `folder` itself */
  breadcrumbs: Array<Pick<FolderInfo, "id" | "name">>;
  folders: FolderInfo[];
  rooms: RoomInfo[];
}

/** GET /api/search?q=&inContent=0|1 */
export interface SearchResponse {
  folders: FolderInfo[];
  rooms: Array<RoomInfo & { snippet?: string }>;
}

const name = z.string().trim().min(1).max(MAX_NAME_LENGTH);

export const CreateFolderBody = z.object({ parentId: z.string().min(1), name });
export type CreateFolderBody = z.infer<typeof CreateFolderBody>;

export const UpdateFolderBody = z
  .object({ name: name.optional(), parentId: z.string().min(1).optional() })
  .refine((b) => b.name !== undefined || b.parentId !== undefined, { message: "nothing to update" });
export type UpdateFolderBody = z.infer<typeof UpdateFolderBody>;

export const CreateRoomBody = z.object({ folderId: z.string().min(1), name });
export type CreateRoomBody = z.infer<typeof CreateRoomBody>;

/**
 * POST /api/rooms/import → 201 RoomInfo. Creates a drawing from an uploaded
 * Excalidraw file. The client parses and restores the file (`loadFromBlob`);
 * the server checks element envelopes, ids, counts and files like any other
 * write. `files` holds the binaries of image elements as data URLs, keyed by
 * fileId, like the `files` map of a `.excalidraw` file
 * (`{ mimeType, dataURL, … }`). Entries no image element references are
 * ignored unchecked, so they are not typed here.
 */
export const ImportRoomBody = z.object({
  folderId: z.string().min(1),
  name,
  elements: z.array(z.unknown()).max(MAX_ELEMENTS_PER_ROOM),
  files: z.record(z.string(), z.unknown()).default({}),
});
export type ImportRoomBody = z.infer<typeof ImportRoomBody>;

export const UpdateRoomBody = z
  .object({ name: name.optional(), folderId: z.string().min(1).optional() })
  .refine((b) => b.name !== undefined || b.folderId !== undefined, { message: "nothing to update" });
export type UpdateRoomBody = z.infer<typeof UpdateRoomBody>;

/** GET /api/rooms/:id/scene */
export interface SceneResponse {
  elements: SceneElement[];
  sceneVersion: number;
}

// ---- Grants ------------------------------------------------------------------

export const GrantInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all"), role: z.enum(["viewer", "editor", "owner"]) }),
  z.object({
    kind: z.literal("user"),
    email: z.string().trim().toLowerCase().email().max(320),
    role: z.enum(["viewer", "editor", "owner"]),
  }),
]);
export type GrantInput = z.infer<typeof GrantInput>;

/** PUT /api/nodes/:kind/:id/grants — replaces ALL direct grants of the node. */
export const PutGrantsBody = z.object({ grants: z.array(GrantInput).max(500) });
export type PutGrantsBody = z.infer<typeof PutGrantsBody>;

/** GET /api/nodes/:kind/:id/grants */
export interface GrantsResponse {
  node: { kind: NodeKind; id: string; name: string };
  /** direct grants on this node */
  grants: Grant[];
  /** grants inherited from ancestors, nearest ancestor first, read-only here */
  inherited: Array<{ from: { kind: "folder"; id: string; name: string }; grants: Grant[] }>;
  /** the caller's effective role on this node */
  effective: Role;
}

// ---- Personal access tokens --------------------------------------------------

export interface TokenInfo {
  id: string;
  name: string;
  /** first PAT_DISPLAY_PREFIX_LENGTH chars of the plaintext, for recognition */
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

export const CreateTokenBody = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type CreateTokenBody = z.infer<typeof CreateTokenBody>;

/** POST /api/tokens — `token` is shown exactly once. */
export interface CreateTokenResponse {
  token: string;
  info: TokenInfo;
}

export interface TokensResponse {
  tokens: TokenInfo[];
}

// ---- Files -------------------------------------------------------------------

/** PUT /api/rooms/:id/files/:fileId → 201 (created) or 200 (already existed) */
export interface FileInfo {
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
}

// ---- Snapshots ---------------------------------------------------------------

export type SnapshotReason = "auto" | "manual" | "agent" | "restore";

export interface SnapshotInfo {
  id: number;
  roomId: string;
  createdAt: number;
  createdBy: UserInfo | null;
  reason: SnapshotReason;
  elementCount: number;
  sceneVersion: number;
}

export const CreateSnapshotBody = z.object({ reason: z.literal("manual").default("manual") });

export interface SnapshotsResponse {
  snapshots: SnapshotInfo[];
}

export interface SnapshotResponse {
  info: SnapshotInfo;
  elements: SceneElement[];
}

// ---- Rendering ---------------------------------------------------------------

/** Query parameters for GET /api/rooms/:id/export.png|svg */
export const ExportQuery = z.object({
  scale: z.coerce.number().min(0.25).max(4).optional(),
  background: z.coerce.boolean().optional(),
  theme: z.enum(["light", "dark"]).optional(),
  /** "x,y,width,height" in scene coordinates */
  region: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+(\.\d+)?,\d+(\.\d+)?$/)
    .optional(),
  /** comma-separated element ids */
  elements: z.string().optional(),
  padding: z.coerce.number().min(0).max(500).optional(),
});
export type ExportQuery = z.infer<typeof ExportQuery>;

// ---- Health ------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
  renderer: "ready" | "starting" | "down" | "disabled";
  uptimeSec: number;
  version: string;
}
