import { describe, expect, test } from "vitest";
import { summarizeAccess, type AccessLevel, type Grant } from "../src/index.js";

type G = Pick<Grant, "principal" | "role">;
const all = (role: G["role"]): G => ({ principal: { kind: "all" }, role });
const user = (email: string, role: G["role"], userId: string | null = null, displayName?: string): G => ({
  principal: { kind: "user", email, userId, ...(displayName ? { displayName } : {}) },
  role,
});
const folder = (id: string) => ({ kind: "folder" as const, id, name: id.toUpperCase() });
const chain = (...levels: Array<[AccessLevel["from"], G[]]>): AccessLevel[] =>
  levels.map(([from, grants]) => ({ from, grants }));

describe("summarizeAccess", () => {
  test("keeps the highest role per principal across the chain, with its source", () => {
    const entries = summarizeAccess(
      chain([null, [user("bob@x", "viewer")]], [folder("projects"), [user("bob@x", "editor"), all("viewer")]]),
    );
    expect(entries).toEqual([
      { principal: { kind: "user", email: "bob@x", userId: null, displayName: null }, role: "editor", from: folder("projects") },
      { principal: { kind: "all" }, role: "viewer", from: folder("projects") },
    ]);
  });

  test("names the nearest source when several give the same role", () => {
    const [entry] = summarizeAccess(chain([null, []], [folder("bridge"), [all("editor")]], [folder("root"), [all("editor")]]));
    expect(entry!.from).toEqual(folder("bridge"));
  });

  test("a direct grant at the maximum role is reported as set here", () => {
    const [entry] = summarizeAccess(chain([null, [all("owner")]], [folder("root"), [all("owner")]]));
    expect(entry!.from).toBeNull();
  });

  test("matches users by e-mail case-insensitively and keeps the linked account details", () => {
    const entries = summarizeAccess(
      chain([null, [user("Dave@X", "viewer")]], [folder("root"), [user("dave@x", "owner", "u-dave", "Dave Doe")]]),
    );
    expect(entries).toEqual([
      { principal: { kind: "user", email: "dave@x", userId: "u-dave", displayName: "Dave Doe" }, role: "owner", from: folder("root") },
    ]);
  });

  test("matches users by user id when the e-mails differ", () => {
    const entries = summarizeAccess(chain([null, [user("old@x", "editor", "u1")]], [folder("root"), [user("new@x", "viewer", "u1")]]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ role: "editor", from: null });
  });

  test("does not merge a renamed user with a grant to their old, now unlinked address", () => {
    const entries = summarizeAccess(
      chain([null, [user("new@x", "viewer", "u-bob", "Bob")]], [folder("root"), [user("old@x", "owner")]]),
    );
    expect(entries.map((e) => [e.principal.kind === "user" && e.principal.email, e.role])).toEqual([
      ["old@x", "owner"],
      ["new@x", "viewer"],
    ]);
  });

  test("an already summarised remainder of the chain counts as farther than every level", () => {
    const inherited = summarizeAccess(chain([folder("projects"), [all("editor"), user("bob@x", "owner")]]));
    const entries = summarizeAccess(chain([null, [all("editor"), user("bob@x", "viewer")]]), inherited);
    expect(entries).toEqual([
      { principal: { kind: "user", email: "bob@x", userId: null, displayName: null }, role: "owner", from: folder("projects") },
      { principal: { kind: "all" }, role: "editor", from: null },
    ]);
  });

  test("keeps everyone and individual users apart, sorted by role then everyone first then name", () => {
    const entries = summarizeAccess(
      chain([null, [user("zed@x", "viewer", "u-z", "Zed"), user("amy@x", "viewer"), all("viewer"), user("own@x", "owner")]]),
    );
    expect(entries.map((e) => (e.principal.kind === "all" ? "all" : e.principal.email))).toEqual([
      "own@x",
      "all",
      "amy@x",
      "zed@x",
    ]);
  });
});
