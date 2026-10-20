import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  MAX_FILE_BYTES_DEFAULT,
  SESSION_TTL_DAYS_DEFAULT,
} from "@exidraw/shared";
const devUser = z.object({
  id: z.string().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(1).max(200),
});
const defaultUsers = [
  { id: "alice", email: "alice@example.test", name: "Alice Architect" },
  { id: "bob", email: "bob@example.test", name: "Bob Builder" },
  { id: "carol", email: "carol@example.test", name: "Carol Viewer" },
  { id: "dave", email: "dave@example.test", name: "Dave Visitor" },
];
const origin = z
  .string()
  .url()
  .transform((value, ctx) => {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "must be an HTTP(S) origin with no path, credentials, query or fragment",
      });
      return z.NEVER;
    }
    return url.origin;
  });
const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    HOST: z.string().min(1).default("0.0.0.0"),
    DATA_DIR: z.string().min(1).default("/data"),
    PUBLIC_URL: origin,
    ALLOWED_ORIGINS: z.string().default(""),
    AUTH_MODE: z.enum(["entra", "dev"]).default("entra"),
    ADMIN_EMAILS: z.string().default(""),
    ADMIN_OIDS: z.string().default(""),
    DEV_USERS: z.string().optional(),
    SESSION_TTL_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .default(SESSION_TTL_DAYS_DEFAULT),
    MAX_FILE_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(MAX_FILE_BYTES_DEFAULT),
    RENDERER: z.enum(["on", "off"]).default("on"),
    WEB_DIST_DIR: z
      .string()
      .min(1)
      .default(fileURLToPath(new URL("../../web/dist", import.meta.url))),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    LOG_PRETTY: z.enum(["0", "1"]).default("0"),
    ENTRA_TENANT_ID: z.string().optional(),
    ENTRA_CLIENT_ID: z.string().optional(),
    ENTRA_CLIENT_SECRET: z.string().optional(),
    ENTRA_ISSUER: z.string().url().optional(),
    ENTRA_ALLOW_GUESTS: z.enum(["true", "false"]).default("false"),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === "entra") {
      for (const key of [
        "ENTRA_TENANT_ID",
        "ENTRA_CLIENT_ID",
        "ENTRA_CLIENT_SECRET",
      ] as const) {
        if (!env[key]?.trim())
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "required in entra mode",
          });
      }
      if (env.ENTRA_TENANT_ID && !/^[a-zA-Z0-9.-]+$/.test(env.ENTRA_TENANT_ID))
        ctx.addIssue({
          code: "custom",
          path: ["ENTRA_TENANT_ID"],
          message: "invalid tenant id",
        });
    }
    if (env.ENTRA_ISSUER) {
      const issuer = new URL(env.ENTRA_ISSUER);
      if (
        issuer.protocol !== "https:" ||
        issuer.username ||
        issuer.password ||
        issuer.search ||
        issuer.hash
      )
        ctx.addIssue({
          code: "custom",
          path: ["ENTRA_ISSUER"],
          message:
            "must be an HTTPS issuer URL without credentials, query or fragment",
        });
    }
  });
export function parseConfig(env: NodeJS.ProcessEnv = process.env) {
  try {
    const value = envSchema.parse(env);
    const allowedOrigins = value.ALLOWED_ORIGINS.split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => origin.parse(v));
    const adminEmails = value.ADMIN_EMAILS.split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
      .map((v) => z.string().email().parse(v));
    const devUsers =
      value.AUTH_MODE === "dev" && value.DEV_USERS !== undefined
        ? z.array(devUser).min(1).parse(JSON.parse(value.DEV_USERS))
        : defaultUsers.map((u) => ({ ...u }));
    if (
      new Set(devUsers.map((u) => u.id)).size !== devUsers.length ||
      new Set(devUsers.map((u) => u.email)).size !== devUsers.length
    )
      throw new Error("DEV_USERS must have unique ids and emails");
    return Object.freeze({
      port: value.PORT,
      host: value.HOST,
      dataDir: value.DATA_DIR,
      publicUrl: value.PUBLIC_URL,
      allowedOrigins: Object.freeze(allowedOrigins),
      authMode: value.AUTH_MODE,
      adminEmails: Object.freeze(adminEmails),
      adminOids: Object.freeze(
        value.ADMIN_OIDS.split(",")
          .map((v) => v.trim().toLowerCase())
          .filter(Boolean)
          .map((v) => z.string().uuid().parse(v)),
      ),
      devUsers: Object.freeze(devUsers.map((u) => Object.freeze(u))),
      sessionTtlDays: value.SESSION_TTL_DAYS,
      maxFileBytes: value.MAX_FILE_BYTES,
      renderer: value.RENDERER,
      webDistDir: value.WEB_DIST_DIR,
      logLevel: value.LOG_LEVEL,
      logPretty: value.LOG_PRETTY === "1",
      entraTenantId: value.ENTRA_TENANT_ID,
      entraAllowGuests: value.ENTRA_ALLOW_GUESTS === "true",
      entraClientId: value.ENTRA_CLIENT_ID,
      entraClientSecret: value.ENTRA_CLIENT_SECRET,
      entraIssuer:
        value.ENTRA_ISSUER ??
        (value.ENTRA_TENANT_ID
          ? `https://login.microsoftonline.com/${value.ENTRA_TENANT_ID}/v2.0`
          : undefined),
    });
  } catch (error) {
    throw new Error(
      `Invalid configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export type Config = ReturnType<typeof parseConfig>;
