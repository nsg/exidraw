# exidraw — Architecture

Self-hosted, multiplayer Excalidraw for small deployments: one container, one
process, all state on `/data`. Uses `@excalidraw/excalidraw` 0.18.1 as a
library inside our own React app; nothing talks to excalidraw.com, Firebase,
CDNs or any other external host.

`shared/src/*.ts` is the contract both implementers import. Where this document
and the shared code disagree, the shared code wins and this document has a bug.

---

## 1. Components and process model

One Node 24 process, one listening port (`PORT`, default 8080):

```
                 ┌────────────────────────────────────────────────────────────┐
 browser (SPA) ─►│ Hono app                                                   │
                 │   /            static SPA (web/dist, index.html fallback)  │
                 │   /auth/*      OIDC (Entra) or dev login, logout           │
                 │   /api/*       REST (cookie session or Bearer PAT)         │
                 │   /mcp         MCP Streamable HTTP (Bearer PAT only)       │
                 │   /healthz                                                 │
                 │   /_internal/renderer/*  static page for headless Chromium │
 browser (WS) ──►│ ws server on the same http.Server (upgrade on /ws)         │
                 │                                                            │
                 │ RoomManager  — in-memory authoritative scenes, reconcile,  │
                 │                broadcast, debounced persist                │
                 │ Store        — node:sqlite (WAL) at $DATA_DIR/exidraw.db   │
                 │ FileStore    — $DATA_DIR/files/<roomId>/<fileId>           │
                 │ Renderer     — Playwright-driven headless Chromium page     │
                 │                (exports, skeleton conversion, mermaid)     │
                 └────────────────────────────────────────────────────────────┘
```

- **Server-authoritative**: the server holds each open room's scene in memory
  (`Map<elementId, element>`), applies every incoming change through one
  reconcile function, persists, and broadcasts. Clients never talk to each
  other directly.
- **Single replica by design**: in-memory room state is the source of truth
  between persists; no clustering, no Redis.
- **Headless Chromium is a helper, not a dependency for collaboration**: if it
  dies, editing keeps working; only render/convert tools fail with
  `renderer_unavailable` until the supervisor relaunches it.

## 2. Repository layout (npm workspaces)

```
package.json            workspaces: shared, server, web; root scripts
tsconfig.base.json
shared/                 @exidraw/shared — contracts (types, zod schemas, constants, pure helpers)
server/                 @exidraw/server — Node backend (Hono, ws, sqlite, MCP, Playwright)
  src/                  TS → dist/ (tsc)
  renderer/             browser page bundled by esbuild → renderer-dist/ (served at /_internal/renderer/)
  test/
web/                    @exidraw/web — React SPA (Vite) → dist/
  src/
  e2e/                  Playwright tests (dev login, two browsers)
docs/
Containerfile           (root; backend owns)
.github/workflows/      (backend owns)
```

`shared` builds with `tsc` to `shared/dist` and is consumed via its package
`exports`. Root `npm run build` builds shared → web → server.

## 3. Technology choices

| Concern | Choice (pinned) | Why |
|---|---|---|
| HTTP | `hono` 4.13.13 + `@hono/node-server` 2.1.5 | Fetch-standard handlers, tiny, typed; the MCP SDK's web-standard transport plugs straight in. `serve()` returns the `http.Server`, which `ws` hooks for upgrades. |
| WebSocket | `ws` 8.22.0 (`noServer: true`, manual `upgrade` handler) | Boring and robust; avoids `@hono/node-ws`'s peer-version mismatch with node-server 2.x. |
| SQLite | `node:sqlite` (built into Node 24, no native build) | Synchronous API fits a single-process server; zero compile/prebuild risk in the image. Verified working on Node 24.22 without warnings. better-sqlite3 was the alternative; rejected only because of the native module in a multi-stage build. If `node:sqlite` turns out to be missing a feature, swap behind `server/src/db.ts` — the API shapes are near-identical. |
| OIDC | `openid-client` 6.8.8 | Certified, fetch-based, PKCE + confidential client out of the box. |
| MCP | `@modelcontextprotocol/sdk` 1.32.1, `WebStandardStreamableHTTPServerTransport` in stateless mode | Stateless = one transport per request, no session table; pairs with Bearer-per-request PAT auth. |
| Validation | `zod` 4.6.7 | The MCP SDK uses it for tool schemas; reuse for REST bodies. Schemas live in `shared`. |
| Rendering | `playwright` 1.64.1 + `chromium-headless-shell` | Official export code with real fonts; also runs mermaid. See § 11. |
| Frontend | React 19.3.1, Vite 8.3.4, `@vitejs/plugin-react` 6.1.2, `react-router` 8.5.0 | Vanilla, matches the Excalidraw peer range. |
| Logging | `pino` 10.4.0 | JSON logs, one dependency. |
| Tests | `vitest` 5.0.5 (unit/integration), `@playwright/test` 1.64.1 (e2e) | |
| TypeScript | 5.9.3 (not 7.x) | Avoids tooling surprises from the Go-based 7.0 line in a prototype; bump later. |

## 4. Authentication, sessions, tokens

### 4.1 Identity

A `users` row is created on first login. `users.email` is the lower-cased
e-mail/UPN and is the key that grants are matched on before a person has ever
logged in. `users.subject` is the provider's stable id (`oid` claim for Entra,
the configured id for dev users).

Admins: `ADMIN_EMAILS` (case-insensitive email/UPN) or `ADMIN_OIDS`
(case-insensitive Entra object GUIDs matched against `users.subject`, Entra users
only). Both are comma-separated and evaluated per request. Prefer stable object
ids for administrators; email/UPN remains the pre-login grant address.

### 4.2 Entra ID (`AUTH_MODE=entra`, default)

Authorization code + PKCE, confidential client (`client_secret_post`), discovery
at `ENTRA_ISSUER` (default `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`).
Scopes: `openid profile email`.

1. `GET /auth/login?returnTo=/r/abc` — generate `state`, PKCE verifier, `nonce`;
   store them with `returnTo` in the `exidraw_oidc` cookie (HttpOnly, SameSite=Lax,
   Secure when `PUBLIC_URL` is https, Max-Age 600); 302 to the authorization endpoint
   with `redirect_uri = PUBLIC_URL + /auth/callback`.
2. `GET /auth/callback` — validate `state`, exchange code, validate ID token
   (`nonce`, issuer, audience). Claims → user: `subject = oid`,
   `email = lower(preferred_username ?? email)`, `name = name ?? email`.
   Upsert `users`; set `grants.principal_user_id` on every grant whose
   `principal_email` equals this email; create a session; clear the flow cookie;
   302 to `returnTo` (must start with a single `/`, else `/`).
3. Guest or unverifiable membership → a 403 HTML page with the flow cookie
   cleared and no session. Other failures → 302 `/login?error=<code>`
   (never leak token contents).

By default only tenant members may sign in. Enable the optional **`acct` claim
for ID tokens** under App registration → Token configuration → Add optional
claim (or `optionalClaims.idToken` in the manifest): `0` means member, `1` guest.
The server denies a missing or unknown `acct` too, so an unconfigured registration
fails closed. A guest can have the resource tenant’s `iss` and `tid`, so those
claims alone cannot distinguish B2B guests. `ENTRA_ALLOW_GUESTS=true` explicitly
disables this membership restriction; issuer/audience/nonce checks still apply.
See Microsoft’s [optional claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference).

### 4.3 Dev login (`AUTH_MODE=dev`)

Never the default. On start the server logs a warning banner. `DEV_USERS` is a
JSON array `[{ "id", "email", "name" }]`; default:

```json
[{"id":"alice","email":"alice@example.test","name":"Alice Architect"},
 {"id":"bob","email":"bob@example.test","name":"Bob Builder"},
 {"id":"carol","email":"carol@example.test","name":"Carol Viewer"},
 {"id":"dave","email":"dave@example.test","name":"Dave Visitor"}]
```

- `GET /api/auth/providers` → `{ mode: "dev", loginUrl: "/auth/dev/login", users: [...] }`
  (in entra mode: `{ mode: "entra", loginUrl: "/auth/login" }`).
- `POST /auth/dev/login` body `DevLoginBody` → upsert user (subject = id),
  create session, `204` + cookie. CSRF header required (it is a cookie-setting
  mutation; the SPA sends it anyway).

The SPA login page renders a user picker in dev mode and a single "Sign in
with Microsoft" link in entra mode. Tests use the dev mode with
`ADMIN_EMAILS=alice@example.test`.

### 4.4 Sessions and CSRF

- `sessions` table; cookie `exidraw_session` = 32 random bytes base64url;
  HttpOnly, SameSite=Lax, Path=/, Secure iff `PUBLIC_URL` is https; sliding
  expiry `SESSION_TTL_DAYS` (touch `last_seen_at` at most once per hour).
- `POST /auth/logout` deletes the session row and clears the cookie.
- CSRF: no CORS is enabled (no `Access-Control-*` headers ever). Every
  non-GET/HEAD request to `/api/*` or `/auth/*` authenticated by cookie must
  carry header `x-exidraw-csrf: 1` (`CSRF_HEADER`/`CSRF_HEADER_VALUE`), else
  `403 {code:"csrf"}`. Custom headers cannot be sent cross-site without a
  preflight, which we refuse. Bearer-authenticated requests are exempt.
- WebSocket upgrade: `Origin` must equal the origin of `PUBLIC_URL` or one of
  `ALLOWED_ORIGINS`; otherwise 403 before upgrade.

### 4.5 Personal access tokens

- Plaintext: `exi_` + base64url(32 random bytes) (47 chars). Shown once.
- Stored: `sha256(plaintext)` hex in `tokens.token_hash`; `prefix` = first 12
  chars for display.
- Accepted as `Authorization: Bearer <token>` on `/api/*` and `/mcp`. Lookup
  by hash; reject if `revoked_at` or `expires_at < now`. Update `last_used_at`
  at most once a minute.
- Tokens act as the user with the user's permissions at the time of use.
  Revocation is immediate (no caching of token→user).
- Missing/invalid Bearer on `/mcp` → `401` with `WWW-Authenticate: Bearer realm="exidraw"`.
  Cookies are ignored on `/mcp`.

## 5. Data model (SQLite)

`$DATA_DIR/exidraw.db`, `PRAGMA journal_mode=WAL; synchronous=FULL; foreign_keys=ON; busy_timeout=5000`.
Schema versioning: table `meta(key TEXT PRIMARY KEY, value TEXT)` with
`schema_version`; migrations are numbered SQL strings applied in a transaction
at startup.

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- random 16 bytes base64url
  auth_mode     TEXT NOT NULL,             -- 'entra' | 'dev'
  subject       TEXT NOT NULL,             -- Entra oid / dev user id
  email         TEXT NOT NULL UNIQUE,      -- lower-cased
  name          TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  UNIQUE (auth_mode, subject)
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,           -- the cookie value
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,       -- sha256 hex
  prefix       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE folders (
  id         TEXT PRIMARY KEY,             -- 'root' for the root folder
  parent_id  TEXT REFERENCES folders(id),  -- NULL only for root
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT,                         -- users.id, NULL for root
  UNIQUE (parent_id, name)
);

CREATE TABLE rooms (
  id         TEXT PRIMARY KEY,             -- 12 chars base64url (URL-safe)
  folder_id  TEXT NOT NULL REFERENCES folders(id),
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,             -- metadata or scene change
  created_by TEXT NOT NULL,
  deleted_at INTEGER                        -- soft delete; hidden everywhere when set
);
CREATE INDEX rooms_folder ON rooms(folder_id);

CREATE TABLE scenes (
  room_id       TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  elements      TEXT NOT NULL,             -- JSON array in canonical order, tombstones included
  scene_version INTEGER NOT NULL,          -- safe-integer sum of element versions
  tombstone_times TEXT NOT NULL DEFAULT '{}', -- server deletion receipt ms by id (migration 2)
  updated_at    INTEGER NOT NULL
);

CREATE TABLE grants (
  id                INTEGER PRIMARY KEY,
  node_kind         TEXT NOT NULL CHECK (node_kind IN ('folder','room')),
  node_id           TEXT NOT NULL,
  principal_kind    TEXT NOT NULL CHECK (principal_kind IN ('all','user')),
  principal_email   TEXT,                  -- lower-cased; NOT NULL when principal_kind='user'
  principal_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  role              TEXT NOT NULL CHECK (role IN ('viewer','editor','owner')),
  created_at        INTEGER NOT NULL,
  created_by        TEXT NOT NULL,
  UNIQUE (node_kind, node_id, principal_kind, principal_email)
);
CREATE INDEX grants_node ON grants(node_kind, node_id);

CREATE TABLE files (
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL,                -- Excalidraw fileId (content hash from the client)
  mime_type  TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (room_id, file_id)
);

CREATE TABLE snapshots (
  id            INTEGER PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,                      -- NULL for 'auto'
  reason        TEXT NOT NULL,             -- 'auto' | 'manual' | 'agent' | 'restore'
  scene_version INTEGER NOT NULL,
  element_count INTEGER NOT NULL,
  elements_gz   BLOB NOT NULL              -- gzip(JSON array)
);
CREATE INDEX snapshots_room ON snapshots(room_id, created_at);
```

Deleting a folder requires it to be empty (`409 conflict` otherwise). Deleting a
room sets `deleted_at` (files and snapshots stay). Hard purge is out of scope.

## 6. Permissions

### 6.1 Model

- Roles: `viewer < editor < owner` (`shared/src/roles.ts`).
- A **grant** = (node, principal, role). Node is a folder or room. Principal is
  `all` (every authenticated user) or `user` (by lower-cased e-mail; linked to a
  `users.id` once that person logs in).
- Grants on a folder apply to everything below it. Inheritance is additive:
  the effective role is the **maximum** matching role over the node and all its
  ancestors. There is no "deny".
- Admins (`ADMIN_EMAILS` or `ADMIN_OIDS`) are `owner` on every node.
- `REQUIRED_ROLE` in `roles.ts` maps every operation to its minimum role; the
  server must consult it (no ad-hoc checks).

### 6.2 Resolution (`computeEffectiveRole`)

```
effectiveRole(subject, node):
  if subject.isAdmin → owner
  chain = grants(node) ∪ grants(parent(node)) ∪ … ∪ grants(root)
  return max(role of g for g in chain if grantMatches(g, subject)) or null
grantMatches(g, s): g.principal.kind == 'all'
                 or g.principal.userId == s.userId
                 or lower(g.principal.email) == lower(s.email)
```

The tree is small (a handful of editors); the server loads all folders, rooms and
grants into memory once per request that needs a listing, and computes roles
top-down. No caching across requests for the prototype (SQLite reads are µs).

### 6.3 Visibility in listings

- A room is listed iff effective role ≥ viewer.
- A folder is listed iff effective role ≥ viewer **or** it has any listed
  descendant (so people can navigate to what they may see). Such
  traversal-only folders carry `role: null`; only their visible children are
  returned when listed, and nothing may be created in them.
- `GET /api/rooms/:id` on an inaccessible room returns `404`, not `403`
  (do not reveal existence). Same for folders.

### 6.4 Examples (`ADMIN_EMAILS=alice@…`)

Tree: `root / Projects / Bridge / plan.excalidraw(room)`, `root / Public / notes(room)`.

| Grants | Bob on `plan` | Carol on `plan` | Carol sees `Projects`? |
|---|---|---|---|
| none | null (404) | null | no |
| `Projects: all=viewer` | viewer | viewer | yes (role viewer) |
| `Projects: all=viewer`, `plan: bob@=editor` | editor | viewer | yes |
| `Bridge: bob@=owner` | owner | null | no; Bob sees `Projects` with `role: null` |
| `root: all=viewer`, `Bridge: all=editor` | editor | editor | yes |

Alice is owner everywhere. A grant for `dave@…` placed before Dave ever logs
in works the moment he logs in (matched by e-mail; linked to his user id then).

### 6.5 Who may do what (derived from `REQUIRED_ROLE`)

| Operation | Role on | Minimum |
|---|---|---|
| open/read room, list folder, download file, render, read snapshots | node | viewer |
| edit scene (WS/MCP), upload file, rename, create snapshot, restore snapshot | node | editor |
| create folder/room | parent folder | editor |
| move node | node: owner; destination folder: editor | |
| delete node, read/write grants | node | owner |
| create/revoke own PATs, list users | — | any authenticated user |

Every path (REST, WS, MCP) resolves the role with the same function and
checks it server-side before acting. The UI only uses roles to hide buttons.

### 6.6 Who has access (`summarizeAccess`, `shared/src/access.ts`)

The effective access of a node, per principal: the maximum role over the
node's own grants and its ancestors', with `from` = the nearest place granting
that role (`null` = the node itself, else `{ kind: "folder", id, name }`).
Sorted by role (owner first), `all` before users, then by name. Admins are not
listed (they are owners without a grant). Entries are per principal, so a user
whose own role is below the `all` role really has the `all` role; the UI says
so ("Editor via everyone").

Principals: `all`; linked users (grant has a user id) are one person only by
id; unlinked grants by lower-cased e-mail; an unlinked grant joins a linked
user only when its e-mail is that user's **current** `users.email`. The server
reports linked grants with the current e-mail (`grants()` and listings), since
login may change a user's e-mail while old grants stay linked by id, and a new
grant to the old address is someone else's (`grantMatches` agrees).

Listings memoise one summary per folder as its children inherit it ("set
here" relabelled to that folder), so each row costs its own grants plus one
merge (`summarizeAccess(ownLevels, inherited)`).

- `/api/tree` and `/api/search` fill `FolderInfo.access` / `RoomInfo.access`
  with it, computed from the in-memory listing (no per-row queries), **only**
  for nodes where the caller has `readGrants`; the field is absent otherwise.
  So nobody learns more than `GET …/grants` would tell them. It falls through
  to the MCP `list_folder`/`search` outputs, which pass these DTOs on.
- The web app's access inspector runs the same function over a
  `GrantsResponse` (`accessFromGrants`); non-owners see only their own role.

## 7. REST API

Base `/api`. JSON bodies, `Content-Type: application/json`. Errors are
`ApiError` with the status codes listed in `api.ts`. Validation uses the zod
schemas in `shared/src/api.ts`; failures → `400 invalid` with zod issues in
`details`. Auth: cookie session or Bearer PAT; `401` when neither.

| Method & path | Role | Body / query → Response |
|---|---|---|
| `GET /api/auth/providers` | public | → `AuthProvidersResponse` |
| `GET /auth/login?returnTo=` | public | 302 to Entra |
| `GET /auth/callback` | public | 302 |
| `POST /auth/dev/login` | public (dev mode) | `DevLoginBody` → 204 |
| `POST /auth/logout` | auth | → 204 |
| `GET /api/me` | auth | → `MeResponse` |
| `GET /api/users?q=` | auth | → `UsersResponse` (name/e-mail substring, max 50) |
| `GET /api/tree?folderId=root` | viewer/traversal | → `TreeResponse`; `access` on nodes the caller owns (§6.6) |
| `GET /api/search?q=&inContent=0` | auth | → `SearchResponse` (only visible nodes; `access` as for the tree) |
| `POST /api/folders` | editor on parent | `CreateFolderBody` → `201 FolderInfo` |
| `PATCH /api/folders/:id` | editor (rename) / owner+editor-on-dest (move) | `UpdateFolderBody` → `FolderInfo` |
| `DELETE /api/folders/:id` | owner | → 204; `409` if not empty; root cannot be deleted |
| `POST /api/rooms` | editor on folder | `CreateRoomBody` → `201 RoomInfo` |
| `POST /api/rooms/import` | editor on folder | `ImportRoomBody` → `201 RoomInfo` |
| `GET /api/rooms/:id` | viewer | → `RoomInfo` |
| `PATCH /api/rooms/:id` | editor (rename) / owner+editor-on-dest (move) | `UpdateRoomBody` → `RoomInfo`; broadcasts `room_updated` |
| `DELETE /api/rooms/:id` | owner | → 204; closes WS clients with 4410 |
| `GET /api/rooms/:id/scene` | viewer | → `SceneResponse` |
| `GET /api/rooms/:id/export.json` | viewer | → Excalidraw file JSON (`type: "excalidraw"`, `elements` non-deleted, `files` embedded as dataURLs) |
| `GET /api/rooms/:id/export.png` / `.svg` | viewer | `ExportQuery` → image; `503 renderer_unavailable` |
| `GET /api/rooms/:id/files/:fileId` | viewer | → bytes, `Content-Type` from DB, `Cache-Control: private, max-age=31536000, immutable` |
| `PUT /api/rooms/:id/files/:fileId` | editor | raw body (`Content-Type` = image mime; ≤ `MAX_FILE_BYTES`) → `201/200 FileInfo` |
| `GET /api/nodes/:kind/:id/grants` | owner | → `GrantsResponse` |
| `PUT /api/nodes/:kind/:id/grants` | owner | `PutGrantsBody` → `GrantsResponse`; replaces all direct grants atomically; then recomputes the role of every WS connection in affected rooms and sends `role` |
| `GET /api/tokens` | auth | → `TokensResponse` (own tokens, non-revoked) |
| `POST /api/tokens` | auth (session only, not Bearer) | `CreateTokenBody` → `201 CreateTokenResponse` |
| `DELETE /api/tokens/:id` | auth (own token) | → 204 (sets `revoked_at`) |
| `GET /api/rooms/:id/snapshots` | viewer | → `SnapshotsResponse` (newest first) |
| `POST /api/rooms/:id/snapshots` | editor | → `201 SnapshotInfo` |
| `GET /api/rooms/:id/snapshots/:sid` | viewer | → `SnapshotResponse` |
| `POST /api/rooms/:id/snapshots/:sid/restore` | editor | → `SnapshotInfo` of the pre-restore snapshot taken first (`reason: "restore"`) |
| `GET /healthz` | public | → `HealthResponse` (always 200 while HTTP is up) |

Rules:
- Room import checks folder `createChild` permission before validating element
  envelopes, unique ids and referenced image data URLs. Deleted elements and
  unreferenced files are discarded; other element JSON stays opaque, except
  images with accepted files get `status: "saved"`. Data URL header mime types
  override file metadata; base64 must be valid and decoded files respect
  `MAX_FILE_BYTES` (`413`). The JSON body uses `MAX_HTTP_JSON_BYTES` (`413`).
  All validation precedes writes. Room and scene (including scene version) are
  inserted atomically; a file write failure removes the room and its metadata.
  Import neither loads the room into memory nor creates a snapshot.
- `fileId` path param: `^[A-Za-z0-9_-]{1,64}$`. `PUT` of an existing fileId is
  idempotent (`200`), bytes are not replaced.
- Accepted upload mime types: `image/png, image/jpeg, image/gif, image/webp,
  image/svg+xml, image/avif, image/bmp, image/x-icon`. SVG is served with
  `Content-Disposition: attachment`-free but `X-Content-Type-Options: nosniff`
  and `Content-Security-Policy: sandbox` headers (defence against scripted SVG).
- Static SPA: everything not matching the routes above and not starting with
  `/api`, `/auth`, `/ws`, `/mcp`, `/_internal`, `/healthz` serves
  `index.html` (so `/r/<id>` deep links work). `/assets/*` and
  `/excalidraw-assets/*` get long immutable caching.
- Security headers on HTML: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`. No CSP in the
  prototype (Excalidraw uses inline styles and blob URLs; leave for later).
- Move operations reject cycles (moving a folder into its own subtree) with
  `400`, and depth > `MAX_FOLDER_DEPTH`.

## 8. Collaboration protocol (WebSocket)

Types: `shared/src/protocol.ts`. JSON text frames, one message per frame,
`type` discriminator. Binary frames are closed with 4400.

### 8.1 Connect

`GET /ws?room=<roomId>` with the session cookie. Server checks, in order:
Origin (403 before upgrade) → session (close 4401) → room exists and not
deleted (4404) → effective role ≥ viewer (4403). For the 4xxx cases the
server sends `error{fatal:true}` then closes with the code.

Then, in this order: `welcome` → `scene_init` → `presence` (to the newcomer) and
`presence` to everyone else. Only after `scene_init` may the client send
`scene_update`.

### 8.2 Client → server

| Message | Role | Server behaviour |
|---|---|---|
| `scene_update{elements}` | editor | Validate (§ 8.4), reconcile (§ 8.5), persist (§ 8.6), broadcast winners to all other connections as `scene_update{origin: connId}`; send losers' server versions back to the sender as `scene_update{origin:"server"}` (only when non-empty). Viewers get `error{code:"forbidden", fatal:false}` and the message is dropped. |
| `pointer{…}` | viewer | Rate-limit (`POINTER_RATE_LIMIT_PER_SEC`, excess dropped silently), fan out as `pointer{connId,…}` to others. Not persisted. |
| `idle{state}` | viewer | Store on the connection, fan out as `idle{connId,state}`, reflect in later `presence`. |
| `request_scene` | viewer | Reply `scene_init` to that connection. Rate-limit 1/s. |

### 8.3 Server → client

`welcome`, `scene_init`, `scene_update`, `presence`, `pointer`, `idle`,
`role`, `room_updated`, `error` — see `protocol.ts` for payloads.

- `presence` is always the full list (including the receiver and synthetic
  agents). Sent on join, on leave, and when agent presence appears or expires.
  Idle changes are not re-sent as `presence`; clients apply `idle` messages.
- `role` is sent when the connection's effective role changes due to a grant
  change. If the new role is null the server sends `error{fatal:true}` and
  closes 4403.

### 8.4 Validation of incoming elements

Per `scene_update`:
- JSON parse OK, `elements` is an array, length ≤ `MAX_ELEMENTS_PER_ROOM`,
  frame ≤ `MAX_WS_MESSAGE_BYTES` (8 MiB, rejected before JSON parsing;
  `message_too_large`, close 4413). Too many elements in a frame returns
  `too_many_elements`, non-fatal.
- Every element passes `isElementEnvelope`: version is an integer in
  `[1, 2^31−1]`, nonce an integer in `[−2^31, 2^31−1]`, `updated` finite,
  and `index` absent/null or a string of at most 64 characters. Otherwise reply
  `error{invalid_message, fatal:false}` and drop the whole message.
- After applying, if the room would exceed `MAX_ELEMENTS_PER_ROOM` non-deleted
  elements → `error{too_many_elements}` and drop.
- Beyond the envelope the element is opaque JSON. The server never
  interprets Excalidraw semantics except in MCP tools (§ 12), and even there
  through the renderer page where possible.
- Beyond `SCENE_UPDATE_RATE_LIMIT_PER_SEC`, valid editor updates are coalesced
  per connection and element id with `remoteWins`, then applied/broadcast within
  100 ms. Buffers drain before disconnect/shutdown persistence. Drag edits are
  never dropped because of this message rate.
- Every connection has a sliding 10-second budget for all received message
  types plus ping/pong: more than 32 MiB or 600 frames closes 4429 with
  `rate_limited`. Bytes count before JSON parsing, including viewer traffic and
  invalid messages. Expired budget entries are removed independently. Twenty
  forbidden viewer updates in 10 seconds close 4403 (`forbidden`).
- Fatal errors use matching codes: 4401 `unauthenticated`, 4404 `not_found`,
  4403 `forbidden`, 4413 `message_too_large`, 4429 `rate_limited`.

### 8.5 Reconcile (server merge) — `RoomManager.applyElements(roomId, incoming, origin)`

Pure, synchronous, the single write path for WS, MCP, REST restore:

```
accepted = []; rejected = []
for e of incoming (in given order):
  cur = scene.get(e.id)
  if remoteWins(cur, e):            // shared/elements.ts: version↑, tie → lower versionNonce
    scene.set(e.id, e); accepted.push(e)
  else if cur and (cur.version != e.version or cur.versionNonce != e.versionNonce):
    rejected.push(cur)               // identical reconnect identities are silent
if accepted.length:
  sceneVersion = computeSceneVersion(scene.values())
  markDirty(room); maybeSnapshot(room)
  broadcast scene_update{elements: accepted, sceneVersion, origin} to all conns except origin
if rejected.length and origin is a connection:
  send scene_update{elements: rejected, sceneVersion, origin:"server"} to origin
return { accepted, rejected }
```

Ordering is by fractional `index` (`compareElementOrder`) only when
serialising (`scene_init`, persist, snapshots, REST). The server never
rewrites `index`; clients run `reconcileElements` (which fixes invalid
indices) on receipt, exactly like upstream.

Because JS is single-threaded and `applyElements` is synchronous, room
mutations are naturally serialised; there must be no `await` between reading
the scene and writing it.

### 8.6 Persistence

- Rooms are loaded from `scenes` into memory on first access and unloaded
  `ROOM_IDLE_UNLOAD_MS` after the last connection closes (if not dirty).
- `markDirty` schedules a persist `SCENE_PERSIST_DEBOUNCE_MS` after the last
  change but no later than `SCENE_PERSIST_MAX_WAIT_MS` after the first
  unpersisted change. Persist = one `UPDATE scenes … ; UPDATE rooms SET updated_at`
  in a transaction; tombstones older than `TOMBSTONE_RETENTION_MS` are dropped
  from both memory and disk at that point. Age uses `scenes.tombstone_times`,
  a server-only receipt-time map persisted atomically alongside elements;
  client `updated` is never used for retention. Repeated updates to an existing
  tombstone do not renew it. Legacy tombstones without metadata start their
  retention period when loaded and are immediately backfilled to disk, so
  unloading/restarting cannot reset that fallback time. The map is never sent
  to clients.
- At most 20,000 live elements and 40,000 total elements are stored per room.
  Before accepting an update over the total cap, remove oldest tombstones
  (server receipt order) until it fits; live overflow rejects the whole update
  with `too_many_elements`.
- MCP writes persist immediately (synchronously, before the tool returns).
- `SIGTERM`/`SIGINT`: stop accepting connections, persist every dirty room
  synchronously, close all sockets with 1001, close the browser, exit 0 —
  all within 5 s. Each failed room persist is logged independently; remaining
  rooms, WebSockets, renderer and database still close.
- Worst case loss on a hard crash: ≤ 5 s of edits (clients still hold them
  and re-send on reconnect, see § 8.7).

### 8.7 Reconnect / resync

- Client reconnects with exponential backoff (1 s → 30 s, jitter) on any
  close except 4401/4403/4404/4410 (which navigate away / show an error).
- On every (re)connect the client receives `scene_init`, reconciles it into
  its local scene (`restoreElements` then `reconcileElements`, `captureUpdate:
  NEVER`), and then sends ONE `scene_update` containing **all** of its
  non-deleted elements plus tombstones newer than `TOMBSTONE_RETENTION_MS`
  (syncAll). The server keeps only winners, so this is safe and is how
  offline edits survive a server restart. There is no periodic full resync
  (TCP delivers or the socket dies).
- Server-side ping every `WS_PING_INTERVAL_MS`; terminate when no pong within
  `WS_PONG_TIMEOUT_MS`.

### 8.8 Agent presence

When an MCP tool mutates a room, the server upserts a synthetic collaborator
`connId = "agent:" + tokenId`, name `"<user.name>'s agent"` (or the token's
name if it ends with "agent"), owner's colour, `isAgent: true`, and sends a
`pointer` placed at the centre of the bbox of the elements it just changed
plus `presence`. It expires `AGENT_PRESENCE_TTL_MS` after the last write
(timer; then `presence` again). Agents never count as connections for unload
purposes.

### 8.9 Client-side algorithm (frontend; mirrors upstream `Collab.tsx`/`Portal.tsx`)

- Keep `broadcastedVersions: Map<id, version>`. On Excalidraw `onChange`,
  collect elements (incl. deleted) whose `version > broadcastedVersions.get(id)`
  (or unknown), skip invisibly-small ones (`isInvisiblySmallElement`), send
  `scene_update`, and record their versions. Do this inside a
  `requestAnimationFrame`/microtask batch, not throttled further.
- On `scene_init`/`scene_update` from the server: `remote = restoreElements(elements, local)`;
  `merged = reconcileElements(local, remote, appState)`; record the versions
  of **received** elements into `broadcastedVersions` **before**
  `updateScene({elements: merged, captureUpdate: CaptureUpdateAction.NEVER})`
  so the resulting `onChange` does not echo them back.
- After `scene_init`: send the syncAll `scene_update` (§ 8.7).
- Cursor: `onPointerUpdate` → throttle `CLIENT_POINTER_THROTTLE_MS` → `pointer`.
  Incoming `pointer`/`idle`/`presence` → `updateScene({ collaborators })` map
  keyed by `connId` (as `SocketId`), with `username`, `color`, `pointer`,
  `button`, `selectedElementIds`, `userState`, `isCurrentUser` for own connId.
- `role` → set `viewModeEnabled = role === "viewer"`.
- View mode: viewers still send `pointer`/`idle`, never `scene_update`.

## 9. Files (images)

Excalidraw keeps binary image data in `files` (keyed by `fileId`, a content
hash the client computes). Our flow follows upstream's `FileManager` minus
encryption:

Upload (editor):
1. User inserts an image → element `status: "pending"`, file in `getFiles()`.
2. Client finds image elements with `status === "pending"` whose `fileId` is
   in local files and not yet uploaded → `PUT /api/rooms/:id/files/:fileId`
   (body = decoded dataURL bytes, `Content-Type` = mime), concurrency 2.
3. On `201/200` the client `updateScene`s the element with `status: "saved"`
   (version bump → broadcast → collaborators learn the file exists).
   On `413`/error: `status: "error"`; show a toast.

Download (anyone with viewer): on receiving elements with `status === "saved"`
and `fileId` not in local files (throttled 500 ms), `GET` the file, build a
dataURL, `excalidrawAPI.addFiles([{id, dataURL, mimeType, created}])`.

The renderer gets files the same way but server-side: the server reads them
from disk and passes `SceneFiles` (dataURLs) in `RenderRequest`.

Storage: `$DATA_DIR/files/<roomId>/<fileId>`; written to a temp name and
fsynced, then renamed (atomic); the containing directory is fsynced before
committing the SQLite metadata row. Files are never deleted in the prototype.

## 10. Snapshots (version history)

Decision: implement (cheap insurance against "someone deleted everything").

- Automatic: when persisting, if the newest snapshot of the room is older than
  `SNAPSHOT_MIN_INTERVAL_MS` **and** `scene_version` differs → insert
  `reason: "auto"`.
- Before any MCP mutation: `reason: "agent"`, at most once per
  `SNAPSHOT_AGENT_MIN_INTERVAL_MS` per room.
- Manual via REST.
- Retention: keep newest `SNAPSHOTS_KEEP_PER_ROOM`; delete older in the same
  transaction.
- Restore (`POST …/restore`): take a `restore` snapshot of the current state;
  then for each element `s` in the snapshot set `version = max(s.version, current?.version ?? 0) + 1`,
  fresh `versionNonce`, `updated = now`; for current elements absent from the
  snapshot create tombstones the same way; feed all through `applyElements`
  (origin `"server"`) so connected clients converge. UI for history is a
  frontend stretch goal; the backend endpoints are required.

## 11. Rendering and element conversion

### 11.1 Decision

Use **one persistent headless Chromium page** (`server/renderer/`) for
everything that needs Excalidraw's own code with real text metrics:
`convertToExcalidrawElements`, `restoreElements({refreshDimensions})`,
`exportToBlob`/`exportToSvg`, mermaid. The server does **reconcile, persist,
permissions, geometry-only edits (move/delete), and compact descriptions in
Node without a browser**.

Why not the jsdom bundle: it works for conversion, but with stubbed canvas
metrics labels are mis-sized, export needs a real canvas anyway, mermaid needs
a DOM, and the 14 MB bundle + stubs is fragile across package upgrades. Why
not everything in the browser: collaboration must not depend on Chromium
being alive. Latency: a `page.evaluate` round-trip is ~1–5 ms; a PNG export of
a large scene is 0.2–2 s. Memory: ~150–300 MB for headless-shell + one page.

### 11.2 Renderer page

- `server/renderer/index.html` + `renderer.ts`, bundled by esbuild
  (`platform: browser`, `format: esm`, loaders `.woff2/.ttf → file`, define
  `process.env.IS_PREACT="false"`, `process.env.NODE_ENV="production"`) into
  `server/renderer-dist/`, together with a copy of
  `node_modules/@excalidraw/excalidraw/dist/prod/fonts/` → `renderer-dist/fonts/`.
  Served at `INTERNAL_RENDERER_PATH` (static, no auth; contains no data).
- The page sets `window.EXCALIDRAW_ASSET_PATH = INTERNAL_RENDERER_PATH`
  **before** importing the package, imports `@excalidraw/excalidraw` and
  `@excalidraw/mermaid-to-excalidraw`, and assigns `window.exidrawRenderer`
  implementing `RendererBridge` (`shared/src/renderer.ts`). It renders no
  React UI.
- `exportPng`: `exportToBlob({ elements, files, appState: {exportBackground, viewBackgroundColor, theme, exportWithDarkMode}, exportPadding, getDimensions: (w,h) => capped scale })`
  → blob → base64. Cap: `scale` reduced so that `w*h*scale² ≤ RENDER_MAX_PIXELS`
  and each edge ≤ `RENDER_MAX_EDGE_PX`; report the scale used.
- `exportSvg`: `exportToSvg(...)` → `outerHTML`. Fonts are inlined by the
  package (`skipInliningFonts` unset) so the SVG is self-contained.
- Region/elementIds filter: select non-deleted elements whose bbox
  intersects the region (or whose id is listed), plus bound text of selected
  containers; export those. (Export is content-bbox based; no pixel clipping.)
- Before the first export, wait for `document.fonts.ready`.

### 11.3 Supervisor (server/src/renderer.ts)

- Launch at startup (`chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] })`;
  `--no-sandbox` is required because the container runs as non-root without
  user namespaces; `PLAYWRIGHT_BROWSERS_PATH` is set in the image), open
  `http://127.0.0.1:${PORT}${INTERNAL_RENDERER_PATH}`, wait for
  `window.exidrawRenderer.ping()`.
- Calls are serialised through a queue with `RENDER_TIMEOUT_MS` per call.
- On crash/disconnect or timeout: relaunch with backoff (1 s, 2 s, … 30 s);
  during that window tools fail fast with `renderer_unavailable`.
- `RENDERER=off` disables all of it (health reports `disabled`); tests that do
  not need it set this to run faster.
- Startup must not block the HTTP listener: listen first, then launch (the
  page is served by ourselves).

## 12. MCP

Endpoint `POST /mcp` (Streamable HTTP, stateless: `sessionIdGenerator: undefined`,
`enableJsonResponse: true`; `GET`/`DELETE /mcp` → 405). Per request: authenticate
Bearer PAT → build an `McpServer` (`name: "exidraw"`, version from package.json)
with the tools below bound to that user → `transport.handleRequest(c.req.raw)`.
Tool definitions and input schemas: `shared/src/mcp.ts` (`Tools`); structured
outputs: `ToolOutputs`. Every tool returns `structuredContent` **and** a text
block; `render_image` png returns an `image` content block + a text line
`"PNG 1600x900 (scale 2), 42 elements"`.

Permission errors → tool result `isError: true` with text
`"forbidden: need editor on room <id> (you have viewer)"`; unknown/invisible
room → `"not_found: room <id>"`. Never throw JSON-RPC errors for domain
failures (LLMs recover better from tool errors).

### 12.1 Compact text format (for `read_scene`, `add_elements`, …)

Header line, then one element per line, in scene order:

```
room "Bridge plan" (r/abc123) role=editor sceneVersion=4123 elements=57 bounds=(−40,−20 1800x900) active=[Alice, Bob's agent (agent)]
rectangle n1 @(100,100) 200x80 "API Gateway" bg=#a5d8ff
ellipse  n2 @(500,100) 160x80 "Auth" 
arrow    a1 @(300,140) 200x0 n1→n2 "JWT"
text     t1 @(100,300) 180x25 "notes:" fontSize=20
frame    f1 @(80,80) 640x160 name="Edge" children=[n1,n2,a1]
```

Rule: `<type> <id> @(x,y) <w>x<h> [angle=<deg>] ["label"|"text"] [from→to] [stroke=#…] [bg=#…] [frame=<id>] [groups=[…]] [link=…] [locked] [deleted]`,
numbers rounded to integers, defaults omitted (`stroke=#1e1e1e`, `bg=transparent`, fontSize 20).

### 12.2 Tool semantics

- `list_folder`, `search`, `get_room`, `create_folder`, `create_room`,
  `whoami`: straightforward over the same services as REST. Content search
  reads persisted scene JSON for unloaded rooms (`searchElements`), without
  populating the room cache, and uses in-memory state for loaded rooms.
- `read_scene`: compact elements (§ 12.1 shapes in `CompactElement`), bound
  text folded into its container's `label` and not listed separately;
  `region` = bbox intersection; `limit/offset` paginate; `format: "full"` =
  raw elements. Compact arrow/line `points` are **absolute scene coordinates**;
  full Excalidraw `points` are relative to the element’s `x,y`.
- `add_elements` (via renderer page `convertSkeletons`):
  1. Server validates skeleton ids are unique and do not exist in the room
     (`conflict` error listing offenders); maps `angle` degrees → radians,
     `roundness: "round"` → `{type: 3}` (`"sharp"` → `null`); arrows with
     bound `start`/`end` without explicit endpoint coordinates are projected
     onto the referenced rectangle/ellipse/diamond outline on the center ray,
     then moved 5 px outward (Excalidraw 0.18.1 binding gap). With one unbound
     end, use the line between that endpoint and the bound shape’s center.
     Rotated shapes are handled in local coordinates. The arrow’s `x,y` is
     its start point and `points[0] = [0,0]`; bindings include `elementId`,
     `focus:0`, `gap:5` (and `fixedPoint` for elbow arrows). The package
     converter establishes both shapes’ `boundElements`; geometry projection
     normalizes its output because conversion alone leaves center endpoints.
  2. `context` = the existing elements referenced by `start.id`, `end.id`,
     `frameId`, `children`.
  3. Page returns converted new elements + `contextPatches` (`boundElements`
     of existing elements that gained a binding).
  4. Server stamps `version = 1`, fresh `versionNonce`, `updated = now`,
     `isDeleted = false` on new elements; for patched existing elements sets
     `boundElements` to the union and bumps version/nonce/updated; then
     `applyElements(origin: "server")` + agent presence (§ 8.8).
- `update_elements`: server copies current elements, applies `set` fields
  (degrees → radians; `roundness` mapping; `label` on a container/arrow → if a
  bound text exists set its `text` and `originalText`, else create one via
  `convertSkeletons` on a skeleton copy `{...container, label}` and merge like
  add; empty label → tombstone the bound text and drop it from
  `boundElements`); then `restoreTouched(all, touchedIds)` in the page to
  re-measure text (skip the page call when only geometry/style fields
  changed); then bump version/nonce/updated on touched elements and apply.
- `move_elements`: Node only. `x += dx; y += dy` on each element and its bound
  text; bump; apply. Both move and geometry updates reproject connected bound
  arrows with the same center-ray/5 px rule, preserve interior points, normalize
  `x,y/points`, and translate their labels with the arrow midpoint. These tools
  can therefore recenter a manually off-center binding; free endpoints remain
  in scene coordinates unless the arrow itself is moved. Moving only a bound
  arrow translates free endpoints and bends while bound endpoints remain
  attached (and can slide toward the translated free endpoint); a straight
  arrow bound at both ends stays in place unless its shapes move. WebSocket edits
  continue to pass through the client’s geometry unchanged.
- `delete_elements`: Node only. Tombstone (`isDeleted: true`) the elements and
  their bound text; for every other element: remove deleted ids from
  `boundElements`; null `startBinding`/`endBinding` whose `elementId` was
  deleted; clear `frameId` referencing a deleted frame; bump all touched;
  apply.
- `render_image`: load files for image elements from disk; call page; PNG →
  image content; SVG → text content.
- `mermaid_to_elements`: page `mermaid()` → elements (+ files, stored via
  FileStore with `created_by` = user) → stamp + apply like `add_elements`.
- All mutating tools: check `editor`, take an `agent` snapshot (rate-limited),
  persist synchronously, return the new `sceneVersion`.

### 12.3 Versions stamped by the server

The page never bumps versions. The server's stamping rule for anything it
creates or edits: `version = (current?.version ?? 0) + 1`,
`versionNonce = randomInt(0, 2^31)`, `updated = Date.now()`. This guarantees
the change wins reconcile on every client that holds the previous version.
Versions cannot exceed `2^31−1`: a server edit/restore at exhaustion returns
`conflict` before modifying the scene. Scene sums are validated as safe integers
before writes (and the 40,000-element cap keeps valid sums below that limit).
SQLite migration 3 clamps legacy scene/snapshot counters to the safe range and
adds write triggers; `Store.run` rejects unsafe integer and nonfinite numeric
parameters, including out-of-range bigint values.

## 13. Configuration (environment)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | single port |
| `HOST` | `0.0.0.0` | |
| `DATA_DIR` | `/data` | db + files; created if missing |
| `PUBLIC_URL` | **required** | browser-facing origin, e.g. `https://draw.corp.example` or `http://localhost:5173` in dev; used for redirect_uri, cookie `Secure`, WS origin check, room URLs |
| `ALLOWED_ORIGINS` | empty | extra comma-separated origins for the WS/CSRF origin check |
| `AUTH_MODE` | `entra` | `entra` \| `dev` |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | — | required in entra mode; refuse to start otherwise |
| `ENTRA_ISSUER` | derived | override for sovereign clouds |
| `ADMIN_EMAILS` | empty | comma-separated case-insensitive email/UPN administrators |
| `ADMIN_OIDS` | empty | comma-separated Entra object GUID administrators, independent of email changes |
| `ENTRA_ALLOW_GUESTS` | `false` | `true` permits guest accounts; otherwise require optional ID-token `acct=0` (configure this claim in app registration) |
| `DEV_USERS` | built-in list | JSON array, dev mode only |
| `SESSION_TTL_DAYS` | `30` | |
| `MAX_FILE_BYTES` | `4194304` | |
| `RENDERER` | `on` | `off` disables Chromium |
| `WEB_DIST_DIR` | `<server>/../web/dist` | container: `/app/web/dist` |
| `LOG_LEVEL` | `info` | pino |
| `LOG_PRETTY` | `0` | `1` for dev |

Config is parsed once at startup with zod into a frozen object; invalid config
exits with a readable message.

## 14. Container image (root `Containerfile`, built with buildah)

```
FROM docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright WEB_DIST_DIR=/app/web/dist
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/shared/package.json ./shared/
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/renderer-dist ./server/renderer-dist
COPY --from=build /app/web/dist ./web/dist
RUN apt-get update && apt-get install -y --no-install-recommends tini \
 && node node_modules/playwright/cli.js install --with-deps chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home app && mkdir -p /data && chown -R app:app /data /ms-playwright
USER 10001
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/main.js"]
```

Health: `GET /healthz` plus an image `HEALTHCHECK`. Non-root (uid 10001).
`/data` holds persistent data. Both base images pin the same multi-platform
index digest (tag `node:24-bookworm-slim`, resolved with `skopeo inspect`). Tini
forwards signals to Node and reaps orphaned Chromium descendants as PID 1.

CI (`.github/workflows/build.yml`): shared build, typecheck and tests; then
official Docker build/publish actions, pinned by commit, publish main/tag images
to `ghcr.io/${{ github.repository }}`. The workflow copies `.containerignore`
to `.dockerignore` for matching contexts; test PNG output is excluded.

## 15. Testing strategy (what the implementers must test)

Bias: few, sharp tests of **our** logic. No tests of Excalidraw, Hono or
Playwright themselves.

Backend (vitest, `server/test/`):
- Unit: `computeEffectiveRole` + visibility over the examples in § 6.4;
  `remoteWins`/`applyElements` (accept/reject/ties, tombstones, rejected
  echo-back); PAT generation/hash/lookup/revoke/expiry; `CompactElement`
  derivation (bound text folding, arrow from/to); `delete_elements` binding
  cleanup; snapshot restore version stamping; config parsing failures.
- Integration (real server on a random port, `DATA_DIR` in a tmp dir,
  `AUTH_MODE=dev`, `RENDERER=off`): auth + CSRF (cookie mutation without
  header → 403; Bearer works on /api; cookie ignored on /mcp); permission
  enforcement per path (REST 404/403, WS close codes, MCP `isError`); two `ws`
  clients converge after concurrent `scene_update`s; reconnect syncAll
  restores offline edits; file upload/download round trip; MCP end-to-end with
  `@modelcontextprotocol/sdk` client (`whoami`, `create_room`, `move_elements`,
  `delete_elements`, `read_scene`).
- Renderer (`RENDERER=on`, actual Chromium required): skeleton conversion,
  labels, image export and Mermaid tests; the bound-arrow reproduction checks
  rectangle/ellipse/diamond outline gaps, bindings, move/resize behavior and
  absolute compact points, then writes the review PNG to
  `server/test/__output__/bound-arrows.png`. Unit regressions cover rotated
  negative points and finite elbow fixed points on zero-size targets.

Frontend (vitest for the collab client, Playwright e2e in `web/e2e/`):
- Unit (no DOM needed): `broadcastedVersions` filtering, echo suppression after
  remote apply, reconnect backoff classification by close code, presence map
  construction.
- E2E against the real server in dev mode (two browser contexts, Alice admin +
  Bob with a grant): login picker; create folder/room; Alice draws, Bob sees it;
  Bob's cursor visible to Alice; Carol (viewer) is in view mode and cannot edit;
  share dialog grants + live `role` switch; token create/revoke page. Keep to
  one spec per flow; run locally, not in CI.

## 16. Work split

### Backend implementer (GPT-6.1-Sol) owns

`server/**`, `Containerfile`, `.github/workflows/**`, root `package-lock.json`
(first `npm install`), server tests. Deliver, in this order:

1. `config.ts`, `db.ts` (migrations), `log.ts`, `main.ts` (listen, SIGTERM).
2. Auth: dev mode, sessions, CSRF middleware, PAT middleware; Entra flow
   (untestable here — implement per § 4.2 and unit-test claim mapping).
3. Tree/permissions service; REST routes (§ 7) incl. static SPA serving.
4. `RoomManager` + WS (§ 8), FileStore (§ 9), snapshots (§ 10).
5. Renderer page + supervisor (§ 11); MCP (§ 12); `/healthz`.
6. Containerfile + workflow; `npm run build` must produce a runnable image.

Must-get-right list: every check goes through `REQUIRED_ROLE`; `applyElements`
is synchronous; persist on shutdown; 404-not-403 for invisible nodes; cookies
ignored on `/mcp`; CSRF header enforced; Origin check on WS; `--no-sandbox`
Chromium args; serve `web/dist` with SPA fallback and the two asset prefixes
with immutable caching.

### Frontend implementer (Claude Opus) owns

`web/**` (SPA, Vite config, e2e tests), plus `web/scripts/copy-excalidraw-assets.mjs`
(copies `dist/prod/fonts` → `web/public/excalidraw-assets/fonts`, run in
`prebuild`/`predev`). Deliver:

1. App shell, router (`SPA_ROUTES`), `GET /api/me` bootstrap, login page
   (providers endpoint), API client that always sends `CSRF_HEADER` and
   handles `ApiError`.
2. Folder browser (`/`, `/f/:id`): breadcrumbs, create folder/room, rename,
   move (simple picker), delete, open room; share/grants dialog
   (`GrantsResponse`/`PutGrantsBody`, user search); "copy link".
3. Room page (`/r/:id`): `<Excalidraw>` with `viewModeEnabled` from role,
   `isCollaborating`, `aiEnabled={false}`, `UIOptions.canvasActions` without
   `loadScene`, `libraryReturnUrl` unset and the "browse libraries" link hidden
   (CSS) so nothing points at excalidraw.com; collab client per § 8.9; file
   upload/download per § 9; presence avatars; connection status + reconnect;
   export menu (PNG/SVG via REST or built-in export; both work offline);
   room rename in the header.
4. Tokens page (`/tokens`): list/create (show once)/revoke.
5. Vite: `define: { "process.env.IS_PREACT": "false" }`, set
   `window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH` in `index.html`
   before the module script, import `@excalidraw/excalidraw/index.css`;
   dev proxy `/api`, `/auth`, `/mcp`, `/healthz` → `http://localhost:8080`
   and `/ws` with `ws: true`.
6. A minimal mock server (`web/mock/server.ts`, `tsx`, Hono + `ws`, in-memory,
   implements `welcome/scene_init/scene_update/presence/pointer` and the
   few REST routes the UI needs with a fixed dev user) **only** for working
   before the real backend lands; e2e tests target the real server.
7. Stretch: snapshot history drawer (list + restore), "follow user".

Must-get-right list: `captureUpdate: CaptureUpdateAction.NEVER` for every
remote apply; record received versions before `updateScene`; never send
`scene_update` as a viewer; syncAll after every `scene_init`; no network
calls except to same-origin paths (verify in DevTools; the Excalidraw
"library" and "AI" features are the usual leaks).

### Interface between them

Everything in `shared/src/*`, plus:
- Server serves `WEB_DIST_DIR` statically with `index.html` fallback; the SPA
  is built with Vite `base: "/"`.
- Dev workflow: backend on `:8080` with `PUBLIC_URL=http://localhost:5173
  AUTH_MODE=dev ADMIN_EMAILS=alice@example.test`; frontend `vite` on `:5173`
  proxying to it. `npm run dev:server` / `npm run dev:web` at the root.
- Neither side edits `shared/` without updating this document; if a contract
  gap is found, add to `shared/` additively (new optional field / new message
  type), never change existing semantics silently.

## 17. Decisions log (short)

- Server-authoritative + Excalidraw's own LWW reconcile, no CRDT: with a
  handful of concurrent editors this is tolerable and identical to upstream
  behaviour.
- One scene blob per room, not per-element rows: simplest crash-safe write;
  revisit if rooms exceed ~5 MB.
- No periodic full resync; syncAll on connect instead.
- Snapshots: yes (gzip blobs, 100 per room, 5-minute cadence).
- Renderer in headless Chromium; Node stays browser-free for collaboration.
- `node:sqlite` over better-sqlite3 (no native build).
- Stateless MCP transport; PAT per request.
- Soft-delete rooms, hard-delete only empty folders.
- No anonymous share links: "share by link" = the room URL + grants
  (`all` viewer/editor or specific e-mails). Everyone authenticates via Entra.

## Backend implementation notes

- The backend task overrides §14: the Containerfile includes a HEALTHCHECK;
  CI uses the official Docker actions to build PR images and publish main/tag
  images to `ghcr.io/${{ github.repository }}`. Use Buildah's `--format docker`
  when retaining HEALTHCHECK metadata (OCI does not define that field).
- OIDC flow cookies use authenticated encryption with a process-local key and
  one-use state tracking. Restarting the process invalidates pending logins;
  users can start sign-in again. Discovery/JWKS/token fetches are restricted to
  the configured issuer's HTTPS origin, including redirect rejection.
- Cookie mutations also reject a supplied Origin outside PUBLIC_URL and
  ALLOWED_ORIGINS. Requests without Origin still require the shared CSRF header.
- MCP browser conversions run on cloned scenes. If a touched or referenced
  element changes during the browser round-trip, the tool returns `conflict`
  and must be retried; unrelated edits proceed concurrently. No stale converted
  data overwrites a concurrent edit. Geometry-only tools remain synchronous and
  work without Chromium, including translating/repositioning bound labels.
- Renderer context includes referenced elements' binding dependencies, so
  frames around existing labelled shapes and arrows can convert correctly.
  Font edits on labelled containers update their bound text too.
- The server test script builds its renderer before Vitest. Renderer tests run
  with actual Chromium; CI installs the headless shell before running tests.
- Deleting an empty folder reparents its already soft-deleted rooms to root so
  their retained scenes/files/snapshots remain valid under SQLite foreign keys.
- Mermaid conversions generate fresh IDs, including binding references, on
  every call. Missing binaries for pending/failed uploads are omitted from
  exports, allowing Excalidraw to show placeholders.
- Logout immediately closes that session's WebSockets; frames and ping ticks
  also revalidate sessions. Shutdown ignores frames from closing sockets and
  performs a final synchronous flush before closing SQLite.
- Configure Entra with the tenant GUID. If using a tenant domain instead,
  ENTRA_ISSUER must match the actual GUID issuer returned by discovery.
- Fix round: shared envelope validation enforces signed 32-bit nonce, positive
  31-bit version, finite timestamps and 64-character indices. Additive exports:
  `ELEMENT_VERSION_MAX`, `ELEMENT_INDEX_MAX_LENGTH`,
  `MAX_STORED_ELEMENTS_PER_ROOM`; `computeSceneVersion` rejects unsafe sums.
  Additive `WsErrorCode` members: `unauthenticated`, `not_found`,
  `message_too_large`. Each incoming WS message still has an 8 MiB/20,000-element
  cap; reconnect syncAll must be chunked by clients when larger.
- Editor bursts coalesce within 100 ms without rate-based data loss; traffic
  budgets also cover viewers. Buffered writes recheck current session and write
  access, and are discarded on access/session revocation or room deletion.
  Identical reconnect identities are silent.
- Deletion receipt metadata is private SQLite scene metadata. Retention and the
  40,000-element total cap ignore client clocks. Dirty-room flush errors are
  isolated so other rooms and resources still close.
- `ADMIN_OIDS` provides stable Entra admin identity, UPN takes precedence over
  `email`, and guest denial requires the optional `acct` ID-token claim. Missing
  `acct` denies sign-in unless `ENTRA_ALLOW_GUESTS=true`; see §4.2 and §13.
- Bound MCP arrows use outline intersection plus 5 px, normalized relative
  points, package-established bindings and boundElements. Moving/resizing their
  shapes refreshes arrows and labels without Chromium. Compact points are
  absolute; full-scene points are relative. The regression PNG is generated at
  `server/test/__output__/bound-arrows.png` (ignored by Git and image builds).
- Container stages are digest-pinned and start through tini. File data and
  directory entries are fsynced before metadata is committed. MCP content
  search shares REST’s non-loading path. Logout without a session returns 204.
