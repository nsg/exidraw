import type { SceneElement } from "@exidraw/shared";

type Point = [number, number];
type Linear = SceneElement & { type: "arrow" | "line" };
/** Excalidraw 0.18.1's FIXED_BINDING_DISTANCE (element/binding.ts). */
const BINDING_GAP = 5;
const center = (e: SceneElement): Point => [
  e.x + e.width / 2,
  e.y + e.height / 2,
];

/** Intersect a ray in the shape's own coordinates, then move outward by 5px. */
export function outlinePoint(e: SceneElement, toward: Point): Point {
  const [cx, cy] = center(e),
    angle = e.angle || 0;
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  let dx = (toward[0] - cx) * cos + (toward[1] - cy) * sin;
  let dy = -(toward[0] - cx) * sin + (toward[1] - cy) * cos;
  if (Math.hypot(dx, dy) < 1e-8) {
    dx = 1;
    dy = 0;
  }
  const rx = Math.max(0.5, e.width / 2),
    ry = Math.max(0.5, e.height / 2);
  const scale =
    e.type === "ellipse"
      ? 1 / Math.hypot(dx / rx, dy / ry)
      : e.type === "diamond"
        ? 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
        : 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry);
  const outward = scale + BINDING_GAP / Math.hypot(dx, dy);
  dx *= outward;
  dy *= outward;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

function absolutePoints(e: Linear): Point[] {
  const xs = e.points.map((p) => p[0]),
    ys = e.points.map((p) => p[1]);
  const cx = e.x + (Math.min(...xs) + Math.max(...xs)) / 2,
    cy = e.y + (Math.min(...ys) + Math.max(...ys)) / 2,
    cos = Math.cos(e.angle || 0),
    sin = Math.sin(e.angle || 0);
  return e.points.map(([x, y]) => {
    const dx = e.x + x - cx,
      dy = e.y + y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
}

/** Normalize coordinates and project the requested bound ends onto their shapes. */
export function projectBindings(
  e: Linear,
  byId: ReadonlyMap<string, SceneElement>,
  projectStart = true,
  projectEnd = true,
): Linear {
  const points = absolutePoints(e);
  if (points.length < 2) return e;
  const start = e.startBinding && byId.get(e.startBinding.elementId);
  const end = e.endBinding && byId.get(e.endBinding.elementId);
  const startCenter = start && !start.isDeleted ? center(start) : points[0]!;
  const endCenter = end && !end.isDeleted ? center(end) : points.at(-1)!;
  if (start && !start.isDeleted && projectStart)
    points[0] = outlinePoint(start, endCenter);
  if (end && !end.isDeleted && projectEnd)
    points[points.length - 1] = outlinePoint(end, startCenter);
  const [x, y] = points[0]!;
  const relative = points.map(([px, py]): Point => [px - x, py - y]);
  const binding = (
    target: SceneElement | null | undefined,
    old: any,
    project: boolean,
    point: Point,
  ) => {
    if (!target || !old || !project) return old;
    const [cx, cy] = center(target),
      cos = Math.cos(target.angle || 0),
      sin = Math.sin(target.angle || 0),
      dx = point[0] - cx,
      dy = point[1] - cy;
    const localX = target.width / 2 + dx * cos + dy * sin,
      localY = target.height / 2 - dx * sin + dy * cos;
    const fraction = (coordinate: number, size: number) =>
      Math.abs(size) < 1e-8 ? 0.5 : Math.min(1, Math.max(0, coordinate / size));
    return {
      ...old,
      focus: 0,
      gap: BINDING_GAP,
      ...(e.type === "arrow" && (e as any).elbowed
        ? {
            fixedPoint: [
              fraction(localX, target.width),
              fraction(localY, target.height),
            ],
          }
        : {}),
    };
  };
  return {
    ...e,
    x,
    y,
    angle: 0,
    points: relative,
    width:
      Math.max(...relative.map((p) => p[0])) -
      Math.min(...relative.map((p) => p[0])),
    height:
      Math.max(...relative.map((p) => p[1])) -
      Math.min(...relative.map((p) => p[1])),
    startBinding: binding(start, e.startBinding, projectStart, points[0]!),
    endBinding: binding(end, e.endBinding, projectEnd, points.at(-1)!),
  } as Linear;
}

function approximatelyEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number")
    return a === b || Math.abs(a - b) <= 1e-6;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length &&
      a.every((value, i) => approximatelyEqual(value, b[i]))
    );
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>,
      right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every(
        (key) => key in right && approximatelyEqual(left[key], right[key]),
      )
    );
  }
  return a === b;
}

/** Update connected arrows and their labels after MCP geometry edits. */
export function refreshBoundArrows(
  elements: SceneElement[],
  touchedIds: Set<string>,
): SceneElement[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const changes: SceneElement[] = [];
  for (const e of elements) {
    if (e.isDeleted || e.type !== "arrow" || !(e.startBinding || e.endBinding))
      continue;
    if (
      !touchedIds.has(e.id) &&
      ![e.startBinding, e.endBinding].some(
        (b) => b && touchedIds.has(b.elementId),
      )
    )
      continue;
    const next = projectBindings(e, byId);
    if (approximatelyEqual(next, e)) continue;
    changes.push(next);
    const before = absolutePoints(e),
      after = absolutePoints(next);
    const mid = (p: Point[]) => {
      const middle = (p.length - 1) / 2,
        left = p[Math.floor(middle)]!,
        right = p[Math.ceil(middle)]!;
      return [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
    };
    const oldMid = mid(before),
      newMid = mid(after);
    for (const b of e.boundElements ?? []) {
      const text = byId.get(b.id);
      if (b.type === "text" && text && !text.isDeleted)
        changes.push({
          ...text,
          x: text.x + newMid[0]! - oldMid[0]!,
          y: text.y + newMid[1]! - oldMid[1]!,
        });
    }
  }
  return changes;
}
