import { describe, expect, it } from "vitest";
import { MAX_NAME_LENGTH, isElementEnvelope } from "@exidraw/shared";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import { ImportError, drawingNameFromFile, pickScene, skippedNote, uploadElements } from "./importing";

function el(id: string, type: string, extra: Record<string, unknown> = {}): ExcalidrawElement {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    groupIds: [],
    frameId: null,
    boundElements: null,
    index: "a0",
    version: 3,
    versionNonce: 7,
    updated: 1,
    isDeleted: false,
    ...extra,
  } as unknown as ExcalidrawElement;
}

describe("drawingNameFromFile", () => {
  it.each([
    ["diagram.excalidraw.png", "diagram"],
    ["x.excalidraw", "x"],
    ["plan.excalidraw.svg", "plan"],
    ["export.JSON", "export"],
    ["Q3.2024 roadmap.excalidraw", "Q3.2024 roadmap"],
    ["  spaced name .excalidraw", "spaced name"],
    ["C:\\fakepath\\board.excalidraw", "board"],
    [".excalidraw", "Untitled"],
    ["", "Untitled"],
  ])("%j → %j", (file, name) => {
    expect(drawingNameFromFile(file)).toBe(name);
  });

  it("cuts long names to the server limit", () => {
    const name = drawingNameFromFile(`${"a".repeat(MAX_NAME_LENGTH + 30)}.excalidraw`);
    expect(name).toHaveLength(MAX_NAME_LENGTH);
  });
});

describe("pickScene", () => {
  it("drops deleted elements and embedded web pages with their text, and every reference to them", () => {
    const { elements, skippedWebPages } = pickScene({
      elements: [
        el("page", "iframe", { boundElements: [{ id: "caption", type: "text" }, { id: "arrow", type: "arrow" }], customData: { generationData: { status: "done", html: "<script>…</script>" } } }),
        el("caption", "text", { containerId: "page" }),
        el("arrow", "arrow", { startBinding: { elementId: "page", focus: 0, gap: 1 }, endBinding: { elementId: "box", focus: 0, gap: 1 } }),
        el("box", "rectangle", { frameId: "page", boundElements: [{ id: "arrow", type: "arrow" }] }),
        el("site", "embeddable", { link: "https://example.com" }),
        el("old", "rectangle", { isDeleted: true }),
      ],
      files: {},
    });
    expect(skippedWebPages).toBe(1);
    expect(elements.map((e) => e.id)).toEqual(["arrow", "box", "site"]);
    const [arrow, box] = elements as unknown as Array<Record<string, unknown>>;
    expect(arrow!.startBinding).toBeNull();
    expect(arrow!.endBinding).toEqual({ elementId: "box", focus: 0, gap: 1 });
    expect(box!.frameId).toBeNull();
    expect(box!.boundElements).toEqual([{ id: "arrow", type: "arrow" }]);
    expect(skippedNote({ skippedWebPages })).toBe("1 embedded web page was skipped");
    expect(skippedNote({ skippedWebPages: 2 })).toBe("2 embedded web pages were skipped");
    expect(skippedNote({ skippedWebPages: 0 })).toBe("");
  });

  it("keeps only referenced files whose data URL is an accepted base64 image", () => {
    const file = (id: string, dataURL: string, mimeType = "image/png") => ({ id, dataURL, mimeType, created: 5 });
    const files = {
      png: file("png", "data:image/png;base64,iVBORw0KGgo="),
      svg: file("svg", "data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+", "image/svg+xml"),
      remote: file("remote", "https://example.com/x.png"),
      html: file("html", "data:text/html;base64,PGh0bWw+"),
      plain: file("plain", "data:image/svg+xml,<svg/>", "image/svg+xml"),
      unused: file("unused", "data:image/png;base64,iVBORw0KGgo="),
    } as unknown as BinaryFiles;
    const images = ["png", "svg", "remote", "html", "plain", "missing"].map((id) => el(`i-${id}`, "image", { fileId: id, status: "saved" }));
    const scene = pickScene({ elements: images, files });
    expect(Object.keys(scene.files).sort()).toEqual(["png", "svg"]);
    expect(scene.files.svg!.mimeType).toBe("image/svg+xml");
    // the elements stay (they show a placeholder)
    expect(scene.elements).toHaveLength(6);
  });
});

describe("uploadElements", () => {
  it("repairs metadata the server checks and leaves valid values alone", () => {
    const [bad, good] = uploadElements(
      [
        el("bad", "rectangle", { versionNonce: 0.5, version: 2.5, updated: undefined, index: "x".repeat(65) }),
        el("good", "rectangle", { versionNonce: -12, version: 9, updated: 77, index: "a1" }),
      ],
      "f.excalidraw",
    ) as Array<Record<string, unknown>>;
    expect(bad!.version).toBe(1);
    expect(Number.isInteger(bad!.versionNonce)).toBe(true);
    expect(typeof bad!.updated).toBe("number");
    expect(bad!.index).toBeNull();
    expect(isElementEnvelope(bad)).toBe(true);
    expect(good).toMatchObject({ versionNonce: -12, version: 9, updated: 77, index: "a1" });
  });

  it("names the file and element when something cannot be repaired", () => {
    expect(() => uploadElements([el("", "rectangle")], "f.excalidraw")).toThrow(
      new ImportError("invalid", "“f.excalidraw” cannot be uploaded: element number 1 is malformed."),
    );
    expect(() => uploadElements([el("a", "rectangle"), el("a", "ellipse")], "f.excalidraw")).toThrow(/element “a” appears twice/);
  });
});
