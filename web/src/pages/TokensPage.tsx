import { useCallback, useEffect, useState } from "react";
import { MCP_PATH, type CreateTokenResponse, type TokenInfo } from "@exidraw/shared";
import { api, errorMessage } from "../api";
import { ConfirmDialog } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { copyText, formatDate, formatRelative } from "../util";
import { CopyIcon, PlusIcon } from "../folder/icons";
import { PencilLoader, PencilRule, Scribble, SheetOnBoard } from "../sketch/Paper";

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
    <div className="board-page tokens-page">
      <SheetOnBoard width="narrow">
        <div className="sheet__head">
          <h1 className="sheet__title">
            <Scribble>Access tokens</Scribble>
          </h1>
        </div>
        <p className="tokens__lead">
          Personal access tokens let scripts and AI agents act as you through the API and the MCP endpoint{" "}
          <code>{mcpUrl}</code>. A token has exactly your permissions; revoke it when it is no longer needed.
        </p>

        <form
          className="token-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="field token-form__name">
            <span className="field__label">Token name</span>
            <input
              className="sketch-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Claude agent"
              maxLength={120}
              required
            />
          </label>
          <label className="field">
            <span className="field__label">Expires</span>
            <select className="sketch-select" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="sketch-btn sketch-btn--primary" disabled={busy || !name.trim()}>
            <PlusIcon />
            Create token
          </button>
        </form>

        {created && (
          <div className="token-created" data-testid="token-created">
            <p className="token-created__title">Copy your new token now. It will not be shown again.</p>
            <div className="token-created__value">
              <code data-testid="token-value">{created.token}</code>
              <button
                className="sketch-btn"
                onClick={async () => {
                  if (await copyText(created.token)) notify("Token copied", "success");
                }}
              >
                <CopyIcon />
                Copy
              </button>
            </div>
            <AgentSetup token={created.token} />
            <button className="sketch-btn sketch-btn--quiet" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        )}

        {!created && (
          <section className="agent-help">
            <h2 className="tokens__section">Connect an agent</h2>
            <p>
              Create a token above, then register the MCP endpoint with your agent. Replace <code>{TOKEN_PLACEHOLDER}</code>{" "}
              with the token.
            </p>
            <AgentSetup token={null} />
          </section>
        )}

        <h2 className="tokens__section">Your tokens</h2>
        {!tokens && <PencilLoader className="pencil-loader--small" />}
        {tokens?.length === 0 && <p className="tokens__none">You have no active tokens.</p>}
        {tokens && tokens.length > 0 && (
          <table className="ruled-table tokens-table">
            <thead>
              <tr>
                <th>
                  Name
                  <PencilRule id="tokens-head" double />
                </th>
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
                  <td className="tokens-table__name">
                    <PencilRule id={t.id} />
                    {t.name}
                  </td>
                  <td className="tokens-table__prefix">
                    <code>{t.prefix}…</code>
                  </td>
                  <td data-label="created" title={formatDate(t.createdAt)}>
                    {formatRelative(t.createdAt)}
                  </td>
                  <td data-label="last used">{t.lastUsedAt ? formatRelative(t.lastUsedAt) : <span className="muted">never</span>}</td>
                  <td data-label="expires">{t.expiresAt ? formatDate(t.expiresAt) : <span className="muted">never</span>}</td>
                  <td className="tokens-table__actions">
                    <button className="sketch-btn sketch-btn--small sketch-btn--danger-ink" onClick={() => setRevoking(t)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SheetOnBoard>

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
        <span className="snippet__label">{label}</span>
        <button
          type="button"
          className="sketch-btn sketch-btn--small"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            if (await copyText(text)) notify("Copied", "success");
          }}
        >
          <CopyIcon />
          Copy
        </button>
      </div>
      <pre data-testid="snippet">{text}</pre>
    </div>
  );
}
