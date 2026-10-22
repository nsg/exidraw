/**
 * Copying a drawing into the open scene ("Insert drawing…", dropped drawing
 * files). Pure so it can be unit-tested in node: Excalidraw's bounds function
 * is passed in. Every element gets a new id and all references are remapped,
 * so inserting the same drawing twice (or into its own room) never collides
 * with what is there.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export type Bounds = readonly [minX: number, minY: number, maxX: number, maxY: number];

export interface InsertOptions {
  /** Scene point the inserted content is centred on. */
  center: { x: number; y: number };
  /** `getCommonBounds` from @excalidraw/excalidraw. */
  getBounds: (elements: readonly ExcalidrawElement[]) => Bounds;
  /**
   * Element links (Excalidraw's `<room url>?element=<element or group id>`)
   * whose origin and path are exactly `from`, the source room's URL, are
   * re-pointed at `to` with the new id. Without it no link is touched.
   */
  links?: { from: string; to: string };
  now?: number;
  newId?: () => string;
}

export interface InsertResult {
  elements: ExcalidrawElement[];
  /** Outermost group wrapping the whole insert; null when the source has frames (Excalidraw does not group frames). */
  groupId: string | null;
  /** What to select afterwards so the insert can be moved right away. */
  selectedElementIds: Record<string, true>;
}

/** Excalidraw's ELEMENT_LINK_KEY: element links are `<room url>?element=<element or group id>`. */
const ELEMENT_LINK_KEY = "element";

// nanoid's alphabet, as used by Excalidraw's randomId (21 chars ≈ 126 bits).
const ID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

export function randomId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(21))) id += ID_ALPHABET[byte & 63];
  return id;
}

/** Same range as Excalidraw's randomInteger: 0 … 2^31-1. */
export function randomNonce(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! >>> 1;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Binding = { elementId: string } | null | undefined;
type Loose = Mutable<ExcalidrawElement> & {
  containerId?: string | null;
  startBinding?: Binding;
  endBinding?: Binding;
  status?: string;
};

export function prepareInsert(source: readonly ExcalidrawElement[], opts: InsertOptions): InsertResult {
  const newId = opts.newId ?? randomId;
  const now = opts.now ?? Date.now();
  const live = source.filter((e) => !e.isDeleted);
  if (live.length === 0) return { elements: [], groupId: null, selectedElementIds: {} };

  const ids = new Map(live.map((e) => [e.id, newId()]));
  const groups = new Map<string, string>();
  for (const e of live) for (const g of e.groupIds) if (!groups.has(g)) groups.set(g, newId());
  const hasFrames = live.some((e) => e.type === "frame" || e.type === "magicframe");
  const outerGroup = hasFrames ? null : newId();
  const remapBinding = (b: Binding) => (b && ids.has(b.elementId) ? { ...b, elementId: ids.get(b.elementId)! } : null);
  const sourcePage = (u: URL) => u.origin + u.pathname;
  const remapLink = (link: string | null) => {
    if (!opts.links) return link;
    let url: URL;
    try {
      url = new URL(link ?? "");
    } catch {
      return link;
    }
    // Conservative: only links demonstrably into the source room are internal.
    if (sourcePage(url) !== sourcePage(new URL(opts.links.from))) return link;
    const target = url.searchParams.get(ELEMENT_LINK_KEY);
    const mapped = target ? (ids.get(target) ?? groups.get(target)) : undefined;
    if (!mapped) return link;
    const next = new URL(opts.links.to);
    next.searchParams.set(ELEMENT_LINK_KEY, mapped);
    return next.toString();
  };

  const [minX, minY, maxX, maxY] = opts.getBounds(live);
  const dx = opts.center.x - (minX + maxX) / 2;
  const dy = opts.center.y - (minY + maxY) / 2;

  const elements = live.map((src) => {
    const e = { ...src } as Loose;
    e.id = ids.get(src.id)!;
    // Linear elements' points are relative to x/y, so moving x/y moves everything.
    e.x = src.x + dx;
    e.y = src.y + dy;
    e.groupIds = [...src.groupIds.map((g) => groups.get(g)!), ...(outerGroup ? [outerGroup] : [])];
    e.frameId = src.frameId && ids.has(src.frameId) ? ids.get(src.frameId)! : null;
    if (src.boundElements) {
      const bound = src.boundElements.filter((b) => ids.has(b.id)).map((b) => ({ ...b, id: ids.get(b.id)! }));
      e.boundElements = bound.length > 0 ? bound : null;
    }
    if ("containerId" in src) e.containerId = src.containerId && ids.has(src.containerId) ? ids.get(src.containerId)! : null;
    if (src.link) e.link = remapLink(src.link);
    if ("startBinding" in src) e.startBinding = remapBinding(src.startBinding);
    if ("endBinding" in src) e.endBinding = remapBinding(src.endBinding);
    // FileSync uploads any live image whose bytes we hold; "error" would make it skip this one.
    if (e.type === "image" && e.status === "error") e.status = "pending";
    e.version = 1;
    e.versionNonce = randomNonce();
    e.updated = now;
    e.isDeleted = false;
    // Excalidraw's Scene re-syncs missing indices on updateScene, generating
    // them after the preceding element: appended elements land on top.
    e.index = null;
    return e as ExcalidrawElement;
  });

  // A group selection needs all its members selected; with frames, select the
  // top-level elements (frames carry their children along).
  const selectedElementIds: Record<string, true> = {};
  for (const e of elements) {
    if (outerGroup || (!e.frameId && !("containerId" in e && e.containerId))) selectedElementIds[e.id] = true;
  }
  return { elements, groupId: outerGroup, selectedElementIds };
}
