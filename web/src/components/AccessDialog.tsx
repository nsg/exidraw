import { useEffect, useState } from "react";
import { REQUIRED_ROLE, ROLES, ROLE_RANK, accessFromGrants, roleAtLeast, type AccessEntry, type Role } from "@exidraw/shared";
import { api, errorMessage } from "../api";
import { Modal } from "./Modal";
import type { ShareTarget } from "./ShareDialog";
import { useMe } from "../session";
import { ROLE_LABEL, folderLabel, principalLabel, principalShortName } from "../util";

/** What each role can do, keyed by operation so the legend follows the server's checks. */
const CAPABILITIES: Array<[keyof typeof REQUIRED_ROLE, string]> = [
  ["viewNode", "open and view"],
  ["listSnapshots", "see the version history"],
  ["render", "export"],
  ["writeScene", "edit"],
  ["renameNode", "rename"],
  ["createChild", "create inside folders"],
  ["restoreSnapshot", "restore snapshots"],
  ["writeGrants", "share"],
  ["moveNode", "move"],
  ["deleteNode", "delete"],
];
const list = new Intl.ListFormat("en", { type: "conjunction" });
const LEGEND = ROLES.map((role, i) => {
  const can = CAPABILITIES.filter(([op]) => REQUIRED_ROLE[op] === role).map(([, label]) => label);
  return { role, text: `${i === 0 ? "Can" : "Also"} ${list.format(can)}.` };
});

/** Read-only view of who can reach a node; owners see everyone, others only themselves. */
export function AccessDialog({
  target,
  role,
  onManage,
  onClose,
}: {
  target: ShareTarget;
  /** the caller's effective role; null on traversal-only folders */
  role: Role | null;
  /** switch to the share dialog (owners only) */
  onManage: () => void;
  onClose: () => void;
}) {
  const { isAdmin } = useMe();
  const isOwner = roleAtLeast(role, REQUIRED_ROLE.readGrants);
  const [entries, setEntries] = useState<AccessEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Losing ownership (live role change in a room) must hide the list at once.
  useEffect(() => {
    setEntries(null);
    setError(null);
    if (!isOwner) return;
    let current = true;
    api.grants(target.kind, target.id).then(
      (res) => current && setEntries(accessFromGrants(res)),
      (err) => current && setError(errorMessage(err)),
    );
    return () => {
      current = false;
    };
  }, [isOwner, target.kind, target.id]);

  const shown = isOwner ? entries : null;

  return (
    <Modal
      title={`Who has access to “${target.name}”`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
          {roleAtLeast(role, REQUIRED_ROLE.writeGrants) && (
            <button type="button" className="btn btn--primary" onClick={onManage}>
              Manage sharing
            </button>
          )}
        </>
      }
    >
      <div className="access">
        <p data-testid="your-access">
          Your access:{" "}
          {role ? (
            <span className={`badge badge--${role}`}>{ROLE_LABEL[role]}</span>
          ) : (
            <span className="muted">none (you can only open folders inside it)</span>
          )}
          {isAdmin && <span className="muted"> as an administrator</span>}
        </p>

        <section>
          <h3>People with access</h3>
          {!isOwner && <p className="muted">Only owners can see who else has access.</p>}
          {isOwner && error && <div className="alert alert--error">{error}</div>}
          {isOwner && !entries && !error && <p className="muted">Loading…</p>}
          {shown && shown.length === 0 && <p className="muted">Nobody has been given access.</p>}
          {shown && shown.length > 0 && (
            <table className="access-table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Role</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.principal.kind === "all" ? "all" : e.principal.email}>
                    <td>
                      <span className="access-table__who">
                        <PrincipalIcon entry={e} />
                        {e.principal.kind === "user" && e.principal.displayName ? (
                          <span>
                            {e.principal.displayName} <span className="muted">{e.principal.email}</span>
                          </span>
                        ) : (
                          <span>{principalLabel(e.principal)}</span>
                        )}
                      </span>
                    </td>
                    <td>
                      <span className={`badge badge--${e.role}`}>{ROLE_LABEL[e.role]}</span>
                      <ViaEveryone entry={e} entries={shown} />
                    </td>
                    <td className="muted">{sourceLabel(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint">Administrators are always owners of everything.</p>
        </section>

        <section>
          <h3>What the roles mean</h3>
          <dl className="access-legend">
            {LEGEND.map(({ role, text }) => (
              <div key={role}>
                <dt>
                  <span className={`badge badge--${role}`}>{ROLE_LABEL[role]}</span>
                </dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </Modal>
  );
}

function sourceLabel(e: AccessEntry): string {
  return e.from ? `From folder “${folderLabel(e.from)}”` : "Set here";
}

/**
 * The higher role a person has through the "everyone" entry. Entries list what
 * each principal was granted; access adds up, so this is what they really get.
 */
function viaEveryone(e: AccessEntry, entries: readonly AccessEntry[]): Role | null {
  if (e.principal.kind === "all") return null;
  const everyone = entries.find((x) => x.principal.kind === "all");
  return everyone && ROLE_RANK[everyone.role] > ROLE_RANK[e.role] ? everyone.role : null;
}

function ViaEveryone({ entry, entries }: { entry: AccessEntry; entries: readonly AccessEntry[] }) {
  const via = viaEveryone(entry, entries);
  return via && <span className="access-table__via muted">{ROLE_LABEL[via]} via everyone</span>;
}

/** "Bob Builder (bob@…) · Viewer, set here (Editor via Everyone)" */
function entryTitle(e: AccessEntry, entries: readonly AccessEntry[]): string {
  const via = viaEveryone(e, entries);
  return `${principalLabel(e.principal)} · ${ROLE_LABEL[e.role]}, ${sourceLabel(e).toLowerCase()}${
    via ? ` (${ROLE_LABEL[via]} via Everyone)` : ""
  }`;
}

/** One line per entry, for tooltips. */
export function accessTitle(entries: readonly AccessEntry[]): string {
  if (entries.length === 0) return "Not shared with anyone";
  return entries.map((e) => entryTitle(e, entries)).join("\n");
}

/**
 * Compact chips for a listing: everyone first (never truncated away, it raises
 * everybody else), then grants set on the node, then inherited ones muted. With `sameAsFolder`, a node that adds nothing to its folder says so
 * instead of repeating the folder's access.
 */
export function AccessChips({
  entries,
  sameAsFolder = false,
  max = 3,
}: {
  entries: readonly AccessEntry[];
  sameAsFolder?: boolean;
  max?: number;
}) {
  const rank = (e: AccessEntry) => (e.principal.kind === "all" ? 0 : e.from ? 2 : 1);
  const ordered = [...entries].sort((a, b) => rank(a) - rank(b));
  if (ordered.length === 0) return <span className="muted">Not shared</span>;
  if (sameAsFolder && ordered.every((e) => e.from)) return <span className="muted">Same as folder</span>;
  const shown = ordered.slice(0, max);
  return (
    <span className="chips">
      {shown.map((e) => (
        <span
          key={e.principal.kind === "all" ? "all" : e.principal.email}
          className={`chip${e.from ? " chip--inherited" : ""}`}
          title={entryTitle(e, entries)}
        >
          <PrincipalIcon entry={e} />
          <span className="chip__name">{principalShortName(e.principal)}</span>{" "}
          <span className="chip__role">· {ROLE_LABEL[e.role]}</span>
        </span>
      ))}
      {ordered.length > shown.length && <span className="muted chips__more">+{ordered.length - shown.length} more</span>}
    </span>
  );
}

function PrincipalIcon({ entry }: { entry: AccessEntry }) {
  return entry.principal.kind === "all" ? <EveryoneIcon /> : <PersonIcon />;
}

function PersonIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" width="14" height="14" aria-hidden>
      <circle cx="10" cy="7" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.8 17c.6-3.2 3.1-5 6.2-5s5.6 1.8 6.2 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function EveryoneIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" width="14" height="14" aria-hidden>
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 10h14M10 3c2 2 2.8 4.4 2.8 7s-.8 5-2.8 7c-2-2-2.8-4.4-2.8-7S8 5 10 3z" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** Two people: the "who has access" button. */
export function PeopleIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden>
      <circle cx="7.5" cy="7" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.5 16.5c.5-2.8 2.5-4.4 5-4.4s4.5 1.6 5 4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12.6 4.5a2.8 2.8 0 0 1 0 5.2M14.6 12.4c1.5.6 2.6 2 2.9 4.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
