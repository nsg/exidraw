import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { AuthProvidersResponse } from "@exidraw/shared";
import { api, errorMessage } from "../api";
import { useSession } from "../session";
import { Brand } from "../components/Layout";
import { safeReturnTo } from "../util";

const ERROR_TEXT: Record<string, string> = {
  state: "The sign-in attempt expired. Please try again.",
  denied: "Sign-in was cancelled.",
};

export function LoginPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const params = new URLSearchParams(location.search);
  const returnTo = safeReturnTo(params.get("returnTo"));
  const errorCode = params.get("error");
  const [providers, setProviders] = useState<AuthProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(
    errorCode ? (ERROR_TEXT[errorCode] ?? `Sign-in failed (${errorCode}).`) : null,
  );
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.providers().then(setProviders, (err) => setError(errorMessage(err)));
  }, []);

  const devLogin = async (userId: string) => {
    setBusy(userId);
    setError(null);
    try {
      await api.devLogin(userId);
      await refresh();
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="login">
      <div className="login__card">
        <h1>
          <Brand />
        </h1>
        <p className="muted">Shared whiteboards for the team.</p>
        {error && <div className="alert alert--error">{error}</div>}
        {!providers && !error && <p className="muted">Loading…</p>}
        {providers?.mode === "entra" && (
          <a className="btn btn--primary btn--block" href={`${providers.loginUrl}?returnTo=${encodeURIComponent(returnTo)}`}>
            Sign in with Microsoft
          </a>
        )}
        {providers?.mode === "dev" && (
          <>
            <div className="alert alert--warn">Development login: pick a test user.</div>
            <ul className="login__users">
              {providers.users.map((u) => (
                <li key={u.id}>
                  <button className="btn btn--block login__user" disabled={busy !== null} onClick={() => void devLogin(u.id)}>
                    <strong>{u.name}</strong>
                    <span className="muted">{u.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
