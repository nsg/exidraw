import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";
import { test, expect } from "vitest";
import { createBackend } from "../src/app.js";
import { parseConfig } from "../src/config.js";
// This is the user-facing tool path, including PAT and actual Chromium, rather
// than a bridge-only test. Chromium is installed locally and in CI.
test("MCP creates a live room, edits labelled boxes and bound arrows and renders PNG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exidraw-mcp-"));
  const backend = createBackend(
    parseConfig({
      AUTH_MODE: "dev",
      PUBLIC_URL: "http://localhost:5173",
      ADMIN_EMAILS: "alice@example.test",
      DATA_DIR: dir,
      HOST: "127.0.0.1",
      PORT: "0",
      RENDERER: "on",
      LOG_LEVEL: "silent",
    }),
  );
  let client: Client | undefined, socket: WebSocket | undefined;
  try {
    const { port } = await backend.start(),
      base = `http://127.0.0.1:${port}`;
    const login = await fetch(base + "/auth/dev/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-exidraw-csrf": "1" },
      body: JSON.stringify({ userId: "alice" }),
    });
    expect(login.status).toBe(204);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const tokenResponse = await fetch(base + "/api/tokens", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-exidraw-csrf": "1",
      },
      body: JSON.stringify({ name: "test agent" }),
    });
    expect(tokenResponse.status).toBe(201);
    const { token, info } = (await tokenResponse.json()) as any;
    client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client!.callTool({ name, arguments: args });
      expect(r.isError, JSON.stringify(r)).not.toBe(true);
      expect(r.structuredContent).toBeDefined();
      return r as any;
    };
    const room = (
      await call("create_room", { folderId: "root", name: "Agent bridge" })
    ).structuredContent.room;
    expect((await call("whoami", {})).structuredContent.tokenName).toBe(
      "test agent",
    );
    const folder = (
      await call("create_folder", { parentId: "root", name: "MCP Folder" })
    ).structuredContent.folder;
    expect(
      (
        await call("list_folder", { folderId: "root" })
      ).structuredContent.folders.some((f: any) => f.id === folder.id),
    ).toBe(true);
    expect(
      (await call("search", { query: "Agent bridge" })).structuredContent
        .rooms[0].id,
    ).toBe(room.id);
    expect(
      (await call("get_room", { roomId: room.id })).structuredContent
        .elementCount,
    ).toBe(0);
    const messages: any[] = [];
    socket = new WebSocket(
      `${base.replace("http:", "ws:")}/ws?room=${room.id}`,
      { origin: "http://localhost:5173", headers: { cookie } },
    );
    socket.on("message", (d) => messages.push(JSON.parse(d.toString())));
    await expect
      .poll(() => messages.some((m) => m.type === "scene_init"))
      .toBe(true);
    await expect
      .poll(() => backend.renderer.status, { timeout: 30000 })
      .toBe("ready");
    const added = await call("add_elements", {
      roomId: room.id,
      elements: [
        {
          type: "rectangle",
          id: "api",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          label: { text: "API Gateway" },
        },
        {
          type: "rectangle",
          id: "auth",
          x: 400,
          y: 0,
          width: 200,
          height: 100,
          label: { text: "Auth" },
        },
        {
          type: "arrow",
          id: "jwt",
          start: { id: "api" },
          end: { id: "auth" },
          label: { text: "JWT" },
        },
      ],
    });
    expect(added.structuredContent.added).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "api", label: "API Gateway" }),
        expect.objectContaining({ id: "jwt", from: "api", to: "auth" }),
      ]),
    );
    await expect
      .poll(() =>
        messages.some(
          (m) =>
            m.type === "scene_update" &&
            m.origin === "server" &&
            m.elements.some((e: any) => e.id === "api"),
        ),
      )
      .toBe(true);
    expect(
      messages.find(
        (m) =>
          m.type === "presence" &&
          m.collaborators.some((p: any) => p.connId === `agent:${info.id}`),
      ),
    ).toBeDefined();
    const scene = (await call("read_scene", { roomId: room.id }))
      .structuredContent;
    expect(scene.elements).toHaveLength(3);
    expect(scene.activeUsers).toContain("test agent (agent)");
    const updated = (
      await call("update_elements", {
        roomId: room.id,
        updates: [
          { id: "api", set: { label: "New API", backgroundColor: "#a5d8ff" } },
        ],
      })
    ).structuredContent;
    expect(updated.updated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "api", label: "New API", bg: "#a5d8ff" }),
      ]),
    );
    const png = await call("render_image", { roomId: room.id, format: "png" });
    const image = png.content.find((c: any) => c.type === "image");
    const bytes = Buffer.from(image.data, "base64");
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16)).toBe(png.structuredContent.width);
    expect(bytes.readUInt32BE(20)).toBe(png.structuredContent.height);
    const collision = await client.callTool({
      name: "add_elements",
      arguments: {
        roomId: room.id,
        elements: [{ type: "rectangle", id: "api", x: 1, y: 1 }],
      },
    });
    expect(collision.isError).toBe(true);
    // A separate call exercises references to existing labelled containers.
    await call("add_elements", {
      roomId: room.id,
      elements: [
        {
          type: "arrow",
          id: "second",
          start: { id: "auth" },
          end: { id: "api" },
        },
      ],
    });
    await call("move_elements", {
      roomId: room.id,
      ids: ["auth"],
      dx: 25,
      dy: 15,
    });
    const deleted = (
      await call("delete_elements", { roomId: room.id, ids: ["api"] })
    ).structuredContent;
    expect(deleted.deleted).toEqual(["api"]);
    const full = (
      await call("read_scene", {
        roomId: room.id,
        format: "full",
        includeDeleted: true,
      })
    ).structuredContent.elements;
    expect(full.find((e: any) => e.id === "api").isDeleted).toBe(true);
    expect(full.find((e: any) => e.id === "jwt").startBinding).toBeNull();
    expect(full.find((e: any) => e.id === "second").endBinding).toBeNull();
    expect(
      full
        .filter((e: any) => e.type === "text" && e.containerId === "api")
        .every((e: any) => e.isDeleted),
    ).toBe(true);
    await call("add_elements", {
      roomId: room.id,
      elements: [{ type: "rectangle", id: "bare", x: 0, y: 300 }],
    });
    await call("update_elements", {
      roomId: room.id,
      updates: [{ id: "bare", set: { label: "Added later", fontSize: 30 } }],
    });
    let labelled = (
      await call("read_scene", { roomId: room.id, format: "full" })
    ).structuredContent.elements;
    expect(
      labelled.find((e: any) => e.type === "text" && e.containerId === "bare")
        .originalText,
    ).toBe("Added later");
    await call("update_elements", {
      roomId: room.id,
      updates: [{ id: "bare", set: { fontSize: 32 } }],
    });
    labelled = (await call("read_scene", { roomId: room.id, format: "full" }))
      .structuredContent.elements;
    expect(
      labelled.find((e: any) => e.type === "text" && e.containerId === "bare")
        .fontSize,
    ).toBe(32);
    await call("add_elements", {
      roomId: room.id,
      elements: [{ type: "frame", id: "group", children: ["bare", "auth"] }],
    });
    labelled = (await call("read_scene", { roomId: room.id, format: "full" }))
      .structuredContent.elements;
    expect(labelled.find((e: any) => e.id === "bare").frameId).toBe("group");
    await call("update_elements", {
      roomId: room.id,
      updates: [{ id: "bare", set: { label: "" } }],
    });
    labelled = (
      await call("read_scene", {
        roomId: room.id,
        format: "full",
        includeDeleted: true,
      })
    ).structuredContent.elements;
    expect(
      labelled
        .filter((e: any) => e.type === "text" && e.containerId === "bare")
        .every((e: any) => e.isDeleted),
    ).toBe(true);
    expect(
      (
        await call("mermaid_to_elements", {
          roomId: room.id,
          mermaid: "flowchart LR\n A[One] --> B[Two]",
          x: 0,
          y: 500,
        })
      ).structuredContent.added.length,
    ).toBeGreaterThan(2);
    // Node-only tools keep working with Chromium disabled/down.
    await backend.renderer.close();
    const unavailable = await client.callTool({
      name: "render_image",
      arguments: { roomId: room.id },
    });
    expect(unavailable.isError).toBe(true);
    expect(JSON.stringify(unavailable)).toContain("renderer_unavailable");
    await call("move_elements", {
      roomId: room.id,
      ids: ["auth"],
      dx: 1,
      dy: 1,
    });
    const snapshots = backend.rooms.snapshots(room.id);
    expect(snapshots.some((s) => s.reason === "agent")).toBe(true);
  } finally {
    socket?.terminate();
    await client?.close();
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
