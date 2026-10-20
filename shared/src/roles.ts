/**
 * Permission model. The server is the only enforcer; the client uses these
 * types/helpers for UI hints only. See docs/ARCHITECTURE.md § Permissions.
 */

export type Role = "viewer" | "editor" | "owner";
export const ROLES: readonly Role[] = ["viewer", "editor", "owner"] as const;
export const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 1, editor: 2, owner: 3 };

export function isRole(x: unknown): x is Role {
  return x === "viewer" || x === "editor" || x === "owner";
}

export function roleAtLeast(have: Role | null | undefined, need: Role): boolean {
  return !!have && ROLE_RANK[have] >= ROLE_RANK[need];
}

export function maxRole(a: Role | null, b: Role | null): Role | null {
  if (!a) return b;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

export type NodeKind = "folder" | "room";
export interface NodeRef {
  kind: NodeKind;
  id: string;
}

/**
 * Who a grant applies to.
 * - `all`: every authenticated user.
 * - `user`: one person, identified by e-mail (lower-cased UPN/e-mail). `userId`
 *   is filled in once that person has logged in at least once (the server links
 *   grants by e-mail on login); matching works either way.
 */
export type Principal =
  | { kind: "all" }
  | { kind: "user"; email: string; userId: string | null; displayName?: string | null };

export interface Grant {
  id: number;
  node: NodeRef;
  principal: Principal;
  role: Role;
  createdAt: number;
  createdBy: string;
}

/** The subject a permission check is made for. */
export interface Subject {
  userId: string;
  /** lower-cased */
  email: string;
  /** From ADMIN_EMAILS. Admins are implicit owners of everything. */
  isAdmin: boolean;
}

export function grantMatches(grant: Pick<Grant, "principal">, subject: Subject): boolean {
  const p = grant.principal;
  if (p.kind === "all") return true;
  if (p.userId && p.userId === subject.userId) return true;
  return p.email.toLowerCase() === subject.email.toLowerCase();
}

/**
 * Effective role of `subject` on a node, given every grant on that node AND on
 * all of its ancestor folders (order irrelevant). Inheritance is purely
 * additive: the result is the maximum matching role along the chain; nothing
 * can revoke an inherited role. Admins are always `owner`.
 *
 * Returns null when the subject has no access at all.
 */
export function computeEffectiveRole(subject: Subject, chainGrants: readonly Pick<Grant, "principal" | "role">[]): Role | null {
  if (subject.isAdmin) return "owner";
  let best: Role | null = null;
  for (const g of chainGrants) {
    if (grantMatches(g, subject)) best = maxRole(best, g.role);
  }
  return best;
}

/** Minimum role per operation. Single source of truth for server checks and UI. */
export const REQUIRED_ROLE = {
  // nodes
  viewNode: "viewer",
  createChild: "editor", // create folder/room inside a folder
  renameNode: "editor",
  moveNode: "owner", // on the node; plus createChild on the destination folder
  deleteNode: "owner",
  readGrants: "owner",
  writeGrants: "owner",
  // room content
  readScene: "viewer",
  writeScene: "editor",
  readFile: "viewer",
  writeFile: "editor",
  listSnapshots: "viewer",
  createSnapshot: "editor",
  restoreSnapshot: "editor",
  render: "viewer",
} as const satisfies Record<string, Role>;
