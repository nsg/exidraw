<div align="center">
  <h1>exidraw</h1>
  <p>Self-hosted, multiplayer Excalidraw with Entra ID login, folders, permissions and an MCP endpoint for agents.</p>

[![AI usage: vibe](https://nsg.github.io/aibadge/vibe.svg)](https://nsg.github.io/aibadge/#vibe)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

## About

exidraw is a collaborative whiteboard for self-hosting inside an
organisation. A few people draw together, live, and share the results
read-only or editable with others who log in. It wraps
the official [Excalidraw](https://github.com/excalidraw/excalidraw) editor
component (`@excalidraw/excalidraw`, used unmodified as a library) in its own
app and server. The excalidraw.com app and its Docker image are not used: they
depend on Firebase and excalidraw.com services and have no login.

Everything runs in one container with its state on one volume. Nothing calls
out to third-party services except the Entra ID login. AI agents connect over
MCP with a personal access token and work as ordinary collaborators: their
edits show up live, and they can render a drawing to look at it.

## Features

- **Live collaboration.** Several users edit one drawing with live cursors and
  names. Viewers follow live in read-only mode. The server holds the
  authoritative copy and merges edits with Excalidraw's own version rule.
- **Folders and rooms.** A room is one drawing. Folders organise rooms and
  carry permissions that apply to everything inside them.
- **Sharing.** Give a role to *all logged-in users* or to specific people by
  email, even before they first log in. A share link is the room URL; whoever
  opens it still has to log in and hold a grant.
- **Entra ID login.** OpenID Connect with PKCE, restricted to your tenant.
  Guest accounts are rejected by default.
- **Version history.** Automatic snapshots (at most one every 5 minutes, and
  before agent edits), the newest 100 kept per room, restorable from the UI.
- **Images.** Images pasted into drawings are stored on the volume and synced
  to collaborators.
- **Upload and insert.** Upload `.excalidraw` files (or PNG/SVG exports with
  an embedded scene) as new drawings, by button or drag and drop. Insert a
  file or another drawing into the open one as a grouped, undoable copy.
- **Agents over MCP.** 13 tools to browse, search, create, read, draw, edit and
  render drawings, plus Mermaid-to-diagram conversion. Agents authenticate with
  personal access tokens and act with their owner's permissions.
- **Rendering.** A bundled headless Chromium renders PNG and SVG for agents
  and exports.
- **Fully self-hosted.** Fonts and assets are served by the app itself. No
  excalidraw.com, Firebase, CDN or library-site calls.

---

## Quick start (development)

Requires Node.js 24.

```bash
npm ci
npm run build:shared
npm run build:renderer -w server
npx playwright install chromium                  # for the renderer and the e2e tests
```

Run the server in dev-login mode and the web app with hot reload, in two
terminals:

```bash
AUTH_MODE=dev ADMIN_EMAILS=alice@example.test \
PUBLIC_URL=http://localhost:5173 DATA_DIR=/tmp/exidraw-dev PORT=8080 \
npm run dev:server
```

```bash
npm run dev:web
```

Open <http://localhost:5173> and pick a dev user. Alice is an admin; Bob,
Carol and Dave are ordinary users who see nothing until they are granted
access.

> **Never enable `AUTH_MODE=dev` on a deployed instance.** It lets anyone log
> in as anyone.

### Tests

```bash
npm run typecheck
npm test                                          # unit and integration tests (server uses real Chromium)
npm run build && npm run e2e                      # Playwright: two browsers against the real server
```

### Container image

```bash
buildah build --format docker -t exidraw:dev .    # or: docker build -f Containerfile -t exidraw:dev .
```

The image is about 1.2 GB because it includes Chromium. It runs as uid 10001,
listens on port 8080, keeps its state in `/data`, and uses `tini` as PID 1.
CI builds it on every pull request and pushes it to
`ghcr.io/<owner>/<repo>` on pushes to `main` (`latest`, `sha-<commit>`) and
on `v*` tags.

---

## Configuration

All configuration is through environment variables. The server validates
them at startup and exits with a readable message if something is missing.

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | **required** | Browser-facing origin, e.g. `https://draw.example.com`. Used for the login redirect, cookie `Secure` flag, origin checks and room links. Must match the ingress host exactly. |
| `AUTH_MODE` | `entra` | `entra`, or `dev` for local development only. |
| `ENTRA_TENANT_ID` | — | Directory (tenant) ID. Required in `entra` mode. |
| `ENTRA_CLIENT_ID` | — | Application (client) ID. Required in `entra` mode. |
| `ENTRA_CLIENT_SECRET` | — | Client secret. Required in `entra` mode. Provide it from a Secret. |
| `ENTRA_ISSUER` | derived from tenant | Override for sovereign clouds. |
| `ENTRA_ALLOW_GUESTS` | `false` | `true` admits guest accounts. Otherwise the ID token must carry the optional `acct` claim with value `0` (member). |
| `ADMIN_EMAILS` | empty | Comma-separated emails/UPNs of administrators (owner on everything). |
| `ADMIN_OIDS` | empty | Comma-separated Entra object IDs of administrators. Preferred over emails, which can change. |
| `ALLOWED_ORIGINS` | empty | Extra origins accepted by the WebSocket and CSRF origin checks. |
| `PORT` | `8080` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `DATA_DIR` | `/data` | SQLite database and image files. |
| `SESSION_TTL_DAYS` | `30` | Sliding session lifetime. |
| `MAX_FILE_BYTES` | `4194304` | Maximum size of one uploaded image. |
| `RENDERER` | `on` | `off` disables Chromium; rendering and Mermaid tools then fail, collaboration keeps working. |
| `LOG_LEVEL` | `info` | pino log level. Logs are JSON on stdout. |
| `DEV_USERS` | built-in list | JSON array of dev users (`AUTH_MODE=dev` only). |

---

## Permissions

There are three roles. Every request (web app, WebSocket, MCP) is checked on
the server against the same rules.

| Role | Can |
|---|---|
| **viewer** | Open rooms and follow them live (read-only), browse folders, download images, export and render, view version history. |
| **editor** | Everything a viewer can, plus draw and edit, upload images, rename, restore versions, create folders and rooms inside a folder. |
| **owner** | Everything an editor can, plus share (manage grants), move and delete. |

**Admins** (`ADMIN_EMAILS` / `ADMIN_OIDS`) are owners of everything.

A **grant** gives one role on one folder or room to either *all logged-in
users* or *one person by email*. Grants combine like this:

1. A grant on a folder applies to every sub-folder and room below it.
2. Grants only add access. Your role is the highest role granted to you on the
   room or on any folder above it. There is no deny, so a sub-folder cannot be
   stricter than its parent; keep private material in a folder that is not
   shared broadly.
3. Without any grant you have no access. Inaccessible rooms answer "Not
   found". Folders above something you can see appear in listings so you can
   navigate, but you cannot open or create anything in them.
4. Only admins can create at the top level unless someone holds editor on the
   root.
5. Role changes apply immediately, also to people who have the room open: the
   editor switches between read-only and editable without a reload.

Example:

```text
Projects/              ← all logged-in users = viewer
├── Website/
│   ├── Sitemap        ← dave@example.com = editor   (Dave edits only this room)
│   └── Wireframes
└── Drafts/            ← no grant: only admins see it
```

---

## Agents (MCP)

The MCP endpoint is `<PUBLIC_URL>/mcp` (Streamable HTTP). Create a personal
access token on the **Tokens** page; it is shown once and acts with your
permissions until you revoke it. The page shows the commands below with your
URL filled in.

```bash
claude mcp add --transport http exidraw https://draw.example.com/mcp \
  --header "Authorization: Bearer exi_..."
```

```json
{
  "mcpServers": {
    "exidraw": {
      "type": "http",
      "url": "https://draw.example.com/mcp",
      "headers": { "Authorization": "Bearer exi_..." }
    }
  }
}
```

| Tool | Purpose |
|---|---|
| `whoami` | The user the token acts as. |
| `list_folder`, `search` | Browse folders and rooms; search names and drawing text. |
| `create_folder`, `create_room` | Create folders and rooms. |
| `get_room` | Room metadata, your role, element count and who has it open. |
| `read_scene` | Compact description of the drawing: ids, types, positions, labels, arrow bindings. |
| `add_elements` | Add shapes with labels, text, frames, and arrows bound to shapes. |
| `update_elements`, `move_elements`, `delete_elements` | Change, move and delete elements. |
| `render_image` | Render the room or a region as PNG or SVG, so the agent can see it. |
| `mermaid_to_elements` | Convert a Mermaid diagram to editable elements. |

Agent edits appear live for everyone in the room, with a cursor labelled
"<name>'s agent", and are saved even when nobody has the room open. A
snapshot is taken before agent edits, so they can be undone from the version
history (they do not enter users' own undo stacks).

---

## Deployment

The image is built for `linux/amd64`. Deploy it as **one replica**: the live
rooms and the SQLite database belong to one process.

### 1. Register the app in Entra ID

1. Create an app registration (single tenant).
2. Add a **Web** platform redirect URI: `https://<host>/auth/callback`.
3. Create a client secret.
4. Under **Token configuration**, add the optional ID-token claim **`acct`**.
   Without it every login is refused, unless `ENTRA_ALLOW_GUESTS=true`.
5. Set `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`,
   `PUBLIC_URL` and `ADMIN_OIDS` (or `ADMIN_EMAILS`).

### 2. Kubernetes checklist

| Topic | Setting | Why |
|---|---|---|
| Replicas | `replicas: 1`, `strategy: Recreate` | A rolling update would briefly run two processes on the same database and volume. |
| Volume | `ReadWriteOnce` PVC mounted at `/data`, on block storage (e.g. Azure Disk) | SQLite in WAL mode is not safe on network file systems (Azure Files/SMB, NFS). |
| Security context | `runAsUser: 10001`, `runAsGroup: 10001`, `fsGroup: 10001` | The process runs as uid 10001 and must be able to write to the volume. |
| Read-only root | If `readOnlyRootFilesystem: true`, mount an `emptyDir` at `/tmp` | Chromium writes its profile to `/tmp`. |
| Probes | Liveness and readiness: `GET /healthz` on port 8080 | Returns 200 while HTTP is up, also while the renderer starts. |
| Resources | Request about 512 Mi memory, limit about 1.5 Gi | Node plus an idle Chromium measured around 0.5–0.8 Gi; rendering adds spikes. |
| Shutdown | Default grace period (30 s) is enough | On SIGTERM all rooms are written to disk and the process exits within a few seconds. |
| Secrets | `ENTRA_CLIENT_SECRET` from a Secret | |
| Image pull | Pull secret for GHCR, or make the package internal | New GHCR packages are private. Keep the image out of public registries; see [License](#license). |

### 3. Ingress

- TLS terminates at the ingress. The host must equal `PUBLIC_URL`, which must
  be `https` so the session cookie is `Secure`.
- Allow WebSocket upgrades on `/ws`, and keep idle connections open well past
  the 30-second ping interval.
- Allow request bodies of at least 16 MB: drawing uploads carry their images
  and may use the full JSON body limit; single image uploads need 5 MB.

For ingress-nginx:

```yaml
nginx.ingress.kubernetes.io/proxy-body-size: "17m"
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

### 4. Data and backups

| Path | Content |
|---|---|
| `/data/exidraw.db` (+ `-wal`, `-shm`) | Users, sessions, tokens (hashed), folders, rooms, grants, drawings, snapshots. |
| `/data/files/<room>/<file>` | Images used in drawings. |

There is no built-in backup. Back up the whole volume, using CSI volume
snapshots or a scheduled copy. SQLite runs with `synchronous=FULL`, so a
crash-consistent volume snapshot is a valid backup. A plain file copy of a
running database is not; scale to zero first, or use SQLite's online backup.

Retention: deleted rooms are hidden, not erased; images are never deleted;
each room keeps its newest 100 snapshots. Plan the volume size accordingly.

### 5. Security model

- Every user must log in. There are no anonymous links.
- Sessions are HttpOnly, SameSite=Lax cookies. State-changing requests need a
  custom CSRF header and an allowed `Origin`. CORS is never enabled.
- Personal access tokens are stored as SHA-256 hashes, checked on every
  request and revocable immediately. Cookies are ignored on `/mcp`.
- Drawings are not end-to-end encrypted. The server reads them to enforce
  permissions, persist them and serve agents. Protect the volume and its
  backups like any other internal data.
- The headless browser only loads the app's own renderer page; all other
  network access from it is blocked.

---

## Architecture

```text
browser ──HTTPS/WSS──► ingress ──► exidraw container (one Node.js process)
                                   ├─ Hono HTTP API, static web app, /mcp
                                   ├─ WebSocket rooms (server-authoritative merge)
                                   ├─ SQLite (node:sqlite) + files on /data
                                   └─ headless Chromium (Playwright) for rendering
```

| Path | Content |
|---|---|
| `shared/` | The contract: REST types, WebSocket messages, roles, MCP tool schemas. |
| `server/` | HTTP/WebSocket/MCP server, persistence, auth, renderer page and supervisor. |
| `web/` | React app around `@excalidraw/excalidraw`, collaboration client, e2e tests. |
| `docs/ARCHITECTURE.md` | Full design: data model, protocol, permission algorithm, MCP semantics. |

## Known limitations

- Single replica only; no high availability.
- Permissions are per user or for all users; Entra groups are not supported yet.
- The view fits to the drawing when a room opens with content, but not when an
  agent draws into a room that was empty when you opened it.
- Agent edits are not part of users' undo history; use version history instead.
- Labels in small shapes can wrap mid-word; agents can see this in a render
  and resize.

## License

[MIT](LICENSE). Third-party components keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The web bundle and the image ship the license texts of everything they
contain (`npm run licenses` generates them and fails on non-permissive
production dependencies). The image includes Google's Chrome for Testing
headless shell, whose redistribution terms are not clearly stated; it is fine
for internal use, but check those terms (or switch to Debian's `chromium`
package) before publishing the image publicly.
