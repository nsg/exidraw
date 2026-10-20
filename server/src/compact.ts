import type {
  SceneElement,
  CompactElement,
  RenderRegion,
  SceneSummary,
} from "@exidraw/shared";
type Point = readonly [number, number];

function absolutePoint(e: SceneElement, point: Point): [number, number] {
  const x = e.x + point[0],
    y = e.y + point[1];
  if (!e.angle) return [x, y];
  const linearPoints =
    (e.type === "arrow" || e.type === "line" || e.type === "freedraw") &&
    Array.isArray(e.points) &&
    e.points.length
      ? e.points
      : [
          [0, 0],
          [e.width, e.height],
        ];
  const xs = linearPoints.map((p) => p[0]!),
    ys = linearPoints.map((p) => p[1]!);
  const cx = e.x + (Math.min(...xs) + Math.max(...xs)) / 2,
    cy = e.y + (Math.min(...ys) + Math.max(...ys)) / 2;
  const cos = Math.cos(e.angle),
    sin = Math.sin(e.angle);
  return [
    cx + (x - cx) * cos - (y - cy) * sin,
    cy + (x - cx) * sin + (y - cy) * cos,
  ];
}

export function elementBounds(e: SceneElement): RenderRegion {
  const points: readonly Point[] =
    (e.type === "arrow" || e.type === "line" || e.type === "freedraw") &&
    Array.isArray(e.points) &&
    e.points.length
      ? e.points
      : [
          [0, 0],
          [e.width, 0],
          [e.width, e.height],
          [0, e.height],
        ];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const point of points) {
    const [x, y] = absolutePoint(e, point);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function bounds(
  elements: SceneElement[],
  includeDeleted = false,
): SceneSummary["bounds"] {
  let result: RenderRegion | null = null;
  for (const element of elements) {
    if (element.isDeleted && !includeDeleted) continue;
    const next = elementBounds(element);
    if (!result) {
      result = next;
      continue;
    }
    const x = Math.min(result.x, next.x),
      y = Math.min(result.y, next.y);
    result = {
      x,
      y,
      width: Math.max(result.x + result.width, next.x + next.width) - x,
      height: Math.max(result.y + result.height, next.y + next.height) - y,
    };
  }
  return result;
}
export function intersects(e: SceneElement, r: RenderRegion): boolean {
  const box = elementBounds(e);
  return (
    box.x + box.width >= r.x &&
    box.x <= r.x + r.width &&
    box.y + box.height >= r.y &&
    box.y <= r.y + r.height
  );
}
export function select(
  elements: SceneElement[],
  region?: RenderRegion,
  ids?: string[],
  includeDeleted = false,
): SceneElement[] {
  const selected = elements.filter(
    (e) =>
      (includeDeleted || !e.isDeleted) &&
      (!ids || ids.includes(e.id)) &&
      (!region || intersects(e, region)),
  );
  const set = new Set(selected.map((e) => e.id));
  for (const e of selected)
    for (const bound of e.boundElements ?? [])
      if (bound.type === "text") set.add(bound.id);
  return elements.filter(
    (e) => set.has(e.id) && (includeDeleted || !e.isDeleted),
  );
}
export function compact(
  elements: SceneElement[],
  context = elements,
): CompactElement[] {
  const byId = new Map(context.map((e) => [e.id, e]));
  return elements
    .filter(
      (e) =>
        !(
          e.type === "text" &&
          e.containerId &&
          byId.has(e.containerId) &&
          !byId.get(e.containerId)!.isDeleted
        ),
    )
    .map((e) => {
      const c: CompactElement = {
        id: e.id,
        type: e.type,
        x: Math.round(e.x),
        y: Math.round(e.y),
        w: Math.round(e.width),
        h: Math.round(e.height),
      };
      const text = (e.boundElements ?? [])
        .map((b) => byId.get(b.id))
        .find((b) => b?.type === "text" && !b.isDeleted);
      if (text?.type === "text") c.label = text.text;
      if (e.angle) c.angle = Math.round((e.angle * 180) / Math.PI);
      if (e.type === "text") {
        c.text = e.text;
        if (e.fontSize !== 20) c.fontSize = e.fontSize;
        c.fontFamily = e.fontFamily;
      }
      if (e.type === "arrow" || e.type === "line") {
        if (e.type === "arrow") {
          if (e.startBinding) c.from = e.startBinding.elementId;
          if (e.endBinding) c.to = e.endBinding.elementId;
        }
        c.points = e.points.map((p) => {
          const [x, y] = absolutePoint(e, p);
          return [Math.round(x), Math.round(y)];
        });
        c.arrowheads = { start: e.startArrowhead, end: e.endArrowhead };
      }
      if (e.strokeColor !== "#1e1e1e") c.stroke = e.strokeColor;
      if (e.backgroundColor !== "transparent") c.bg = e.backgroundColor;
      if (e.groupIds?.length) c.groupIds = [...e.groupIds];
      if (e.frameId) c.frameId = e.frameId;
      if (e.type === "frame" || e.type === "magicframe")
        c.children = context
          .filter((ch) => ch.frameId === e.id && !ch.isDeleted)
          .map((ch) => ch.id);
      if (e.type === "image" && e.fileId) c.fileId = e.fileId;
      if (e.link) c.link = e.link;
      if (e.locked) c.locked = true;
      if (e.isDeleted) c.deleted = true;
      return c;
    });
}
export function compactText(
  summary: SceneSummary,
  elements: CompactElement[],
): string {
  const b = summary.bounds;
  const header = `room ${JSON.stringify(summary.room.name)} (r/${summary.room.id}) role=${summary.room.role} sceneVersion=${summary.sceneVersion} elements=${summary.totalElements} bounds=${b ? `(${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)})` : "empty"} active=[${summary.activeUsers.join(", ")}]`;
  return [
    header,
    ...elements.map(
      (e) =>
        `${e.type} ${e.id} @(${e.x},${e.y}) ${e.w}x${e.h}${e.angle ? ` angle=${e.angle}` : ""}${e.text !== undefined ? ` ${JSON.stringify(e.text)}` : e.label !== undefined ? ` ${JSON.stringify(e.label)}` : ""}${e.from || e.to ? ` ${e.from ?? "?"}→${e.to ?? "?"}` : ""}${e.stroke ? ` stroke=${e.stroke}` : ""}${e.bg ? ` bg=${e.bg}` : ""}${e.fontSize ? ` fontSize=${e.fontSize}` : ""}${e.frameId ? ` frame=${e.frameId}` : ""}${e.children ? ` children=[${e.children.join(",")}]` : ""}${e.groupIds ? ` groups=[${e.groupIds.join(",")}]` : ""}${e.link ? ` link=${e.link}` : ""}${e.locked ? " locked" : ""}${e.deleted ? " deleted" : ""}`,
    ),
  ].join("\n");
}
