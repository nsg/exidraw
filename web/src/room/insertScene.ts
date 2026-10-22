/**
 * Applying an insert (./insert.ts) to the live Excalidraw scene, and routing
 * drawing files dropped on the canvas into it instead of Excalidraw's
 * "open file" behaviour.
 */
import { CaptureUpdateAction, getCommonBounds, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { MAX_ELEMENTS_PER_ROOM } from "@exidraw/shared";
import { ImportError, drawingNameFromFile, readExcalidrawFile, type DrawingData } from "../importing";
import { prepareInsert } from "./insert";

/** Same offsets as the initial fit-to-content: keep clear of the toolbar and the zoom bar. */
const CANVAS_OFFSETS = { top: 72, bottom: 64, left: 16, right: 16 };

/**
 * Add a copy of `data` on top of the scene, centred on `at` (scene
 * coordinates; default: the viewport centre), selected and undoable. Throws
 * `ImportError` when the room would exceed its element limit. Returns the
 * number of elements added.
 */
export function insertIntoScene(
  excalidraw: ExcalidrawImperativeAPI,
  data: DrawingData,
  at?: { x: number; y: number },
): number {
  const existing = excalidraw.getSceneElementsIncludingDeleted();
  const live = existing.reduce((n, e) => (e.isDeleted ? n : n + 1), 0);
  if (live + data.elements.length > MAX_ELEMENTS_PER_ROOM) {
    throw new ImportError(
      "invalid",
      `Cannot insert ${data.elements.length} elements: a drawing holds at most ${MAX_ELEMENTS_PER_ROOM.toLocaleString()}.`,
    );
  }
  const appState = excalidraw.getAppState();
  const zoom = appState.zoom.value;
  const center = at ?? {
    x: appState.width / 2 / zoom - appState.scrollX,
    y: appState.height / 2 / zoom - appState.scrollY,
  };
  const { elements, groupId, selectedElementIds } = prepareInsert(data.elements, {
    center,
    getBounds: getCommonBounds,
    links: data.sourceUrl ? { from: data.sourceUrl, to: window.location.origin + window.location.pathname } : undefined,
  });
  const files = Object.values(data.files);
  if (files.length > 0) excalidraw.addFiles(files);
  // Deleted elements stay so their tombstones are not lost; the resulting
  // onChange broadcasts the new elements like any local edit.
  excalidraw.updateScene({
    elements: [...existing, ...elements],
    appState: { selectedElementIds, selectedGroupIds: groupId ? { [groupId]: true } : {}, editingGroupId: null },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });

  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  const visibleWidth = appState.width - CANVAS_OFFSETS.left - CANVAS_OFFSETS.right;
  const visibleHeight = appState.height - CANVAS_OFFSETS.top - CANVAS_OFFSETS.bottom;
  if ((maxX - minX) * zoom > visibleWidth || (maxY - minY) * zoom > visibleHeight) {
    excalidraw.scrollToContent(elements, {
      fitToViewport: true,
      viewportZoomFactor: 0.9,
      maxZoom: zoom,
      animate: true,
      canvasOffsets: CANVAS_OFFSETS,
    });
  }
  return elements.length;
}

interface DropHandlers {
  canEdit: () => boolean;
  /** A drawing was dropped at this scene point. */
  onDrawing: (data: DrawingData, name: string, at: { x: number; y: number }) => void;
  onLibrary: (fileName: string) => void;
  onError: (message: string) => void;
}

/**
 * Excalidraw opens a dropped scene (`.excalidraw`/JSON, or a PNG/SVG export
 * with an embedded scene) by replacing the whole scene with it
 * (`handleAppOnDrop` / `loadFileToCanvas`). In a shared room that wipes the
 * local view of everyone else's work, and re-dropping an export of this room
 * bumps the versions of its elements past the collaborators' edits.
 *
 * So every file dropped on this editor is taken over (capture phase, ahead of
 * React's root listener) and classified by content, since Excalidraw sniffs
 * content too and names/mime types prove nothing: scenes are inserted as a
 * copy, libraries go to the library, and only files shown to hold no scene are
 * handed back to Excalidraw, re-typed as what was checked, for its normal
 * image insert. Everything else is rejected here.
 */
export function interceptDrawingDrops(
  excalidraw: ExcalidrawImperativeAPI,
  container: HTMLElement,
  handlers: DropHandlers,
): () => void {
  let disposed = false;
  let replaying = false;
  // The element React renders the app into (the child of <body> holding the editor).
  let appRoot: HTMLElement = container;
  while (appRoot.parentElement && appRoot.parentElement !== document.body) appRoot = appRoot.parentElement;
  const handler = (event: DragEvent) => {
    if (replaying) return;
    const target = event.target;
    const file = event.dataTransfer?.files[0];
    if (!file || !(target instanceof Node)) return;
    if (!appRoot.contains(target)) {
      // Excalidraw renders its dialogs and popovers in portals on <body>
      // (useCreatePortalContainer); React still bubbles drops there to its
      // scene-replacing drop handler. Nothing of ours lives outside the app
      // root, so file drops there are simply swallowed.
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!(target instanceof Element) || !container.contains(target) || !target.closest(".excalidraw")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const { clientX, clientY } = event;
    void (async () => {
      const contents = await readExcalidrawFile(file).catch(() => ({ kind: "invalid" }) as const);
      if (disposed) return;
      switch (contents.kind) {
        case "scene": {
          if (!handlers.canEdit()) return handlers.onError("This drawing is view only.");
          if (contents.data.elements.length === 0) return handlers.onError(`“${file.name}” is an empty drawing.`);
          const at = viewportCoordsToSceneCoords({ clientX, clientY }, excalidraw.getAppState());
          return handlers.onDrawing(contents.data, drawingNameFromFile(file.name), at);
        }
        case "library":
          await excalidraw.updateLibrary({ libraryItems: contents.libraryItems, merge: true, openLibraryMenu: true });
          if (!disposed) handlers.onLibrary(file.name);
          return;
        case "image": {
          // Only back onto the canvas the file was dropped on; the original
          // DataTransfer is no longer readable, so replay with a copy.
          if (!target.isConnected || !container.contains(target)) return;
          if (!handlers.canEdit()) return handlers.onError("This drawing is view only.");
          const transfer = new DataTransfer();
          transfer.items.add(contents.file);
          replaying = true;
          try {
            target.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true, clientX, clientY }));
          } finally {
            replaying = false;
          }
          return;
        }
        case "invalid":
          return handlers.onError(`“${file.name}” is not an Excalidraw drawing or image.`);
      }
    })().catch((err: unknown) => {
      if (!disposed) handlers.onError(err instanceof Error ? err.message : String(err));
    });
  };
  window.addEventListener("drop", handler, { capture: true });
  return () => {
    disposed = true;
    window.removeEventListener("drop", handler, { capture: true });
  };
}
