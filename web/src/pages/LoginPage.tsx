import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { AuthProvidersResponse } from "@exidraw/shared";
import { api, errorMessage } from "../api";
import { useSession } from "../session";
import { Brand, initials } from "../components/Layout";
import { LoginBoard } from "../login/LoginBoard";
import { ArrowIcon, LockIcon, MicrosoftLogo, PaperCard, Scribble, StartHint } from "../login/Paper";
import { safeReturnTo } from "../util";

const ERROR_TEXT: Record<string, string> = {
  state: "The sign-in attempt expired. Please try again.",
  denied: "Sign-in was cancelled.",
};

/** Marker colours for the dev users' initials, as on the board's cursors. */
const AVATAR_COLORS = ["#f76707", "#1c7ed6", "#d6336c", "#2f9e44", "#6965db", "#f59f00"];

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
    <LoginBoard>
      <PaperCard>
        <h1 className="login__brand">
          <Brand />
        </h1>
        <p className="login__tagline">
          Shared whiteboards
          <br />
          for the <Scribble>team.</Scribble>
        </p>
        <p className="login__lead">Sign in to pick up where you left off.</p>
        {error && (
          <div className="alert alert--error login__alert" role="alert">
            {error}
          </div>
        )}
        {!providers && !error && <p className="login__loading">Loading…</p>}
        {providers?.mode === "entra" && (
          <>
            <div className="login__cta">
              <StartHint label="start here!" />
              <a className="login__ms" href={`${providers.loginUrl}?returnTo=${encodeURIComponent(returnTo)}`}>
                <MicrosoftLogo />
                Sign in with Microsoft
                <ArrowIcon className="login__arrow" />
              </a>
            </div>
            <p className="login__foot">
              <LockIcon />
              Self-hosted · work accounts only
            </p>
          </>
        )}
        {providers?.mode === "dev" && (
          <>
            <div className="alert alert--warn login__note">Development login: pick a test user.</div>
            <ul className="login__users">
              {providers.users.map((u, i) => (
                <li key={u.id} className="login__cta">
                  {i === 0 && <StartHint label="pick one!" />}
                  <button type="button" className="login__user" disabled={busy !== null} onClick={() => void devLogin(u.id)}>
                    <span className="login__avatar" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }} aria-hidden>
                      {initials(u.name)}
                    </span>
                    <span className="login__who">
                      <strong>{u.name}</strong>
                      <span>{u.email}</span>
                    </span>
                    <ArrowIcon className="login__arrow" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </PaperCard>
    </LoginBoard>
  );
}
