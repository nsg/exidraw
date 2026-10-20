import { expect, test, type Page } from "@playwright/test";
import { elementCount, signIn, waitForRoomLive } from "./helpers";

async function newDrawing(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New drawing" }).click();
  await page.getByLabel("Drawing name").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await waitForRoomLive(page);
}

// 4x4 red PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC";

test("a dropped image is uploaded, marked saved and downloaded by another client", async ({ browser, baseURL }) => {
  const { page, context } = await signIn(browser, "Alice Architect", baseURL!);
  await newDrawing(page, `Images ${Date.now()}`);

  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "red.png", { type: "image/png" }));
    const target = document.querySelector(".excalidraw__canvas.interactive")!;
    for (const type of ["dragover", "drop"]) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 500, clientY: 400 }));
    }
  }, PNG_B64);
  const imageStatus = (p: Page) =>
    p.evaluate(() => (window.__exidraw?.elements() as Array<{ type: string; status?: string }>).map((e) => `${e.type}:${e.status}`));
  await expect.poll(() => imageStatus(page)).toEqual(["image:saved"]);

  const other = await context.newPage();
  const download = other.waitForResponse((r) => r.url().includes("/files/") && r.request().method() === "GET");
  await other.goto(page.url());
  expect((await download).status()).toBe(200);
  await expect.poll(() => other.evaluate(() => window.__exidraw?.fileIds().length)).toBe(1);
  await context.close();
});

test("pasting HTML with an external <img> never fetches it", async ({ browser, baseURL }) => {
  const { page, context, offOrigin } = await signIn(browser, "Alice Architect", baseURL!);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await newDrawing(page, `Paste ${Date.now()}`);
  await page.mouse.click(600, 400);

  await page.evaluate(async () => {
    const html = '<p>hello</p><img src="https://example.com/x.png">';
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob(["hello world"], { type: "text/plain" }),
      }),
    ]);
  });
  await page.mouse.move(600, 400);
  await page.keyboard.press("Control+V");

  await expect.poll(() => elementCount(page)).toBe(1);
  expect(await page.evaluate(() => (window.__exidraw?.elements()[0] as { type: string }).type)).toBe("text");
  expect(offOrigin).toEqual([]);
  await context.close();
});
