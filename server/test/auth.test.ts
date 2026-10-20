import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as oidc from "openid-client";
import { AuthService, hashToken } from "../src/auth.js";
import { parseConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import {
  claimsToIdentity,
  issuerFetch,
  OidcFlow,
  safeReturnTo,
} from "../src/oidc.js";
const stores: Store[] = [];
function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  const config = parseConfig({
    AUTH_MODE: "dev",
    PUBLIC_URL: "https://draw.example.test",
    ADMIN_EMAILS: "ALICE@example.test",
  });
  const auth = new AuthService(store, config);
  const login = auth.login(
    { subject: "alice", email: "Alice@EXAMPLE.TEST", name: "Alice" },
    "dev",
  );
  const headers = new Headers({ cookie: `exidraw_session=${login.sessionId}` });
  return { store, config, auth, login, headers };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("configuration and persistence", () => {
  it("requires an explicit public origin and complete Entra credentials", () => {
    expect(() => parseConfig({})).toThrow("PUBLIC_URL");
    expect(() => parseConfig({ PUBLIC_URL: "https://draw.test" })).toThrow(
      "ENTRA_CLIENT_SECRET",
    );
    expect(() =>
      parseConfig({ AUTH_MODE: "dev", PUBLIC_URL: "https://draw.test/path" }),
    ).toThrow("origin");
    expect(() =>
      parseConfig({
        AUTH_MODE: "dev",
        PUBLIC_URL: "https://draw.test",
        PORT: "-1",
      }),
    ).toThrow();
    expect(() =>
      parseConfig({
        AUTH_MODE: "dev",
        PUBLIC_URL: "https://draw.test",
        DEV_USERS: "{}",
      }),
    ).toThrow();
    expect(() =>
      parseConfig({
        AUTH_MODE: "dev",
        PUBLIC_URL: "https://draw.test",
        ALLOWED_ORIGINS: "https://other.test/path",
      }),
    ).toThrow();
    expect(() =>
      parseConfig({
        AUTH_MODE: "dev",
        PUBLIC_URL: "https://draw.test",
        ENTRA_ISSUER: "http://issuer.test",
      }),
    ).toThrow();
  });
  it("normalizes and freezes the configured users and origins", () => {
    const config = parseConfig({
      AUTH_MODE: "dev",
      PUBLIC_URL: "https://draw.test/",
      ADMIN_EMAILS: " ALICE@example.test ",
      DEV_USERS: '[{"id":"a","name":"Alice","email":"ALICE@example.test"}]',
    });
    expect(config.publicUrl).toBe("https://draw.test");
    expect(config.adminEmails).toEqual(["alice@example.test"]);
    expect(config.devUsers[0]?.email).toBe("alice@example.test");
    expect(Object.isFrozen(config.devUsers[0])).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
  });
  it("migrates once, seeds root and rolls back nested transactions", () => {
    const dir = mkdtempSync(join(tmpdir(), "exidraw-db-"));
    try {
      let store = new Store(dir);
      expect(store.get("PRAGMA journal_mode").journal_mode).toBe("wal");
      expect(
        store.get("SELECT parent_id FROM folders WHERE id='root'").parent_id,
      ).toBeNull();
      expect(() =>
        store.transaction(() => {
          store.run("INSERT INTO folders VALUES('a','root','A',1,1,NULL)");
          store.transaction(() =>
            store.run("INSERT INTO folders VALUES('b','a','B',1,1,NULL)"),
          );
          throw new Error("abort");
        }),
      ).toThrow("abort");
      expect(store.all("SELECT id FROM folders")).toHaveLength(1);
      store.close();
      store = new Store(dir);
      expect(store.all("SELECT id FROM folders")).toHaveLength(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("sessions and personal tokens", () => {
  it("links pre-login grants, rejects a different subject with the same email and resolves admins per request", () => {
    const { store, auth, login, headers } = setup();
    store.run(
      "INSERT INTO grants(node_kind,node_id,principal_kind,principal_email,role,created_at,created_by) VALUES('folder','root','user','bob@example.test','editor',1,?)",
      login.user.id,
    );
    const bob = auth.login(
      { subject: "bob", email: "BOB@example.test", name: "Bob" },
      "dev",
    );
    expect(
      store.get("SELECT principal_user_id FROM grants").principal_user_id,
    ).toBe(bob.user.id);
    expect(auth.require(headers).subject.isAdmin).toBe(true);
    expect(() =>
      auth.login(
        { subject: "mallory", email: "alice@example.test", name: "Mallory" },
        "entra",
      ),
    ).toThrow("another identity");
    expect(store.all("SELECT * FROM users")).toHaveLength(2);
    expect(
      new AuthService(store, { ...auth.config, adminEmails: [] }).require(
        headers,
      ).subject.isAdmin,
    ).toBe(false);
  });
  it("uses stable Entra object ids for admins across email changes without trusting dev subjects", () => {
    const { store } = setup();
    const oid = "01234567-89ab-4cde-8fab-0123456789ab";
    const config = parseConfig({ AUTH_MODE: "dev", PUBLIC_URL: "https://draw.test", ADMIN_OIDS: ` ${oid.toUpperCase()} ` });
    const auth = new AuthService(store, config);
    const first = auth.login({ subject: oid, email: "before@example.test", name: "Admin" }, "entra");
    const headers = new Headers({ cookie: `exidraw_session=${first.sessionId}` });
    expect(auth.require(headers).subject.isAdmin).toBe(true);
    auth.login({ subject: oid, email: "after@example.test", name: "Admin" }, "entra");
    expect(auth.require(headers).subject.isAdmin).toBe(true);
    const dev = auth.login({ subject: oid, email: "dev@example.test", name: "Dev" }, "dev");
    expect(auth.require(new Headers({ cookie: `exidraw_session=${dev.sessionId}` })).subject.isAdmin).toBe(false);
  });
  it("stores only token hashes, ignores cookies on PAT-only calls and revokes immediately", () => {
    const { store, auth, headers, login } = setup();
    const result = auth.createToken(auth.require(headers), "Agent", 1);
    expect(result.token).toMatch(/^exi_[A-Za-z0-9_-]{43}$/);
    const row = store.get("SELECT * FROM tokens WHERE id=?", result.info.id);
    expect(row.token_hash).toBe(hashToken(result.token));
    expect(JSON.stringify(row)).not.toContain(result.token);
    expect(auth.authenticate(headers, true)).toBeNull();
    const bearer = new Headers({
      authorization: `Bearer ${result.token}`,
      cookie: headers.get("cookie")!,
    });
    const tokenAuth = auth.require(bearer, true);
    expect(tokenAuth.via).toBe("token");
    expect(tokenAuth.user.id).toBe(login.user.id);
    expect(() => auth.createToken(tokenAuth, "Mint another")).toThrow(
      "session",
    );
    expect(
      store.get("SELECT last_used_at FROM tokens").last_used_at,
    ).not.toBeNull();
    auth.revokeToken("someone-else", result.info.id);
    expect(auth.authenticate(bearer)).not.toBeNull();
    auth.revokeToken(login.user.id, result.info.id);
    expect(auth.authenticate(bearer)).toBeNull();
    expect(auth.tokens(login.user.id)).toHaveLength(0);
    expect(
      auth.authenticate(
        new Headers({
          authorization: "Bearer invalid",
          cookie: headers.get("cookie")!,
        }),
      ),
    ).toBeNull();
  });
  it("rejects and removes expired sessions and permits HTTP development cookies", () => {
    const { store, auth, headers, login } = setup();
    store.run(
      "UPDATE sessions SET expires_at=? WHERE id=?",
      Date.now(),
      login.sessionId,
    );
    expect(auth.authenticate(headers)).toBeNull();
    expect(
      store.get("SELECT id FROM sessions WHERE id=?", login.sessionId),
    ).toBeUndefined();
    const dev = new AuthService(store, {
      ...auth.config,
      publicUrl: "http://localhost:5173",
    });
    expect(dev.sessionCookie(login.sessionId)).not.toContain("Secure");
  });
  it("expires tokens and slides sessions once per hour, then logout deletes the session", () => {
    const { store, auth, headers, login } = setup();
    const now = Date.now();
    const token = auth.createToken(auth.require(headers), "Short lived", 1);
    vi.spyOn(Date, "now").mockReturnValue(now + 3600001);
    auth.require(headers);
    const session = store.get(
      "SELECT * FROM sessions WHERE id=?",
      login.sessionId,
    );
    expect(session.last_seen_at).toBe(now + 3600001);
    expect(session.expires_at).toBe(now + 3600001 + 30 * 86400000);
    vi.mocked(Date.now).mockReturnValue(token.info.expiresAt!);
    expect(
      auth.authenticate(
        new Headers({ authorization: `Bearer ${token.token}` }),
      ),
    ).toBeNull();
    expect(auth.sessionCookie(login.sessionId)).toContain(
      "HttpOnly; SameSite=Lax",
    );
    expect(auth.sessionCookie(login.sessionId)).toContain("Secure");
    auth.logout(headers);
    expect(auth.authenticate(headers)).toBeNull();
    expect(auth.sessionCookie(null)).toContain("Max-Age=0");
  });
});
function entraSetup(allowGuests = false) {
  const { auth, store } = setup();
  const issuer = "https://login.microsoftonline.com/tenant/v2.0";
  const config = parseConfig({
    PUBLIC_URL: "https://draw.example.test",
    ENTRA_TENANT_ID: "tenant",
    ENTRA_CLIENT_ID: "client",
    ENTRA_CLIENT_SECRET: "secret",
    ENTRA_ALLOW_GUESTS: String(allowGuests),
  });
  const configuration = new oidc.Configuration(
    {
      issuer,
      authorization_endpoint:
        "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize",
      token_endpoint:
        "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
      jwks_uri: "https://login.microsoftonline.com/tenant/discovery/v2.0/keys",
    },
    "client",
    "secret",
  );
  const discover = vi.fn().mockResolvedValue(configuration);
  const exchange = vi
    .fn()
    .mockResolvedValue({
      claims: () => ({
        oid: "entra-user",
        acct: 0,
        preferred_username: "Entra@EXAMPLE.TEST",
        name: "Entra User",
      }),
    });
  const flow = new OidcFlow(config, auth, {
    discover: discover as unknown as typeof oidc.discovery,
    exchange: exchange as unknown as typeof oidc.authorizationCodeGrant,
  });
  return { flow, discover, exchange, store, configuration };
}
function callback(location: string) {
  return new URL(
    `https://draw.example.test/auth/callback?code=code&state=${new URL(location).searchParams.get("state")}`,
  );
}
function flowHeaders(cookie: string) {
  return new Headers({ cookie: cookie.split(";")[0]! });
}
describe("OIDC flow", () => {
  it("maps Entra's stable oid and normalized email, rejecting absent identity claims", () => {
    expect(
      claimsToIdentity({
        oid: "oid",
        email: "USER@EXAMPLE.TEST",
        preferred_username: "upn@example.test",
      }),
    ).toEqual({
      subject: "oid",
      email: "upn@example.test",
      name: "upn@example.test",
    });
    expect(() =>
      claimsToIdentity({ sub: "sub", email: "user@example.test" }),
    ).toThrow();
    expect(() => claimsToIdentity({ oid: "oid" })).toThrow();
  });
  it("denies guests and unverifiable membership by default, and permits explicit guest opt-in", async () => {
    for (const acct of [1, "1", undefined]) {
      const { flow, exchange, store } = entraSetup();
      exchange.mockResolvedValue({ claims: () => ({ oid: "guest", acct, preferred_username: "guest@example.test" }) });
      const started = await flow.login();
      const result = await flow.callback(callback(started.location), flowHeaders(started.cookie));
      expect(result.forbidden).toBe(true);
      expect(result.cookies).toHaveLength(1);
      expect(store.get("SELECT id FROM users WHERE subject='guest'")).toBeUndefined();
    }
    const { flow, exchange } = entraSetup(true);
    exchange.mockResolvedValue({ claims: () => ({ oid: "guest", acct: 1, preferred_username: "guest@example.test" }) });
    const started = await flow.login();
    expect((await flow.callback(callback(started.location), flowHeaders(started.cookie))).location).toBe("/");
  });
  it("keeps return destinations local, including browser backslash normalization", () => {
    for (const bad of [
      "//evil.test",
      "/\\evil.test",
      "https://evil.test",
      "/\nevil.test",
      "\\evil.test",
    ])
      expect(safeReturnTo(bad)).toBe("/");
    expect(safeReturnTo("/r/abc?x=1")).toBe("/r/abc?x=1");
  });
  it("uses a confidential code flow with nonce, state and S256 PKCE and consumes the cookie only once", async () => {
    const { flow, discover, exchange, store } = entraSetup();
    const started = await flow.login("/r/room");
    const authorization = new URL(started.location).searchParams;
    expect(authorization.get("scope")).toBe("openid profile email");
    expect(authorization.get("code_challenge_method")).toBe("S256");
    expect(authorization.get("redirect_uri")).toBe(
      "https://draw.example.test/auth/callback",
    );
    expect(started.cookie).toContain(
      "HttpOnly; SameSite=Lax; Max-Age=600; Secure",
    );
    expect(started.cookie).not.toContain(authorization.get("state")!);
    const result = await flow.callback(
      callback(started.location),
      flowHeaders(started.cookie),
    );
    expect(result.location).toBe("/r/room");
    expect(result.cookies).toHaveLength(2);
    const checks = exchange.mock.calls[0]![2];
    expect(checks.expectedState).toBe(authorization.get("state"));
    expect(checks.expectedNonce).toBe(authorization.get("nonce"));
    expect(checks.idTokenExpected).toBe(true);
    expect(await oidc.calculatePKCECodeChallenge(checks.pkceCodeVerifier)).toBe(
      authorization.get("code_challenge"),
    );
    expect(discover).toHaveBeenCalledOnce();
    expect(
      store.get("SELECT email FROM users WHERE subject='entra-user'").email,
    ).toBe("entra@example.test");
    const replay = await flow.callback(
      callback(started.location),
      flowHeaders(started.cookie),
    );
    expect(replay.location).toBe("/login?error=oidc");
    expect(exchange).toHaveBeenCalledOnce();
  });
  it("rejects mismatched state, tampered and expired cookies before any token exchange", async () => {
    const { flow, exchange } = entraSetup();
    const started = await flow.login("//evil.test");
    const wrongState = callback(started.location);
    wrongState.searchParams.set("state", "wrong");
    expect(
      (await flow.callback(wrongState, flowHeaders(started.cookie))).location,
    ).toBe("/login?error=oidc");
    const tampered = started.cookie.replace("exidraw_oidc=", "exidraw_oidc=x");
    expect(
      (await flow.callback(callback(started.location), flowHeaders(tampered)))
        .location,
    ).toBe("/login?error=oidc");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600001);
    expect(
      (
        await flow.callback(
          callback(started.location),
          flowHeaders(started.cookie),
        )
      ).location,
    ).toBe("/login?error=oidc");
    expect(exchange).not.toHaveBeenCalled();
  });
  it("clears flow cookies and hides token-exchange errors", async () => {
    const { flow, exchange } = entraSetup();
    const started = await flow.login();
    exchange.mockRejectedValue(new Error("token=secret-token"));
    const result = await flow.callback(
      callback(started.location),
      flowHeaders(started.cookie),
    );
    expect(result).toEqual({
      location: "/login?error=oidc",
      cookies: [
        "exidraw_oidc=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
      ],
    });
  });
  it("confines OIDC fetches to the issuer and never follows redirects", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("", {
          status: 302,
          headers: { location: "https://elsewhere.test" },
        }),
      );
    const restricted = issuerFetch(
      "https://issuer.test/tenant",
      fetch as unknown as typeof globalThis.fetch,
    );
    const options = { method: "GET", headers: {}, body: undefined };
    await expect(
      restricted("https://elsewhere.test/keys", options),
    ).rejects.toThrow("outside");
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      restricted("https://issuer.test/keys", options),
    ).rejects.toThrow("redirects");
    expect(fetch.mock.calls[0]![1].redirect).toBe("manual");
  });
});
