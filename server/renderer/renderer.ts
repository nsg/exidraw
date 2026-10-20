import {
  INTERNAL_RENDERER_PATH,
  RENDER_DEFAULT_SCALE,
  RENDER_MAX_EDGE_PX,
  RENDER_MAX_PIXELS,
} from "@exidraw/shared";
import type {
  ConvertResult,
  RendererBridge,
  RenderRequest,
  SceneElement,
  SceneFiles,
} from "@exidraw/shared";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { projectBindings } from "../src/bindings.js";
// Dynamic imports are intentional: the package reads this during module initialization.
window.EXCALIDRAW_ASSET_PATH = INTERNAL_RENDERER_PATH;
const {
  convertToExcalidrawElements,
  restoreElements,
  exportToBlob,
  exportToSvg,
  exportToCanvas,
  getCommonBounds,
  FONT_FAMILY,
} = await import("@excalidraw/excalidraw");
const { parseMermaidToExcalidraw } = await import(
  "@excalidraw/mermaid-to-excalidraw"
);
const clone = <T>(value: T): T => structuredClone(value);
// Export registers the package's font faces. Load every local subset before exposing
// the synchronous conversion methods, so later labels use the editor's real metrics.
const warmup = convertToExcalidrawElements(
  Object.values(FONT_FAMILY).map((fontFamily, index) => ({
    type: "text",
    x: 0,
    y: index * 30,
    text: "Font metrics",
    fontFamily,
  })),
  { regenerateIds: false },
);
await exportToCanvas({ elements: warmup, files: {} });
const faces: Promise<FontFace>[] = [];
document.fonts.forEach((face) => {
  faces.push(face.load());
});
await Promise.all(faces);
await document.fonts.ready;
function keepVersion(
  element: SceneElement,
  original?: SceneElement,
): SceneElement {
  if (!original) return element;
  return {
    ...element,
    version: original.version,
    versionNonce: original.versionNonce,
    updated: original.updated,
  };
}
function convertSkeletons(
  skeletons: unknown[],
  context: SceneElement[],
): ConvertResult {
  const previous = new Map(context.map((element) => [element.id, element]));
  // Existing frames are full elements rather than frame skeletons; supply the
  // children list required by the package without changing their original bounds.
  const existing = context.map((element) =>
    element.type === "frame" || element.type === "magicframe"
      ? {
          ...element,
          children: context
            .filter((child) => child.frameId === element.id)
            .map((child) => child.id),
        }
      : element,
  );
  let converted: SceneElement[] = convertToExcalidrawElements(
    clone([...skeletons, ...existing]) as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
  // 0.18.1's converter establishes bindings but leaves endpoints at the
  // supplied coordinates (and offsets points by 0.5). Project omitted ends
  // after labels have established the shapes' actual dimensions.
  const sources = new Map(
    (skeletons as Record<string, any>[]).map((e) => [e.id, e]),
  );
  const byId = new Map(converted.map((e) => [e.id, e]));
  const projected = new Set<string>();
  converted = converted.map((element) => {
    const source = sources.get(element.id);
    if (!source || (element.type !== "arrow" && element.type !== "line"))
      return element;
    const start =
      !!source.start &&
      source.x === undefined &&
      source.y === undefined &&
      !source.points;
    const end =
      !!source.end &&
      !source.points &&
      source.width === undefined &&
      source.height === undefined;
    const startShape = byId.get(source.start?.id),
      endShape = byId.get(source.end?.id);
    const x =
      source.x ??
      (startShape ? startShape.x + startShape.width / 2 : element.x);
    const y =
      source.y ??
      (startShape ? startShape.y + startShape.height / 2 : element.y);
    const points = source.points ?? [
      [0, 0],
      [
        source.width ?? (endShape ? endShape.x + endShape.width / 2 - x : 100),
        source.height ?? (endShape ? endShape.y + endShape.height / 2 - y : 0),
      ],
    ];
    const next = projectBindings(
      { ...element, x, y, points },
      byId,
      start,
      end,
    );
    projected.add(next.id);
    return next;
  });
  // Re-center labels after changing arrow geometry, using the package's text
  // measurement/restoration rather than approximating font metrics in Node.
  if (projected.size) {
    const restored = restoreTouched(converted, [...projected]);
    const patches = new Map(restored.map((e) => [e.id, e]));
    converted = converted.map((e) => patches.get(e.id) ?? e);
  }
  const contextPatches: ConvertResult["contextPatches"] = [];
  for (const element of converted) {
    const original = previous.get(element.id);
    if (
      original &&
      JSON.stringify(original.boundElements) !==
        JSON.stringify(element.boundElements)
    ) {
      contextPatches.push({
        id: element.id,
        boundElements: element.boundElements,
      });
    }
  }
  return {
    elements: converted.filter((element) => !previous.has(element.id)),
    contextPatches,
  };
}
function restoreTouched(
  elements: SceneElement[],
  touchedIds: string[],
): SceneElement[] {
  const ids = new Set(touchedIds);
  const originals = new Map(elements.map((element) => [element.id, element]));
  for (const element of elements) {
    if (ids.has(element.id)) {
      for (const binding of element.boundElements ?? [])
        if (binding.type === "text") ids.add(binding.id);
    }
  }
  const restored: SceneElement[] = restoreElements(clone(elements), null, {
    refreshDimensions: true,
    repairBindings: true,
  });
  return restored
    .filter((element) => ids.has(element.id))
    .map((element) => keepVersion(element, originals.get(element.id)));
}
function selected(req: RenderRequest): SceneElement[] {
  const elements = req.elements.filter((element) => !element.isDeleted);
  const ids = req.options.elementIds
    ? new Set(req.options.elementIds)
    : undefined;
  const region = req.options.region;
  const chosen = new Set(
    elements
      .filter((element) => {
        if (ids && !ids.has(element.id)) return false;
        if (!region) return true;
        const [x1, y1, x2, y2] = getCommonBounds([element]);
        return (
          x1 <= region.x + region.width &&
          x2 >= region.x &&
          y1 <= region.y + region.height &&
          y2 >= region.y
        );
      })
      .map((element) => element.id),
  );
  for (const element of elements) {
    if (chosen.has(element.id)) {
      for (const binding of element.boundElements ?? [])
        if (binding.type === "text") chosen.add(binding.id);
    }
  }
  return elements.filter((element) => chosen.has(element.id));
}
function exportArgs(req: RenderRequest) {
  return {
    elements: selected(req),
    files: clone(req.files),
    exportPadding: req.options.padding ?? 20,
    appState: {
      exportBackground: req.options.background ?? true,
      viewBackgroundColor: "#ffffff",
      theme: req.options.theme ?? "light",
      exportWithDarkMode: req.options.theme === "dark",
    },
  };
}
window.exidrawRenderer = {
  ping: () => "0.18.1",
  convertSkeletons,
  restoreTouched,
  async exportPng(req) {
    await document.fonts.ready;
    let width = 0;
    let height = 0;
    let scale = req.options.scale ?? RENDER_DEFAULT_SCALE;
    const blob = await exportToBlob({
      ...exportArgs(req),
      getDimensions(w: number, h: number) {
        // Canvas truncates fractional dimensions. Floor here too so reported
        // dimensions match the PNG and never exceed either rendering limit.
        w = Math.max(1, w);
        h = Math.max(1, h);
        scale = Math.min(
          scale,
          RENDER_MAX_EDGE_PX / w,
          RENDER_MAX_EDGE_PX / h,
          Math.sqrt(RENDER_MAX_PIXELS / (w * h)),
        );
        width = Math.max(1, Math.floor(w * scale));
        height = Math.max(1, Math.floor(h * scale));
        return { width, height, scale };
      },
    });
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1]!);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { base64, width, height, scale };
  },
  async exportSvg(req) {
    await document.fonts.ready;
    const svg = await exportToSvg(exportArgs(req));
    return {
      svg: svg.outerHTML,
      width: Number.parseFloat(svg.getAttribute("width")!),
      height: Number.parseFloat(svg.getAttribute("height")!),
    };
  },
  async mermaid(definition, opts) {
    const diagram = await parseMermaidToExcalidraw(definition, {
      startOnLoad: false,
      maxTextSize: 100000,
      maxEdges: 5000,
      themeVariables: { fontSize: `${opts.fontSize ?? 20}px` },
    });
    // Mermaid node/edge ids are deterministic and can exceed our wire limit.
    // Let Excalidraw replace them and remap bindings for each new diagram.
    const elements: SceneElement[] = convertToExcalidrawElements(
      diagram.elements,
      {
        regenerateIds: true,
      },
    );
    if (!elements.length)
      return { elements, files: (diagram.files ?? {}) as SceneFiles };
    const [minX, minY] = getCommonBounds(elements);
    return {
      elements: elements.map((element) => ({
        ...element,
        x: element.x + opts.x - minX,
        y: element.y + opts.y - minY,
      })),
      files: (diagram.files ?? {}) as SceneFiles,
    };
  },
} satisfies RendererBridge;
