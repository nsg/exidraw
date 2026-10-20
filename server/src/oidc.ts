import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as client from "openid-client";
import { OIDC_FLOW_COOKIE } from "@exidraw/shared";
import { z } from "zod";
import { AuthService, cookieValue, type LoginIdentity } from "./auth.js";
import type { Config } from "./config.js";
const FLOW_SECONDS = 600;
const flowSchema = z.object({
  state: z.string().min(32),
  verifier: z.string().min(32),
  nonce: z.string().min(32),
  returnTo: z.string(),
  expiresAt: z.number(),
});
type Flow = z.infer<typeof flowSchema>;
export interface OidcDependencies {
  discover?: typeof client.discovery;
  exchange?: typeof client.authorizationCodeGrant;
  fetch?: typeof globalThis.fetch;
}
export function safeReturnTo(value?: string | null): string {
  // Browsers normalize backslashes into slashes before navigating; reject those too.
  return value &&
    value.length <= 2048 &&
    /^\/(?!\/)/.test(value) &&
    !/[\\\u0000-\u0020\u007f]/.test(value)
    ? value
    : "/";
}
export function claimsToIdentity(
  claims: Record<string, unknown> | undefined,
): LoginIdentity {
  const values = z
    .object({
      oid: z.string().min(1).max(256),
      email: z.string().optional(),
      preferred_username: z.string().optional(),
      name: z.string().optional(),
    })
    .parse(claims);
  const email = z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(320)
    .parse(values.preferred_username ?? values.email);
  return { subject: values.oid, email, name: values.name?.trim() || email };
}
/** Every server-side OIDC request stays on the configured issuer's origin. */
export function issuerFetch(
  issuer: string,
  implementation: typeof globalThis.fetch = globalThis.fetch,
): client.CustomFetch {
  const origin = new URL(issuer).origin;
  return async (input, options) => {
    const url = new URL(input);
    if (
      url.origin !== origin ||
      url.protocol !== "https:" ||
      url.username ||
      url.password
    )
      throw new Error("OIDC request outside configured issuer origin");
    const body =
      options.body instanceof Uint8Array
        ? new Uint8Array(options.body).buffer
        : options.body;
    const response = await implementation(url, {
      ...options,
      body,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error("OIDC redirects are not allowed");
    return response;
  };
}
export class OidcFlow {
  private readonly key = randomBytes(32);
  private configuration?: Promise<client.Configuration>;
  private readonly used = new Map<string, number>();
  constructor(
    readonly config: Config,
    readonly auth: AuthService,
    private readonly deps: OidcDependencies = {},
  ) {}
  private async discover(): Promise<client.Configuration> {
    if (
      this.config.authMode !== "entra" ||
      !this.config.entraIssuer ||
      !this.config.entraClientId ||
      !this.config.entraClientSecret
    )
      throw new Error("Entra authentication is not configured");
    if (!this.configuration) {
      const fetch = issuerFetch(this.config.entraIssuer, this.deps.fetch);
      this.configuration = (this.deps.discover ?? client.discovery)(
        new URL(this.config.entraIssuer),
        this.config.entraClientId,
        this.config.entraClientSecret,
        client.ClientSecretPost(this.config.entraClientSecret),
        {
          [client.customFetch]: fetch,
          timeout: 10,
          execute: [client.enableNonRepudiationChecks],
        },
      )
        .then((configuration) => {
          const metadata = configuration.serverMetadata();
          if (metadata.issuer !== this.config.entraIssuer)
            throw new Error("Unexpected OIDC issuer");
          for (const endpoint of [
            metadata.authorization_endpoint,
            metadata.token_endpoint,
            metadata.jwks_uri,
          ]) {
            if (
              endpoint &&
              new URL(endpoint).origin !==
                new URL(this.config.entraIssuer!).origin
            )
              throw new Error("OIDC endpoint outside configured issuer origin");
          }
          configuration[client.customFetch] = fetch;
          return configuration;
        })
        .catch((error) => {
          this.configuration = undefined;
          throw error;
        });
    }
    return this.configuration;
  }
  private flowCookie(value: string | null): string {
    return `${OIDC_FLOW_COOKIE}=${value ?? ""}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${value === null ? 0 : FLOW_SECONDS}${this.config.publicUrl.startsWith("https:") ? "; Secure" : ""}`;
  }
  private encode(flow: Flow): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(OIDC_FLOW_COOKIE));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(flow)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }
  private decode(value: string | null): Flow {
    if (!value || value.length > 5000 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error("Missing or invalid OIDC flow");
    const data = Buffer.from(value, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      data.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(OIDC_FLOW_COOKIE));
    decipher.setAuthTag(data.subarray(12, 28));
    const flow = flowSchema.parse(
      JSON.parse(
        Buffer.concat([
          decipher.update(data.subarray(28)),
          decipher.final(),
        ]).toString(),
      ),
    );
    if (
      flow.expiresAt <= Date.now() ||
      flow.expiresAt > Date.now() + FLOW_SECONDS * 1000
    )
      throw new Error("Expired OIDC flow");
    return flow;
  }
  private prune(): void {
    for (const [state, expiry] of this.used)
      if (expiry <= Date.now()) this.used.delete(state);
  }
  async login(returnTo?: string | null): Promise<{
    location: string;
    cookie: string;
  }> {
    const configuration = await this.discover();
    const verifier = client.randomPKCECodeVerifier();
    const flow: Flow = {
      state: client.randomState(),
      verifier,
      nonce: client.randomNonce(),
      returnTo: safeReturnTo(returnTo),
      expiresAt: Date.now() + FLOW_SECONDS * 1000,
    };
    const location = client.buildAuthorizationUrl(configuration, {
      redirect_uri: `${this.config.publicUrl}/auth/callback`,
      scope: "openid profile email",
      response_type: "code",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    }).href;
    this.prune();
    return { location, cookie: this.flowCookie(this.encode(flow)) };
  }
  async callback(
    url: URL,
    headers: Headers,
  ): Promise<{
    location: string;
    cookies: string[];
    forbidden?: boolean;
  }> {
    const clearCookie = this.flowCookie(null);
    try {
      const flow = this.decode(cookieValue(headers, OIDC_FLOW_COOKIE));
      const target = new URL(`${this.config.publicUrl}/auth/callback`);
      if (
        url.origin !== target.origin ||
        url.pathname !== target.pathname ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.get("state") !== flow.state
      )
        throw new Error("OIDC state mismatch");
      this.prune();
      if (this.used.has(flow.state))
        throw new Error("OIDC flow already consumed");
      this.used.set(flow.state, flow.expiresAt);
      const configuration = await this.discover();
      const tokens = await (
        this.deps.exchange ?? client.authorizationCodeGrant
      )(configuration, url, {
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        pkceCodeVerifier: flow.verifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      // Resource-tenant iss/tid also occur on B2B guest tokens. Require the
      // optional ID-token acct claim (0=member, 1=guest) when guests are denied.
      if (
        !this.config.entraAllowGuests &&
        claims?.acct !== 0 && claims?.acct !== "0"
      )
        return {
          location: "/login?error=guest",
          cookies: [clearCookie],
          forbidden: true,
        };
      const identity = claimsToIdentity(claims);
      const { sessionId } = this.auth.login(identity, "entra");
      return {
        location: safeReturnTo(flow.returnTo),
        cookies: [clearCookie, this.auth.sessionCookie(sessionId)],
      };
    } catch {
      return { location: "/login?error=oidc", cookies: [clearCookie] };
    }
  }
}
