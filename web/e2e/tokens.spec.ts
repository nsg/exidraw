import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("create a token, use it as Bearer, revoke it", async ({ browser, baseURL, playwright }) => {
  const { page, context } = await signIn(browser, "Carol Viewer", baseURL!);
  await page.getByRole("link", { name: "Access tokens" }).click();

  // Generic help uses a placeholder, never a real token.
  await expect(page.locator(".agent-help").getByTestId("snippet").first()).toContainText("Bearer <your-token>");

  const name = `e2e ${Date.now()}`;
  await page.getByLabel("Token name").fill(name);
  await page.getByRole("button", { name: "Create token" }).click();
  const token = (await page.getByTestId("token-value").textContent())!;
  expect(token).toMatch(/^exi_[A-Za-z0-9_-]{43}$/);
  // Agent setup shows the real token only in the just-created card.
  const created = page.getByTestId("token-created");
  await expect(created.getByTestId("snippet").first()).toHaveText(
    `claude mcp add --transport http exidraw ${baseURL}/mcp --header "Authorization: Bearer ${token}"`,
  );
  const row = page.getByTestId("token-row").filter({ hasText: name });
  await expect(row).toContainText(token.slice(0, 12));

  // Fresh request context: no cookies, only the token.
  const bearer = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  const me = await bearer.get("/api/me");
  expect(me.status()).toBe(200);
  expect((await me.json()).user.email).toBe("carol@example.test");

  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(row).toBeHidden();
  await expect(page.getByTestId("token-created")).toBeHidden();
  expect((await bearer.get("/api/me")).status()).toBe(401);

  await bearer.dispose();
  await context.close();
});
