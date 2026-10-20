import { useEffect, useId, useMemo, useState } from "react";
import { ROLES, type Grant, type GrantInput, type GrantsResponse, type NodeKind, type Role, type UserInfo } from "@exidraw/shared";
import { api, errorMessage } from "../api";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";
import { ROLE_LABEL, absoluteUrl, copyText, folderLabel } from "../util";

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
  role: Role;
}

function principalLabel(g: Grant): string {
  if (g.principal.kind === "all") return "Everyone signed in";
  return g.principal.displayName ? `${g.principal.displayName} (${g.principal.email})` : g.principal.email;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ShareDialog({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
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
        setPeople(
          res.grants.flatMap((g) =>
            g.principal.kind === "user" ? [{ email: g.principal.email, label: principalLabel(g), role: g.role }] : [],
          ),
        );
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
      return [...rows, { email, label, role: newRole }];
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
              className="btn btn--ghost footer-left"
              onClick={async () => {
                if (await copyText(absoluteUrl(target.linkPath!))) notify("Link copied", "success");
              }}
            >
              Copy link
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!dirty || saving || !data} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {error && <div className="alert alert--error">{error}</div>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <div className="share">
          <section>
            <h3>General access</h3>
            <label className="field field--inline">
              <span>Everyone signed in</span>
              <select
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
                  <span className="share__who">{p.label}</span>
                  <select
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
                    className="icon-btn"
                    aria-label={`Remove ${p.email}`}
                    onClick={() => {
                      setPeople((rows) => rows.filter((r) => r.email !== p.email));
                      setDirty(true);
                    }}
                  >
                    ×
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
              <select aria-label="Role for new person" value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn">
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
                      <span>{principalLabel(g)}</span>
                      <span className="badge">{ROLE_LABEL[g.role]}</span>
                      <span className="muted">from {folderLabel(i.from)}</span>
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
