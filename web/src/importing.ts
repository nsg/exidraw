/**
 * Reading Excalidraw drawings from files (folder upload, "Insert drawing…",
 * canvas drops) and from another room's export. Parsing goes through
 * Excalidraw's own loaders, which run `restore` and so normalise legacy
 * files. The package is imported lazily: the folder pages use this module
 * and must not pull the editor bundle into their chunk.
 */
import {
  ELEMENT_INDEX_MAX_LENGTH,
  ELEMENT_VERSION_MAX,
  MAX_NAME_LENGTH,
  isElementEnvelope,
} from "@exidraw/shared";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, BinaryFiles, LibraryItems_anyVersion } from "@excalidraw/excalidraw/types";
import { randomNonce } from "./room/insert";

/** File picker filter for drawings: .excalidraw/JSON, and PNG/SVG exports with an embedded scene. */
export const DRAWING_FILE_ACCEPT = ".excalidraw,.json,.png,.svg,application/json";

/** A drawing ready to import: live elements and the image files they use. */
export interface DrawingData {
  elements: ExcalidrawElement[];
  files: BinaryFiles;
  /** Embedded web pages (`iframe` elements) left out of the import. */
  skippedWebPages: number;
  /** URL of the room it was copied from; element links into that room are remapped on insert. */
  sourceUrl?: string;
}

export type ImportErrorCode = "invalid" | "library" | "no_scene" | "empty";

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

const KNOWN_EXTENSIONS = /\.(excalidraw|json|png|svg)$/i;

/** Drawing name for an uploaded file: `diagram.excalidraw.png` → `diagram`. */
export function drawingNameFromFile(fileName: string): string {
  let name = fileName.replace(/^.*[\\/]/, "");
  while (KNOWN_EXTENSIONS.test(name)) name = name.replace(KNOWN_EXTENSIONS, "");
  name = name.trim().slice(0, MAX_NAME_LENGTH).trim();
  return name || "Untitled";
}

/** "1 embedded web page was skipped" / "" */
export function skippedNote(data: Pick<DrawingData, "skippedWebPages">): string {
  const n = data.skippedWebPages;
  return n === 0 ? "" : `${n} embedded web page${n === 1 ? " was" : "s were"} skipped`;
}

// ---- reading files -----------------------------------------------------------------

/** What a file holds, judged by its content (names and mime types are not trusted). */
export type FileContents =
  | { kind: "scene"; data: DrawingData }
  | { kind: "library"; libraryItems: LibraryItems_anyVersion }
  /** An image without a scene; `file` carries the mime type Excalidraw will treat it as. */
  | { kind: "image"; file: File }
  | { kind: "invalid" };

/** Image types Excalidraw inserts (its IMAGE_MIME_TYPES). */
const EXCALIDRAW_IMAGE_TYPES = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/avif",
  "image/jfif",
]);

const startsWith = (head: Uint8Array, bytes: number[], at = 0) => bytes.every((b, i) => head[at + i] === b);

/** Raster formats recognisable by signature, a superset of Excalidraw's own sniffing (png/jpeg/gif). */
function sniffRaster(head: Uint8Array): string | null {
  if (startsWith(head, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (startsWith(head, [255, 216, 255])) return "image/jpeg";
  if (startsWith(head, [71, 73, 70, 56])) return "image/gif";
  if (startsWith(head, [82, 73, 70, 70]) && startsWith(head, [87, 69, 66, 80], 8)) return "image/webp";
  return null;
}

/**
 * Classify a file by content. Scenes can only be embedded in PNG and SVG; for
 * those the same Excalidraw decoder its drop handler uses is run on the same
 * bytes, so a file reported as "image" holds no scene for Excalidraw either.
 */
export async function readExcalidrawFile(file: File): Promise<FileContents> {
  const { loadSceneOrLibraryFromBlob } = await import("@excalidraw/excalidraw");
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const raster = sniffRaster(head);
  const text = new TextDecoder().decode(head).replace(/^﻿/, "").trimStart();

  // Mime type to decode with; null: the format cannot carry a scene.
  let decodeAs: string | null;
  if (raster === "image/png") decodeAs = "image/png";
  else if (raster) decodeAs = null;
  else if (text.startsWith("{")) decodeAs = "";
  else if (text.startsWith("<") && (/<svg[\s>]/i.test(text) || file.type === "image/svg+xml")) decodeAs = "image/svg+xml";
  else if (EXCALIDRAW_IMAGE_TYPES.has(file.type) && file.type !== "image/png" && file.type !== "image/svg+xml") decodeAs = null;
  else decodeAs = "";

  if (decodeAs === null) return { kind: "image", file: retype(file, raster ?? file.type) };
  try {
    const loaded = await loadSceneOrLibraryFromBlob(retype(file, decodeAs), null, null);
    if (loaded.type === "application/vnd.excalidrawlib+json") {
      const items = loaded.data.libraryItems ?? loaded.data.library;
      return items ? { kind: "library", libraryItems: items } : { kind: "invalid" };
    }
    return { kind: "scene", data: pickScene(loaded.data) };
  } catch (err) {
    if (decodeAs && (err as { code?: string } | null)?.code === "IMAGE_NOT_CONTAINS_SCENE_DATA") {
      return { kind: "image", file: retype(file, decodeAs) };
    }
    return { kind: "invalid" };
  }
}

function retype(file: File, type: string): File {
  return file.type === type ? file : new File([file], file.name, { type });
}

/** Parse a user-picked file as a drawing. Throws `ImportError` with a message naming the file. */
export async function parseDrawingFile(file: File): Promise<DrawingData> {
  const label = `“${file.name}”`;
  const contents = await readExcalidrawFile(file);
  switch (contents.kind) {
    case "scene":
      if (contents.data.elements.length === 0) throw new ImportError("empty", `${label} is an empty drawing.`);
      return contents.data;
    case "library":
      throw new ImportError("library", `${label} is a shape library, not a drawing. Add it from the library panel inside a drawing.`);
    case "image":
      throw new ImportError("no_scene", `${label} is an image without an embedded drawing. Export it from Excalidraw with “Embed scene” turned on.`);
    case "invalid":
      throw new ImportError("invalid", `${label} is not an Excalidraw drawing.`);
  }
}

/** Normalise `GET /api/rooms/:id/export.json` the same way a file is. */
export async function parseExportedDrawing(json: unknown, name: string): Promise<DrawingData> {
  const { restore } = await import("@excalidraw/excalidraw");
  const label = `“${name}”`;
  const data = json as { elements?: unknown; files?: unknown } | null;
  if (!data || !Array.isArray(data.elements)) throw new ImportError("invalid", `${label} could not be read.`);
  const restored = restore(
    { elements: data.elements as ExcalidrawElement[], files: (data.files ?? {}) as BinaryFiles },
    null,
    null,
    { repairBindings: true, refreshDimensions: false },
  );
  const scene = pickScene(restored);
  if (scene.elements.length === 0) throw new ImportError("empty", `${label} is an empty drawing.`);
  return scene;
}

// ---- normalising scenes --------------------------------------------------------------

/** The server's accepted image types; anything else (e.g. an http URL) is never handed to the browser. */
const IMAGE_DATA_URL =
  /^data:(image\/png|image\/jpeg|image\/gif|image\/webp|image\/svg\+xml|image\/avif|image\/bmp|image\/x-icon)(;[^,]*)?;base64,/;

/**
 * Live elements without embedded web pages, plus only the files their image
 * elements reference. `iframe` elements render their stored HTML with
 * scripts enabled and could reach third-party origins; nothing legitimate
 * creates them here (AI features are off). `embeddable` elements are kept.
 */
export function pickScene(data: { elements: readonly ExcalidrawElement[]; files: BinaryFiles }): DrawingData {
  const live = data.elements.filter((e) => !e.isDeleted);
  const webPages = new Set(live.filter((e) => e.type === "iframe").map((e) => e.id));
  const removed = new Set(webPages);
  for (const e of live) if (e.type === "text" && e.containerId && webPages.has(e.containerId)) removed.add(e.id);
  const elements = removed.size > 0 ? withoutElements(live, removed) : live;

  const files: BinaryFiles = {};
  for (const e of elements) {
    if (e.type !== "image" || !e.fileId) continue;
    const file: BinaryFileData | undefined = data.files?.[e.fileId];
    const mime = typeof file?.dataURL === "string" ? IMAGE_DATA_URL.exec(file.dataURL)?.[1] : undefined;
    if (!file || !mime) continue; // the element stays and shows a placeholder
    files[e.fileId] = {
      ...file,
      id: e.fileId,
      mimeType: mime as BinaryFileData["mimeType"],
      created: Number.isFinite(file.created) ? file.created : Date.now(),
    };
  }
  return { elements, files, skippedWebPages: webPages.size };
}

/** Remove elements and every reference to them, as if they had never been there. */
function withoutElements(elements: readonly ExcalidrawElement[], removed: ReadonlySet<string>): ExcalidrawElement[] {
  const gone = (id: string | null | undefined) => !!id && removed.has(id);
  return elements
    .filter((e) => !removed.has(e.id))
    .map((e) => {
      const patch: Record<string, unknown> = {};
      if (e.boundElements?.some((b) => gone(b.id))) {
        const bound = e.boundElements.filter((b) => !gone(b.id));
        patch.boundElements = bound.length > 0 ? bound : null;
      }
      if (gone(e.frameId)) patch.frameId = null;
      if ("containerId" in e && gone(e.containerId)) patch.containerId = null;
      if ("startBinding" in e && gone(e.startBinding?.elementId)) patch.startBinding = null;
      if ("endBinding" in e && gone(e.endBinding?.elementId)) patch.endBinding = null;
      return Object.keys(patch).length > 0 ? ({ ...e, ...patch } as ExcalidrawElement) : e;
    });
}

const isIntIn = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/**
 * Elements as `POST /api/rooms/import` stores them: repair the metadata the
 * server checks (files from other tools sometimes carry fractional nonces or
 * no timestamps), then check what remains with the server's own rule so a bad
 * file gets a clear message instead of "Invalid element envelope at index N".
 */
export function uploadElements(elements: readonly ExcalidrawElement[], fileName: string): unknown[] {
  const seen = new Set<string>();
  return elements.map((src, i) => {
    const e = { ...src } as Record<string, unknown>;
    if (!isIntIn(e.version, 1, ELEMENT_VERSION_MAX)) e.version = 1;
    if (!isIntIn(e.versionNonce, -(2 ** 31), 2 ** 31 - 1)) e.versionNonce = randomNonce();
    if (typeof e.updated !== "number" || !Number.isFinite(e.updated)) e.updated = Date.now();
    if (!(e.index == null || (typeof e.index === "string" && e.index.length <= ELEMENT_INDEX_MAX_LENGTH))) e.index = null;
    const id = typeof e.id === "string" ? e.id : "";
    if (!isElementEnvelope(e) || seen.has(id)) {
      const which = id ? `“${id.slice(0, 40)}”` : `number ${i + 1}`;
      const why = seen.has(id) ? "appears twice" : "is malformed";
      throw new ImportError("invalid", `“${fileName}” cannot be uploaded: element ${which} ${why}.`);
    }
    seen.add(id);
    return e;
  });
}
