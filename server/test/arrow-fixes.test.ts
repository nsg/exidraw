import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, vi } from "vitest";
import type { SceneElement } from "@exidraw/shared";
import { createBackend } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { projectBindings, refreshBoundArrows } from "../src/bindings.js";
import { compact } from "../src/compact.js";

const element = (
  id: string,
  fields: Record<string, unknown> = {},
): SceneElement =>
  ({
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    version: 1,
    versionNonce: 1,
    updated: Date.now(),
    index: null,
    isDeleted: false,
    boundElements: null,
    ...fields,
  }) as SceneElement;

function setup(renderer: "on" | "off") {
  const backend = createBackend(
    parseConfig({
      AUTH_MODE: "dev",
      PUBLIC_URL: "http://localhost:5173",
      DATA_DIR: ":memory:",
      RENDERER: renderer,
      ADMIN_EMAILS: "alice@example.test",
      LOG_LEVEL: "silent",
      HOST: "127.0.0.1",
      PORT: "0",
    }),
  );
  const { sessionId } = backend.auth.login(
    { subject: "alice", email: "alice@example.test", name: "Alice" },
    "dev",
  );
  const token = backend.auth.createToken(
    backend.auth.require(
      new Headers({ cookie: `exidraw_session=${sessionId}` }),
    ),
    "arrow regression",
  );
  const auth = backend.auth.require(
    new Headers({ authorization: `Bearer ${token.token}` }),
  );
  const room = backend.tree.createRoom(auth.subject, "root", "Arrow outlines");
  return { backend, auth, room };
}

function assertEndpoints(elements: SceneElement[]) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const e of elements) {
    if (e.type !== "arrow" || e.isDeleted) continue;
    expect(e.points[0]).toEqual([0, 0]);
    for (const [binding, point] of [
      [e.startBinding, e.points[0]],
      [e.endBinding, e.points.at(-1)],
    ] as const) {
      if (!binding) continue;
      const target = byId.get(binding.elementId)!;
      const dx = e.x + point![0] - target.x - target.width / 2;
      const dy = e.y + point![1] - target.y - target.height / 2;
      const a = Math.abs(dx) / (target.width / 2),
        b = Math.abs(dy) / (target.height / 2);
      const radius =
        target.type === "ellipse"
          ? Math.hypot(a, b)
          : target.type === "diamond"
            ? a + b
            : Math.max(a, b);
      expect(radius).toBeGreaterThan(1);
      const distance = Math.hypot(dx, dy) * (1 - 1 / radius);
      expect(distance).toBeGreaterThanOrEqual(1);
      expect(distance).toBeLessThanOrEqual(12);
      expect(distance).toBeCloseTo(5, 5);
      expect(target.boundElements).toContainEqual({ id: e.id, type: "arrow" });
      expect(binding.focus).toBe(0);
      expect(binding.gap).toBe(5);
    }
  }
}

test("MCP projects bound arrows outside rectangle, ellipse and diamond outlines and keeps them attached after edits", async () => {
  const { backend, auth, room } = setup("on");
  try {
    await backend.start();
    await expect
      .poll(() => backend.renderer.status, { timeout: 30000 })
      .toBe("ready");
    const call = async (
      name: Parameters<typeof backend.mcp.execute>[0],
      args: Record<string, unknown>,
    ) => {
      const result = await backend.mcp.execute(
        name,
        { roomId: room.id, ...args },
        auth,
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return result;
    };
    // Exercise new skeletons and references to already persisted shapes.
    await call("add_elements", {
      elements: [
        {
          id: "web",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 180,
          height: 80,
          label: { text: "Web" },
        },
        {
          id: "api",
          type: "rectangle",
          x: 300,
          y: 0,
          width: 180,
          height: 80,
          label: { text: "API" },
        },
        {
          id: "db",
          type: "ellipse",
          x: 600,
          y: -10,
          width: 160,
          height: 100,
          label: { text: "DB" },
        },
        {
          id: "bus",
          type: "diamond",
          x: 310,
          y: 180,
          width: 160,
          height: 110,
          label: { text: "Bus" },
        },
        {
          id: "rest",
          type: "arrow",
          start: { id: "web" },
          end: { id: "api" },
          label: { text: "REST" },
        },
      ],
    });
    await call("add_elements", {
      elements: [
        { id: "data", type: "arrow", start: { id: "api" }, end: { id: "db" } },
        {
          id: "events",
          type: "arrow",
          start: { id: "api" },
          end: { id: "bus" },
        },
        { id: "unbound", type: "arrow", x: 900, y: 40, end: { id: "db" } },
      ],
    });
    let elements = backend.rooms.elements(room.id);
    assertEndpoints(elements);
    const arrow = elements.find((e) => e.id === "events")!;
    expect(
      arrow.type === "arrow" && arrow.x + arrow.points.at(-1)![0],
    ).toBeCloseTo(390);
    expect(
      arrow.type === "arrow" && arrow.y + arrow.points.at(-1)![1],
    ).toBeCloseTo(175);
    const compact = await call("read_scene", {});
    expect(
      (compact.structuredContent as any).elements
        .find((e: any) => e.id === "events")
        .points.at(-1),
    ).toEqual([390, 175]);
    const image = await backend.renderer.call("exportPng", {
      elements: elements.filter((e) => e.id !== "unbound"),
      files: {},
      options: { scale: 2 },
    });
    const output = fileURLToPath(
      new URL("./__output__/bound-arrows.png", import.meta.url),
    );
    mkdirSync(fileURLToPath(new URL("./__output__/", import.meta.url)), {
      recursive: true,
    });
    const png = Buffer.from(image.base64, "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    writeFileSync(output, png);
    await call("move_elements", { ids: ["api"], dx: 15, dy: 10 });
    assertEndpoints(backend.rooms.elements(room.id));
    await call("update_elements", {
      updates: [{ id: "bus", set: { x: 350, width: 200 } }],
    });
    elements = backend.rooms.elements(room.id);
    assertEndpoints(elements);
  } finally {
    await backend.close();
  }
}, 60000);

test("MCP content search reads unloaded scenes without loading rooms", async () => {
  const { backend, auth } = setup("off");
  try {
    const search = vi
      .spyOn(backend.rooms, "searchElements")
      .mockReturnValue([]);
    const load = vi.spyOn(backend.rooms, "elements").mockImplementation(() => {
      throw new Error("search loaded a room");
    });
    const result = await backend.mcp.execute(
      "search",
      { query: "missing text", inContent: true },
      auth,
    );
    expect(result.isError).not.toBe(true);
    expect(search).toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  } finally {
    await backend.close();
  }
});

test("moving a shape preserves the free endpoint of a rotated arrow with negative points", () => {
  const shape = element("shape", { x: 300, y: 100, width: 80, height: 80 });
  const arrow = element("edge", {
    type: "arrow",
    x: 200,
    y: 100,
    width: 100,
    height: 60,
    angle: Math.PI / 2,
    points: [
      [0, 0],
      [-40, 20],
      [-100, 60],
    ],
    startBinding: { elementId: "shape", focus: 0, gap: 5 },
    endBinding: null,
  });
  // Rotate around the actual bounds center (150,130), not (250,130).
  expect(compact([arrow])[0]!.points).toEqual([
    [180, 180],
    [160, 140],
    [120, 80],
  ]);
  const moved = { ...shape, y: 150 };
  const changes = refreshBoundArrows([moved, arrow], new Set([shape.id]));
  const next = changes.find((e) => e.id === arrow.id)!;
  expect(next.type).toBe("arrow");
  if (next.type !== "arrow") throw new Error("Expected arrow");
  expect(next.points[0]).toEqual([0, 0]);
  expect(next.x + next.points[1]![0]).toBeCloseTo(160);
  expect(next.y + next.points[1]![1]).toBeCloseTo(140);
  expect(next.x + next.points.at(-1)![0]).toBeCloseTo(120);
  expect(next.y + next.points.at(-1)![1]).toBeCloseTo(80);
  expect(compact([next])[0]!.points!.at(-1)).toEqual([120, 80]);
  // Numerical noise during repeated projections must not create extra edits.
  expect(
    refreshBoundArrows(
      [moved, { ...next, x: next.x + 1e-8 }],
      new Set([shape.id]),
    ),
  ).toEqual([]);
});

test("elbow binding fixed points use rotated target coordinates and stay finite for zero dimensions", () => {
  for (const [width, height] of [
    [100, 40],
    [0, 40],
    [100, 0],
    [0, 0],
  ]) {
    const target = element("target", { width, height, angle: Math.PI / 2 });
    const arrow = element("edge", {
      type: "arrow",
      elbowed: true,
      x: 200,
      y: height! / 2,
      points: [
        [0, 0],
        [100, 0],
      ],
      startBinding: { elementId: target.id },
      endBinding: null,
    });
    if (arrow.type !== "arrow") throw new Error("Expected arrow");
    const next = projectBindings(arrow, new Map([[target.id, target]]));
    const fixed = (next.startBinding as any).fixedPoint as number[];
    expect(fixed.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)).toBe(
      true,
    );
    if (width === 100 && height === 40) {
      expect(fixed[0]).toBeCloseTo(0.5);
      expect(fixed[1]).toBe(0);
    }
    if (width === 0) expect(fixed[0]).toBe(0.5);
    if (height === 0) expect(fixed[1]).toBe(0.5);
  }
});

test("moving a bound arrow keeps attachments while its free ends and bends translate", async () => {
  const { backend, auth, room } = setup("off");
  try {
    const left = element("left"),
      right = element("right", { x: 300 });
    const seed = element("both", {
      type: "arrow",
      x: 105,
      y: 50,
      width: 190,
      height: 50,
      points: [
        [0, 0],
        [95, 50],
        [190, 0],
      ],
      startBinding: { elementId: left.id, focus: 0, gap: 5 },
      endBinding: { elementId: right.id, focus: 0, gap: 5 },
    });
    const free = { ...seed, id: "free", endBinding: null } as SceneElement;
    backend.rooms.applyElements(room.id, [left, right, seed, free], "server");
    const result = await backend.mcp.execute(
      "move_elements",
      { roomId: room.id, ids: ["both", "free"], dx: 20, dy: 30 },
      auth,
    );
    expect(result.isError).not.toBe(true);
    const output = compact(backend.rooms.elements(room.id));
    expect(output.find((e) => e.id === "both")!.points).toEqual([
      [105, 50],
      [220, 130],
      [295, 50],
    ]);
    const oneBound = output.find((e) => e.id === "free")!;
    expect(oneBound.points!.slice(1)).toEqual([
      [220, 130],
      [315, 80],
    ]);
    expect(oneBound.from).toBe("left");
    // The attachment can slide along the outline toward its translated free end.
    expect(oneBound.points![0]![0]).toBeGreaterThanOrEqual(105);
    expect(oneBound.points![0]![0]).toBeLessThan(106);
    expect(oneBound.points![0]![1]).toBeGreaterThan(50);
    expect(oneBound.points![0]![1]).toBeLessThan(100);
  } finally {
    await backend.close();
  }
});
