import { expect, test } from "@playwright/test";
import { drawRectangle, elementCount, grantPerson, signIn, waitForRoomLive } from "./helpers";

test("Alice and Bob collaborate live; viewer is read-only until granted editor", async ({ browser, baseURL }) => {
  const alice = await signIn(browser, "Alice Architect", baseURL!);
  const bob = await signIn(browser, "Bob Builder", baseURL!);
  const folderName = `E2E ${Date.now()}`;

  // Alice (admin) creates a folder and a drawing inside it, then draws.
  await alice.page.getByRole("button", { name: "New folder" }).click();
  await alice.page.getByLabel("Folder name").fill(folderName);
  await alice.page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await alice.page.getByRole("link", { name: folderName }).click();
  await expect(alice.page.getByRole("heading", { name: folderName })).toBeVisible();
  const folderUrl = alice.page.url();

  // Bob gets viewer on the folder (inherited by the room).
  await alice.page.getByRole("button", { name: "Share" }).click();
  await grantPerson(alice.page, "bob@example.test", "Viewer");

  await alice.page.getByRole("button", { name: "New drawing" }).click();
  await alice.page.getByLabel("Drawing name").fill("Plan");
  await alice.page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await expect(alice.page).toHaveURL(/\/r\/[A-Za-z0-9_-]+$/);
  await waitForRoomLive(alice.page);
  const roomUrl = alice.page.url();

  await drawRectangle(alice.page, 300, 250);
  await expect.poll(() => elementCount(alice.page)).toBe(1);

  // Bob opens the room: sees Alice's shape, is in view mode.
  await bob.page.goto(roomUrl);
  await waitForRoomLive(bob.page);
  await expect(bob.page.getByTestId("view-only")).toBeVisible();
  await expect.poll(() => elementCount(bob.page)).toBe(1);

  // Live: Alice draws again, Bob sees it without reloading.
  await drawRectangle(alice.page, 550, 250);
  await expect.poll(() => elementCount(bob.page)).toBe(2);

  // Bob's cursor shows up for Alice.
  await bob.page.mouse.move(700, 500);
  await bob.page.mouse.move(720, 520, { steps: 3 });
  await expect(alice.page.locator(".excalidraw .UserList__collaborator").first()).toBeVisible();

  // Bob as viewer cannot edit.
  await drawRectangle(bob.page, 300, 450);
  await alice.page.waitForTimeout(500);
  expect(await elementCount(bob.page)).toBe(2);
  expect(await elementCount(alice.page)).toBe(2);

  // Alice grants Bob editor on this one room; his view mode switches off live.
  await alice.page.getByRole("button", { name: "Share" }).click();
  await grantPerson(alice.page, "bob@example.test", "Editor");
  await expect(bob.page.getByTestId("view-only")).toBeHidden();
  await expect.poll(() => bob.page.evaluate(() => window.__exidraw?.role())).toBe("editor");

  await drawRectangle(bob.page, 300, 450);
  await expect.poll(() => elementCount(bob.page)).toBe(3);
  await expect.poll(() => elementCount(alice.page)).toBe(3);

  // Who has access: the owner sees every principal and where the role comes from; Bob only his own role.
  await alice.page.getByRole("button", { name: "Who has access" }).click();
  const aliceAccess = alice.page.getByRole("dialog", { name: /^Who has access/ });
  const bobRow = aliceAccess.getByRole("row", { name: /Bob Builder/ });
  await expect(bobRow).toContainText("Editor");
  await expect(bobRow).toContainText("Set here");
  await aliceAccess.getByRole("button", { name: "Done" }).click();
  await bob.page.getByRole("button", { name: "Who has access" }).click();
  const bobAccess = bob.page.getByRole("dialog", { name: /^Who has access/ });
  await expect(bobAccess.getByTestId("your-access")).toContainText("Editor");
  await expect(bobAccess).toContainText("Only owners can see who else has access.");
  await bobAccess.getByRole("button", { name: "Done" }).click();

  // Promoted to owner Bob sees the list; demoted live, it disappears from the open dialog.
  await alice.page.getByRole("button", { name: "Share" }).click();
  await grantPerson(alice.page, "bob@example.test", "Owner");
  await expect.poll(() => bob.page.evaluate(() => window.__exidraw?.role())).toBe("owner");
  await bob.page.getByRole("button", { name: "Who has access" }).click();
  await expect(bobAccess.getByRole("table")).toBeVisible();
  await alice.page.getByRole("button", { name: "Share" }).click();
  await grantPerson(alice.page, "bob@example.test", "Editor");
  await expect(bobAccess.getByRole("table")).toBeHidden();
  await expect(bobAccess).toContainText("Only owners can see who else has access.");
  await bobAccess.getByRole("button", { name: "Done" }).click();

  // The editor grant is on the room only: Bob still views the folder, edits the room.
  await bob.page.goto(folderUrl);
  await expect(bob.page.getByRole("navigation", { name: "Breadcrumbs" })).toContainText("Viewer");
  await expect(bob.page.getByTestId("node-room")).toContainText("Editor");

  // Reload preserves the scene.
  await alice.page.reload();
  await waitForRoomLive(alice.page);
  await expect.poll(() => elementCount(alice.page)).toBe(3);

  // The listing shows the owner who has access: the room's own grant, and the folder's in the header.
  await alice.page.goto(folderUrl);
  await expect(alice.page.getByTestId("node-room")).toContainText("Bob Builder · Editor");
  await expect(alice.page.getByRole("navigation", { name: "Breadcrumbs" })).toContainText("Bob Builder · Viewer");

  // Nothing talked to any other origin (CDNs, excalidraw.com, …).
  expect(alice.offOrigin).toEqual([]);
  expect(bob.offOrigin).toEqual([]);

  await alice.context.close();
  await bob.context.close();
});
