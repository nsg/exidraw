/**
 * The doodles pinned to the login board, built from the shared hand-drawn
 * primitives. Everything is seeded, so a doodle redraws with a slightly
 * different wobble each time but a page load is reproducible.
 */
import { HAND_FONT, INK, ellipsePts, rectPts, smooth, type Pt, type Rough } from "../sketch/rough";

const SVG_NS = "http://www.w3.org/2000/svg";

/** One step of drawing a doodle, in order. */
export type DrawOp =
  | { kind: "path"; el: SVGPathElement; speed: number }
  | { kind: "fill"; el: SVGPathElement }
  | { kind: "text"; el: SVGTextElement; reveal: SVGRectElement };

let clipSeq = 0;

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent?.appendChild(el);
  return el;
}

/** Builds a doodle's SVG into `g`, recording each stroke as a draw op. */
export class Sketch {
  readonly ops: DrawOp[] = [];
  constructor(
    readonly g: SVGGElement,
    readonly rough: Rough,
  ) {}

  stroke(d: string, color = INK, width = 2, speed = 1): void {
    const el = svgEl("path", { d, stroke: color, "stroke-width": width, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" }, this.g);
    this.ops.push({ kind: "path", el, speed });
  }

  hatch(pts: readonly Pt[], color: string, gap = 7, width = 1.7): void {
    this.stroke(this.rough.hachure(pts, gap), color, width, 2.6);
  }

  solid(d: string, color: string, attrs: Record<string, string> = {}): void {
    this.ops.push({ kind: "fill", el: svgEl("path", { d, fill: color, ...attrs }, this.g) });
  }

  /** Handwritten text, revealed left to right through a growing clip rect. */
  text(str: string, x: number, y: number, size: number, color = INK, anchor = "start"): void {
    const id = `login-clip-${++clipSeq}`;
    const clip = svgEl("clipPath", { id }, this.g);
    const reveal = svgEl("rect", { x: 0, y: 0, width: 0, height: 0 }, clip);
    const el = svgEl("text", { x, y, "font-size": size, fill: color, "text-anchor": anchor, "font-family": HAND_FONT, "clip-path": `url(#${id})` }, this.g);
    el.textContent = str;
    this.ops.push({ kind: "text", el, reveal });
  }
}

/* ---- the doodles, in local coordinates ---------------------------------------------- */

function flow(s: Sketch, r: Rough) {
  s.stroke(r.rect(0, 24, 112, 62));
  s.hatch(rectPts(0, 24, 112, 62), "#74c0fc");
  s.text("idea", 56, 63, 20, INK, "middle");
  s.stroke(r.line(120, 55, 163, 55) + r.head(163, 55, 0));
  const diamond: Pt[] = [[212, 9], [259, 55], [212, 101], [165, 55]];
  s.stroke(r.poly(diamond));
  s.hatch(diamond, "#ffd43b", 7.5);
  s.text("ok?", 212, 62, 20, INK, "middle");
  s.stroke(r.line(264, 55, 306, 55) + r.head(306, 55, 0));
  s.stroke(r.rect(312, 24, 116, 62));
  s.hatch(rectPts(312, 24, 116, 62), "#69db7c");
  s.text("ship it", 370, 62, 19, INK, "middle");
  const back = r.wobble([[212, 108], [178, 142], [112, 150], [66, 124], [57, 95]]);
  s.stroke(smooth(back) + r.head(57, 93, Math.atan2(-29, -7), 11), "#495057", 1.8);
  s.text("not yet…", 124, 176, 15, "#868e96", "middle");
}

function roadmap(s: Sketch, r: Rough) {
  s.solid("M3 1 L199 4 L197 200 L1 197 Z", "#fff3bf", { filter: "url(#login-lift)" });
  s.solid("M197 168 L197 200 L166 200 Z", "#ffe066");
  s.text("Q3 roadmap", 18, 44, 25);
  s.stroke(smooth(r.wobble([[16, 56], [70, 52], [130, 55], [160, 51]], 1)), "#f76707", 2.6);
  ["SSO login", "live cursors", "MCP tools"].forEach((item, i) => {
    const y = 96 + i * 34;
    s.stroke(r.rect(18, y - 15, 16, 16, 0.6), INK, 1.6);
    s.text(item, 44, y, 17);
    if (i < 2) s.stroke(r.poly([[18, y - 8], [25, y], [40, y - 22]], false, 0.5), "#2f9e44", 2.8);
  });
}

function ideas(s: Sketch, r: Rough) {
  s.solid("M2 3 L178 0 L180 170 L0 172 Z", "#e5e3ff", { filter: "url(#login-lift)" });
  s.text("ideas!", 16, 44, 27, "#6965db");
  s.stroke(r.ellipse(140, 52, 17, 19), INK, 1.8);
  s.stroke(r.line(132, 75, 148, 75, 0.5) + r.line(134, 82, 146, 82, 0.5), INK, 1.8);
  s.stroke(smooth(r.wobble([[131, 48], [134, 41], [140, 37]], 0.4)), "#f59f00", 1.8);
  s.stroke(
    r.line(140, 24, 140, 17, 0.4) +
      r.line(117, 36, 111, 31, 0.4) +
      r.line(163, 36, 169, 31, 0.4) +
      r.line(114, 58, 107, 59, 0.4) +
      r.line(166, 58, 173, 59, 0.4),
    "#f59f00",
    2,
  );
  ["– dark mode", "– templates", "– more snacks"].forEach((item, i) => s.text(item, 16, 98 + i * 26, 16, "#3d3d45"));
}

function smiley(s: Sketch, r: Rough) {
  const [cx, cy] = [46, 48];
  s.stroke(r.ellipse(cx, cy, 42, 40));
  s.hatch(ellipsePts(cx, cy, 40, 38), "#ffd43b", 7);
  s.stroke(r.line(32, 34, 32, 44, 0.3) + r.line(60, 34, 60, 44, 0.3), INK, 3.2);
  s.stroke(smooth(r.wobble([[25, 57], [37, 71], [56, 71], [68, 55]], 0.8)), INK, 2.4);
  s.text("love this!", 104, 26, 19, "#e8590c");
  s.stroke(smooth(r.wobble([[110, 36], [104, 46], [94, 50]], 0.5)) + r.head(94, 50, Math.PI * 0.95, 8), "#e8590c", 1.8);
}

function wireframe(s: Sketch, r: Rough) {
  s.text("new dashboard?", 2, 18, 17, "#495057");
  s.stroke(r.rect(0, 30, 252, 166));
  s.stroke(r.line(0, 56, 252, 56), INK, 1.6);
  s.stroke(r.ellipse(14, 43, 4, 4, 0.3) + r.ellipse(27, 43, 4, 4, 0.3) + r.ellipse(40, 43, 4, 4, 0.3), INK, 1.5);
  s.stroke(r.rect(16, 70, 94, 66), INK, 1.7);
  s.hatch(rectPts(16, 70, 94, 66), "#b197fc", 6.5, 1.5);
  s.stroke(r.poly([[22, 130], [46, 102], [62, 118], [78, 98], [104, 130]], false, 0.6), INK, 1.6);
  for (const [x, y, x2] of [[124, 82, 234], [124, 100, 212], [124, 118, 228], [16, 156, 106], [16, 174, 86]] as const)
    s.stroke(r.line(x, y, x2, y, 0.6), "#adb5bd", 3.2);
  s.stroke(r.rect(150, 148, 84, 30, 0.7), "#6965db", 1.8);
  s.hatch(rectPts(150, 148, 84, 30), "#9775fa", 6, 1.5);
}

function chart(s: Sketch, r: Rough) {
  s.stroke(r.poly([[12, 4], [12, 150], [200, 150]], false) + r.head(12, 2, -Math.PI / 2, 10) + r.head(202, 150, 0, 10));
  [40, 64, 56, 100].forEach((h, i) => {
    const [x, y] = [32 + i * 40, 150 - h];
    s.stroke(r.rect(x, y, 26, h, 0.7), INK, 1.6);
    s.hatch(rectPts(x, y, 26, h), i % 2 ? "#9775fa" : "#d0bfff", 6, 1.6);
  });
  const trend = r.wobble([[30, 100], [72, 78], [112, 88], [168, 26]], 1);
  s.stroke(smooth(trend) + r.head(170, 24, Math.atan2(-8, 6), 11), "#e03131", 2.4);
  s.text("+42%", 176, 30, 19, "#2f9e44");
}

function sun(s: Sketch, r: Rough) {
  s.stroke(r.ellipse(30, 30, 16, 16, 0.6), "#f59f00", 2);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    s.stroke(r.line(30 + Math.cos(a) * 23, 30 + Math.sin(a) * 23, 30 + Math.cos(a) * 31, 30 + Math.sin(a) * 31, 0.3), "#f59f00", 2, 2);
  }
  s.text("standup 9:30", 68, 36, 17, "#495057");
}

/** [dx, dy from the viewport centre, scale, rotation°] */
type DesktopSpot = readonly [number, number, number, number];
/** [band above/below the card, dx from centre, dy within the band, scale, rotation°] */
type MobileSpot = readonly ["top" | "bottom", number, number, number, number];

export interface DoodleSpec {
  id: "flow" | "chart" | "ideas" | "roadmap" | "wireframe" | "smiley" | "sun";
  build: (s: Sketch, r: Rough) => void;
  w: number;
  h: number;
  desktop: DesktopSpot;
  mobile: MobileSpot | null;
}

export const DOODLES: readonly DoodleSpec[] = [
  { id: "flow", build: flow, w: 430, h: 180, desktop: [-690, -360, 1, -1.5], mobile: ["bottom", -182, -6, 0.47, -2] },
  { id: "chart", build: chart, w: 210, h: 156, desktop: [-650, -20, 0.95, 1.5], mobile: null },
  { id: "ideas", build: ideas, w: 180, h: 172, desktop: [-560, 195, 1, -4], mobile: ["bottom", 62, 4, 0.6, 4] },
  { id: "roadmap", build: roadmap, w: 200, h: 200, desktop: [300, -378, 1, 3.5], mobile: ["top", -178, -4, 0.6, -3] },
  { id: "wireframe", build: wireframe, w: 252, h: 196, desktop: [400, -70, 0.95, -1], mobile: null },
  { id: "smiley", build: smiley, w: 190, h: 90, desktop: [330, 230, 1, 2], mobile: ["top", 44, 16, 0.72, 3] },
  { id: "sun", build: sun, w: 180, h: 62, desktop: [-140, 330, 0.9, -2], mobile: null },
];
