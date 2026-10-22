import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  MAX_ELEMENTS_PER_ROOM,
  MAX_HTTP_JSON_BYTES,
  computeSceneVersion,
  type ImportRoomBody,
  type RoomInfo,
  type SceneElement,
  type SceneResponse,
  type ServerMessage,
  type TreeResponse,
} from "@exidraw/shared";
import { createBackend } from "../src/app.js";
import { parseConfig } from "../src/config.js";

const origin = "http://localhost:5173";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4XcAAAAASUVORK5CYII=",
  "base64",
);
function element(id: string, extra: Record<string, unknown> = {}): SceneElement {
  return {
    id,
    type: "rectangle",
    version: 1,
    versionNonce: 100,
    updated: 1_700_000_000_000,
    isDeleted: false,
    index: "a0",
    x: 10,
    y: 20,
    width: 100,
    height: 60,
    angle: 0,
    boundElements: null,
    frameId: null,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    groupIds: [],
    locked: false,
    ...extra,
  } as SceneElement;
}
function image(id: string, fileId = id, extra: Record<string, unknown> = {}) {
  return element(id, { type: "image", fileId, status: "pending", ...extra });
}
function file(bytes = png, mimeType = "image/png") {
  return { mimeType, dataURL: `data:${mimeType};base64,${bytes.toString("base64")}` };
}
function body(extra: Partial<ImportRoomBody> = {}): ImportRoomBody {
  return { folderId: "root", name: "Imported drawing", elements: [], files: {}, ...extra };
}

describe("POST /api/rooms/import", () => {
  let directory: string;
  let backend: ReturnType<typeof createBackend>;
  let base: string;
  let alice: string;
  let sockets: WebSocket[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "exidraw-import-"));
    backend = createBackend(parseConfig({
      AUTH_MODE: "dev",
      ADMIN_EMAILS: "alice@example.test",
      DATA_DIR: directory,
      PUBLIC_URL: origin,
      PORT: "0",
      HOST: "127.0.0.1",
      RENDERER: "off",
      WEB_DIST_DIR: directory,
      LOG_LEVEL: "silent",
      MAX_FILE_BYTES: "128",
    }));
    base = `http://127.0.0.1:${(await backend.start()).port}`;
    sockets = [];
    alice = await login("alice");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const socket of sockets) socket.terminate();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  });

  function request(path: string, cookie = alice, method = "GET", value?: unknown, csrf = true) {
    const headers = new Headers({ Cookie: cookie });
    if (csrf) headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
    if (value !== undefined) headers.set("Content-Type", "application/json");
    return fetch(base + path, {
      method,
      headers,
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
    });
  }
  async function json<T>(path: string, cookie = alice, method = "GET", value?: unknown, status = 200): Promise<T> {
    const response = await request(path, cookie, method, value);
    expect(response.status, await response.clone().text()).toBe(status);
    return response.json() as Promise<T>;
  }
  async function login(userId: string) {
    const response = await request("/auth/dev/login", "", "POST", { userId });
    expect(response.status).toBe(204);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  }
  function imported(value: ImportRoomBody) {
    return json<RoomInfo>("/api/rooms/import", alice, "POST", value, 201);
  }
  function persistedCounts() {
    return ["rooms", "scenes", "files", "snapshots"].map((table) =>
      backend.store.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)!.count,
    );
  }
  async function rejected(value: unknown, status = 400, cookie = alice) {
    const before = await json<TreeResponse>("/api/tree");
    const counts = persistedCounts();
    const put = vi.spyOn(backend.files, "put");
    const response = await request("/api/rooms/import", cookie, "POST", value);
    expect(response.status, await response.clone().text()).toBe(status);
    expect(put).not.toHaveBeenCalled();
    expect(persistedCounts()).toEqual(counts);
    expect(await json<TreeResponse>("/api/tree")).toEqual(before);
    expect(backend.rooms.rooms.size).toBe(0);
    put.mockRestore();
    return response.json();
  }

  test("persists the scene and normalized image bytes without loading the room or taking a snapshot", async () => {
    const folder = await json<{ id: string }>("/api/folders", alice, "POST", { parentId: "root", name: "Imports" }, 201);
    const elements = [
      element("shape", { index: "a0", version: 4 }),
      element("caption", { type: "text", index: "a1", text: "An imported scene", version: 2 }),
      image("picture", "png_1", { index: "a2", version: 3 }),
    ];
    const drawing = await imported(body({
      folderId: folder.id,
      name: "Imported plan",
      elements,
      files: { png_1: { ...file(png, "IMAGE/PNG; charset=binary"), mimeType: "text/html" } },
    }));
    expect(drawing).toMatchObject({ folderId: folder.id, name: "Imported plan", role: "owner", url: `${origin}/r/${drawing.id}` });
    expect(drawing.createdAt).toEqual(expect.any(Number));
    expect(drawing.updatedAt).toEqual(expect.any(Number));
    expect(backend.rooms.rooms.has(drawing.id)).toBe(false);
    expect(persistedCounts()).toEqual([1, 1, 1, 0]);
    const row = backend.store.get<{ elements: string; scene_version: number }>("SELECT elements,scene_version FROM scenes WHERE room_id=?", drawing.id)!;
    const expected = elements.map((e) => e.type === "image" ? { ...e, status: "saved" } : e);
    expect(JSON.parse(row.elements)).toEqual(expected);
    expect(row.scene_version).toBe(computeSceneVersion(elements));
    const scene = await json<SceneResponse>(`/api/rooms/${drawing.id}/scene`);
    expect(scene).toEqual({ elements: expected, sceneVersion: computeSceneVersion(elements) });
    const download = await request(`/api/rooms/${drawing.id}/files/png_1`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(png);
    expect((await json<TreeResponse>(`/api/tree?folderId=${folder.id}`)).rooms).toEqual([{ ...drawing, access: [] }]);
  });

  test("drops deleted elements, ignores their malformed binaries and unreferenced files, and preserves missing-file statuses", async () => {
    const pending = image("pending", "missing"), failed = image("failed", "absent", { status: "error", index: "a1" });
    const drawing = await imported(body({
      elements: [pending, failed, image("removed", "removed_file", { isDeleted: true })],
      files: {
        removed_file: { mimeType: "not/an-image", dataURL: "broken" },
        "../unreferenced": { mimeType: "not/an-image", dataURL: "also broken" },
        malformed_unreferenced: 42,
      },
    }));
    expect(await json<SceneResponse>(`/api/rooms/${drawing.id}/scene`)).toEqual({ elements: [pending, failed], sceneVersion: 2 });
    expect(persistedCounts()).toEqual([1, 1, 0, 0]);
    expect((await request(`/api/rooms/${drawing.id}/files/removed_file`)).status).toBe(404);
  });

  test("reports the first invalid envelope, including deleted elements, before writing anything", async () => {
    const result = await rejected(body({ elements: [element("valid"), element("bad", { version: 0, isDeleted: true }), null] }));
    expect(result.error.message).toMatch(/index 1\b/);
  });

  test("rejects duplicate ids even when one occurrence is deleted", async () => {
    const result = await rejected(body({ elements: [element("duplicate"), element("duplicate", { isDeleted: true })] }));
    expect(JSON.stringify(result.error)).toContain("duplicate");
  });

  test.each([
    ["missing folderId", { name: "Missing destination", elements: [], files: {} }],
    ["too many elements", body({ elements: Array.from({ length: MAX_ELEMENTS_PER_ROOM + 1 }, (_, index) => element(`element_${index}`)) })],
  ])("rejects %s through the request schema without writing anything", async (_name, value) => {
    const result = await rejected(value);
    expect(result.error.code).toBe("invalid");
  });

  test.each([
    ["unsupported mime", "image_1", { mimeType: "text/plain", dataURL: "data:text/plain;base64,YQ==" }],
    ["invalid fileId", "../image", file()],
    ["non-data URL", "image_1", { mimeType: "image/png", dataURL: "https://example.test/image.png" }],
    ["invalid base64 character", "image_1", { mimeType: "image/png", dataURL: "data:image/png;base64,YQ?=" }],
    ["invalid base64 padding", "image_1", { mimeType: "image/png", dataURL: "data:image/png;base64,YQ=" }],
    ["missing dataURL", "image_1", { mimeType: "image/png" }],
    ["non-object entry", "image_1", "data:image/png;base64,YQ=="],
  ])("rejects %s before creating a room or writing any files", async (_name, fileId, value) => {
    await rejected(body({ elements: [image("picture", fileId)], files: { [fileId]: value } }));
  });

  test("validates every referenced binary before storing the first one", async () => {
    await rejected(body({
      elements: [image("first"), image("second")],
      files: { first: file(), second: { mimeType: "image/png", dataURL: "data:image/png;base64,!!!!" } },
    }));
  });

  test("enforces the decoded file byte limit with 413", async () => {
    await rejected(body({ elements: [image("large")], files: { large: file(Buffer.alloc(backend.config.maxFileBytes + 1)) } }), 413);
  });

  test("rejects oversized JSON requests before creating a room", async () => {
    const before = await json<TreeResponse>("/api/tree");
    const response = await request("/api/rooms/import", alice, "POST", body({
      files: { unused: { mimeType: "image/png", dataURL: "x".repeat(MAX_HTTP_JSON_BYTES) } },
    }));
    expect(response.status).toBe(413);
    expect(persistedCounts()).toEqual([0, 0, 0, 0]);
    expect(await json<TreeResponse>("/api/tree")).toEqual(before);
  });

  test("checks folder write permission before inspecting element envelopes or binaries", async () => {
    const bob = await login("bob");
    const folder = await json<{ id: string }>("/api/folders", alice, "POST", { parentId: "root", name: "Read only" }, 201);
    await json(`/api/nodes/folder/${folder.id}/grants`, alice, "PUT", { grants: [{ kind: "user", email: "bob@example.test", role: "viewer" }] });
    await rejected(body({ folderId: folder.id, elements: [null], files: { image: { mimeType: "invalid", dataURL: "broken" } } }), 403, bob);
    await rejected(body({ elements: [null] }), 401, "");
  });

  test("requires cookie CSRF and permits Bearer import without a CSRF header", async () => {
    const denied = await request("/api/rooms/import", alice, "POST", body(), false);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("csrf");
    expect(persistedCounts()).toEqual([0, 0, 0, 0]);
    const token = await json<{ token: string }>("/api/tokens", alice, "POST", { name: "importer" }, 201);
    const response = await fetch(base + "/api/rooms/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body({ elements: [element("from-token")] })),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const drawing = await response.json() as RoomInfo;
    expect((await json<SceneResponse>(`/api/rooms/${drawing.id}/scene`)).elements.map((e) => e.id)).toEqual(["from-token"]);
  });

  test("rolls back the room, scene and earlier file rows when a later file write fails", async () => {
    const before = await json<TreeResponse>("/api/tree");
    const original = backend.files.put.bind(backend.files);
    const put = vi.spyOn(backend.files, "put")
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => { throw new Error("simulated disk failure"); });
    const response = await request("/api/rooms/import", alice, "POST", body({
      elements: [image("first"), image("second")],
      files: { first: file(), second: file() },
    }));
    expect(response.status).toBe(500);
    expect(put).toHaveBeenCalledTimes(2);
    expect(persistedCounts()).toEqual([0, 0, 0, 0]);
    expect(await json<TreeResponse>("/api/tree")).toEqual(before);
    expect(backend.rooms.rooms.size).toBe(0);
  });

  test("sends the persisted imported scene to a WebSocket peer on connection", async () => {
    const elements = [element("shape", { version: 5 }), image("picture", "image_file", { index: "a1" })];
    const drawing = await imported(body({ elements, files: { image_file: file() } }));
    const socket = new WebSocket(base.replace("http:", "ws:") + `/ws?room=${drawing.id}`, { origin, headers: { Cookie: alice } });
    sockets.push(socket);
    const scene = await new Promise<Extract<ServerMessage, { type: "scene_init" }>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for imported scene")), 3000);
      socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as ServerMessage;
        if (message.type === "scene_init") {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    expect(scene.elements).toEqual([elements[0], { ...elements[1], status: "saved" }]);
    expect(scene.sceneVersion).toBe(computeSceneVersion(elements));
  });
});
