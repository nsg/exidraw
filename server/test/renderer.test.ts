import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Page } from "playwright";
import { describe, expect, test } from "vitest";
import {
  INTERNAL_RENDERER_PATH,
  RENDER_MAX_EDGE_PX,
  RENDER_MAX_PIXELS,
} from "@exidraw/shared";
import { parseConfig } from "../src/config.js";
import { Renderer, rendererDist } from "../src/renderer.js";
const config = (renderer: "on" | "off") =>
  parseConfig({
    AUTH_MODE: "dev",
    PUBLIC_URL: "http://localhost:8080",
    RENDERER: renderer,
  });
const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve(
        (
          server.address() as {
            port: number;
          }
        ).port,
      ),
    );
  });
const close = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
describe("renderer", () => {
  test("disabled renderer fails fast without launching a browser", async () => {
    const renderer = new Renderer(config("off"));
    await renderer.start(1);
    expect(renderer.status).toBe("disabled");
    await expect(renderer.call("ping")).rejects.toMatchObject({
      code: "renderer_unavailable",
    });
    await renderer.close();
  });
  test("converts contextual bindings and exports using only local assets", async () => {
    let forbiddenRequests = 0;
    let redirectedRequests = 0;
    const trap = createServer((_, response) => {
      forbiddenRequests++;
      response.end("forbidden");
    });
    const trapPort = await listen(trap);
    trap.on("upgrade", (_, socket) => {
      forbiddenRequests++;
      socket.destroy();
    });
    const server = createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url!, "http://localhost").pathname;
        if (pathname === "/redirect-target") {
          redirectedRequests++;
          response.end("redirect followed");
          return;
        }
        if (pathname === "/redirect-local" || pathname === "/redirect-chain") {
          response.writeHead(302, {
            Location: pathname === "/redirect-local" ? "/redirect-target" : "/redirect",
          }).end();
          return;
        }
        if (pathname === "/not-modified") {
          response.writeHead(304).end();
          return;
        }
        if (pathname === "/redirect") {
          response
            .writeHead(302, {
              Location: `http://127.0.0.1:${trapPort}/redirected`,
            })
            .end();
          return;
        }
        if (!pathname.startsWith(INTERNAL_RENDERER_PATH)) {
          response.writeHead(404).end();
          return;
        }
        const relative =
          pathname.slice(INTERNAL_RENDERER_PATH.length) || "index.html";
        const file = resolve(rendererDist, relative);
        if (!file.startsWith(rendererDist)) {
          response.writeHead(404).end();
          return;
        }
        response.setHeader(
          "Content-Type",
          (
            {
              ".js": "text/javascript",
              ".html": "text/html",
              ".css": "text/css",
              ".woff2": "font/woff2",
              ".wasm": "application/wasm",
            } as Record<string, string>
          )[extname(file)] ?? "application/octet-stream",
        );
        response.end(await readFile(file));
      } catch {
        response.writeHead(404).end();
      }
    });
    const port = await listen(server);
    const warnings: unknown[] = [];
    const renderer = new Renderer(config("on"), {
      warn: (...args) => warnings.push(args),
    });
    try {
      await renderer.start(port);
      expect(renderer.status, JSON.stringify(warnings)).toBe("ready");
      expect(await renderer.call("ping")).toBe("0.18.1");
      const boxes = await renderer.call(
        "convertSkeletons",
        [
          {
            id: "left",
            type: "rectangle",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            label: { text: "API Gateway" },
          },
          {
            id: "right",
            type: "rectangle",
            x: 400,
            y: 0,
            width: 200,
            height: 100,
            label: { text: "Auth" },
          },
        ],
        [],
      );
      expect(
        boxes.elements.filter((element) => element.type === "text"),
      ).toHaveLength(2);
      const arrow = await renderer.call(
        "convertSkeletons",
        [
          {
            id: "edge",
            type: "arrow",
            x: 200,
            y: 50,
            width: 200,
            height: 0,
            start: { id: "left" },
            end: { id: "right" },
            label: { text: "JWT" },
          },
        ],
        boxes.elements,
      );
      expect(arrow.elements.map((element) => element.id)).toContain("edge");
      expect(
        arrow.elements.every(
          (element) => !boxes.elements.some((box) => box.id === element.id),
        ),
      ).toBe(true);
      expect(arrow.contextPatches.map((patch) => patch.id).sort()).toEqual([
        "left",
        "right",
      ]);
      const edge = arrow.elements.find((element) => element.id === "edge")!;
      expect(edge.type === "arrow" && edge.startBinding?.elementId).toBe(
        "left",
      );
      expect(edge.type === "arrow" && edge.endBinding?.elementId).toBe("right");
      const elements = [...boxes.elements, ...arrow.elements];
      const png = await renderer.call("exportPng", {
        elements,
        files: {},
        options: { scale: 2, padding: 20 },
      });
      const bytes = Buffer.from(png.base64, "base64");
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.readUInt32BE(16)).toBe(png.width);
      expect(bytes.readUInt32BE(20)).toBe(png.height);
      expect(png.width).toBe(1280);
      expect(png.height).toBe(280);
      const page = (
        renderer as unknown as {
          page: Page;
        }
      ).page;
      const decoded = await page.evaluate(async (base64) => {
        const image = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${base64}`)).blob(),
        );
        return [image.width, image.height];
      }, png.base64);
      expect(decoded).toEqual([png.width, png.height]);
      const svg = await renderer.call("exportSvg", {
        elements,
        files: {},
        options: { elementIds: ["left"], padding: 0 },
      });
      expect(svg.width).toBe(200);
      expect(svg.height).toBe(100);
      expect(svg.svg).toContain("API Gateway");
      expect(svg.svg).toContain("data:font/woff2");
      const restored = await renderer.call(
        "restoreTouched",
        elements.map((element) =>
          element.type === "text"
            ? {
                ...element,
                text: "A longer label",
                originalText: "A longer label",
                fontSize: 30,
              }
            : element,
        ),
        ["left"],
      );
      expect(restored.map((element) => element.type).sort()).toEqual([
        "rectangle",
        "text",
      ]);
      expect(
        restored.every(
          (element) =>
            element.version ===
            elements.find((original) => original.id === element.id)!.version,
        ),
      ).toBe(true);
      const capped = await renderer.call("exportPng", {
        elements: boxes.elements.map((element) => ({
          ...element,
          x: element.x * 100,
        })),
        files: {},
        options: { scale: 4 },
      });
      expect(capped.width).toBeLessThanOrEqual(RENDER_MAX_EDGE_PX);
      expect(capped.width * capped.height).toBeLessThanOrEqual(
        RENDER_MAX_PIXELS,
      );
      expect(capped.scale).toBeLessThan(4);
      const definition = `flowchart LR\n ${"longNode".repeat(15)}[One] --> B[Two]`;
      const diagram = await renderer.call(
        "mermaid",
        definition,
        { x: 300, y: 400, fontSize: 24 },
      );
      expect(diagram.elements.length).toBeGreaterThan(2);
      expect(
        Math.min(...diagram.elements.map((element) => element.x)),
      ).toBeCloseTo(300);
      expect(
        Math.min(...diagram.elements.map((element) => element.y)),
      ).toBeCloseTo(400);
      const repeated = await renderer.call("mermaid", definition, { x: 0, y: 0 });
      const firstIds = new Set(diagram.elements.map((element) => element.id));
      expect(repeated.elements.every((element) => !firstIds.has(element.id))).toBe(true);
      for (const converted of [diagram, repeated]) {
        const ids = new Set(converted.elements.map((element) => element.id));
        expect(ids.size).toBe(converted.elements.length);
        expect([...ids].every((id) => id.length > 0 && id.length <= 64)).toBe(true);
        const arrows = converted.elements.filter((element) => element.type === "arrow");
        expect(arrows.length).toBeGreaterThan(0);
        for (const arrow of arrows) {
          expect(ids.has(arrow.startBinding!.elementId)).toBe(true);
          expect(ids.has(arrow.endBinding!.elementId)).toBe(true);
        }
        for (const element of converted.elements) {
          for (const bound of element.boundElements ?? []) expect(ids.has(bound.id)).toBe(true);
          if (element.type === "text" && element.containerId) expect(ids.has(element.containerId)).toBe(true);
        }
      }
      const rejectedRedirects = await page.evaluate(async (port) => {
        await fetch(`http://127.0.0.1:${port}/blocked`).catch(() => {});
        await fetch("https://example.com/blocked").catch(() => {});
        const rejectedRedirects = await Promise.all(
          ["/redirect", "/redirect-local", "/redirect-chain", "/not-modified"].map((path) =>
            fetch(path).then(() => false, () => true),
          ),
        );
        await new Promise<void>((resolve) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/blocked`);
          socket.onclose = () => resolve();
          socket.onerror = () => resolve();
        });
        return rejectedRedirects;
      }, trapPort);
      expect(rejectedRedirects).toEqual([true, true, true, true]);
      expect(redirectedRequests).toBe(0);
      expect(forbiddenRequests).toBe(0);
      // Invalid input must leave the persistent helper available for later calls.
      await expect(
        renderer.call("mermaid", "not a valid diagram", { x: 0, y: 0 }),
      ).rejects.toMatchObject({ code: "invalid" });
      expect(renderer.status).toBe("ready");
      await page.close();
      expect(renderer.status).toBe("down");
      await expect(renderer.call("ping")).rejects.toMatchObject({
        code: "renderer_unavailable",
      });
      await expect
        .poll(() => renderer.status, { timeout: 30000 })
        .toBe("ready");
    } finally {
      await renderer.close();
      await Promise.all([close(server), close(trap)]);
    }
  }, 90000);
});
