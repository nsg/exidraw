import type { CSSProperties } from "react";
import { NavLink, Outlet, useMatch, useNavigate } from "react-router";
import { SPA_ROUTES } from "@exidraw/shared";
import { useMe, useSession } from "../session";
import { FACE_COLORS, Rough, pick } from "../sketch/rough";

/** The pencil line under the top bar, stretched to its width. */
const TOPBAR_LINE = new Rough(5).line(0, 3, 1000, 3.4, 0.5);

export function TopbarLine() {
  return (
    <svg className="topbar__line" viewBox="0 0 1000 6" preserveAspectRatio="none" aria-hidden>
      <path d={TOPBAR_LINE} />
    </svg>
  );
}

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
        <span className="avatar" style={{ "--marker": pick(FACE_COLORS, me.user.email) } as CSSProperties} aria-hidden>
          {initials(me.user.name)}
        </span>
        <span className="user-chip__name">{me.user.name}</span>
        {me.isAdmin && <span className="badge">admin</span>}
      </span>
      <button
        className="user-menu__signout"
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
  // Every folder is part of "Drawings", not only the root.
  const inFolder = useMatch(SPA_ROUTES.folder(":folderId")) !== null;
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to={SPA_ROUTES.root} className="topbar__brand">
          <Brand />
        </NavLink>
        <nav className="topbar__nav">
          <NavLink to={SPA_ROUTES.root} end className={({ isActive }) => (isActive || inFolder ? "active" : "")}>
            Drawings
          </NavLink>
          <NavLink to={SPA_ROUTES.tokens} className={({ isActive }) => (isActive ? "active" : "")}>
            Access tokens
          </NavLink>
        </nav>
        <UserMenu />
        <TopbarLine />
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
