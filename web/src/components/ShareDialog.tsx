import { useEffect, useId, useMemo, useState } from "react";
import { ROLES, ROLE_RANK, type GrantInput, type GrantsResponse, type NodeKind, type Role, type UserInfo } from "@exidraw/shared";
import { api, errorMessage } from "../api";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";
import { ROLE_LABEL, absoluteUrl, copyText, folderLabel, principalLabel } from "../util";
import { PersonFace, RoleMark } from "./AccessDialog";
import { LinkIcon } from "../folder/icons";
import { CrossIcon, PencilLoader, PencilRule } from "../sketch/Paper";

export interface ShareTarget {
  kind: NodeKind;
  id: string;
  name: string;
  /** room page path, for "copy link" */
  linkPath?: string;
}

interface PersonRow {
  email: string;
  label: string;
  /** for their initials, when known */
  name?: string;
  role: Role;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ShareDialog({
  target,
  onClose,
  onSaved,
}: {
  target: ShareTarget;
  onClose: () => void;
  /** after the grants were saved, e.g. to reload a listing showing access */
  onSaved?: () => void;
}) {
  const notify = useToast();
  const [data, setData] = useState<GrantsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allRole, setAllRole] = useState<Role | "">("");
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("viewer");
  const [suggestions, setSuggestions] = useState<UserInfo[]>([]);
  const listId = useId();

  useEffect(() => {
    api.grants(target.kind, target.id).then(
      (res) => {
        setData(res);
        const all = res.grants.find((g) => g.principal.kind === "all");
        setAllRole(all?.role ?? "");
        // Two grants can show one address (a linked user's current e-mail); keep the higher role.
        const byEmail = new Map<string, PersonRow>();
        for (const g of res.grants) {
          if (g.principal.kind !== "user") continue;
          const known = byEmail.get(g.principal.email);
          if (!known || ROLE_RANK[g.role] > ROLE_RANK[known.role]) {
            byEmail.set(g.principal.email, {
              email: g.principal.email,
              label: principalLabel(g.principal),
              ...(g.principal.displayName ? { name: g.principal.displayName } : {}),
              role: g.role,
            });
          }
        }
        setPeople([...byEmail.values()]);
      },
      (err) => setError(errorMessage(err)),
    );
  }, [target.kind, target.id]);

  // User directory suggestions for the "add person" field.
  useEffect(() => {
    const q = newEmail.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api.users(q).then((r) => setSuggestions(r.users), () => setSuggestions([]));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [newEmail]);

  const addPerson = () => {
    const email = newEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      notify("Enter a valid e-mail address.", "error");
      return;
    }
    const known = suggestions.find((u) => u.email === email);
    setPeople((rows) => {
      const label = known ? `${known.name} (${known.email})` : email;
      const existing = rows.findIndex((r) => r.email === email);
      if (existing >= 0) return rows.map((r, i) => (i === existing ? { ...r, role: newRole } : r));
      return [...rows, { email, label, ...(known ? { name: known.name } : {}), role: newRole }];
    });
    setNewEmail("");
    setDirty(true);
  };

  const save = async () => {
    const grants: GrantInput[] = [
      ...(allRole ? [{ kind: "all" as const, role: allRole }] : []),
      ...people.map((p) => ({ kind: "user" as const, email: p.email, role: p.role })),
    ];
    setSaving(true);
    try {
      await api.putGrants(target.kind, target.id, { grants });
      notify("Sharing updated", "success");
      onSaved?.();
      onClose();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const inherited = useMemo(() => data?.inherited.filter((i) => i.grants.length > 0) ?? [], [data]);

  return (
    <Modal
      title={`Share “${target.name}”`}
      onClose={onClose}
      wide
      footer={
        <>
          {target.linkPath && (
            <button
              type="button"
              className="sketch-btn sketch-btn--quiet modal__footer-left"
              onClick={async () => {
                if (await copyText(absoluteUrl(target.linkPath!))) notify("Link copied", "success");
              }}
            >
              <LinkIcon />
              Copy link
            </button>
          )}
          <button type="button" className="sketch-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="sketch-btn sketch-btn--primary" disabled={!dirty || saving || !data} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {error && <div className="alert alert--error">{error}</div>}
      {!data && !error && <PencilLoader className="pencil-loader--small" />}
      {data && (
        <div className="share">
          <section>
            <h3>General access</h3>
            <label className="field field--inline">
              <span>Everyone signed in</span>
              <select
                className="sketch-select"
                aria-label="General access"
                value={allRole}
                onChange={(e) => {
                  setAllRole(e.target.value as Role | "");
                  setDirty(true);
                }}
              >
                <option value="">No access</option>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section>
            <h3>People</h3>
            {people.length === 0 && <p className="muted">No one has been added to this {target.kind} directly.</p>}
            <ul className="share__people">
              {people.map((p) => (
                <li key={p.email}>
                  <PencilRule id={`share:${p.email}`} />
                  <PersonFace email={p.email} name={p.name} />
                  <span className="share__who">{p.label}</span>
                  <select
                    className="sketch-select"
                    aria-label={`Role for ${p.email}`}
                    value={p.role}
                    onChange={(e) => {
                      const role = e.target.value as Role;
                      setPeople((rows) => rows.map((r) => (r.email === p.email ? { ...r, role } : r)));
                      setDirty(true);
                    }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="close-btn"
                    aria-label={`Remove ${p.email}`}
                    onClick={() => {
                      setPeople((rows) => rows.filter((r) => r.email !== p.email));
                      setDirty(true);
                    }}
                  >
                    <CrossIcon />
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="share__add"
              onSubmit={(e) => {
                e.preventDefault();
                addPerson();
              }}
            >
              <input
                className="sketch-input"
                type="email"
                placeholder="name@company.com"
                aria-label="Add person by e-mail"
                list={listId}
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
              <datalist id={listId}>
                {suggestions.map((u) => (
                  <option key={u.id} value={u.email}>
                    {u.name}
                  </option>
                ))}
              </datalist>
              <select className="sketch-select" aria-label="Role for new person" value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <button type="submit" className="sketch-btn">
                Add
              </button>
            </form>
            <p className="hint">People who have never signed in can be added by e-mail; access applies on their first login.</p>
          </section>

          {inherited.length > 0 && (
            <section>
              <h3>Inherited</h3>
              <ul className="share__inherited">
                {inherited.map((i) =>
                  i.grants.map((g) => (
                    <li key={g.id}>
                      <span className="share__who">{principalLabel(g.principal)}</span>
                      <RoleMark role={g.role} />
                      <span className="share__from">from {folderLabel(i.from)}</span>
                    </li>
                  )),
                )}
              </ul>
              <p className="hint">Inherited access can only be changed on the folder it comes from.</p>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
