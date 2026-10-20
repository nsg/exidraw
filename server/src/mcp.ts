import { VERSION } from "./version.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Tools, MCP_SERVER_NAME } from "@exidraw/shared";
import type {
  ToolName,
  SceneElement,
  SceneSummary,
  RenderRequest,
} from "@exidraw/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthContext } from "./auth.js";
import { Tree, id } from "./tree.js";
import { RoomManager, stamp } from "./rooms.js";
import { FileStore } from "./files.js";
import { Renderer } from "./renderer.js";
import { HttpError } from "./errors.js";
import { compact, compactText, bounds, select } from "./compact.js";
import { refreshBoundArrows } from "./bindings.js";
// Work on JSON clones; Excalidraw-specific mutable fields stay opaque to Node.
type Mutable = Record<string, any>;
function normalize(e: Mutable): Mutable {
  const result = structuredClone(e);
  if (typeof result.angle === "number")
    result.angle = (result.angle * Math.PI) / 180;
  if (result.roundness === "round") result.roundness = { type: 3 };
  else if (result.roundness === "sharp") result.roundness = null;
  return result;
}
export class McpTools {
  constructor(
    readonly tree: Tree,
    readonly rooms: RoomManager,
    readonly files: FileStore,
    readonly renderer: Renderer,
  ) {}
  summary(auth: AuthContext, roomId: string): SceneSummary {
    const elements = this.rooms.elements(roomId);
    return {
      room: this.tree.room(auth.subject, roomId),
      sceneVersion: this.rooms.load(roomId).sceneVersion,
      bounds: bounds(elements),
      totalElements: elements.filter((e) => !e.isDeleted).length,
      activeUsers: this.rooms
        .collaborators(roomId)
        .map((p) => p.name + (p.isAgent ? " (agent)" : "")),
    };
  }
  private commit(
    auth: AuthContext,
    roomId: string,
    changes: SceneElement[],
    baseline: SceneElement[],
    newIds: string[] = [],
    readIds: string[] = [],
  ) {
    this.tree.require(auth.subject, "room", roomId, "writeScene");
    const current = this.rooms.elements(roomId);
    // Only dependencies used by this edit must remain unchanged while the
    // browser works. Unrelated scene edits can proceed without a conflict.
    const byId = new Map(current.map((e) => [e.id, e]));
    const originals = new Map(baseline.map((e) => [e.id, e]));
    for (const elementId of new Set([
      ...readIds,
      ...changes.map((e) => e.id),
    ])) {
      const original = originals.get(elementId);
      if (
        original &&
        JSON.stringify(byId.get(elementId)) !== JSON.stringify(original)
      )
        throw new HttpError(
          "conflict",
          `Element ${elementId} changed during conversion; retry the tool`,
        );
    }
    for (const newId of newIds)
      if (byId.has(newId))
        throw new HttpError("conflict", `Element already exists: ${newId}`);
    const stamped = changes.map((e) => stamp(e, byId.get(e.id)));
    this.rooms.beforeAgent(roomId, auth.user.id);
    this.rooms.applyElements(roomId, stamped, "server");
    this.rooms.persist(roomId);
    this.rooms.agent(roomId, auth.token!, auth.user, stamped);
    return stamped;
  }
  private async convert(skeletons: Mutable[], baseline: SceneElement[]) {
    const used = new Set(baseline.map((e) => e.id));
    const seen = new Set<string>();
    const normalized = skeletons.map((e) =>
      normalize({ ...e, id: e.id ?? id() }),
    );
    const collisions: string[] = [];
    for (const e of normalized) {
      if (used.has(e.id) || seen.has(e.id)) collisions.push(e.id);
      seen.add(e.id);
    }
    if (collisions.length)
      throw new HttpError(
        "conflict",
        `Element ids already exist or repeat: ${collisions.join(", ")}`,
      );
    const contextIds = new Set<string>(),
      all = new Map<string, Mutable>(
        [...baseline, ...normalized].map((e) => [e.id, e]),
      );
    for (const e of normalized) {
      for (const ref of [
        e.start?.id,
        e.end?.id,
        e.frameId,
        ...(e.children ?? []),
      ])
        if (ref) {
          if (!all.has(ref) || all.get(ref)!.isDeleted)
            throw new HttpError("invalid", `Unknown element reference: ${ref}`);
          contextIds.add(ref);
        }
      if (e.type === "arrow" || e.type === "line") {
        const start = all.get(e.start?.id);
        if (e.x === undefined) {
          if (!start)
            throw new HttpError(
              "invalid",
              "Arrow x/y required unless start is bound",
            );
        }
        if (e.y === undefined) {
          if (!start)
            throw new HttpError(
              "invalid",
              "Arrow x/y required unless start is bound",
            );
        }
      }
    }
    // Context must be closed over existing bindings: frame conversion inspects
    // every bound element of a child, including arrows and their endpoints.
    const existingById = new Map(baseline.map((e) => [e.id, e]));
    const pending = [...contextIds];
    while (pending.length) {
      const element = existingById.get(pending.pop()!);
      if (!element) continue;
      const raw = element as Mutable;
      const references = [
        ...(element.boundElements ?? []).map((b) => b.id),
        raw.startBinding?.elementId,
        raw.endBinding?.elementId,
        element.frameId,
      ];
      for (const reference of references) {
        const target = existingById.get(reference);
        if (target && !target.isDeleted && !contextIds.has(reference)) {
          contextIds.add(reference);
          pending.push(reference);
        }
      }
    }
    const result = await this.renderer.call(
      "convertSkeletons",
      normalized,
      baseline.filter((e) => contextIds.has(e.id)),
    );
    const changes = [...result.elements];
    for (const patch of result.contextPatches) {
      const cur = baseline.find((e) => e.id === patch.id);
      if (cur) {
        const union = new Map(
          [...(cur.boundElements ?? []), ...(patch.boundElements ?? [])].map(
            (b) => [b.id, b],
          ),
        );
        changes.push({ ...cur, boundElements: [...union.values()] });
      }
    }
    for (const frame of normalized.filter((e) => e.type === "frame")) {
      const children = new Set<string>(frame.children ?? []);
      for (const childId of [...children])
        for (const bound of (
          changes.find((e) => e.id === childId) ?? existingById.get(childId)
        )?.boundElements ?? [])
          if (bound.type === "text") children.add(bound.id);
      for (const childId of children) {
        const index = changes.findIndex((e) => e.id === childId);
        if (index >= 0)
          changes[index] = { ...changes[index]!, frameId: frame.id };
        else {
          const child = existingById.get(childId);
          if (child) changes.push({ ...child, frameId: frame.id });
        }
      }
    }
    return {
      changes,
      newIds: result.elements.map((e) => e.id),
      readIds: [...contextIds],
    };
  }
  async execute(
    name: ToolName,
    input: unknown,
    auth: AuthContext,
  ): Promise<CallToolResult> {
    try {
      const args = Tools[name].inputSchema.parse(input) as any;
      return await this.run(name, args, auth);
    } catch (error) {
      const e =
        error instanceof HttpError
          ? error
          : new HttpError(
              "invalid",
              error instanceof Error ? error.message : "Tool failed",
            );
      return {
        isError: true,
        content: [{ type: "text", text: `${e.code}: ${e.message}` }],
        structuredContent: { error: { code: e.code, message: e.message } },
      };
    }
  }
  private output(data: Record<string, any>, text?: string): CallToolResult {
    return {
      structuredContent: data,
      content: [{ type: "text", text: text ?? JSON.stringify(data) }],
    };
  }
  private async run(
    name: ToolName,
    a: any,
    auth: AuthContext,
  ): Promise<CallToolResult> {
    const s = auth.subject;
    switch (name) {
      case "whoami":
        return this.output({
          user: auth.user,
          isAdmin: s.isAdmin,
          tokenName: auth.token?.name ?? "",
        });
      case "list_folder": {
        const t = this.tree.list(s, a.folderId);
        return this.output({
          folder: t.folder,
          path: [...t.breadcrumbs, { id: t.folder.id, name: t.folder.name }],
          folders: t.folders,
          rooms: t.rooms,
        });
      }
      case "search": {
        const r = this.tree.search(s, a.query, a.inContent, (r) =>
          this.rooms.searchElements(r),
        );
        return this.output({
          folders: r.folders.slice(0, a.limit),
          rooms: r.rooms.slice(0, a.limit),
        });
      }
      case "create_folder":
        return this.output({
          folder: this.tree.createFolder(s, a.parentId, a.name),
        });
      case "create_room":
        return this.output({
          room: this.tree.createRoom(s, a.folderId, a.name),
        });
      case "get_room": {
        this.tree.require(s, "room", a.roomId, "readScene");
        const summary = this.summary(auth, a.roomId);
        return this.output({
          room: this.tree.room(s, a.roomId),
          path: this.tree
            .ancestors("room", a.roomId)
            .reverse()
            .map((f) => ({ id: f.id, name: f.name })),
          elementCount: summary.totalElements,
          activeUsers: summary.activeUsers,
        });
      }
      case "read_scene": {
        this.tree.require(s, "room", a.roomId, "readScene");
        const all = this.rooms.elements(a.roomId),
          filtered = select(all, a.region, a.elementIds, a.includeDeleted);
        const elements = (
            a.format === "full" ? filtered : compact(filtered, all)
          ).slice(a.offset, a.offset + a.limit),
          summary = this.summary(auth, a.roomId);
        return this.output(
          { ...summary, elements, returned: elements.length, offset: a.offset },
          a.format === "compact"
            ? compactText(summary, elements as any)
            : JSON.stringify({ ...summary, elements }),
        );
      }
      case "render_image": {
        this.tree.require(s, "room", a.roomId, "render");
        const elements = this.rooms.elements(a.roomId),
          req: RenderRequest = {
            elements,
            files: this.files.sceneFiles(a.roomId, elements),
            options: a,
          };
        const elementCount = select(elements, a.region, a.elementIds).length;
        if (a.format === "svg") {
          const r = await this.renderer.call("exportSvg", req);
          this.tree.require(s, "room", a.roomId, "render");
          return {
            structuredContent: {
              format: "svg",
              width: r.width,
              height: r.height,
              elementCount,
            },
            content: [{ type: "text", text: r.svg }],
          };
        }
        const r = await this.renderer.call("exportPng", req);
        this.tree.require(s, "room", a.roomId, "render");
        return {
          structuredContent: {
            format: "png",
            width: r.width,
            height: r.height,
            scale: r.scale,
            elementCount,
          },
          content: [
            { type: "image", mimeType: "image/png", data: r.base64 },
            {
              type: "text",
              text: `PNG ${r.width}x${r.height} (scale ${r.scale}), ${elementCount} elements`,
            },
          ],
        };
      }
    }
    this.tree.require(s, "room", a.roomId, "writeScene");
    const baseline = this.rooms.elements(a.roomId),
      byId = new Map(baseline.map((e) => [e.id, e]));
    let changes: SceneElement[] = [];
    let newIds: string[] = [];
    let readIds: string[] = [];
    let data: Record<string, any> = {};
    if (name === "add_elements") {
      const converted = await this.convert(a.elements, baseline);
      changes = converted.changes;
      newIds = converted.newIds;
      readIds = converted.readIds;
    } else if (name === "mermaid_to_elements") {
      const result = await this.renderer.call("mermaid", a.mermaid, {
        x: a.x,
        y: a.y,
        fontSize: a.fontSize,
      });
      this.tree.require(s, "room", a.roomId, "writeScene");
      for (const file of Object.values(result.files)) {
        const match = /^data:([^;,]+);base64,(.*)$/s.exec(file.dataURL);
        if (!match) throw new HttpError("invalid", "Invalid renderer file");
        this.files.put(
          a.roomId,
          file.id,
          file.mimeType,
          Buffer.from(match[2]!, "base64"),
          s.userId,
        );
      }
      changes = result.elements;
      newIds = changes.map((e) => e.id);
    } else if (name === "move_elements" || name === "delete_elements") {
      const ids = new Set<string>(a.ids),
        notFound = [...ids].filter(
          (k) => !byId.has(k) || byId.get(k)!.isDeleted,
        ),
        found = [...ids].filter((k) => byId.has(k) && !byId.get(k)!.isDeleted);
      for (const key of found)
        for (const bound of byId.get(key)!.boundElements ?? [])
          if (bound.type === "text") ids.add(bound.id);
      for (const e of baseline) {
        let next: Mutable = { ...e };
        let touched = false;
        if (ids.has(e.id) && !e.isDeleted) {
          if (name === "move_elements") {
            next.x += a.dx;
            next.y += a.dy;
          } else next.isDeleted = true;
          touched = true;
        }
        if (name === "delete_elements") {
          if (e.boundElements?.some((b) => ids.has(b.id))) {
            next.boundElements = e.boundElements.filter((b) => !ids.has(b.id));
            touched = true;
          }
          for (const binding of ["startBinding", "endBinding"])
            if (next[binding] && ids.has(next[binding].elementId)) {
              next[binding] = null;
              touched = true;
            }
          if (e.frameId && ids.has(e.frameId)) {
            next.frameId = null;
            touched = true;
          }
        }
        if (touched) changes.push(next as SceneElement);
      }
      data = {
        [name === "move_elements" ? "moved" : "deleted"]: found,
        notFound,
      };
    } else if (name === "update_elements") {
      const staged = new Map(baseline.map((e) => [e.id, structuredClone(e)])),
        touched = new Set<string>(),
        notFound: string[] = [];
      let remeasure = false;
      for (const update of a.updates) {
        const e = staged.get(update.id) as Mutable | undefined;
        if (!e || e.isDeleted) {
          notFound.push(update.id);
          continue;
        }
        const set = normalize(update.set);
        const label = set.label;
        delete set.label;
        if (
          label !== undefined &&
          !["rectangle", "ellipse", "diamond", "arrow", "line"].includes(e.type)
        )
          throw new HttpError(
            "invalid",
            "label requires a container or linear element",
          );
        if (set.text !== undefined) {
          if (e.type !== "text")
            throw new HttpError(
              "invalid",
              "text can only update text elements",
            );
          set.originalText = set.text;
        }
        const oldGeometry = {
          x: e.x,
          y: e.y,
          width: e.width,
          height: e.height,
        };
        Object.assign(e, set);
        touched.add(e.id);
        for (const binding of e.boundElements ?? []) {
          if (binding.type !== "text") continue;
          const text = staged.get(binding.id) as Mutable | undefined;
          if (!text) continue;
          if (
            ["x", "y", "width", "height", "angle"].some((field) => field in set)
          ) {
            text.x +=
              e.x -
              oldGeometry.x +
              (e.width - oldGeometry.width) *
                (text.textAlign === "left"
                  ? 0
                  : text.textAlign === "right"
                    ? 1
                    : 0.5);
            text.y +=
              e.y -
              oldGeometry.y +
              (e.height - oldGeometry.height) *
                (text.verticalAlign === "top"
                  ? 0
                  : text.verticalAlign === "bottom"
                    ? 1
                    : 0.5);
            if (
              set.angle !== undefined &&
              e.type !== "arrow" &&
              e.type !== "line"
            )
              text.angle = e.angle;
            touched.add(text.id);
          }
          for (const field of ["fontSize", "fontFamily", "textAlign"])
            if (set[field] !== undefined) {
              text[field] = set[field];
              touched.add(text.id);
            }
        }
        if (label !== undefined) {
          const bound = (e.boundElements ?? []).find(
              (b: any) => b.type === "text",
            ),
            text = bound
              ? (staged.get(bound.id) as Mutable | undefined)
              : undefined;
          if (label === "") {
            if (text) {
              text.isDeleted = true;
              touched.add(text.id);
            }
            e.boundElements = (e.boundElements ?? []).filter(
              (b: any) => b.type !== "text",
            );
          } else if (text) {
            text.text = label;
            text.originalText = label;
            touched.add(text.id);
          } else {
            const { elements } = await this.renderer.call(
              "convertSkeletons",
              [
                {
                  ...e,
                  label: {
                    text: label,
                    fontSize: set.fontSize,
                    fontFamily: set.fontFamily,
                    textAlign: set.textAlign,
                  },
                },
              ],
              [],
            );
            const container = elements.find((v) => v.id === e.id);
            if (container) {
              e.boundElements = container.boundElements;
              e.width = container.width;
              e.height = container.height;
            }
            for (const el of elements)
              if (el.id !== e.id) {
                if (staged.has(el.id))
                  throw new HttpError(
                    "conflict",
                    "Generated element id collision",
                  );
                staged.set(el.id, el);
                newIds.push(el.id);
                touched.add(el.id);
              }
          }
          remeasure = true;
        }
        if (
          ["text", "fontSize", "fontFamily", "textAlign"].some((k) => k in set)
        )
          remeasure = true;
      }
      if (remeasure) {
        const restored = await this.renderer.call(
          "restoreTouched",
          [...staged.values()],
          [...touched],
        );
        for (const e of restored) {
          staged.set(e.id, e);
          touched.add(e.id);
        }
      }
      changes = [...touched].map((k) => staged.get(k)!);
      data = { notFound };
    }
    if (name === "move_elements" || name === "update_elements") {
      const staged = new Map(baseline.map((e) => [e.id, e]));
      for (const e of changes) staged.set(e.id, e);
      const rerouted = refreshBoundArrows(
        [...staged.values()],
        new Set(
          changes
            .filter((e) => {
              const original = byId.get(e.id);
              return (
                !original ||
                ["x", "y", "width", "height", "angle", "points"].some(
                  (field) =>
                    JSON.stringify((original as Mutable)[field]) !==
                    JSON.stringify((e as Mutable)[field]),
                )
              );
            })
            .map((e) => e.id),
        ),
      );
      if (rerouted.length) {
        const merged = new Map(changes.map((e) => [e.id, e]));
        for (const e of rerouted) merged.set(e.id, e);
        changes = [...merged.values()];
        // Geometry reads both endpoints, even if only one was selected.
        readIds = [
          ...new Set(
            rerouted.flatMap((e) =>
              e.type === "arrow"
                ? [e.startBinding?.elementId, e.endBinding?.elementId].filter(
                    (v): v is string => !!v,
                  )
                : [],
            ),
          ),
        ];
      }
    }
    const stamped = this.commit(
      auth,
      a.roomId,
      changes,
      baseline,
      newIds,
      readIds,
    );
    const version = this.rooms.load(a.roomId).sceneVersion;
    if (name === "add_elements" || name === "mermaid_to_elements")
      data = {
        added: compact(
          stamped.filter((e) => newIds.includes(e.id)),
          this.rooms.elements(a.roomId),
        ),
      };
    if (name === "update_elements")
      data.updated = compact(stamped, this.rooms.elements(a.roomId));
    return this.output({ ...data, sceneVersion: version });
  }
  async handle(request: Request, auth: AuthContext): Promise<Response> {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: VERSION });
    for (const name of Object.keys(Tools) as ToolName[]) {
      const definition = Tools[name];
      server.registerTool(
        name,
        {
          description: definition.description,
          inputSchema: definition.inputSchema,
        },
        async (args: unknown) => this.execute(name, args, auth),
      );
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request); // JSON mode completes before return; release per-request transports.
      return response;
    } finally {
      await server.close();
    }
  }
}
