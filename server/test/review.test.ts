import { test, expect, vi } from "vitest";
import { MAX_ELEMENTS_PER_ROOM, type SceneElement } from "@exidraw/shared";
import { createBackend } from "../src/app.js";
import { parseConfig } from "../src/config.js";
function setup() {
  const backend = createBackend(
    parseConfig({
      AUTH_MODE: "dev",
      PUBLIC_URL: "http://localhost:5173",
      DATA_DIR: ":memory:",
      RENDERER: "off",
      ADMIN_EMAILS: "alice@example.test",
      LOG_LEVEL: "silent",
    }),
  );
  const { sessionId } = backend.auth.login(
    { subject: "alice", email: "alice@example.test", name: "Alice" },
    "dev",
  );
  const cookie = new Headers({ cookie: `exidraw_session=${sessionId}` });
  const token = backend.auth.createToken(
    backend.auth.require(cookie),
    "review agent",
  );
  const auth = backend.auth.require(
    new Headers({ authorization: `Bearer ${token.token}` }),
  );
  const room = backend.tree.createRoom(auth.subject, "root", "Review");
  return { backend, auth, room, token: token.token };
}
const element = (
  id: string,
  extra: Record<string, unknown> = {},
): SceneElement =>
  ({
    id,
    type: "rectangle",
    version: 1,
    versionNonce: 1,
    updated: Date.now(),
    isDeleted: false,
    index: null,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    boundElements: null,
    ...extra,
  }) as SceneElement;
test("MCP conversions tolerate unrelated concurrent changes but reject stale touched elements", async () => {
  const { backend, auth, room } = setup();
  try {
    const initial = element("existing");
    backend.rooms.applyElements(room.id, [initial], "server");
    let complete!: (value: unknown) => void;
    let started!: () => void;
    const called = new Promise<void>((resolve) => (started = resolve));
    vi.spyOn(backend.renderer, "call").mockImplementation((() => {
      started();
      return new Promise((resolve) => (complete = resolve));
    }) as any);
    const pending = backend.mcp.execute(
      "add_elements",
      {
        roomId: room.id,
        elements: [{ id: "new", type: "rectangle", x: 300, y: 0 }],
      },
      auth,
    );
    await called;
    backend.rooms.applyElements(
      room.id,
      [{ ...initial, x: 40, version: 2 }],
      "other-client",
    );
    complete({ elements: [element("new", { x: 300 })], contextPatches: [] });
    expect((await pending).isError).not.toBe(true);
    expect(
      backend.rooms.elements(room.id).find((e) => e.id === "existing")?.x,
    ).toBe(40);
    const text = element("caption", {
      type: "text",
      text: "Before",
      originalText: "Before",
      fontSize: 20,
      fontFamily: 5,
    });
    backend.rooms.applyElements(room.id, [text], "server");
    let finish!: (value: unknown) => void;
    let began!: () => void;
    const callStarted = new Promise<void>((resolve) => (began = resolve));
    vi.mocked(backend.renderer.call).mockImplementation((() => {
      began();
      return new Promise((resolve) => (finish = resolve));
    }) as any);
    const conflict = backend.mcp.execute(
      "update_elements",
      { roomId: room.id, updates: [{ id: "caption", set: { text: "Agent" } }] },
      auth,
    );
    await callStarted;
    backend.rooms.applyElements(
      room.id,
      [{ ...text, version: 2, text: "Person" } as SceneElement],
      "other-client",
    );
    finish([{ ...text, text: "Agent" }]);
    const result = await conflict;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "conflict" },
    });
    expect(
      (backend.rooms.elements(room.id).find((e) => e.id === "caption") as any)
        .text,
    ).toBe("Person");
  } finally {
    await backend.close();
  }
});
test("geometry-only property edits move and resize bound labels without requiring Chromium", async () => {
  const { backend, auth, room } = setup();
  try {
    backend.rooms.applyElements(
      room.id,
      [
        element("box", { boundElements: [{ id: "text", type: "text" }] }),
        element("text", {
          type: "text",
          x: 20,
          y: 30,
          width: 60,
          height: 20,
          text: "Label",
          containerId: "box",
          textAlign: "center",
          verticalAlign: "middle",
          fontSize: 20,
          fontFamily: 5,
        }),
      ],
      "server",
    );
    const result = await backend.mcp.execute(
      "update_elements",
      {
        roomId: room.id,
        updates: [
          {
            id: "box",
            set: { x: 100, y: 100, width: 200, height: 100, angle: 90 },
          },
        ],
      },
      auth,
    );
    expect(result.isError).not.toBe(true);
    expect(
      backend.rooms.elements(room.id).find((e) => e.id === "text"),
    ).toMatchObject({ x: 170, y: 140, angle: Math.PI / 2, version: 2 });
    expect(backend.renderer.status).toBe("disabled");
  } finally {
    await backend.close();
  }
});
test("snapshot restore accepts retained tombstones beyond the WebSocket per-frame count", async () => {
  const { backend, auth, room } = setup();
  try {
    const tombstones = Array.from({ length: MAX_ELEMENTS_PER_ROOM }, (_, i) =>
      element(`gone${i}`, { isDeleted: true }),
    );
    backend.rooms.applyElements(
      room.id,
      [...tombstones, element("live")],
      "server",
    );
    const target = backend.rooms.snapshot(room.id, "manual", auth.user.id);
    backend.rooms.applyElements(
      room.id,
      [element("live", { version: 4, x: 800 })],
      "server",
    );
    backend.rooms.restore(room.id, target.id, auth.user.id);
    expect(backend.rooms.elements(room.id)).toHaveLength(
      MAX_ELEMENTS_PER_ROOM + 1,
    );
    expect(
      backend.rooms.elements(room.id).find((e) => e.id === "live"),
    ).toMatchObject({ x: 0, version: 5, isDeleted: false });
  } finally {
    await backend.close();
  }
});
test("missing binaries from pending or failed uploads do not prevent exporting the rest of the scene", async () => {
  const { backend, auth, room, token } = setup();
  try {
    backend.rooms.applyElements(
      room.id,
      [
        element("pending", {
          type: "image",
          fileId: "not-uploaded",
          status: "error",
        }),
      ],
      "server",
    );
    expect(
      backend.files.sceneFiles(room.id, backend.rooms.elements(room.id)),
    ).toEqual({});
    const response = await backend.app.request(
      `/api/rooms/${room.id}/export.json`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).elements).toHaveLength(1);
  } finally {
    await backend.close();
  }
});
