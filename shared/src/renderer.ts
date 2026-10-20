/**
 * Contract between the Node server and the renderer page it drives in headless
 * Chromium (server/renderer/, bundled with esbuild and served at
 * INTERNAL_RENDERER_PATH). The page loads @excalidraw/excalidraw in a real
 * browser so text metrics, fonts, exportToSvg/exportToBlob and mermaid behave
 * exactly like in the editor.
 *
 * The page exposes `window.exidrawRenderer: RendererBridge`; the server calls
 * it with `page.evaluate`. The page is stateless between calls and never bumps
 * element versions — the server does that when merging results.
 */
import type { SceneElement, SceneFiles } from "./elements.js";

export interface RenderRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderOptions {
  /** Export only elements intersecting this region (scene coordinates). */
  region?: RenderRegion;
  /** Export only these elements (and their bound text). */
  elementIds?: string[];
  /** PNG only. Output = scene bbox * scale, capped by RENDER_MAX_* constants. */
  scale?: number;
  /** Draw the canvas background (default true). */
  background?: boolean;
  theme?: "light" | "dark";
  /** px around the content (default 20) */
  padding?: number;
}

export interface RenderRequest {
  elements: SceneElement[];
  files: SceneFiles;
  options: RenderOptions;
}

export interface PngResult {
  /** base64 of PNG bytes */
  base64: string;
  width: number;
  height: number;
  /** scale actually used after capping */
  scale: number;
}

export interface SvgResult {
  svg: string;
  width: number;
  height: number;
}

export interface ConvertResult {
  /**
   * Converted elements for the skeletons (containers + their bound text,
   * arrows, frames...) in scene order. Existing elements that were passed as
   * `context` are NOT included; instead `contextPatches` carries the fields of
   * those that changed (currently only `boundElements`) so the server can merge.
   */
  elements: SceneElement[];
  contextPatches: Array<{ id: string; boundElements: SceneElement["boundElements"] }>;
}

export interface RendererBridge {
  /** Sanity call; returns the package version. */
  ping(): string;

  /**
   * convertToExcalidrawElements(skeletons, { regenerateIds: false }). `context`
   * are existing scene elements that skeletons may reference by id (arrow
   * start/end, frame children); they are appended to the batch so bindings
   * resolve. Skeleton ids must not collide with existing ids (server checks).
   */
  convertSkeletons(skeletons: unknown[], context: SceneElement[]): ConvertResult;

  /**
   * restoreElements(elements, null, { refreshDimensions: true, repairBindings: true })
   * applied to a scene; returns only elements whose id is in `touchedIds` (plus
   * any bound text of those). Used after text/font edits so sizes are
   * re-measured with real fonts.
   */
  restoreTouched(elements: SceneElement[], touchedIds: string[]): SceneElement[];

  exportPng(req: RenderRequest): Promise<PngResult>;
  exportSvg(req: RenderRequest): Promise<SvgResult>;

  /**
   * @excalidraw/mermaid-to-excalidraw parseMermaidToExcalidraw → skeletons →
   * convertSkeletons. Elements are translated so their bbox's top-left is at
   * (x, y). `files` holds rasterised fallbacks (mermaid produces images for
   * unsupported diagram types).
   */
  mermaid(definition: string, opts: { x: number; y: number; fontSize?: number }): Promise<{ elements: SceneElement[]; files: SceneFiles }>;
}

declare global {
  interface Window {
    exidrawRenderer?: RendererBridge;
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}
