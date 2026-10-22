import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { SPA_ROUTES } from "@exidraw/shared";
import { SessionProvider, useSession } from "./session";
import { ToastProvider } from "./components/Toasts";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { FolderPage } from "./pages/FolderPage";
import { TokensPage } from "./pages/TokensPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { safeReturnTo } from "./util";

// The editor (and the Excalidraw bundle) loads only when a drawing is opened.
const RoomPage = lazy(() => import("./pages/RoomPage").then((m) => ({ default: m.RoomPage })));

export function App() {
  return (
    <ToastProvider>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </ToastProvider>
  );
}

function AppRoutes() {
  const { state, refresh } = useSession();
  const location = useLocation();

  if (state.status === "loading") return <div className="splash">Loading…</div>;
  if (state.status === "error") {
    return (
      <div className="splash">
        <p>Could not reach the server: {state.message}</p>
        <button className="btn" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  if (state.status === "anonymous") {
    if (location.pathname === SPA_ROUTES.login) return <LoginPage />;
    const returnTo = location.pathname + location.search;
    const target = returnTo === "/" ? SPA_ROUTES.login : `${SPA_ROUTES.login}?returnTo=${encodeURIComponent(returnTo)}`;
    return <Navigate to={target} replace />;
  }

  return (
    <Routes>
      <Route
        path={SPA_ROUTES.login}
        element={<Navigate to={safeReturnTo(new URLSearchParams(location.search).get("returnTo"))} replace />}
      />
      <Route
        path="/r/:roomId"
        element={
          <Suspense fallback={<div className="splash">Loading…</div>}>
            <RoomPage />
          </Suspense>
        }
      />
      <Route element={<Layout />}>
        <Route index element={<FolderPage />} />
        <Route path="/f/:folderId" element={<FolderPage />} />
        <Route path={SPA_ROUTES.tokens} element={<TokensPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
