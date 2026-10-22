/**
 * Hand-drawn SVG path primitives (a tiny rough.js look-alike) shared by the
 * login board and the folder sheet. Everything is seeded: the same seed gives
 * the same wobble, so a stroke keyed on an id looks the same on every render.
 */

export type Pt = readonly [number, number];

export const INK = "#1b1b1f";
/** Must match the @font-face in styles.css (a name Excalidraw never registers). */
export const HAND_FONT = '"Exidraw Virgil", "Comic Sans MS", cursive';

/** Marker colours for people's initials, as on the login board's cursors. */
export const MARKER_COLORS = ["#f76707", "#1c7ed6", "#d6336c", "#2f9e44", "#6965db", "#f59f00"] as const;
/** Darker markers for small white initials in the app: each at least 4.5:1 against white. */
export const FACE_COLORS = ["#b35900", "#1971c2", "#c2255c", "#087f5b", "#5f3dc4", "#c92a2a", "#0b7285", "#862e9c"] as const;
/** Excalidraw's lighter fill colours, for hachure. */
export const FILL_COLORS = ["#4dabf7", "#9775fa", "#fcc419", "#51cf66", "#ff8787", "#f783ac", "#3bc9db", "#ffa94d"] as const;

/** mulberry32: small, fast, good enough for wobble. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: a stable seed from a string such as an id or an e-mail. */
export function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The same entry of `list` for the same key, every time. */
export function pick<T>(list: readonly T[], key: string): T {
  return list[hashSeed(key) % list.length]!;
}

/** One decimal is plenty and keeps the path strings short. */
const f = (n: number) => Math.round(n * 10) / 10;

export const rectPts = (x: number, y: number, w: number, h: number): Pt[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

export const ellipsePts = (cx: number, cy: number, rx: number, ry: number): Pt[] =>
  Array.from({ length: 28 }, (_, i) => [cx + Math.cos((i / 28) * Math.PI * 2) * rx, cy + Math.sin((i / 28) * Math.PI * 2) * ry] as const);

/** Catmull-Rom through the points, as cubic Béziers. */
export function smooth(pts: readonly Pt[]): string {
  const at = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]!;
  let d = `M${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d +=
      `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ` +
      `${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

/** Seeded generator of wobbly strokes. `r` scales the roughness. */
export class Rough {
  readonly random: () => number;
  constructor(seed: number) {
    this.random = mulberry32(seed);
  }

  /** Uniform in [-n, n]. */
  jitter(n: number): number {
    return (this.random() - 0.5) * 2 * n;
  }

  line(x1: number, y1: number, x2: number, y2: number, r = 1): string {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const [nx, ny] = [-dy / len, dx / len];
    const o = Math.min(1.8, len * 0.03 + 0.5) * r;
    const bow = this.jitter(len * 0.014 * r + 0.4);
    const p = (t: number): Pt => [x1 + dx * t + nx * bow + this.jitter(o * 0.5), y1 + dy * t + ny * bow + this.jitter(o * 0.5)];
    const a: Pt = [x1 + this.jitter(o), y1 + this.jitter(o)];
    const [c1, c2] = [p(0.32), p(0.7)];
    const b: Pt = [x2 + this.jitter(o), y2 + this.jitter(o)];
    return `M${f(a[0])} ${f(a[1])}C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(b[0])} ${f(b[1])}`;
  }

  poly(pts: readonly Pt[], closed = true, r = 1): string {
    let d = "";
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const [a, b] = [pts[i]!, pts[(i + 1) % n]!];
      d += this.line(a[0], a[1], b[0], b[1], r);
    }
    return d;
  }

  rect(x: number, y: number, w: number, h: number, r?: number): string {
    return this.poly(rectPts(x, y, w, h), true, r);
  }

  /** Slightly overshooting loop, like a quick freehand circle. */
  ellipse(cx: number, cy: number, rx: number, ry: number, r = 1): string {
    const n = 9;
    const a0 = this.random() * Math.PI * 2;
    const overshoot = 0.3 + this.random() * 0.3;
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((Math.PI * 2 + overshoot) * i) / n;
      const k = 1 + this.jitter(0.05 * r);
      pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
    }
    return smooth(pts);
  }

  /** Arrowhead with its tip at (x, y), pointing along `angle`. */
  head(x: number, y: number, angle: number, size = 12): string {
    const [a1, a2] = [angle + Math.PI * 0.83, angle - Math.PI * 0.83];
    return (
      this.line(x + Math.cos(a1) * size, y + Math.sin(a1) * size, x, y, 0.5) +
      this.line(x, y, x + Math.cos(a2) * size, y + Math.sin(a2) * size, 0.5)
    );
  }

  /** Nudge every point a little. */
  wobble(pts: readonly Pt[], amount = 1.5): Pt[] {
    return pts.map((p) => [p[0] + this.jitter(amount), p[1] + this.jitter(amount)] as const);
  }

  /**
   * Zig-zag hachure fill clipped to a polygon, like Excalidraw's default fill.
   * `inset` keeps the strokes off the outline, `r` is their roughness.
   */
  hachure(pts: readonly Pt[], gap = 7, deg = -41, inset = 2, r = 0.45): string {
    const t = (deg * Math.PI) / 180;
    const [c, s] = [Math.cos(t), Math.sin(t)];
    const rotated = pts.map(([x, y]) => [x * c + y * s, -x * s + y * c] as const);
    const ys = rotated.map((p) => p[1]);
    const [lo, hi] = [Math.min(...ys), Math.max(...ys)];
    let d = "";
    let flip = false;
    for (let y = lo + gap * 0.6; y < hi - 1; y += gap) {
      const xs: number[] = [];
      for (let i = 0; i < rotated.length; i++) {
        const [a, b] = [rotated[i]!, rotated[(i + 1) % rotated.length]!];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let [x1, x2] = [xs[k]! + inset, xs[k + 1]! - inset];
        if (x2 - x1 < inset + 1) continue;
        if (flip) [x1, x2] = [x2, x1];
        d += this.line(x1 * c - y * s, x1 * s + y * c, x2 * c - y * s, x2 * s + y * c, r);
      }
      flip = !flip;
    }
    return d;
  }
}

/** A sheet's double pencil outline, for a sheet of w×h px (drawn 6px outside it). */
export function paperBorder(w: number, h: number, roughness: readonly [number, number] = [1.1, 1.3]): [string, string] {
  const rough = new Rough(9);
  const pts: Pt[] = [[4, 5], [w + 8, 3], [w + 9, h + 8], [3, h + 7]];
  return [rough.poly(pts, true, roughness[0]), rough.poly(pts, true, roughness[1])];
}
