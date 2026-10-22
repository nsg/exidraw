import { describe, expect, it } from "vitest";
import { isElementEnvelope } from "@exidraw/shared";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { prepareInsert, randomId, type Bounds } from "./insert";

type Any = Record<string, unknown>;

function el(id: string, type: string, extra: Any = {}): ExcalidrawElement {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    groupIds: [],
    frameId: null,
    boundElements: null,
    index: "a0",
    version: 7,
    versionNonce: 123,
    updated: 1,
    isDeleted: false,
    ...extra,
  } as unknown as ExcalidrawElement;
}

/** Axis-aligned stand-in for Excalidraw's getCommonBounds. */
const boxBounds = (elements: readonly ExcalidrawElement[]): Bounds => [
  Math.min(...elements.map((e) => e.x)),
  Math.min(...elements.map((e) => e.y)),
  Math.max(...elements.map((e) => e.x + e.width)),
  Math.max(...elements.map((e) => e.y + e.height)),
];

const source = [
  el("rect", "rectangle", {
    x: 0,
    y: 0,
    groupIds: ["outer"],
    boundElements: [
      { id: "label", type: "text" },
      { id: "arrow", type: "arrow" },
      { id: "elsewhere", type: "arrow" },
    ],
  }),
  el("label", "text", { x: 10, y: 10, containerId: "rect", groupIds: ["outer"] }),
  el("ellipse", "ellipse", { x: 300, y: 150, groupIds: ["inner", "outer"], boundElements: [{ id: "arrow", type: "arrow" }] }),
  el("arrow", "arrow", {
    x: 100,
    y: 25,
    width: 200,
    height: 150,
    points: [
      [0, 0],
      [200, 150],
    ],
    groupIds: ["inner", "outer"],
    startBinding: { elementId: "rect", focus: 0, gap: 1 },
    endBinding: { elementId: "ellipse", focus: 0.2, gap: 4 },
  }),
  el("dangling", "arrow", { x: 0, y: 100, startBinding: { elementId: "nowhere", focus: 0, gap: 1 }, endBinding: null }),
  el("img", "image", { x: 200, y: 0, fileId: "f1", status: "error" }),
  el("gone", "rectangle", { x: 5000, y: 5000, isDeleted: true }),
];

const insert = (src: readonly ExcalidrawElement[], center = { x: 1000, y: 2000 }) =>
  prepareInsert(src, { center, getBounds: boxBounds, now: 42 });

const byOldId = (result: ReturnType<typeof insert>, src: readonly ExcalidrawElement[]) => {
  const live = src.filter((e) => !e.isDeleted);
  return Object.fromEntries(live.map((e, i) => [e.id, result.elements[i] as unknown as Any]));
};

describe("prepareInsert", () => {
  it("drops deleted elements and gives every element a fresh id", () => {
    const result = insert(source);
    expect(result.elements).toHaveLength(6);
    const ids = result.elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
      expect(source.some((e) => e.id === id)).toBe(false);
    }
  });

  it("remaps bound text, arrow bindings and boundElements, dropping references outside the source", () => {
    const result = insert(source);
    const m = byOldId(result, source);
    const id = (old: string) => m[old]!.id;
    expect(m.label!.containerId).toBe(id("rect"));
    expect(m.rect!.boundElements).toEqual([
      { id: id("label"), type: "text" },
      { id: id("arrow"), type: "arrow" },
    ]);
    expect(m.ellipse!.boundElements).toEqual([{ id: id("arrow"), type: "arrow" }]);
    expect(m.arrow!.startBinding).toEqual({ elementId: id("rect"), focus: 0, gap: 1 });
    expect(m.arrow!.endBinding).toEqual({ elementId: id("ellipse"), focus: 0.2, gap: 4 });
    expect(m.dangling!.startBinding).toBeNull();
    expect(m.dangling!.endBinding).toBeNull();
  });

  it("maps each old group to one new group and wraps everything in a new outermost group", () => {
    const result = insert(source);
    const m = byOldId(result, source);
    const g = (old: string) => m[old]!.groupIds as string[];
    expect(result.groupId).toMatch(/^[A-Za-z0-9_-]{21}$/);
    for (const e of result.elements) expect(e.groupIds.at(-1)).toBe(result.groupId);
    // innermost → outermost order is kept, the shared group ids stay shared
    expect(g("rect")).toEqual([g("ellipse")[1], result.groupId]);
    expect(g("arrow")).toEqual(g("ellipse"));
    expect(g("label")).toEqual(g("rect"));
    expect(g("dangling")).toEqual([result.groupId]);
    expect(g("ellipse")[0]).not.toBe("inner");
    expect(g("ellipse")[1]).not.toBe("outer");
    expect(Object.keys(result.selectedElementIds).sort()).toEqual(result.elements.map((e) => e.id).sort());
  });

  it("centres the common bounds on the given point without touching relative points", () => {
    // source bounds: 0,0 → 400,200 (centre 200,100)
    const result = insert(source, { x: 1000, y: 2000 });
    const m = byOldId(result, source);
    expect([m.rect!.x, m.rect!.y]).toEqual([800, 1900]);
    expect([m.ellipse!.x, m.ellipse!.y]).toEqual([1100, 2050]);
    expect([m.arrow!.x, m.arrow!.y]).toEqual([900, 1925]);
    expect(m.arrow!.points).toEqual([
      [0, 0],
      [200, 150],
    ]);
    const [minX, minY, maxX, maxY] = boxBounds(result.elements);
    expect([(minX + maxX) / 2, (minY + maxY) / 2]).toEqual([1000, 2000]);
  });

  it("stamps fresh versions, clears the index and passes the server's envelope check", () => {
    const result = insert(source);
    for (const e of result.elements) {
      expect(e.version).toBe(1);
      expect(e.updated).toBe(42);
      expect(e.isDeleted).toBe(false);
      expect(e.index).toBeNull();
      expect(Number.isInteger(e.versionNonce) && e.versionNonce >= 0 && e.versionNonce < 2 ** 31).toBe(true);
      expect(isElementEnvelope(e)).toBe(true);
    }
    expect(new Set(result.elements.map((e) => e.versionNonce)).size).toBeGreaterThan(1);
  });

  it("re-queues images that failed to upload in the source", () => {
    const m = byOldId(insert(source), source);
    expect(m.img!.status).toBe("pending");
    expect(m.img!.fileId).toBe("f1");
    const saved = byOldId(insert([el("i", "image", { fileId: "f2", status: "saved" })]), [el("i", "image")]);
    expect(saved.i!.status).toBe("saved");
  });

  it("does not add a group when the source has frames, and remaps frame membership", () => {
    const framed = [
      el("frame", "frame", { width: 500, height: 500, groupIds: [] }),
      el("child", "rectangle", { x: 10, y: 10, frameId: "frame", groupIds: ["g"] }),
      el("sibling", "rectangle", { x: 20, y: 20, frameId: "frame", groupIds: ["g"] }),
      el("orphan", "rectangle", { x: 600, y: 0, frameId: "other-frame" }),
    ];
    const result = insert(framed);
    const m = byOldId(result, framed);
    expect(result.groupId).toBeNull();
    expect(m.frame!.groupIds).toEqual([]);
    expect(m.child!.frameId).toBe(m.frame!.id);
    expect(m.sibling!.frameId).toBe(m.frame!.id);
    expect(m.orphan!.frameId).toBeNull();
    expect((m.child!.groupIds as string[])).toHaveLength(1);
    expect(m.child!.groupIds).toEqual(m.sibling!.groupIds);
    expect(m.child!.groupIds).not.toEqual(["g"]);
    // top-level selection: the frame carries its children
    expect(Object.keys(result.selectedElementIds).sort()).toEqual([m.frame!.id, m.orphan!.id].sort());
  });

  it("rewrites element links into the source room only, leaving every other link alone", () => {
    const linked = [
      el("a", "rectangle", { groupIds: ["g"], link: "https://draw.example/r/source?element=b" }),
      el("b", "rectangle", { groupIds: ["g"], link: "https://draw.example/r/source?element=g" }),
      el("c", "rectangle", { link: "https://draw.example/r/source?element=not-in-source" }),
      el("d", "rectangle", { link: "https://docs.example/view?element=a" }),
      el("e", "rectangle", { link: "https://draw.example/r/other-room?element=a" }),
      el("f", "rectangle", { link: "not a url" }),
    ];
    const links = { from: "https://draw.example/r/source", to: "https://draw.example/r/target" };
    const m = byOldId(prepareInsert(linked, { center: { x: 0, y: 0 }, getBounds: boxBounds, links }), linked);
    expect(m.a!.link).toBe(`https://draw.example/r/target?element=${m.b!.id}`);
    expect(m.b!.link).toBe(`https://draw.example/r/target?element=${(m.a!.groupIds as string[])[0]}`);
    expect(m.c!.link).toBe("https://draw.example/r/source?element=not-in-source");
    expect(m.d!.link).toBe("https://docs.example/view?element=a");
    expect(m.e!.link).toBe("https://draw.example/r/other-room?element=a");
    expect(m.f!.link).toBe("not a url");

    // Without a known source room (inserting a file) no link is rewritten.
    const plain = byOldId(insert(linked), linked);
    expect(linked.map((e) => plain[e.id]!.link)).toEqual(linked.map((e) => e.link));
  });

  it("returns nothing for an empty source", () => {
    expect(insert([el("x", "rectangle", { isDeleted: true })])).toEqual({ elements: [], groupId: null, selectedElementIds: {} });
  });

  it("does not mutate the source elements", () => {
    const copy = JSON.parse(JSON.stringify(source));
    insert(source);
    expect(JSON.parse(JSON.stringify(source))).toEqual(copy);
  });
});

describe("randomId", () => {
  it("is 21 url-safe characters and does not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, randomId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });
});
