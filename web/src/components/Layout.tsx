import { NavLink, Outlet, useNavigate } from "react-router";
import { SPA_ROUTES } from "@exidraw/shared";
import { useMe, useSession } from "../session";

export function Brand() {
  return (
    <span className="brand">
      <img src="/favicon.svg" alt="" width={22} height={22} />
      exidraw
    </span>
  );
}

export function UserMenu() {
  const me = useMe();
  const { logout } = useSession();
  const navigate = useNavigate();
  return (
    <div className="user-menu">
      <span className="user-chip" title={me.user.email} data-testid="current-user">
        <span className="avatar" aria-hidden>
          {initials(me.user.name)}
        </span>
        {me.user.name}
        {me.isAdmin && <span className="badge">admin</span>}
      </span>
      <button
        className="btn btn--ghost"
        onClick={async () => {
          await logout();
          navigate(SPA_ROUTES.login, { replace: true });
        }}
      >
        Sign out
      </button>
    </div>
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

export function Layout() {
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to={SPA_ROUTES.root} className="topbar__brand">
          <Brand />
        </NavLink>
        <nav className="topbar__nav">
          <NavLink to={SPA_ROUTES.root} end className={({ isActive }) => (isActive ? "active" : "")}>
            Drawings
          </NavLink>
          <NavLink to={SPA_ROUTES.tokens} className={({ isActive }) => (isActive ? "active" : "")}>
            Access tokens
          </NavLink>
        </nav>
        <UserMenu />
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
