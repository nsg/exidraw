import { describe, expect, it } from "vitest";
import { TOMBSTONE_RETENTION_MS, WS_CLOSE, type CollaboratorInfo, type SceneElement } from "@exidraw/shared";
import {
  BroadcastTracker,
  applyRemote,
  chunkElements,
  frameGapMs,
  buildCollaborators,
  classifyClose,
  collectOutgoing,
  collectSyncAll,
  reconnectDelay,
  type MergeDeps,
} from "./core";

interface El {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  updated: number;
  width: number;
}

const el = (id: string, version: number, extra: Partial<El> = {}): El => ({
  id,
  version,
  versionNonce: 100,
  isDeleted: false,
  updated: 1_000,
  width: 50,
  ...extra,
});

const opts = { isInvisiblySmall: (e: El) => e.width === 0 };

// Stand-in for Excalidraw's restore/reconcile with the same keep-local rule.
// appState stand-in: id of the element being edited locally (or null).
const deps: MergeDeps<El, string | null> = {
  restore: (remote) => remote.map((e) => ({ ...(e as unknown as El) })),
  reconcile: (local, remote, editingId) => {
    const byId = new Map(local.map((e) => [e.id, e]));
    for (const r of remote) {
      const l = byId.get(r.id);
      const keepLocal =
        l && (l.id === editingId || l.version > r.version || (l.version === r.version && l.versionNonce < r.versionNonce));
      if (!keepLocal) byId.set(r.id, r);
    }
    return [...byId.values()];
  },
};
const asWire = (els: El[]) => els as unknown as SceneElement[];

describe("collectOutgoing", () => {
  it("sends unknown and newer elements, skips ones already at the recorded version", () => {
    const t = new BroadcastTracker();
    t.record([el("a", 2), el("b", 3)]);
    const out = collectOutgoing([el("a", 2), el("b", 4), el("c", 1)], t, opts);
    expect(out.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("holds back invisibly small live elements", () => {
    const out = collectOutgoing([el("a", 1, { width: 0 })], new BroadcastTracker(), opts);
    expect(out).toEqual([]);
  });

  it("sends tombstones only for elements the server already knows", () => {
    const t = new BroadcastTracker();
    t.record([el("known", 1)]);
    const out = collectOutgoing(
      [el("known", 2, { isDeleted: true }), el("local-only", 2, { isDeleted: true, width: 0 })],
      t,
      opts,
    );
    expect(out.map((e) => e.id)).toEqual(["known"]);
  });
});

describe("collectSyncAll", () => {
  it("includes all live elements and only recent tombstones", () => {
    const now = TOMBSTONE_RETENTION_MS + 10_000;
    const out = collectSyncAll(
      [
        el("live", 1),
        el("tiny", 1, { width: 0 }),
        el("recent", 2, { isDeleted: true, updated: now - 1_000 }),
        el("old", 2, { isDeleted: true, updated: 1 }),
      ],
      { ...opts, now },
    );
    expect(out.map((e) => e.id)).toEqual(["live", "recent"]);
  });
});

describe("BroadcastTracker.record", () => {
  it("never lowers a recorded version", () => {
    const t = new BroadcastTracker();
    t.record([el("a", 5)]);
    t.record([el("a", 3)]);
    expect(t.get("a")).toBe(5);
  });
});

describe("applyRemote", () => {
  it("records received versions so the following onChange does not echo them", () => {
    const t = new BroadcastTracker();
    const { elements } = applyRemote([], asWire([el("a", 3)]), null, t, deps);
    expect(collectOutgoing(elements, t, opts)).toEqual([]);
  });

  it("keeps a newer unsent local edit and still sends it afterwards", () => {
    const t = new BroadcastTracker();
    t.record([el("a", 1)]);
    const { elements } = applyRemote([el("a", 4)], asWire([el("a", 2)]), null, t, deps);
    expect(elements[0]!.version).toBe(4);
    expect(collectOutgoing(elements, t, opts).map((e) => e.version)).toEqual([4]);
  });

  it("defers a newer remote version that lost because the element is being edited", () => {
    const t = new BroadcastTracker();
    t.record([el("a", 1)]);
    const { elements, deferred } = applyRemote([el("a", 2)], asWire([el("a", 7)]), "a", t, deps);
    expect(t.get("a")).toBe(1);
    expect(elements[0]!.version).toBe(2);
    expect(deferred.map((e) => e.version)).toEqual([7]);
  });

  it("does not record a version the merge bumped locally (index repair) so it gets sent", () => {
    const t = new BroadcastTracker();
    const repairing: MergeDeps<El, null> = {
      ...deps,
      reconcile: (local, remote) => deps.reconcile(local, remote, null).map((e) => ({ ...e, version: e.version + 1, versionNonce: 7 })),
    };
    const { elements } = applyRemote([], asWire([el("z", 1)]), null, t, repairing);
    expect(collectOutgoing(elements, t, opts).map((e) => e.version)).toEqual([2]);
  });

  it("authoritative mode replaces the scene and resets stale watermarks (viewer scene_init)", () => {
    const t = new BroadcastTracker();
    t.record([el("a", 9)]);
    const { elements } = applyRemote([el("a", 9), el("stale", 1)], asWire([el("a", 2)]), null, t, deps, true);
    expect(elements.map((e) => [e.id, e.version])).toEqual([["a", 2]]);
    // promoted to editor later: the next local edit (v3) must be sent
    expect(collectOutgoing([el("a", 3)], t, opts).map((e) => e.version)).toEqual([3]);
  });
});

describe("chunkElements", () => {
  it("splits by serialized size and by count, never producing empty frames", () => {
    const big = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, pad: "x".repeat(40) }));
    const bySize = chunkElements(big, 130, 100);
    expect(bySize.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(chunkElements(big, 10_000, 2).map((c) => c.length)).toEqual([2, 2, 1]);
    expect(chunkElements([{ huge: "y".repeat(500) }], 100, 10)).toHaveLength(1);
  });
});

describe("frameGapMs", () => {
  it("keeps small frames 40 ms apart and spaces big ones by size, under the server's 32 MiB / 10 s budget", () => {
    expect(frameGapMs(2_000)).toBe(40);
    const big = 3 * 1024 * 1024;
    const framesIn10s = 10_000 / frameGapMs(big);
    expect(framesIn10s * big).toBeLessThan(32 * 1024 * 1024 * 0.6);
  });
});

describe("classifyClose", () => {
  it.each([
    [WS_CLOSE.NORMAL, "stop"],
    [WS_CLOSE.GOING_AWAY, "reconnect"],
    [1006, "reconnect"],
    [WS_CLOSE.RATE_LIMITED, "reconnect"],
    [WS_CLOSE.UNAUTHENTICATED, "fatal"],
    [WS_CLOSE.FORBIDDEN, "fatal"],
    [WS_CLOSE.ROOM_NOT_FOUND, "fatal"],
    [WS_CLOSE.ROOM_DELETED, "fatal"],
  ])("close %i → %s", (code, kind) => {
    expect(classifyClose(code).kind).toBe(kind);
  });
});

describe("reconnectDelay", () => {
  it("grows exponentially from ~1 s and caps at 30 s", () => {
    const mid = () => 0.5;
    expect(reconnectDelay(0, mid)).toBe(1_000);
    expect(reconnectDelay(3, mid)).toBe(8_000);
    expect(reconnectDelay(20, () => 1)).toBe(30_000);
  });
});

describe("buildCollaborators", () => {
  const info = (connId: string, name: string): CollaboratorInfo => ({
    connId,
    userId: `u-${name}`,
    name,
    color: { background: "#fff", stroke: "#000" },
    isAgent: false,
    idle: "active",
  });

  it("keys by connId, marks self, attaches others' pointers and latest idle state", () => {
    const pointer = { x: 1, y: 2, tool: "pointer" as const, button: "down" as const, selectedElementIds: ["e1"] };
    const map = buildCollaborators(
      [info("c1", "Alice"), info("c2", "Bob")],
      "c1",
      new Map([
        ["c1", pointer],
        ["c2", pointer],
      ]),
      new Map([["c2", "away" as const]]),
    );
    expect(map.get("c1")).toMatchObject({ isCurrentUser: true, username: "Alice" });
    expect(map.get("c1")!.pointer).toBeUndefined();
    expect(map.get("c2")).toMatchObject({
      isCurrentUser: false,
      userState: "away",
      pointer: { x: 1, y: 2 },
      button: "down",
      selectedElementIds: { e1: true },
    });
  });
});
