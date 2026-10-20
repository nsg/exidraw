import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ELEMENT_VERSION_MAX,
  MAX_ELEMENTS_PER_ROOM,
  MAX_STORED_ELEMENTS_PER_ROOM,
  TOMBSTONE_RETENTION_MS,
  computeSceneVersion,
  isElementEnvelope,
  type SceneElement,
} from "@exidraw/shared";
import { Store } from "../src/db.js";
import { RoomManager, stamp, type Peer } from "../src/rooms.js";

function element(id = "e", extra: Record<string, unknown> = {}): SceneElement {
  return { id, type: "rectangle", version: 1, versionNonce: 1,
    isDeleted: false, updated: Date.now(), index: null, ...extra } as SceneElement;
}
function setup(onError = vi.fn()) {
  const store = new Store(":memory:");
  for (const id of ["a", "b"])
    store.run("INSERT INTO rooms(id,folder_id,name,created_at,updated_at,created_by) VALUES(?,'root',?,0,0,'u')", id, id);
  for (const id of ["a", "b"])
    store.run("INSERT INTO scenes(room_id,elements,scene_version,updated_at) VALUES(?,'[]',0,0)", id);
  return { store, rooms: new RoomManager(store, onError), onError };
}
function peer(connId: string, send = vi.fn(), close = vi.fn()): Peer {
  return { connId, send, close, presence: { connId, userId: "u", name: "U",
    color: { background: "white", stroke: "black" }, idle: "active", isAgent: false } };
}
afterEach(() => vi.useRealTimers());

test("element envelopes bound every ordering field and keep scene sums safe", () => {
  expect(isElementEnvelope(element("ok", { version: ELEMENT_VERSION_MAX,
    versionNonce: -(2 ** 31), index: "a".repeat(64) }))).toBe(true);
  for (const extra of [
    { version: 0 }, { version: ELEMENT_VERSION_MAX + 1 }, { version: Number.MAX_VALUE },
    { versionNonce: -(2 ** 31) - 1 }, { versionNonce: 2 ** 31 },
    { updated: Infinity }, { updated: NaN }, { index: "a".repeat(65) },
  ]) expect(isElementEnvelope(element("bad", extra))).toBe(false);
  expect(computeSceneVersion([element("a", { version: ELEMENT_VERSION_MAX })])).toBe(ELEMENT_VERSION_MAX);
  expect(() => computeSceneVersion([{ version: Number.MAX_SAFE_INTEGER }, { version: 1 }])).toThrow("safe integer");
});

test("identical reconnect versions are silent while an actual loser receives the winner", () => {
  const { store, rooms } = setup();
  const origin = peer("origin"), other = peer("other");
  try {
    rooms.join("a", origin); rooms.join("a", other);
    const current = element("e", { version: 2 });
    rooms.applyElements("a", [current], "server");
    vi.mocked(origin.send).mockClear(); vi.mocked(other.send).mockClear();
    expect(rooms.applyElements("a", [current], "origin")).toEqual({ accepted: [], rejected: [] });
    expect(origin.send).not.toHaveBeenCalled(); expect(other.send).not.toHaveBeenCalled();
    rooms.applyElements("a", [element()], "origin");
    expect(origin.send).toHaveBeenCalledWith(expect.objectContaining({ elements: [current] }));
    expect(other.send).not.toHaveBeenCalled();
  } finally { rooms.close(); store.close(); }
});

test("server deletion receipt times survive reload, ignore client clocks and expire", () => {
  vi.useFakeTimers();
  const { store, rooms } = setup();
  let reloaded: RoomManager | undefined;
  try {
    rooms.applyElements("a", [element("old-clock", { isDeleted: true, updated: -1e15 }),
      element("future-clock", { isDeleted: true, updated: 1e15 })], "server");
    rooms.persist("a");
    expect(rooms.elements("a")).toHaveLength(2);
    rooms.close();
    vi.advanceTimersByTime(TOMBSTONE_RETENTION_MS + 1);
    reloaded = new RoomManager(store);
    // Updating an existing tombstone must not restart its retention period.
    reloaded.applyElements("a", [element("future-clock", {
      version: 2, isDeleted: true, updated: 1e15 }), element("live")], "server");
    reloaded.persist("a");
    expect(reloaded.elements("a").map((e) => e.id)).toEqual(["live"]);
  } finally { reloaded?.close(); rooms.close(); store.close(); }
});

test("room budgets bound tombstones by pruning the oldest and reject live overflow atomically", () => {
  const { store, rooms } = setup();
  try {
    for (let batch = 0; batch < 2; batch++)
      rooms.applyElements("a", Array.from({ length: MAX_ELEMENTS_PER_ROOM }, (_, i) =>
        element(`dead-${batch}-${i}`, { isDeleted: true })), "server");
    rooms.applyElements("a", [element("fresh", { isDeleted: true })], "server");
    expect(rooms.elements("a")).toHaveLength(MAX_STORED_ELEMENTS_PER_ROOM);
    expect(rooms.elements("a").some((e) => e.id === "dead-0-0")).toBe(false);
    expect(rooms.elements("a").some((e) => e.id === "fresh")).toBe(true);
    rooms.applyElements("b", Array.from({ length: MAX_ELEMENTS_PER_ROOM }, (_, i) => element(`live-${i}`)), "server");
    expect(() => rooms.applyElements("b", [element("overflow")], "server")).toThrow("too_many_elements");
    expect(rooms.elements("b")).toHaveLength(MAX_ELEMENTS_PER_ROOM);
  } finally { rooms.close(); store.close(); }
});

test("flush and close persist other rooms after one fails and close every peer", () => {
  vi.useFakeTimers();
  const { store, rooms, onError } = setup();
  const first = peer("first", vi.fn(), vi.fn(() => { throw new Error("bad peer"); }));
  const second = peer("second");
  try {
    rooms.applyElements("a", [element()], "server");
    rooms.applyElements("b", [element()], "server");
    rooms.join("a", first); rooms.join("b", second);
    const persist = rooms.persist.bind(rooms);
    vi.spyOn(rooms, "persist").mockImplementation((id) => {
      if (id === "a") throw new Error("unwritable room");
      persist(id);
    });
    rooms.flush();
    expect(store.get("SELECT scene_version FROM scenes WHERE room_id='b'").scene_version).toBe(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "unwritable room" }));
    expect(() => rooms.close()).not.toThrow();
    expect(first.close).toHaveBeenCalled(); expect(second.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { rooms.close(); store.close(); }
});

test("stamping and snapshot restore reject version exhaustion without changing the scene", () => {
  const { store, rooms } = setup();
  try {
    expect(stamp(element(), element("e", { version: ELEMENT_VERSION_MAX - 1 })).version).toBe(ELEMENT_VERSION_MAX);
    expect(() => stamp(element(), element("e", { version: ELEMENT_VERSION_MAX }))).toThrow("exhausted");
    rooms.applyElements("a", [element()], "server");
    const snapshot = rooms.snapshot("a", "manual", null);
    rooms.applyElements("a", [element("e", { version: ELEMENT_VERSION_MAX })], "server");
    expect(() => rooms.restore("a", snapshot.id, "u")).toThrow("exhausted");
    expect(rooms.scene("a").sceneVersion).toBe(ELEMENT_VERSION_MAX);
    expect(rooms.snapshots("a")).toHaveLength(1);
  } finally { rooms.close(); store.close(); }
});

test("invalid persisted envelopes cannot become authoritative after a restart", () => {
  const { store, rooms } = setup();
  try {
    store.run("UPDATE scenes SET elements=? WHERE room_id='a'", JSON.stringify([element("e", { version: 2 ** 31 })]));
    expect(() => rooms.load("a")).toThrow("Invalid element envelope");
    expect(rooms.rooms.has("a")).toBe(false);
  } finally { rooms.close(); store.close(); }
});

test("database writes reject unsafe numeric parameters and out-of-range scene counters", () => {
  const { store, rooms } = setup();
  try {
    for (const value of [Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 9007199254740992n])
      expect(() => store.run("UPDATE scenes SET scene_version=? WHERE room_id='a'", value)).toThrow("Unsafe numeric");
    for (const value of ["9007199254740992", "-1", "1.5"])
      expect(() => store.db.exec(`UPDATE scenes SET scene_version=${value} WHERE room_id='a'`)).toThrow("Unsafe scene version");
    expect(store.get("SELECT scene_version FROM scenes WHERE room_id='a'").scene_version).toBe(0);
  } finally { rooms.close(); store.close(); }
});

test("counter migration makes legacy oversized SQLite integers readable on restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "exidraw-counters-"));
  let store: Store | undefined;
  try {
    store = new Store(directory);
    // Reproduce a database written before the safe-counter migration existed.
    for (const table of ["scenes", "snapshots"])
      for (const operation of ["insert", "update"])
        store.db.exec(`DROP TRIGGER ${table}_safe_scene_version_${operation}`);
    store.db.exec("INSERT INTO rooms(id,folder_id,name,created_at,updated_at,created_by) VALUES('a','root','A',0,0,'u'); INSERT INTO scenes(room_id,elements,scene_version,updated_at) VALUES('a','[]',9223372036854775807,0); UPDATE meta SET value='2' WHERE key='schema_version'");
    store.close();
    store = new Store(directory);
    expect(store.get("SELECT scene_version FROM scenes WHERE room_id='a'").scene_version).toBe(Number.MAX_SAFE_INTEGER);
    const rooms = new RoomManager(store);
    expect(rooms.scene("a").sceneVersion).toBe(0);
    rooms.close();
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy tombstones get a durable conservative receipt time on first load", () => {
  vi.useFakeTimers();
  const { store, rooms } = setup();
  try {
    store.run("UPDATE scenes SET elements=? WHERE room_id='a'", JSON.stringify([element("old", { isDeleted: true })]));
    rooms.load("a");
    expect(JSON.parse(store.get("SELECT tombstone_times FROM scenes WHERE room_id='a'").tombstone_times)).toEqual({ old: Date.now() });
  } finally { rooms.close(); store.close(); }
});
