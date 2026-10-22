import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { drawRectangle, elementCount, signIn, waitForRoomLive } from "./helpers";

const FIXTURE = join(import.meta.dirname, "fixtures", "diagram.excalidraw");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  elements: Array<{ id: string; isDeleted: boolean; groupIds: string[] }>;
  files: Record<string, unknown>;
};
const FIXTURE_LIVE = fixture.elements.filter((e) => !e.isDeleted).length; // 5
const FIXTURE_IDS = new Set(fixture.elements.map((e) => e.id));
const FIXTURE_GROUPS = new Set(fixture.elements.flatMap((e) => e.groupIds));
const IMAGE_FILE_ID = Object.keys(fixture.files)[0]!;

type El = {
  id: string;
  type: string;
  status?: string;
  index: string;
  groupIds: string[];
  containerId?: string | null;
  startBinding?: { elementId: string } | null;
};
const elements = (page: Page) => page.evaluate(() => window.__exidraw!.elements() as unknown as El[]);
const hasFile = (page: Page, id: string) => page.evaluate((f) => window.__exidraw!.fileIds().includes(f), id);

async function newFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function newDrawing(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New drawing" }).click();
  await page.getByLabel("Drawing name").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await waitForRoomLive(page);
}

async function openInsertDialog(page: Page) {
  await page.getByTestId("main-menu-trigger").click();
  await page.getByText("Insert drawing…").click();
  const dialog = page.getByRole("dialog", { name: "Insert drawing" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Synthetic file drop on the canvas, like the image test in room-content.spec. */
async function dropFile(
  page: Page,
  text: string,
  name: string,
  type: string,
  at = { x: 700, y: 500 },
  selector = ".excalidraw__canvas.interactive",
): Promise<void> {
  await page.evaluate(
    ({ text, name, type, at, selector }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, { type }));
      const target = document.querySelector(selector)!;
      for (const ev of ["dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(ev, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
      }
    },
    { text, name, type, at, selector },
  );
}

/** The inserted elements are exactly the ones whose ids were not there before. */
function inserted(before: El[], after: El[]): El[] {
  const old = new Set(before.map((e) => e.id));
  return after.filter((e) => !old.has(e.id));
}

function expectFreshCopy(added: El[]): void {
  expect(added).toHaveLength(FIXTURE_LIVE);
  for (const e of added) expect(FIXTURE_IDS.has(e.id)).toBe(false);
  // one new outermost group around the whole insert
  const outer = added[0]!.groupIds.at(-1)!;
  expect(FIXTURE_GROUPS.has(outer)).toBe(false);
  for (const e of added) expect(e.groupIds.at(-1)).toBe(outer);
  // bound text and arrow bindings point at the copies
  const ids = new Set(added.map((e) => e.id));
  const label = added.find((e) => e.type === "text")!;
  const arrow = added.find((e) => e.type === "arrow")!;
  expect(ids.has(label.containerId!)).toBe(true);
  expect(ids.has(arrow.startBinding!.elementId)).toBe(true);
}

test("uploading a .excalidraw file creates a drawing with its elements and image", async ({ browser, baseURL }) => {
  const { page, context, offOrigin } = await signIn(browser, "Alice Architect", baseURL!);
  await newFolder(page, `Upload ${Date.now()}`);

  await page.getByLabel("Upload drawings").setInputFiles(FIXTURE);
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]+$/);
  await expect(page.getByRole("heading", { name: "diagram" })).toBeVisible();
  await waitForRoomLive(page);
  await expect.poll(() => elementCount(page)).toBe(FIXTURE_LIVE);
  await expect.poll(() => hasFile(page, IMAGE_FILE_ID)).toBe(true);
  const els = await elements(page);
  expect(els.find((e) => e.type === "image")?.status).toBe("saved");
  expect(els.map((e) => e.type).sort()).toEqual(["arrow", "ellipse", "image", "rectangle", "text"]);

  // A second client downloads the stored image from the server.
  const other = await context.newPage();
  const download = other.waitForResponse((r) => r.url().includes(`/files/${IMAGE_FILE_ID}`) && r.request().method() === "GET");
  await other.goto(page.url());
  expect((await download).status()).toBe(200);
  await expect.poll(() => hasFile(other, IMAGE_FILE_ID)).toBe(true);

  expect(offOrigin).toEqual([]);
  await context.close();
});

test("uploading several files stays in the folder and reports each file", async ({ browser, baseURL }) => {
  const { page, context } = await signIn(browser, "Alice Architect", baseURL!);
  await newFolder(page, `Batch ${Date.now()}`);
  const buffer = readFileSync(FIXTURE);
  await page.getByLabel("Upload drawings").setInputFiles([
    { name: "first.excalidraw", mimeType: "", buffer },
    { name: "second.excalidraw.json", mimeType: "application/json", buffer },
    { name: "notes.excalidraw", mimeType: "", buffer: Buffer.from("hello") },
  ]);
  await expect(page.getByText("Uploaded 2 drawings")).toBeVisible();
  await expect(page.getByText("“notes.excalidraw” is not an Excalidraw drawing.")).toBeVisible();
  await expect(page.getByTestId("node-room")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "first" })).toBeVisible();
  await expect(page.getByRole("link", { name: "second" })).toBeVisible();
  await context.close();
});

test("inserting a drawing from a file or by dropping it adds a grouped copy that collaborators see", async ({ browser, baseURL }) => {
  const alice = await signIn(browser, "Alice Architect", baseURL!);
  const second = await signIn(browser, "Alice Architect", baseURL!);
  await newDrawing(alice.page, `Insert ${Date.now()}`);
  await drawRectangle(alice.page, 300, 250);
  await expect.poll(() => elementCount(alice.page)).toBe(1);
  await second.page.goto(alice.page.url());
  await waitForRoomLive(second.page);
  await expect.poll(() => elementCount(second.page)).toBe(1);
  const before = await elements(alice.page);

  const dialog = await openInsertDialog(alice.page);
  await dialog.getByLabel("Drawing file").setInputFiles(FIXTURE);
  await expect(dialog).toBeHidden();
  await expect(alice.page.getByText("Inserted “diagram”")).toBeVisible();
  await expect.poll(() => elementCount(alice.page)).toBe(1 + FIXTURE_LIVE);
  const after = await elements(alice.page);
  const added = inserted(before, after);
  expectFreshCopy(added);
  // on top of what was there
  for (const e of added) expect(e.index > before[0]!.index).toBe(true);

  await expect.poll(() => elementCount(second.page)).toBe(1 + FIXTURE_LIVE);
  expect((await elements(second.page)).map((e) => e.id).sort()).toEqual(after.map((e) => e.id).sort());
  await expect.poll(() => hasFile(second.page, IMAGE_FILE_ID)).toBe(true);

  // Dropping the file on the canvas inserts another copy instead of replacing the scene.
  await dropFile(alice.page, readFileSync(FIXTURE, "utf8"), "diagram.excalidraw", "");
  await expect.poll(() => elementCount(alice.page)).toBe(1 + 2 * FIXTURE_LIVE);
  const afterDrop = await elements(alice.page);
  const dropped = inserted(after, afterDrop);
  expectFreshCopy(dropped);
  expect(dropped[0]!.groupIds.at(-1)).not.toBe(added[0]!.groupIds.at(-1));
  await expect.poll(() => elementCount(second.page)).toBe(1 + 2 * FIXTURE_LIVE);

  // Files are judged by content: a scene renamed to .txt is inserted too, never opened in place.
  await dropFile(alice.page, readFileSync(FIXTURE, "utf8"), "notes.txt", "text/plain", { x: 400, y: 300 });
  await expect.poll(() => elementCount(alice.page)).toBe(1 + 3 * FIXTURE_LIVE);
  expectFreshCopy(inserted(afterDrop, await elements(alice.page)));
  await expect.poll(() => elementCount(second.page)).toBe(1 + 3 * FIXTURE_LIVE);

  // Undo removes the last insert as one step.
  await alice.page.keyboard.press("Control+Z");
  await expect.poll(() => elementCount(alice.page)).toBe(1 + 2 * FIXTURE_LIVE);

  // A shape library dropped as .json goes to the (per-browser) library, not the scene.
  const library = {
    type: "excalidrawlib",
    version: 2,
    source: "test",
    libraryItems: [{ id: "lib-item", status: "unpublished", created: 1, elements: [fixture.elements[2]] }],
  };
  await dropFile(alice.page, JSON.stringify(library), "shapes.json", "application/json");
  await expect(alice.page.getByText("Added “shapes.json” to your library")).toBeVisible();
  await expect.poll(() => alice.page.evaluate(() => localStorage.getItem("exidraw.library") ?? "")).toContain("lib-item");
  expect(await elementCount(alice.page)).toBe(1 + 2 * FIXTURE_LIVE);

  expect(alice.offOrigin).toEqual([]);
  await alice.context.close();
  await second.context.close();
});

test("inserting from another drawing via search", async ({ browser, baseURL }) => {
  const { page, context } = await signIn(browser, "Alice Architect", baseURL!);
  await newFolder(page, `Source ${Date.now()}`);
  const folderUrl = page.url();
  const sourceName = `source-${Date.now()}`;
  await page.getByLabel("Upload drawings").setInputFiles({ name: `${sourceName}.excalidraw`, mimeType: "", buffer: readFileSync(FIXTURE) });
  await waitForRoomLive(page);
  await expect.poll(() => hasFile(page, IMAGE_FILE_ID)).toBe(true);
  const sourceIds = new Set((await elements(page)).map((e) => e.id));

  await page.goto(folderUrl);
  await newDrawing(page, "Target");
  const dialog = await openInsertDialog(page);
  await dialog.getByRole("tab", { name: "From another drawing" }).click();
  // The picker opens on this drawing's folder, which holds the source.
  await expect(dialog.getByRole("button", { name: sourceName })).toBeVisible();
  await dialog.getByLabel("Search drawings").fill(sourceName);
  await dialog.getByRole("button", { name: sourceName }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`Inserted “${sourceName}”`)).toBeVisible();

  await expect.poll(() => elementCount(page)).toBe(FIXTURE_LIVE);
  const els = await elements(page);
  for (const e of els) expect(sourceIds.has(e.id)).toBe(false);
  const outer = els[0]!.groupIds.at(-1);
  for (const e of els) expect(e.groupIds.at(-1)).toBe(outer);
  // The image bytes came with the export and are stored in this room too.
  await expect.poll(() => elements(page).then((all) => all.find((e) => e.type === "image")?.status)).toBe("saved");

  await page.reload();
  await waitForRoomLive(page);
  await expect.poll(() => elementCount(page)).toBe(FIXTURE_LIVE);
  await expect.poll(() => hasFile(page, IMAGE_FILE_ID)).toBe(true);
  await context.close();
});

test("a drawing dropped on one of Excalidraw's dialogs does not replace the scene", async ({ browser, baseURL }) => {
  const { page, context } = await signIn(browser, "Alice Architect", baseURL!);
  await newDrawing(page, `Portal ${Date.now()}`);
  await drawRectangle(page, 300, 250);
  await expect.poll(() => elementCount(page)).toBe(1);
  const before = await elements(page);

  // The help dialog lives in a portal on <body>, outside the editor's DOM.
  await page.keyboard.press("Shift+?");
  const help = page.locator(".excalidraw-modal-container .Dialog");
  await expect(help).toBeVisible();
  await dropFile(page, readFileSync(FIXTURE, "utf8"), "diagram.excalidraw", "", { x: 640, y: 400 }, ".excalidraw-modal-container .Dialog");
  await page.waitForTimeout(1_000);
  expect((await elements(page)).map((e) => e.id)).toEqual(before.map((e) => e.id));
  await context.close();
});
