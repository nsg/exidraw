import { Hono } from "hono";
import { VERSION } from "./version.js";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import {
  DevLoginBody,
  CreateFolderBody,
  UpdateFolderBody,
  CreateRoomBody,
  ImportRoomBody,
  UpdateRoomBody,
  PutGrantsBody,
  CreateTokenBody,
  CreateSnapshotBody,
  ExportQuery,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  SESSION_COOKIE,
  MAX_HTTP_JSON_BYTES,
  INTERNAL_RENDERER_PATH,
} from "@exidraw/shared";
import type { NodeKind, RenderOptions } from "@exidraw/shared";
import { parseConfig, type Config } from "./config.js";
import { Store } from "./db.js";
import { createLogger } from "./log.js";
import {
  AuthService,
  cookieValue,
  userInfo,
  type AuthContext,
} from "./auth.js";
import { OidcFlow } from "./oidc.js";
import { Tree } from "./tree.js";
import { RoomManager } from "./rooms.js";
import { FileStore } from "./files.js";
import { Collaboration } from "./ws.js";
import { Renderer, rendererDist } from "./renderer.js";
import { McpTools } from "./mcp.js";
import { HttpError } from "./errors.js";
import { importRoom } from "./import.js";
type Env = {
  Variables: {
    auth: AuthContext;
  };
};
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};
function staticFile(
  root: string,
  path: string,
): {
  bytes: Buffer;
  type: string;
} | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const file = resolve(
      root,
      `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`,
    ),
    base = resolve(root);
  if (file !== base && !file.startsWith(base + sep)) return null;
  try {
    if (!statSync(file).isFile()) return null;
    return {
      bytes: readFileSync(file),
      type: mime[extname(file)] ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}
export function createBackend(config: Config = parseConfig()) {
  const log = createLogger(config),
    store = new Store(config.dataDir),
    auth = new AuthService(store, config),
    tree = new Tree(store, config),
    rooms = new RoomManager(store, (error) =>
      log.error({ err: error }, "Scene persistence failed"),
    ),
    files = new FileStore(store, config),
    renderer = new Renderer(config, log),
    mcp = new McpTools(tree, rooms, files, renderer),
    oidc = new OidcFlow(config, auth);
  const app = new Hono<Env>();
  let server: Server | undefined, collaboration: Collaboration | undefined;
  let closing: Promise<void> | undefined;
  const started = Date.now();
  app.onError((error, c) => {
    let e: HttpError;
    if (error instanceof HttpError) e = error;
    else if (error instanceof ZodError)
      e = new HttpError("invalid", "Invalid request", error.issues);
    else if (error instanceof SyntaxError)
      e = new HttpError("invalid", "Invalid JSON");
    else if (
      (error as any).code?.startsWith("ERR_SQLITE_CONSTRAINT") ||
      (error as any).errcode === 2067
    )
      e = new HttpError("conflict", "Conflicting node or grant");
    else {
      e = new HttpError("internal", "Internal server error");
      log.error({ err: error }, "Request failed");
    }
    if (c.req.path === "/mcp" && e.status === 401)
      c.header("WWW-Authenticate", 'Bearer realm="exidraw"');
    return c.json(
      {
        error: {
          code: e.code,
          message: e.message,
          ...(e.details !== undefined ? { details: e.details } : {}),
        },
      },
      e.status as any,
    );
  });
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
    await next();
  });
  // Files have their own byte limit. All other requests have a bounded body,
  // including chunked transfer encodings and MCP input.
  app.use("*", async (c, next) => {
    const limit =
      c.req.method === "PUT" && /^\/api\/rooms\/[^/]+\/files\//.test(c.req.path)
        ? config.maxFileBytes
        : MAX_HTTP_JSON_BYTES;
    return bodyLimit({
      maxSize: limit,
      onError: () => {
        throw new HttpError("too_large", "Request body exceeds limit");
      },
    })(c, next);
  });
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      renderer: renderer.status,
      uptimeSec: Math.floor((Date.now() - started) / 1000),
      version: VERSION,
    }),
  );
  app.get("/api/auth/providers", (c) =>
    c.json(
      config.authMode === "dev"
        ? { mode: "dev", loginUrl: "/auth/dev/login", users: config.devUsers }
        : { mode: "entra", loginUrl: "/auth/login" },
    ),
  );
  app.use("/api/*", async (c, next) => {
    const context = auth.require(c.req.raw.headers);
    c.set("auth", context);
    if (!["GET", "HEAD"].includes(c.req.method) && context.via === "session") {
      if (c.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE)
        throw new HttpError("csrf", "Missing CSRF header");
      checkOrigin(c.req.header("origin"));
    }
    if (context.via === "session") {
      const sid = cookieValue(c.req.raw.headers, SESSION_COOKIE);
      if (sid) c.header("Set-Cookie", auth.sessionCookie(sid));
    }
    c.header("Cache-Control", "no-store");
    await next();
  });
  function checkOrigin(origin?: string) {
    if (
      origin !== undefined &&
      ![new URL(config.publicUrl).origin, ...config.allowedOrigins].includes(
        origin,
      )
    )
      throw new HttpError("csrf", "Origin is not allowed");
  }
  app.post("/auth/dev/login", async (c) => {
    if (config.authMode !== "dev")
      throw new HttpError("not_found", "Not found");
    if (c.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE)
      throw new HttpError("csrf", "Missing CSRF header");
    checkOrigin(c.req.header("origin"));
    const body = DevLoginBody.parse(await c.req.json());
    const user = config.devUsers.find((u) => u.id === body.userId);
    if (!user) throw new HttpError("invalid", "Unknown dev user");
    const result = auth.login(
      { subject: user.id, email: user.email, name: user.name },
      "dev",
    );
    c.header("Set-Cookie", auth.sessionCookie(result.sessionId));
    return c.body(null, 204);
  });
  app.post("/auth/logout", (c) => {
    const context = auth.authenticate(c.req.raw.headers);
    if (context?.via === "session") {
      if (c.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE)
        throw new HttpError("csrf", "Missing CSRF header");
      checkOrigin(c.req.header("origin"));
      auth.logout(c.req.raw.headers);
      collaboration?.revokeSession(
        cookieValue(c.req.raw.headers, SESSION_COOKIE),
      );
    }
    c.header("Set-Cookie", auth.sessionCookie(null));
    return c.body(null, 204);
  });
  app.get("/auth/login", async (c) => {
    if (config.authMode !== "entra") return c.redirect("/login");
    try {
      const result = await oidc.login(c.req.query("returnTo"));
      c.header("Set-Cookie", result.cookie);
      return c.redirect(result.location);
    } catch {
      return c.redirect("/login?error=oidc");
    }
  });
  app.get("/auth/callback", async (c) => {
    if (config.authMode !== "entra") return c.redirect("/login?error=oidc");
    const result = await oidc.callback(
      new URL(c.req.path + new URL(c.req.url).search, config.publicUrl),
      c.req.raw.headers,
    );
    for (const cookie of result.cookies)
      c.header("Set-Cookie", cookie, { append: true });
    if (result.forbidden)
      return c.html("<!doctype html><html><head><title>Access denied</title></head><body><h1>Access denied</h1><p>This application requires a verified tenant member account. Contact your administrator.</p></body></html>", 403);
    return c.redirect(result.location);
  });
  app.get("/api/me", (c) => {
    const a = c.get("auth");
    return c.json({
      user: a.user,
      isAdmin: a.subject.isAdmin,
      authMode: config.authMode,
      via: a.via,
    });
  });
  app.get("/api/users", (c) => {
    const q = (c.req.query("q") ?? "").toLowerCase();
    return c.json({
      users: store
        .all<any>("SELECT * FROM users ORDER BY name,email")
        .filter((u) => u.name.toLowerCase().includes(q) || u.email.includes(q))
        .slice(0, 50)
        .map(userInfo),
    });
  });
  app.get("/api/tree", (c) =>
    c.json(tree.list(c.get("auth").subject, c.req.query("folderId") ?? "root")),
  );
  app.get("/api/search", (c) =>
    c.json(
      tree.search(
        c.get("auth").subject,
        c.req.query("q") ?? "",
        c.req.query("inContent") === "1",
        (r) => rooms.searchElements(r),
      ),
    ),
  );
  app.post("/api/folders", async (c) => {
    const b = CreateFolderBody.parse(await c.req.json());
    return c.json(
      tree.createFolder(c.get("auth").subject, b.parentId, b.name),
      201,
    );
  });
  app.patch("/api/folders/:id", async (c) => {
    const b = UpdateFolderBody.parse(await c.req.json()),
      result = tree.update(
        c.get("auth").subject,
        "folder",
        c.req.param("id"),
        b,
      );
    collaboration?.refreshRoles();
    return c.json(result);
  });
  app.delete("/api/folders/:id", (c) => {
    tree.delete(c.get("auth").subject, "folder", c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/api/rooms", async (c) => {
    const b = CreateRoomBody.parse(await c.req.json());
    return c.json(
      tree.createRoom(c.get("auth").subject, b.folderId, b.name),
      201,
    );
  });
  app.post("/api/rooms/import", async (c) => {
    const body = ImportRoomBody.parse(await c.req.json());
    const room = importRoom(tree, files, c.get("auth").subject, body, (error) =>
      log.error({ err: error }, "Removing a failed import failed"),
    );
    return c.json(room, 201);
  });
  app.get("/api/rooms/:id", (c) =>
    c.json(tree.room(c.get("auth").subject, c.req.param("id"))),
  );
  app.patch("/api/rooms/:id", async (c) => {
    const b = UpdateRoomBody.parse(await c.req.json()),
      result = tree.update(c.get("auth").subject, "room", c.req.param("id"), b);
    collaboration?.roomUpdated(c.req.param("id"));
    return c.json(result);
  });
  app.delete("/api/rooms/:id", (c) => {
    const roomId = c.req.param("id");
    tree.delete(c.get("auth").subject, "room", roomId);
    rooms.closeRoom(roomId, 4410);
    return c.body(null, 204);
  });
  app.get("/api/rooms/:id/scene", (c) => {
    const roomId = c.req.param("id");
    tree.require(c.get("auth").subject, "room", roomId, "readScene");
    return c.json(rooms.scene(roomId));
  });
  app.get("/api/rooms/:id/export.json", (c) => {
    const roomId = c.req.param("id");
    tree.require(c.get("auth").subject, "room", roomId, "readScene");
    const elements = rooms.elements(roomId).filter((e) => !e.isDeleted);
    c.header(
      "Content-Disposition",
      'attachment; filename="drawing.excalidraw"',
    );
    return c.json({
      type: "excalidraw",
      version: 2,
      source: config.publicUrl,
      elements,
      appState: { viewBackgroundColor: "#ffffff" },
      files: files.sceneFiles(roomId, elements),
    });
  });
  for (const format of ["png", "svg"] as const)
    app.get(`/api/rooms/:id/export.${format}`, async (c) => {
      const roomId = c.req.param("id");
      tree.require(c.get("auth").subject, "room", roomId, "render");
      const q = ExportQuery.parse(c.req.query());
      let region: RenderOptions["region"];
      if (q.region) {
        const [x, y, width, height] = q.region.split(",").map(Number);
        region = { x: x!, y: y!, width: width!, height: height! };
      }
      const elements = rooms.elements(roomId),
        options: RenderOptions = {
          ...q,
          background:
            c.req.query("background") === undefined
              ? true
              : !["0", "false"].includes(c.req.query("background")!),
          region,
          elementIds: q.elements?.split(","),
        },
        request = {
          elements,
          files: files.sceneFiles(roomId, elements),
          options,
        };
      if (format === "png") {
        const result = await renderer.call("exportPng", request);
        tree.require(c.get("auth").subject, "room", roomId, "render");
        c.header("Content-Type", "image/png");
        return c.body(new Uint8Array(Buffer.from(result.base64, "base64")));
      }
      const result = await renderer.call("exportSvg", request);
      tree.require(c.get("auth").subject, "room", roomId, "render");
      c.header("Content-Type", "image/svg+xml");
      c.header("Content-Security-Policy", "sandbox");
      return c.body(result.svg);
    });
  app.get("/api/rooms/:id/files/:fileId", (c) => {
    const roomId = c.req.param("id");
    tree.require(c.get("auth").subject, "room", roomId, "readFile");
    const result = files.get(roomId, c.req.param("fileId"));
    c.header("Content-Type", result.info.mimeType);
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    if (result.info.mimeType === "image/svg+xml")
      c.header("Content-Security-Policy", "sandbox");
    return c.body(new Uint8Array(result.bytes));
  });
  app.put("/api/rooms/:id/files/:fileId", async (c) => {
    const a = c.get("auth"),
      roomId = c.req.param("id");
    tree.require(a.subject, "room", roomId, "writeFile");
    files.validate(c.req.param("fileId"));
    const bytes = Buffer.from(await c.req.arrayBuffer());
    tree.require(a.subject, "room", roomId, "writeFile");
    const result = files.put(
      roomId,
      c.req.param("fileId"),
      (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase(),
      bytes,
      a.user.id,
    );
    return c.json(result.info, result.created ? 201 : 200);
  });
  const kind = (value: string): NodeKind => {
    if (value !== "folder" && value !== "room")
      throw new HttpError("invalid", "Invalid node kind");
    return value;
  };
  app.get("/api/nodes/:kind/:id/grants", (c) =>
    c.json(
      tree.readGrants(
        c.get("auth").subject,
        kind(c.req.param("kind")),
        c.req.param("id"),
      ),
    ),
  );
  app.put("/api/nodes/:kind/:id/grants", async (c) => {
    const b = PutGrantsBody.parse(await c.req.json()),
      result = tree.putGrants(
        c.get("auth").subject,
        kind(c.req.param("kind")),
        c.req.param("id"),
        b.grants,
      );
    collaboration?.refreshRoles();
    return c.json(result);
  });
  app.get("/api/tokens", (c) =>
    c.json({ tokens: auth.tokens(c.get("auth").user.id) }),
  );
  app.post("/api/tokens", async (c) => {
    const b = CreateTokenBody.parse(await c.req.json());
    return c.json(
      auth.createToken(c.get("auth"), b.name, b.expiresInDays),
      201,
    );
  });
  app.delete("/api/tokens/:id", (c) => {
    auth.revokeToken(c.get("auth").user.id, c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/api/rooms/:id/snapshots", (c) => {
    const roomId = c.req.param("id");
    tree.require(c.get("auth").subject, "room", roomId, "listSnapshots");
    return c.json({ snapshots: rooms.snapshots(roomId) });
  });
  app.post("/api/rooms/:id/snapshots", async (c) => {
    const roomId = c.req.param("id");
    tree.require(c.get("auth").subject, "room", roomId, "createSnapshot");
    const text = await c.req.text();
    CreateSnapshotBody.parse(text ? JSON.parse(text) : {});
    tree.require(c.get("auth").subject, "room", roomId, "createSnapshot");
    return c.json(rooms.snapshot(roomId, "manual", c.get("auth").user.id), 201);
  });
  app.get("/api/rooms/:id/snapshots/:sid", (c) => {
    const roomId = c.req.param("id");
    tree.require(c.get("auth").subject, "room", roomId, "listSnapshots");
    return c.json(rooms.getSnapshot(roomId, c.req.param("sid")));
  });
  app.post("/api/rooms/:id/snapshots/:sid/restore", (c) => {
    const roomId = c.req.param("id");
    tree.require(c.get("auth").subject, "room", roomId, "restoreSnapshot");
    return c.json(
      rooms.restore(roomId, c.req.param("sid"), c.get("auth").user.id),
    );
  });
  app.all("/mcp", async (c) => {
    const a = auth.require(c.req.raw.headers, true);
    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return c.body(null, 405);
    }
    return mcp.handle(c.req.raw, a);
  });
  app.get(`${INTERNAL_RENDERER_PATH}*`, (c) => {
    const path = c.req.path.slice(INTERNAL_RENDERER_PATH.length);
    const file = staticFile(rendererDist, path ? `/${path}` : "/index.html");
    if (!file) throw new HttpError("not_found", "Renderer asset");
    c.header("Content-Type", file.type);
    return c.body(new Uint8Array(file.bytes));
  });
  app.all("*", (c) => {
    if (/^\/(api|auth|ws|mcp|_internal|healthz)(?:\/|$)/.test(c.req.path))
      throw new HttpError("not_found", "Not found");
    if (c.req.method !== "GET" && c.req.method !== "HEAD")
      throw new HttpError("not_found", "Not found");
    const asset =
      c.req.path.startsWith("/assets/") ||
      c.req.path.startsWith("/excalidraw-assets/");
    const file =
      staticFile(
        config.webDistDir,
        c.req.path === "/" ? "/index.html" : c.req.path,
      ) ?? (!asset ? staticFile(config.webDistDir, "/index.html") : null);
    if (!file) throw new HttpError("not_found", "SPA asset not found");
    c.header("Content-Type", file.type);
    c.header(
      "Cache-Control",
      asset ? "public, max-age=31536000, immutable" : "no-cache",
    );
    return c.body(new Uint8Array(file.bytes));
  });
  return {
    app,
    config,
    log,
    store,
    auth,
    tree,
    rooms,
    files,
    renderer,
    mcp,
    get collaboration() {
      return collaboration;
    },
    async start() {
      if (server) throw new Error("Server already started");
      if (config.authMode === "dev")
        log.warn(
          "AUTH_MODE=dev: development login is enabled; do not expose this mode to untrusted users",
        );
      server = serve({
        fetch: app.fetch,
        hostname: config.host,
        port: config.port,
      }) as Server;
      collaboration = new Collaboration(server, config, auth, tree, rooms);
      await new Promise<void>((resolve, reject) => {
        server!.once("listening", resolve);
        server!.once("error", reject);
      });
      const port = (server.address() as any).port as number;
      log.info({ port }, "exidraw listening");
      void renderer
        .start(port)
        .catch((error) => log.error({ err: error }, "Renderer startup failed"));
      return { port };
    },
    close() {
      return (closing ??= (async () => {
        const httpClosed = server
          ? new Promise<void>((resolve) => server!.close(() => resolve()))
          : Promise.resolve(); // stop accepting before flushing
        const force = setTimeout(() => {
          collaboration?.terminate();
          server?.closeAllConnections();
        }, 1000);
        force.unref();
        try {
          try {
            collaboration?.flushPending();
            rooms.close();
          } catch (error) {
            log.error({ err: error }, "Room shutdown failed");
          } finally {
            try {
              collaboration?.close();
            } finally {
              await Promise.all([httpClosed, renderer.close()]);
            }
          }
        } finally {
          clearTimeout(force);
          collaboration?.terminate();
          try {
            rooms.flush();
          } finally {
            store.close();
          }
        }
        log.info("exidraw stopped; all scenes flushed");
      })());
    },
  };
}
