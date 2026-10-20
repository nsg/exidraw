import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MeResponse } from "@exidraw/shared";
import { api, ApiRequestError, setUnauthenticatedHandler } from "./api";

type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "error"; message: string }
  | { status: "authenticated"; me: MeResponse };

interface SessionContextValue {
  state: SessionState;
  /** Re-fetch /api/me (after login). */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      setState({ status: "authenticated", me: await api.me() });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) setState({ status: "anonymous" });
      else setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setState({ status: "anonymous" });
    }
  }, []);

  useEffect(() => {
    void refresh();
    setUnauthenticatedHandler(() => setState({ status: "anonymous" }));
    return () => setUnauthenticatedHandler(null);
  }, [refresh]);

  const value = useMemo(() => ({ state, refresh, logout }), [state, refresh, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}

/** The signed-in user; only call below the authenticated route guard. */
export function useMe(): MeResponse {
  const { state } = useSession();
  if (state.status !== "authenticated") throw new Error("useMe without a session");
  return state.me;
}
