import { createHash, randomBytes } from "node:crypto";
import {
  MAX_NAME_LENGTH,
  PAT_DISPLAY_PREFIX_LENGTH,
  PAT_LAST_USED_WRITE_INTERVAL_MS,
  PAT_PREFIX,
  SESSION_COOKIE,
  type AuthMode,
  type CreateTokenResponse,
  type Subject,
  type TokenInfo,
  type UserInfo,
} from "@exidraw/shared";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { HttpError } from "./errors.js";
const DAY = 86400000;
export interface UserRow {
  id: string;
  auth_mode: AuthMode;
  subject: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at: number;
  last_login_at: number;
}
export interface AuthContext {
  user: UserInfo;
  subject: Subject;
  via: "session" | "token";
  token?: {
    id: string;
    name: string;
  };
}
export interface LoginIdentity {
  subject: string;
  email: string;
  name: string;
}
export function cookieValue(headers: Headers, name: string): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name)
      return part.slice(separator + 1).trim();
  }
  return null;
}
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function userInfo(
  row: Pick<UserRow, "id" | "email" | "name" | "avatar_url">,
): UserInfo {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url ?? null,
  };
}
function tokenInfo(row: any): TokenInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}
export class AuthService {
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {}
  userInfo = userInfo;
  private context(
    row: UserRow,
    via: AuthContext["via"],
    token?: AuthContext["token"],
  ): AuthContext {
    const user = userInfo(row);
    return {
      user,
      subject: {
        userId: user.id,
        email: user.email,
        isAdmin:
          this.config.adminEmails.includes(user.email.toLowerCase()) ||
          (row.auth_mode === "entra" &&
            this.config.adminOids.includes(row.subject.toLowerCase())),
      },
      via,
      ...(token ? { token } : {}),
    };
  }
  authenticate(headers: Headers, patOnly = false): AuthContext | null {
    const now = Date.now();
    const authorization = headers.get("authorization");
    if (authorization !== null) {
      const match = /^Bearer (exi_[A-Za-z0-9_-]{43})$/i.exec(authorization);
      if (!match) return null;
      const row = this.store.get<
        UserRow & {
          token_id: string;
          token_name: string;
          last_used_at: number | null;
        }
      >(
        "SELECT u.*, t.id AS token_id, t.name AS token_name, t.last_used_at FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)",
        hashToken(match[1]!),
        now,
      );
      if (!row) return null;
      if (
        row.last_used_at === null ||
        now - row.last_used_at >= PAT_LAST_USED_WRITE_INTERVAL_MS
      )
        this.store.run(
          "UPDATE tokens SET last_used_at=? WHERE id=?",
          now,
          row.token_id,
        );
      return this.context(row, "token", {
        id: row.token_id,
        name: row.token_name,
      });
    }
    if (patOnly) return null;
    const sessionId = cookieValue(headers, SESSION_COOKIE);
    if (!sessionId || !/^[A-Za-z0-9_-]{43}$/.test(sessionId)) return null;
    const row = this.store.get<
      UserRow & {
        last_seen_at: number;
        expires_at: number;
      }
    >(
      "SELECT u.*, s.last_seen_at, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?",
      sessionId,
    );
    if (!row) return null;
    if (row.expires_at <= now) {
      this.store.run("DELETE FROM sessions WHERE id=?", sessionId);
      return null;
    }
    if (now - row.last_seen_at >= 3600000)
      this.store.run(
        "UPDATE sessions SET last_seen_at=?, expires_at=? WHERE id=?",
        now,
        now + this.config.sessionTtlDays * DAY,
        sessionId,
      );
    return this.context(row, "session");
  }
  require(headers: Headers, patOnly = false): AuthContext {
    const auth = this.authenticate(headers, patOnly);
    if (!auth)
      throw new HttpError("unauthenticated", "Authentication required");
    return auth;
  }
  login(
    identity: LoginIdentity,
    mode: AuthMode,
  ): {
    user: UserInfo;
    sessionId: string;
  } {
    const email = identity.email.trim().toLowerCase();
    if (!identity.subject || !email || !identity.name)
      throw new HttpError("invalid", "Incomplete login identity");
    return this.store.transaction(() => {
      const now = Date.now();
      const existing = this.store.get<UserRow>(
        "SELECT * FROM users WHERE auth_mode=? AND subject=?",
        mode,
        identity.subject,
      );
      const emailOwner = this.store.get<UserRow>(
        "SELECT * FROM users WHERE email=?",
        email,
      );
      // E-mail is a grant address, never proof that two provider subjects are the same account.
      if (emailOwner && emailOwner.id !== existing?.id)
        throw new HttpError(
          "conflict",
          "Email is already linked to another identity",
        );
      const id = existing?.id ?? randomBytes(16).toString("base64url");
      if (existing)
        this.store.run(
          "UPDATE users SET email=?,name=?,last_login_at=? WHERE id=?",
          email,
          identity.name,
          now,
          id,
        );
      else
        this.store.run(
          "INSERT INTO users(id,auth_mode,subject,email,name,avatar_url,created_at,last_login_at) VALUES(?,?,?,?,?,NULL,?,?)",
          id,
          mode,
          identity.subject,
          email,
          identity.name,
          now,
          now,
        );
      this.store.run(
        "UPDATE grants SET principal_user_id=? WHERE principal_kind='user' AND principal_email=?",
        id,
        email,
      );
      const sessionId = randomBytes(32).toString("base64url");
      this.store.run(
        "INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)",
        sessionId,
        id,
        now,
        now + this.config.sessionTtlDays * DAY,
        now,
      );
      return {
        user: userInfo(
          this.store.get<UserRow>("SELECT * FROM users WHERE id=?", id)!,
        ),
        sessionId,
      };
    });
  }
  logout(headers: Headers): void {
    const session = cookieValue(headers, SESSION_COOKIE);
    if (session) this.store.run("DELETE FROM sessions WHERE id=?", session);
  }
  sessionCookie(sessionId: string | null): string {
    return `${SESSION_COOKIE}=${sessionId ?? ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionId === null ? 0 : this.config.sessionTtlDays * 86400}${this.config.publicUrl.startsWith("https:") ? "; Secure" : ""}`;
  }
  createToken(
    auth: AuthContext,
    name: string,
    expiresInDays?: number,
  ): CreateTokenResponse {
    if (auth.via !== "session")
      throw new HttpError(
        "forbidden",
        "A session is required to create personal access tokens",
      );
    if (
      !name.trim() ||
      name.trim().length > MAX_NAME_LENGTH ||
      (expiresInDays !== undefined &&
        (!Number.isInteger(expiresInDays) ||
          expiresInDays < 1 ||
          expiresInDays > 3650))
    )
      throw new HttpError("invalid", "Invalid personal access token settings");
    const token = PAT_PREFIX + randomBytes(32).toString("base64url");
    const info: TokenInfo = {
      id: randomBytes(16).toString("base64url"),
      name: name.trim(),
      prefix: token.slice(0, PAT_DISPLAY_PREFIX_LENGTH),
      createdAt: Date.now(),
      expiresAt: null,
      lastUsedAt: null,
    };
    if (expiresInDays !== undefined)
      info.expiresAt = info.createdAt + expiresInDays * DAY;
    this.store.run(
      "INSERT INTO tokens(id,user_id,name,token_hash,prefix,created_at,expires_at,last_used_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL,NULL)",
      info.id,
      auth.user.id,
      info.name,
      hashToken(token),
      info.prefix,
      info.createdAt,
      info.expiresAt,
    );
    return { token, info };
  }
  tokens(userId: string): TokenInfo[] {
    return this.store
      .all(
        "SELECT * FROM tokens WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC,id",
        userId,
      )
      .map(tokenInfo);
  }
  revokeToken(userId: string, id: string): void {
    this.store.run(
      "UPDATE tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL",
      Date.now(),
      id,
      userId,
    );
  }
}
