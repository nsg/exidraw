/**
 * MCP tool contract (Streamable HTTP at MCP_PATH, Bearer PAT auth).
 * Input schemas are zod objects: pass `Tool.inputSchema.shape` to
 * McpServer.registerTool. Outputs are returned BOTH as `structuredContent`
 * (typed below) and as human/LLM-readable `content` text (format in
 * docs/ARCHITECTURE.md § MCP). Images are returned as MCP image content.
 */
import { z } from "zod";
import type { FolderInfo, RoomInfo, UserInfo } from "./api.js";
import type { Role } from "./roles.js";
import { MAX_NAME_LENGTH } from "./constants.js";

export const MCP_SERVER_NAME = "exidraw";

// ---- Compact element description (LLM-facing read model) ---------------------

export type CompactElementType =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "text"
  | "arrow"
  | "line"
  | "freedraw"
  | "image"
  | "frame"
  | "magicframe"
  | "embeddable"
  | "iframe"
  | "selection";

/**
 * Lossy, rounded (integers) view of an element. Optional fields are omitted
 * when they hold the default/empty value.
 */
export interface CompactElement {
  id: string;
  type: CompactElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** degrees, omitted when 0 */
  angle?: number;
  /** text elements: content (bound text elements are folded into `label` of their container and not listed separately) */
  text?: string;
  /** containers/arrows/lines: content of the bound text element */
  label?: string;
  /** arrows: element ids bound at the start/end */
  from?: string;
  to?: string;
  /** lines/arrows: absolute scene points, rounded */
  points?: Array<[number, number]>;
  arrowheads?: { start: string | null; end: string | null };
  stroke?: string;
  bg?: string;
  fontSize?: number;
  fontFamily?: number;
  groupIds?: string[];
  frameId?: string;
  /** frames: ids of elements inside */
  children?: string[];
  /** images */
  fileId?: string;
  link?: string;
  locked?: true;
  deleted?: true;
}

export interface SceneSummary {
  room: Pick<RoomInfo, "id" | "name" | "url" | "role">;
  sceneVersion: number;
  /** of non-deleted elements; null when empty */
  bounds: { x: number; y: number; width: number; height: number } | null;
  /** non-deleted elements in the whole scene (before region/limit filtering) */
  totalElements: number;
  /** names of users currently connected (agents included, suffixed " (agent)") */
  activeUsers: string[];
}

// ---- Skeleton input (LLM-facing write model) ---------------------------------
// Mirrors @excalidraw/excalidraw ExcalidrawElementSkeleton, restricted and
// documented. Anything not listed is rejected (strict objects).

const color = z.string().max(32).describe('CSS colour, e.g. "#1971c2" or "transparent"');
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional().describe("optional id; must be unique in the room; generated when omitted");
const fontFamily = z.number().int().min(1).max(10).optional().describe("1=Virgil(hand-drawn,default) 2=Helvetica 3=Cascadia(code) 5=Excalifont 6=Nunito 7=LilitaOne 8=ComicShanns");

const styleFields = {
  strokeColor: color.optional(),
  backgroundColor: color.optional(),
  fillStyle: z.enum(["solid", "hachure", "cross-hatch", "zigzag"]).optional(),
  strokeWidth: z.number().min(0.5).max(20).optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z.number().int().min(0).max(2).optional().describe("0=architect(clean) 1=artist 2=cartoonist"),
  opacity: z.number().int().min(0).max(100).optional(),
  angle: z.number().optional().describe("degrees"),
  groupIds: z.array(z.string().max(64)).max(16).optional(),
  frameId: z.string().max(64).optional().describe("id of the frame this element belongs to"),
  link: z.string().url().max(2048).optional(),
  locked: z.boolean().optional(),
};

export const LabelSkeleton = z
  .object({
    text: z.string().max(10_000),
    fontSize: z.number().min(4).max(400).optional(),
    fontFamily,
    textAlign: z.enum(["left", "center", "right"]).optional(),
    verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
    strokeColor: color.optional(),
  })
  .strict();

export const ContainerSkeleton = z
  .object({
    type: z.enum(["rectangle", "ellipse", "diamond"]),
    id,
    x: z.number(),
    y: z.number(),
    width: z.number().min(1).optional().describe("default 200; grows to fit label when omitted"),
    height: z.number().min(1).optional().describe("default 100"),
    label: LabelSkeleton.optional(),
    roundness: z.enum(["round", "sharp"]).optional().describe("default round for rectangles"),
    ...styleFields,
  })
  .strict();

export const TextSkeleton = z
  .object({
    type: z.literal("text"),
    id,
    x: z.number(),
    y: z.number(),
    text: z.string().min(1).max(10_000),
    fontSize: z.number().min(4).max(400).optional().describe("default 20"),
    fontFamily,
    textAlign: z.enum(["left", "center", "right"]).optional(),
    ...styleFields,
  })
  .strict();

const bindingEnd = z
  .object({ id: z.string().min(1).max(64) })
  .strict()
  .describe("bind to an existing element or one created in the same call");

export const LinearSkeleton = z
  .object({
    type: z.enum(["arrow", "line"]),
    id,
    x: z.number().optional().describe("start point; required unless `start` is bound"),
    y: z.number().optional(),
    points: z
      .array(z.tuple([z.number(), z.number()]))
      .min(2)
      .max(500)
      .optional()
      .describe("points relative to (x,y); first must be [0,0]. Default: straight to (x+width, y+height)"),
    width: z.number().optional(),
    height: z.number().optional(),
    start: bindingEnd.optional(),
    end: bindingEnd.optional(),
    label: LabelSkeleton.optional(),
    startArrowhead: z.enum(["arrow", "bar", "dot", "triangle", "circle", "diamond"]).nullable().optional(),
    endArrowhead: z.enum(["arrow", "bar", "dot", "triangle", "circle", "diamond"]).nullable().optional().describe("arrows default to 'arrow'"),
    elbowed: z.boolean().optional().describe("arrows only: orthogonal routing"),
    ...styleFields,
  })
  .strict();

export const FrameSkeleton = z
  .object({
    type: z.literal("frame"),
    id,
    name: z.string().max(MAX_NAME_LENGTH).optional(),
    children: z.array(z.string().min(1).max(64)).max(5000).describe("ids of elements the frame should contain; frame bounds are computed from them"),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .strict();

export const ElementSkeleton = z.discriminatedUnion("type", [ContainerSkeleton, TextSkeleton, LinearSkeleton, FrameSkeleton]);
export type ElementSkeleton = z.infer<typeof ElementSkeleton>;

// ---- Tools -------------------------------------------------------------------

const roomId = z.string().min(1).max(64).describe("room id (from list_folder/search or the room URL /r/<id>)");
const folderId = z.string().min(1).max(64).describe("folder id; 'root' for the top level");

export const Tools = {
  whoami: {
    description: "Return the user this token acts as and whether they are an admin.",
    inputSchema: z.object({}).strict(),
  },
  list_folder: {
    description: "List sub-folders and rooms (drawings) of a folder the user can see. Start at folder 'root'.",
    inputSchema: z.object({ folderId: folderId.default("root") }).strict(),
  },
  search: {
    description: "Search folders and rooms by name; optionally also text inside drawings.",
    inputSchema: z
      .object({
        query: z.string().min(1).max(200),
        inContent: z.boolean().default(false).describe("also match text elements inside rooms"),
        limit: z.number().int().min(1).max(100).default(20),
      })
      .strict(),
  },
  create_folder: {
    description: "Create a folder. Requires editor on the parent.",
    inputSchema: z.object({ parentId: folderId, name: z.string().trim().min(1).max(MAX_NAME_LENGTH) }).strict(),
  },
  create_room: {
    description: "Create an empty room (drawing) in a folder. Requires editor on the folder.",
    inputSchema: z.object({ folderId, name: z.string().trim().min(1).max(MAX_NAME_LENGTH) }).strict(),
  },
  get_room: {
    description: "Room metadata, your role, element count, and who has it open.",
    inputSchema: z.object({ roomId }).strict(),
  },
  read_scene: {
    description:
      "Compact description of the elements in a room: id, type, position/size, label text, arrow bindings, colours. Use region/elementIds to narrow. Bound text is folded into its container's `label`. Compact points are absolute scene coordinates; full element and skeleton points are relative to x,y.",
    inputSchema: z
      .object({
        roomId,
        region: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).strict().optional(),
        elementIds: z.array(z.string()).max(1000).optional(),
        includeDeleted: z.boolean().default(false),
        limit: z.number().int().min(1).max(2000).default(500),
        offset: z.number().int().min(0).default(0),
        format: z.enum(["compact", "full"]).default("compact").describe("'full' returns raw Excalidraw element JSON (large)"),
      })
      .strict(),
  },
  add_elements: {
    description:
      "Add elements from simplified skeletons: shapes with labels, text, arrows/lines (bindable to element ids via start/end), frames. Returns the created elements. Changes appear live for users in the room.",
    inputSchema: z.object({ roomId, elements: z.array(ElementSkeleton).min(1).max(500) }).strict(),
  },
  update_elements: {
    description:
      "Change properties of existing elements: position, size, style, text/label, font, link, lock. Text is re-measured. Unspecified fields are kept. Geometry edits reproject bound arrow endpoints onto the affected shapes; interior bends are preserved and arrow labels follow.",
    inputSchema: z
      .object({
        roomId,
        updates: z
          .array(
            z
              .object({
                id: z.string().min(1).max(64),
                set: z
                  .object({
                    x: z.number().optional(),
                    y: z.number().optional(),
                    width: z.number().min(1).optional(),
                    height: z.number().min(1).optional(),
                    text: z.string().max(10_000).optional().describe("text elements only"),
                    label: z.string().max(10_000).optional().describe("containers/arrows: set or replace bound text; empty string removes it"),
                    fontSize: z.number().min(4).max(400).optional(),
                    fontFamily,
                    textAlign: z.enum(["left", "center", "right"]).optional(),
                    roundness: z.enum(["round", "sharp"]).optional(),
                    startArrowhead: z.enum(["arrow", "bar", "dot", "triangle", "circle", "diamond"]).nullable().optional(),
                    endArrowhead: z.enum(["arrow", "bar", "dot", "triangle", "circle", "diamond"]).nullable().optional(),
                    ...styleFields,
                  })
                  .strict(),
              })
              .strict(),
          )
          .min(1)
          .max(500),
      })
      .strict(),
  },
  move_elements: {
    description:
      "Translate elements by (dx, dy). Bound text moves with its container. Bound arrow endpoints are reprojected onto the moved shapes; interior bends are preserved and arrow labels follow. Moving an arrow alone translates its free endpoints and interior bends while bound endpoints stay attached; an attachment can slide along its target outline toward the free endpoint. A straight arrow with both ends bound stays in place unless its shapes move.",
    inputSchema: z.object({ roomId, ids: z.array(z.string().min(1).max(64)).min(1).max(2000), dx: z.number(), dy: z.number() }).strict(),
  },
  delete_elements: {
    description: "Delete elements (and their bound text). Arrows bound to them are unbound, not deleted.",
    inputSchema: z.object({ roomId, ids: z.array(z.string().min(1).max(64)).min(1).max(2000) }).strict(),
  },
  render_image: {
    description:
      "Render the room (or a region / set of elements) as PNG (returned as an image) or SVG (returned as text). Use this to SEE the drawing.",
    inputSchema: z
      .object({
        roomId,
        format: z.enum(["png", "svg"]).default("png"),
        region: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).strict().optional(),
        elementIds: z.array(z.string()).max(1000).optional(),
        scale: z.number().min(0.25).max(4).default(2).describe("png only"),
        background: z.boolean().default(true),
        theme: z.enum(["light", "dark"]).default("light"),
        padding: z.number().min(0).max(500).default(20),
      })
      .strict(),
  },
  mermaid_to_elements: {
    description:
      "Convert a Mermaid diagram (flowchart, sequence, class, …) to Excalidraw elements and add them at (x, y). Unsupported diagram types become an image.",
    inputSchema: z
      .object({
        roomId,
        mermaid: z.string().min(1).max(100_000),
        x: z.number().default(0),
        y: z.number().default(0),
        fontSize: z.number().min(4).max(100).default(20),
      })
      .strict(),
  },
} as const;

export type ToolName = keyof typeof Tools;
export type ToolInput<T extends ToolName> = z.infer<(typeof Tools)[T]["inputSchema"]>;

// ---- structuredContent per tool ----------------------------------------------

export interface ToolOutputs {
  whoami: { user: UserInfo; isAdmin: boolean; tokenName: string };
  list_folder: {
    folder: Pick<FolderInfo, "id" | "name" | "role">;
    path: Array<Pick<FolderInfo, "id" | "name">>;
    folders: Array<Pick<FolderInfo, "id" | "name" | "role">>;
    rooms: Array<Pick<RoomInfo, "id" | "name" | "role" | "updatedAt" | "url">>;
  };
  search: {
    folders: Array<Pick<FolderInfo, "id" | "name" | "role">>;
    rooms: Array<Pick<RoomInfo, "id" | "name" | "role" | "url"> & { snippet?: string }>;
  };
  create_folder: { folder: Pick<FolderInfo, "id" | "name" | "parentId" | "role"> };
  create_room: { room: Pick<RoomInfo, "id" | "name" | "folderId" | "role" | "url"> };
  get_room: {
    room: Pick<RoomInfo, "id" | "name" | "folderId" | "role" | "url" | "updatedAt">;
    path: Array<Pick<FolderInfo, "id" | "name">>;
    elementCount: number;
    activeUsers: string[];
  };
  read_scene: SceneSummary & { elements: CompactElement[] | unknown[]; returned: number; offset: number };
  add_elements: { added: CompactElement[]; sceneVersion: number };
  update_elements: { updated: CompactElement[]; notFound: string[]; sceneVersion: number };
  move_elements: { moved: string[]; notFound: string[]; sceneVersion: number };
  delete_elements: { deleted: string[]; notFound: string[]; sceneVersion: number };
  render_image: { format: "png" | "svg"; width: number; height: number; scale?: number; elementCount: number };
  mermaid_to_elements: { added: CompactElement[]; sceneVersion: number };
}

/** Role each tool requires on its target node. */
export const TOOL_REQUIRED_ROLE: Readonly<Record<ToolName, Role | null>> = {
  whoami: null,
  list_folder: "viewer",
  search: null, // filtered per node
  create_folder: "editor", // on parent
  create_room: "editor", // on folder
  get_room: "viewer",
  read_scene: "viewer",
  add_elements: "editor",
  update_elements: "editor",
  move_elements: "editor",
  delete_elements: "editor",
  render_image: "viewer",
  mermaid_to_elements: "editor",
};
