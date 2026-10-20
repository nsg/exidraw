/**
 * Same-origin REST client. Every non-GET request carries the CSRF header
 * (ARCHITECTURE.md § 4.4); errors are surfaced as `ApiRequestError` carrying
 * the server's `ApiError` code.
 */
import {
  API_PREFIX,
  AUTH_PREFIX,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  type ApiError,
  type ApiErrorCode,
  type AuthProvidersResponse,
  type CreateFolderBody,
  type CreateRoomBody,
  type CreateTokenBody,
  type CreateTokenResponse,
  type FileInfo,
  type FolderInfo,
  type GrantsResponse,
  type MeResponse,
  type NodeKind,
  type PutGrantsBody,
  type RoomInfo,
  type SearchResponse,
  type SnapshotInfo,
  type SnapshotResponse,
  type SnapshotsResponse,
  type TokensResponse,
  type TreeResponse,
  type UpdateFolderBody,
  type UpdateRoomBody,
  type UsersResponse,
} from "@exidraw/shared";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "network",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** Called on any 401 so the app can drop to the login page. */
let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(fn: (() => void) | null): void {
  onUnauthenticated = fn;
}

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: "invalid",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  429: "rate_limited",
  503: "renderer_unavailable",
};

interface RequestOptions {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Do not trigger the global 401 handler (e.g. the /api/me bootstrap). */
  quiet401?: boolean;
}

async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { ...opts.headers };
  if (method !== "GET" && method !== "HEAD") headers[CSRF_HEADER] = CSRF_HEADER_VALUE;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, credentials: "same-origin" });
  } catch (err) {
    throw new ApiRequestError(0, "network", err instanceof Error ? err.message : "Network error");
  }
  if (res.ok) return res;

  let code: ApiErrorCode = STATUS_CODES[res.status] ?? "internal";
  let message = `${res.status} ${res.statusText}`;
  let details: unknown;
  try {
    const parsed = (await res.json()) as Partial<ApiError>;
    if (parsed.error) {
      code = parsed.error.code ?? code;
      message = parsed.error.message || message;
      details = parsed.error.details;
    }
  } catch {
    // non-JSON error body; keep the status-derived code
  }
  if (res.status === 401 && !opts.quiet401) onUnauthenticated?.();
  throw new ApiRequestError(res.status, code, message, details);
}

async function json<T>(path: string, opts?: RequestOptions): Promise<T> {
  const res = await request(path, opts);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;
const A = API_PREFIX;

export const api = {
  // auth
  providers: () => json<AuthProvidersResponse>(`${A}/auth/providers`),
  me: () => json<MeResponse>(`${A}/me`, { quiet401: true }),
  devLogin: (userId: string) =>
    request(`${AUTH_PREFIX}/dev/login`, { method: "POST", json: { userId }, quiet401: true }).then(() => undefined),
  logout: () => request(`${AUTH_PREFIX}/logout`, { method: "POST", quiet401: true }).then(() => undefined),
  users: (q: string) => json<UsersResponse>(`${A}/users?q=${enc(q)}`),

  // tree
  tree: (folderId: string) => json<TreeResponse>(`${A}/tree?folderId=${enc(folderId)}`),
  search: (q: string) => json<SearchResponse>(`${A}/search?q=${enc(q)}&inContent=0`),
  createFolder: (body: CreateFolderBody) => json<FolderInfo>(`${A}/folders`, { method: "POST", json: body }),
  updateFolder: (id: string, body: UpdateFolderBody) =>
    json<FolderInfo>(`${A}/folders/${enc(id)}`, { method: "PATCH", json: body }),
  deleteFolder: (id: string) => request(`${A}/folders/${enc(id)}`, { method: "DELETE" }).then(() => undefined),
  createRoom: (body: CreateRoomBody) => json<RoomInfo>(`${A}/rooms`, { method: "POST", json: body }),
  room: (id: string) => json<RoomInfo>(`${A}/rooms/${enc(id)}`),
  updateRoom: (id: string, body: UpdateRoomBody) =>
    json<RoomInfo>(`${A}/rooms/${enc(id)}`, { method: "PATCH", json: body }),
  deleteRoom: (id: string) => request(`${A}/rooms/${enc(id)}`, { method: "DELETE" }).then(() => undefined),

  // grants
  grants: (kind: NodeKind, id: string) => json<GrantsResponse>(`${A}/nodes/${kind}/${enc(id)}/grants`),
  putGrants: (kind: NodeKind, id: string, body: PutGrantsBody) =>
    json<GrantsResponse>(`${A}/nodes/${kind}/${enc(id)}/grants`, { method: "PUT", json: body }),

  // files
  fileUrl: (roomId: string, fileId: string) => `${A}/rooms/${enc(roomId)}/files/${enc(fileId)}`,
  getFile: (roomId: string, fileId: string) => request(api.fileUrl(roomId, fileId)).then((r) => r.blob()),
  putFile: (roomId: string, fileId: string, bytes: Blob) =>
    json<FileInfo>(api.fileUrl(roomId, fileId), {
      method: "PUT",
      body: bytes,
      headers: { "content-type": bytes.type || "application/octet-stream" },
    }),

  // tokens
  tokens: () => json<TokensResponse>(`${A}/tokens`),
  createToken: (body: CreateTokenBody) => json<CreateTokenResponse>(`${A}/tokens`, { method: "POST", json: body }),
  revokeToken: (id: string) => request(`${A}/tokens/${enc(id)}`, { method: "DELETE" }).then(() => undefined),

  // snapshots
  snapshots: (roomId: string) => json<SnapshotsResponse>(`${A}/rooms/${enc(roomId)}/snapshots`),
  snapshot: (roomId: string, sid: number) => json<SnapshotResponse>(`${A}/rooms/${enc(roomId)}/snapshots/${sid}`),
  createSnapshot: (roomId: string) =>
    json<SnapshotInfo>(`${A}/rooms/${enc(roomId)}/snapshots`, { method: "POST", json: { reason: "manual" } }),
  restoreSnapshot: (roomId: string, sid: number) =>
    json<SnapshotInfo>(`${A}/rooms/${enc(roomId)}/snapshots/${sid}/restore`, { method: "POST" }),
};

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === "network") return "Cannot reach the server.";
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
