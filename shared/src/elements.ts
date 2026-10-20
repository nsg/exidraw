/**
 * Element types on the wire and the server-side reconcile rule.
 *
 * Elements are the Excalidraw element objects, passed through untouched (the
 * server treats them as opaque JSON beyond the envelope fields validated here).
 */
import type { OrderedExcalidrawElement, ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { MAX_ELEMENTS_PER_ROOM } from "./constants.js";

export type { OrderedExcalidrawElement, ExcalidrawElement, BinaryFileData };

/** An element as stored and transmitted. Tombstones (isDeleted=true) are included. */
export type SceneElement = OrderedExcalidrawElement;
export type FileId = BinaryFileData["id"];
export type SceneFiles = Record<string, BinaryFileData>;

/** The fields the server validates on every incoming element. */
export interface ElementEnvelope {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  /** epoch ms */
  updated: number;
  /** fractional index; may be missing/null on freshly created elements */
  index?: string | null;
}

export const ELEMENT_ID_MAX_LENGTH = 64;
export const ELEMENT_VERSION_MAX = 2 ** 31 - 1;
export const ELEMENT_INDEX_MAX_LENGTH = 64;
/** Live elements plus retained tombstones. */
export const MAX_STORED_ELEMENTS_PER_ROOM = MAX_ELEMENTS_PER_ROOM * 2;

export function isElementEnvelope(x: unknown): x is ElementEnvelope {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    e.id.length > 0 &&
    e.id.length <= ELEMENT_ID_MAX_LENGTH &&
    typeof e.type === "string" &&
    Number.isInteger(e.version) &&
    (e.version as number) >= 1 &&
    (e.version as number) <= ELEMENT_VERSION_MAX &&
    Number.isInteger(e.versionNonce) &&
    (e.versionNonce as number) >= -(2 ** 31) &&
    (e.versionNonce as number) <= 2 ** 31 - 1 &&
    typeof e.isDeleted === "boolean" &&
    typeof e.updated === "number" &&
    Number.isFinite(e.updated) &&
    (e.index === undefined || e.index === null ||
      (typeof e.index === "string" && e.index.length <= ELEMENT_INDEX_MAX_LENGTH))
  );
}

/**
 * Excalidraw's reconcile rule (packages/excalidraw/data/reconcile.ts): the
 * incoming element replaces the stored one iff it has a higher version, or the
 * same version and a strictly lower versionNonce. Everything else is kept.
 */
export function remoteWins(local: ElementEnvelope | undefined, remote: ElementEnvelope): boolean {
  if (!local) return true;
  if (remote.version > local.version) return true;
  return remote.version === local.version && remote.versionNonce < local.versionNonce;
}

/** Same value as @excalidraw/excalidraw `getSceneVersion`: sum of element versions. */
export function computeSceneVersion(elements: Iterable<Pick<ElementEnvelope, "version">>): number {
  let v = 0;
  for (const e of elements) {
    v += e.version;
    if (!Number.isSafeInteger(v) || e.version < 1)
      throw new RangeError("Scene version exceeds safe integer range");
  }
  return v;
}

/**
 * Canonical element order: by fractional `index` (plain string comparison, as
 * fractional-indexing guarantees lexicographic order), elements without an
 * index last, ties by id. Server output and snapshots use this order.
 */
export function compareElementOrder(a: ElementEnvelope, b: ElementEnvelope): number {
  const ai = a.index ?? null;
  const bi = b.index ?? null;
  if (ai !== null && bi !== null) {
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  } else if (ai !== null) {
    return -1;
  } else if (bi !== null) {
    return 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
