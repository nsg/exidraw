import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

export type DevUser = "Alice Architect" | "Bob Builder" | "Carol Viewer" | "Dave Visitor";

/** New browser context signed in through the dev login picker. */
export async function signIn(browser: Browser, user: DevUser, baseURL: string): Promise<{ context: BrowserContext; page: Page; offOrigin: string[] }> {
  const context = await browser.newContext({ baseURL });
  const offOrigin = trackOffOriginRequests(context, baseURL);
  const page = await context.newPage();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("button", { name: new RegExp(user) }).click();
  await expect(page.getByTestId("current-user")).toContainText(user);
  return { context, page, offOrigin };
}

/** Collects every request that leaves the app's origin (data:/blob: are local). */
export function trackOffOriginRequests(context: BrowserContext, baseURL: string): string[] {
  const origin = new URL(baseURL).origin;
  const offenders: string[] = [];
  context.on("request", (req) => {
    const url = new URL(req.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (url.origin !== origin) offenders.push(req.url());
  });
  return offenders;
}

export async function elementCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__exidraw?.elements().length ?? -1);
}

export async function waitForRoomLive(page: Page): Promise<void> {
  await expect(page.getByTestId("connection-status")).toHaveText("Live");
}

/** Draw a rectangle by keyboard shortcut + drag on the canvas (page coordinates). */
export async function drawRectangle(page: Page, x: number, y: number, w = 160, h = 90): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + w / 2, y + h / 2, { steps: 4 });
  await page.mouse.move(x + w, y + h, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
}

/** Share dialog: add (or update) one person by e-mail and save. */
export async function grantPerson(page: Page, email: string, role: "Viewer" | "Editor" | "Owner"): Promise<void> {
  const dialog = page.getByRole("dialog", { name: /^Share / });
  await dialog.getByLabel("Add person by e-mail").fill(email);
  await dialog.getByLabel("Role for new person").selectOption({ label: role });
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

declare global {
  interface Window {
    __exidraw?: { elements: () => readonly unknown[]; fileIds: () => string[]; role: () => string; status: () => string };
  }
}
