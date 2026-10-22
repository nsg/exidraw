/**
 * Who can reach a node: per principal, the highest role and where it comes
 * from. Server (listings) and web (access inspector) summarise with the same
 * function so they agree. See docs/ARCHITECTURE.md § Permissions.
 */
import type { GrantsResponse } from "./api.js";
import { ROLE_RANK, type Grant, type Principal, type Role } from "./roles.js";

/** The ancestor folder a role is inherited from; null = granted on the node itself. */
export type AccessSource = { kind: "folder"; id: string; name: string } | null;

export interface AccessEntry {
  /** user e-mails lower-cased */
  principal: Principal;
  /** highest role granted to this principal on the node or any ancestor */
  role: Role;
  /** nearest place granting `role` */
  from: AccessSource;
}

/** The direct grants of one node in a chain. */
export interface AccessLevel {
  from: AccessSource;
  grants: readonly Pick<Grant, "principal" | "role">[];
}

/**
 * Identity of a principal, consistent with `grantMatches` for the person a
 * linked grant belongs to: linked users (user id set) are the same only by id;
 * unlinked ones by e-mail. An unlinked grant to a linked user's current e-mail
 * is that user's (callers pass the current e-mail for linked principals, as the
 * server does). `linked` maps current e-mails to linked keys.
 */
function principalKey(p: Principal, linked: ReadonlyMap<string, string>): string {
  if (p.kind === "all") return "all";
  if (p.userId) return `u:${p.userId}`;
  const email = p.email.toLowerCase();
  return linked.get(email) ?? `e:${email}`;
}

function normalize(p: Principal): Principal {
  return p.kind === "all"
    ? { kind: "all" }
    : { kind: "user", email: p.email.toLowerCase(), userId: p.userId, displayName: p.displayName ?? null };
}

function sortKey(p: Principal): string {
  return p.kind === "all" ? "" : (p.displayName ?? p.email).toLowerCase();
}

/**
 * `levels` is the node's own grants first, then each ancestor folder's,
 * nearest first; `inherited` is an already summarised remainder of the chain
 * (farther than every level), so callers can reuse a folder's summary for
 * everything below it. Inheritance is additive (see `computeEffectiveRole`):
 * each principal gets its maximum role, and on a tie the nearest source wins.
 * Admins are not listed: they are owners everywhere without a grant.
 *
 * Sorted by role (owner first), then "all" before users, then by name.
 */
export function summarizeAccess(
  levels: readonly AccessLevel[],
  inherited: readonly AccessEntry[] = [],
): AccessEntry[] {
  const items: AccessEntry[] = [
    ...levels.flatMap((level) => level.grants.map((g) => ({ principal: g.principal, role: g.role, from: level.from }))),
    ...inherited,
  ];
  const linked = new Map<string, string>();
  for (const { principal: p } of items) {
    if (p.kind === "user" && p.userId) linked.set(p.email.toLowerCase(), `u:${p.userId}`);
  }
  const entries = new Map<string, AccessEntry>();
  for (const item of items) {
    const key = principalKey(item.principal, linked);
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, { principal: normalize(item.principal), role: item.role, from: item.from });
      continue;
    }
    if (ROLE_RANK[item.role] > ROLE_RANK[existing.role]) {
      existing.role = item.role;
      existing.from = item.from;
    }
    // Show the linked account, not an e-mail-only grant folded into it.
    if (existing.principal.kind === "user" && !existing.principal.userId && item.principal.kind === "user") {
      existing.principal = normalize(item.principal);
    }
  }
  return [...entries.values()].sort(
    (a, b) =>
      ROLE_RANK[b.role] - ROLE_RANK[a.role] ||
      sortKey(a.principal).localeCompare(sortKey(b.principal)),
  );
}

/** The summary for a `GET /api/nodes/:kind/:id/grants` response. */
export function accessFromGrants(res: Pick<GrantsResponse, "grants" | "inherited">): AccessEntry[] {
  return summarizeAccess([{ from: null, grants: res.grants }, ...res.inherited]);
}
