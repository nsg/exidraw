import { useCallback, useEffect, useState } from "react";
import { MCP_PATH, type CreateTokenResponse, type TokenInfo } from "@exidraw/shared";
import { api, errorMessage } from "../api";
import { ConfirmDialog } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { copyText, formatDate, formatRelative } from "../util";

const TOKEN_PLACEHOLDER = "<your-token>";

const EXPIRY_OPTIONS = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "Never", days: 0 },
];

export function TokensPage() {
  const notify = useToast();
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState(90);
  const [created, setCreated] = useState<CreateTokenResponse | null>(null);
  const [revoking, setRevoking] = useState<TokenInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTokens((await api.tokens()).tokens);
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }, [notify]);

  useEffect(() => {
    document.title = "Access tokens · exidraw";
    void load();
  }, [load]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const res = await api.createToken({ name: trimmed, ...(expiry ? { expiresInDays: expiry } : {}) });
      setCreated(res);
      setName("");
      await load();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const mcpUrl = window.location.origin + MCP_PATH;

  return (
    <div className="tokens-page narrow">
      <div className="page-header">
        <h1>Access tokens</h1>
      </div>
      <p className="muted">
        Personal access tokens let scripts and AI agents act as you through the API and the MCP endpoint{" "}
        <code>{mcpUrl}</code>. A token has exactly your permissions; revoke it when it is no longer needed.
      </p>

      <form
        className="card token-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="field">
          <span>Token name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Claude agent"
            maxLength={120}
            required
          />
        </label>
        <label className="field">
          <span>Expires</span>
          <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
          Create token
        </button>
      </form>

      {created && (
        <div className="card token-created" data-testid="token-created">
          <strong>Copy your new token now. It will not be shown again.</strong>
          <div className="token-created__value">
            <code data-testid="token-value">{created.token}</code>
            <button
              className="btn"
              onClick={async () => {
                if (await copyText(created.token)) notify("Token copied", "success");
              }}
            >
              Copy
            </button>
          </div>
          <AgentSetup token={created.token} />
          <button className="btn btn--ghost" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      )}

      {!created && (
        <section className="agent-help">
          <h2>Connect an agent</h2>
          <p className="muted">
            Create a token above, then register the MCP endpoint with your agent. Replace <code>{TOKEN_PLACEHOLDER}</code>{" "}
            with the token.
          </p>
          <AgentSetup token={null} />
        </section>
      )}

      <h2>Your tokens</h2>
      {!tokens && <p className="muted">Loading…</p>}
      {tokens?.length === 0 && <p className="muted">You have no active tokens.</p>}
      {tokens && tokens.length > 0 && (
        <table className="nodes">
          <thead>
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} data-testid="token-row">
                <td>{t.name}</td>
                <td>
                  <code>{t.prefix}…</code>
                </td>
                <td title={formatDate(t.createdAt)}>{formatRelative(t.createdAt)}</td>
                <td>{t.lastUsedAt ? formatRelative(t.lastUsedAt) : <span className="muted">never</span>}</td>
                <td>{t.expiresAt ? formatDate(t.expiresAt) : <span className="muted">never</span>}</td>
                <td className="nodes__actions">
                  <button className="btn btn--danger-ghost" onClick={() => setRevoking(t)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {revoking && (
        <ConfirmDialog
          title="Revoke token"
          message={`Revoke “${revoking.name}”? Anything using it stops working immediately.`}
          confirmLabel="Revoke"
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            try {
              await api.revokeToken(revoking.id);
              setRevoking(null);
              if (created?.info.id === revoking.id) setCreated(null);
              await load();
            } catch (err) {
              notify(errorMessage(err), "error");
            }
          }}
        />
      )}
    </div>
  );
}

/** Ready-to-paste MCP client setups; `token` null renders a placeholder. */
function AgentSetup({ token }: { token: string | null }) {
  const url = window.location.origin + MCP_PATH;
  const bearer = `Bearer ${token ?? TOKEN_PLACEHOLDER}`;
  const snippets = [
    {
      label: "Claude Code",
      text: `claude mcp add --transport http exidraw ${url} --header "Authorization: ${bearer}"`,
    },
    {
      label: "Other MCP clients (JSON)",
      text: JSON.stringify({ mcpServers: { exidraw: { type: "http", url, headers: { Authorization: bearer } } } }, null, 2),
    },
  ];
  return (
    <div className="agent-setup">
      {snippets.map((s) => (
        <Snippet key={s.label} label={s.label} text={s.text} />
      ))}
    </div>
  );
}

function Snippet({ label, text }: { label: string; text: string }) {
  const notify = useToast();
  return (
    <div className="snippet">
      <div className="snippet__header">
        <span>{label}</span>
        <button
          type="button"
          className="btn btn--ghost"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            if (await copyText(text)) notify("Copied", "success");
          }}
        >
          Copy
        </button>
      </div>
      <pre data-testid="snippet">{text}</pre>
    </div>
  );
}
