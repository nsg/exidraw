import { describe, expect, test, vi } from "vitest";
import {
  MAX_ELEMENTS_PER_ROOM,
  SCENE_PERSIST_MAX_WAIT_MS,
  SCENE_PERSIST_DEBOUNCE_MS,
  TOMBSTONE_RETENTION_MS,
  MAX_FOLDER_DEPTH,
} from "@exidraw/shared";
import type { SceneElement } from "@exidraw/shared";
import { Store } from "../src/db.js";
import { parseConfig } from "../src/config.js";
import { AuthService } from "../src/auth.js";
import { Tree } from "../src/tree.js";
import { RoomManager } from "../src/rooms.js";
import { bounds, compact, elementBounds, select } from "../src/compact.js";
function setup() {
  const store = new Store(":memory:"),
    config = parseConfig({
      AUTH_MODE: "dev",
      PUBLIC_URL: "http://localhost:5173",
      ADMIN_EMAILS: "alice@example.test",
    }),
    auth = new AuthService(store, config),
    login = auth.login(
      { subject: "alice", email: "alice@example.test", name: "Alice" },
      "dev",
    ),
    subject = auth.require(
      new Headers({ cookie: `exidraw_session=${login.sessionId}` }),
    ).subject,
    tree = new Tree(store, config),
    room = tree.createRoom(subject, "root", "Test"),
    rooms = new RoomManager(store);
  return { store, tree, rooms, subject, room };
}
const element = (
  id: string,
  version = 1,
  versionNonce = 1,
  extra: Record<string, unknown> = {},
): SceneElement =>
  ({
    id,
    type: "rectangle",
    version,
    versionNonce,
    isDeleted: false,
    updated: Date.now(),
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    index: null,
    ...extra,
  }) as SceneElement;
describe("authoritative scenes", () => {
  test("reconciles versions/tie nonce, echoes server winners and rejects the entire overflowing batch", () => {
    const { store, rooms, room } = setup(),
      send = vi.fn();
    try {
      rooms.join(room.id, {
        connId: "client",
        presence: {
          connId: "client",
          userId: "u",
          name: "U",
          color: { background: "white", stroke: "black" },
          idle: "active",
          isAgent: false,
        },
        send,
        close: () => {},
      });
      rooms.applyElements(room.id, [element("x", 2, 10)], "server");
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "scene_update", origin: "server" }),
      );
      send.mockClear();
      expect(
        rooms.applyElements(room.id, [element("x", 1, 0)], "client").rejected[0]
          ?.version,
      ).toBe(2);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: "server",
          elements: [expect.objectContaining({ id: "x", version: 2 })],
        }),
      );
      expect(
        rooms.applyElements(room.id, [element("x", 2, 9)], "client").accepted,
      ).toHaveLength(1);
      expect(
        rooms.applyElements(room.id, [element("x", 2, 11)], "client").rejected,
      ).toHaveLength(1);
      const batch = Array.from({ length: MAX_ELEMENTS_PER_ROOM }, (_, i) =>
        element(`e${i}`),
      );
      expect(() => rooms.applyElements(room.id, batch, "server")).toThrow(
        "too_many_elements",
      );
      expect(rooms.elements(room.id)).toHaveLength(1);
      expect(() =>
        rooms.applyElements(
          room.id,
          [element("ok"), { id: "bad" } as any],
          "server",
        ),
      ).toThrow("envelope");
      expect(rooms.elements(room.id)).toHaveLength(1);
    } finally {
      rooms.close();
      store.close();
    }
  });
  test("persists after debounce and caps a continuous edit burst at maximum wait, retaining new deletions", () => {
    vi.useFakeTimers();
    const { store, rooms, room } = setup();
    try {
      rooms.applyElements(
        room.id,
        [
          element("gone", 1, 1, {
            isDeleted: true,
            updated: Date.now() - TOMBSTONE_RETENTION_MS - 1,
          }),
          element("keep"),
        ],
        "server",
      );
      vi.advanceTimersByTime(SCENE_PERSIST_DEBOUNCE_MS);
      expect(
        JSON.parse(
          store.get("SELECT elements FROM scenes WHERE room_id=?", room.id)
            .elements,
        ).map((e: any) => e.id),
      ).toEqual(["gone", "keep"]);
      for (let i = 1; i <= SCENE_PERSIST_MAX_WAIT_MS / 100; i++) {
        rooms.applyElements(room.id, [element("keep", i + 1)], "server");
        vi.advanceTimersByTime(100);
      }
      expect(
        store.get("SELECT scene_version FROM scenes WHERE room_id=?", room.id)
          .scene_version,
      ).toBe(52);
      expect(rooms.snapshots(room.id)).toHaveLength(1);
    } finally {
      rooms.close();
      store.close();
      vi.useRealTimers();
    }
  });
  test("restoring snapshots stamps winners and tombstones elements absent from the target", () => {
    const { store, rooms, room, subject } = setup();
    try {
      rooms.applyElements(room.id, [element("x", 8)], "server");
      const snapshot = rooms.snapshot(room.id, "manual", subject.userId);
      rooms.applyElements(
        room.id,
        [element("x", 50), element("other", 3)],
        "server",
      );
      const before = rooms.restore(room.id, snapshot.id, subject.userId);
      expect(before.reason).toBe("restore");
      const restored = rooms.scene(room.id);
      expect(restored.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "x", version: 51, isDeleted: false }),
          expect.objectContaining({ id: "other", version: 4, isDeleted: true }),
        ]),
      );
      expect(
        JSON.parse(
          store.get("SELECT elements FROM scenes WHERE room_id=?", room.id)
            .elements,
        ),
      ).toEqual(restored.elements);
    } finally {
      rooms.close();
      store.close();
    }
  });
});
test("compact descriptions fold bound labels, preserve arrow endpoints and omit defaults", () => {
  const all = [
    element("box", 1, 1, {
      backgroundColor: "transparent",
      strokeColor: "#1e1e1e",
      boundElements: [{ type: "text", id: "label" }],
    }),
    element("label", 1, 1, {
      type: "text",
      containerId: "box",
      text: "Hello",
      fontSize: 20,
      fontFamily: 5,
    }),
    element("edge", 1, 1, {
      type: "arrow",
      points: [
        [0, 0],
        [100, 80],
      ],
      startBinding: { elementId: "box" },
      endBinding: { elementId: "other" },
    }),
  ];
  const result = compact(all);
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ id: "box", label: "Hello" });
  expect(result[0]).not.toHaveProperty("bg");
  expect(result[0]).not.toHaveProperty("stroke");
  expect(result[1]).toMatchObject({
    from: "box",
    to: "other",
    points: [
      [0, 0],
      [100, 80],
    ],
  });
});
test("region selection and scene bounds follow negative linear and freehand points", () => {
  for (const type of ["arrow", "line", "freedraw"]) {
    const drawing = element(type, 1, 1, {
      type,
      x: 100,
      y: 100,
      width: 100,
      height: 50,
      points: [
        [0, 0],
        [-100, -50],
      ],
    });
    expect(elementBounds(drawing)).toEqual({
      x: 0,
      y: 50,
      width: 100,
      height: 50,
    });
    expect(select([drawing], { x: 5, y: 55, width: 10, height: 10 })).toEqual([
      drawing,
    ]);
    expect(
      select([drawing], { x: 180, y: 120, width: 10, height: 10 }),
    ).toEqual([]);
    expect(bounds([drawing])).toEqual(elementBounds(drawing));
    const rotated = { ...drawing, angle: Math.PI / 2 } as SceneElement;
    const rotatedBounds = elementBounds(rotated);
    // Excalidraw rotates linear/freehand points around their actual bounds,
    // whose center is (50,75) for this negative-direction drawing.
    expect(rotatedBounds.x).toBeCloseTo(25);
    expect(rotatedBounds.y).toBeCloseTo(25);
    expect(rotatedBounds.width).toBeCloseTo(50);
    expect(rotatedBounds.height).toBeCloseTo(100);
    expect(select([rotated], { x: 30, y: 30, width: 10, height: 10 })).toEqual([
      rotated,
    ]);
  }
});

test("rotated bounds and compact line points use the element center and optionally include tombstones", () => {
  const box = element("rotated", 1, 1, {
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    angle: Math.PI / 2,
  });
  const boxBounds = elementBounds(box);
  expect(boxBounds.x).toBeCloseTo(40);
  expect(boxBounds.y).toBeCloseTo(-10);
  expect(boxBounds.width).toBeCloseTo(40);
  expect(boxBounds.height).toBeCloseTo(100);
  expect(select([box], { x: 45, y: -5, width: 10, height: 10 })).toEqual([box]);
  const line = {
    ...box,
    id: "line",
    type: "line",
    points: [
      [0, 0],
      [100, 40],
    ],
  } as unknown as SceneElement;
  expect(compact([line])[0]!.points).toEqual([
    [80, -10],
    [40, 90],
  ]);
  expect(compact([{ ...line, angle: 0 } as SceneElement])[0]!.points).toEqual([
    [10, 20],
    [110, 60],
  ]);
  const deleted = { ...box, isDeleted: true };
  expect(bounds([deleted])).toBeNull();
  expect(bounds([deleted], true)).toEqual(boxBounds);
  const aggregate = bounds([
    box,
    element("origin", 1, 1, { width: 10, height: 10 }),
  ])!;
  expect(aggregate.x).toBe(0);
  expect(aggregate.y).toBeCloseTo(-10);
  expect(aggregate.width).toBeCloseTo(80);
  expect(aggregate.height).toBeCloseTo(100);
});

test("tree rejects folder cycles, excessive depths and deleting nonempty folders", () => {
  const { store, tree, rooms, subject } = setup();
  try {
    const folder = tree.createFolder(subject, "root", "Parent"),
      child = tree.createFolder(subject, folder.id, "Child");
    expect(() =>
      tree.update(subject, "folder", folder.id, { parentId: child.id }),
    ).toThrow("cycle");
    expect(() => tree.delete(subject, "folder", folder.id)).toThrow(
      "not empty",
    );
    let current = child;
    for (let i = 2; i < MAX_FOLDER_DEPTH; i++)
      current = tree.createFolder(subject, current.id, `Depth${i}`);
    expect(() => tree.createFolder(subject, current.id, "Too deep")).toThrow(
      "depth",
    );
  } finally {
    rooms.close();
    store.close();
  }
});
