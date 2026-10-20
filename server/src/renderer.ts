import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { INTERNAL_RENDERER_PATH, RENDER_TIMEOUT_MS } from "@exidraw/shared";
import type { RendererBridge } from "@exidraw/shared";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
export const rendererDist = fileURLToPath(
  new URL("../renderer-dist/", import.meta.url),
);
type RendererStatus = "ready" | "starting" | "down" | "disabled";
type RendererLogger = {
  warn: (...args: any[]) => void;
  info?: (...args: any[]) => void;
};
function unavailable(): HttpError {
  return new HttpError(
    "renderer_unavailable",
    "The renderer is unavailable; retry shortly",
  );
}
async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unavailable()), RENDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Chromium is deliberately isolated from room storage and collaboration. */
export class Renderer {
  status: RendererStatus;
  private browser?: Browser;
  private page?: Page;
  private port?: number;
  private stopped = false;
  private generation = 0;
  private retryDelay = 1000;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private launching?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly config: Config,
    private readonly logger?: RendererLogger,
  ) {
    this.status = config.renderer === "off" ? "disabled" : "down";
  }
  async start(port: number): Promise<void> {
    if (this.config.renderer === "off" || this.stopped) return;
    this.port = port;
    if (this.status === "ready") return;
    if (this.launching) return this.launching;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.launching = this.launch();
    try {
      await this.launching;
    } finally {
      this.launching = undefined;
    }
  }
  private async launch(): Promise<void> {
    const generation = ++this.generation;
    this.status = "starting";
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--disable-background-networking",
          "--disable-component-update",
          "--no-first-run",
        ],
        timeout: RENDER_TIMEOUT_MS,
      });
      if (this.stopped || generation !== this.generation) {
        await browser.close();
        return;
      }
      this.browser = browser;
      browser.on("disconnected", () =>
        this.fail(generation, new Error("Renderer browser disconnected")),
      );
      const context = await browser.newContext({ serviceWorkers: "block" });
      const origin = `http://127.0.0.1:${this.port}`;
      // Intercept before creating the page. Do not allow alternate loopback
      // ports/hostnames, redirects, workers or WebSockets.
      await context.route("**/*", async (route) => {
        try {
          const url = new URL(route.request().url());
          if (url.protocol === "data:" || url.protocol === "blob:") {
            await route.continue();
            return;
          }
          if (url.protocol !== "http:" || url.origin !== origin) {
            await route.abort("blockedbyclient");
            return;
          }
          // Playwright routes only the first request in a redirect chain. Fetch
          // without following redirects, and reject every redirect response.
          const response = await route.fetch({
            maxRedirects: 0,
            timeout: RENDER_TIMEOUT_MS,
          });
          try {
            if (response.status() >= 300 && response.status() < 400) {
              await route.abort("blockedbyclient");
              return;
            }
            await route.fulfill({ response });
          } finally {
            await response.dispose();
          }
        } catch {
          // Closing a failed page can interrupt pending local asset requests.
          await route.abort("blockedbyclient").catch(() => {});
        }
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      const page = await context.newPage();
      this.page = page;
      page.on("crash", () =>
        this.fail(generation, new Error("Renderer page crashed")),
      );
      page.on("close", () =>
        this.fail(generation, new Error("Renderer page closed")),
      );
      await page.goto(`${origin}${INTERNAL_RENDERER_PATH}`, {
        waitUntil: "load",
        timeout: RENDER_TIMEOUT_MS,
      });
      await page.waitForFunction(
        () => window.exidrawRenderer?.ping() === "0.18.1",
        undefined,
        { timeout: RENDER_TIMEOUT_MS },
      );
      if (this.stopped || generation !== this.generation) {
        await browser.close();
        return;
      }
      this.status = "ready";
      this.retryDelay = 1000;
      this.logger?.info?.("Renderer ready");
    } catch (error) {
      this.fail(generation, error);
      void browser?.close().catch(() => {});
    }
  }
  private fail(generation: number, error: unknown): void {
    if (this.stopped || generation !== this.generation) return;
    ++this.generation;
    this.status = "down";
    this.page = undefined;
    const browser = this.browser;
    this.browser = undefined;
    void browser?.close().catch(() => {});
    this.logger?.warn({ err: error }, "Renderer unavailable; restarting");
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, 30000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped && this.port !== undefined) void this.start(this.port);
    }, delay);
    this.retryTimer.unref();
  }
  call<K extends keyof RendererBridge>(
    method: K,
    ...args: Parameters<RendererBridge[K]>
  ): Promise<Awaited<ReturnType<RendererBridge[K]>>> {
    if (this.status !== "ready" || !this.page)
      return Promise.reject(unavailable());
    const generation = this.generation;
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        const page = this.page;
        if (
          this.stopped ||
          this.status !== "ready" ||
          !page ||
          generation !== this.generation
        )
          throw unavailable();
        let result;
        try {
          result = await deadline(
            page.evaluate(
              async ({ method, args }) => {
                try {
                  const bridge = window.exidrawRenderer!;
                  const fn = bridge[method] as (
                    ...values: unknown[]
                  ) => unknown;
                  return { ok: true as const, value: await fn(...args) };
                } catch (error) {
                  return {
                    ok: false as const,
                    message:
                      error instanceof Error ? error.message : String(error),
                  };
                }
              },
              { method, args },
            ),
          );
        } catch (error) {
          this.fail(generation, error);
          throw unavailable();
        }
        if (!result.ok) throw new HttpError("invalid", result.message);
        return result.value as Awaited<ReturnType<RendererBridge[K]>>;
      });
    this.queue = work;
    return work as Promise<Awaited<ReturnType<RendererBridge[K]>>>;
  }
  async close(): Promise<void> {
    this.stopped = true;
    ++this.generation;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.status = this.config.renderer === "off" ? "disabled" : "down";
    this.page = undefined;
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close();
  }
}
