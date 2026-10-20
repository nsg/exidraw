import { Writable } from "node:stream";
import pino from "pino";
import type { Config } from "./config.js";
export function createLogger(config: Pick<Config, "logLevel" | "logPretty">) {
  const options: pino.LoggerOptions = {
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "password",
        "clientSecret",
        "token",
        "sessionId",
      ],
      censor: "[redacted]",
    },
  };
  if (!config.logPretty) return pino(options);
  const pretty = new Writable({
    write(chunk, _encoding, callback) {
      try {
        const record = JSON.parse(String(chunk));
        const {
          time,
          level,
          msg,
          pid: _pid,
          hostname: _hostname,
          ...fields
        } = record;
        process.stdout.write(
          `${new Date(time).toISOString()} ${pino.levels.labels[level]?.toUpperCase() ?? level} ${msg ?? ""}${Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ""}\n`,
        );
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  return pino(options, pretty);
}
