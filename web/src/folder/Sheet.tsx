import { useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { PencilOutline, useElementSize, type Size } from "../sketch/Paper";
import { FILL_COLORS, INK, Rough, hashSeed, pick, rectPts, smooth, type Pt } from "../sketch/rough";

/**
 * The folder page's board: a dotted grid with one sheet of paper taped to it,
 * outlined in pencil. `children` go on the sheet, `margin` beside it.
 */
export function SheetOnBoard({ margin, children }: { margin?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const size = useElementSize(ref);
  return (
    <>
      <div className="board" aria-hidden />
      <div className="desk">
        {margin}
        <section className="sheet" ref={ref}>
          <div className="sheet__tape" aria-hidden />
          <div className="sheet__tape sheet__tape--corner" aria-hidden />
          {size && <PencilOutline size={size} className="sheet__border" roughness={sheetRoughness(size)} />}
          {children}
        </section>
      </div>
    </>
  );
}

/** Long edges get a gentler hand than the login card's, or a big sheet looks crumpled. */
function sheetRoughness({ w, h }: Size): [number, number] {
  const k = Math.min(1, 440 / Math.max(w, h));
  return [Math.max(0.45, 1.1 * k), Math.max(0.55, 1.3 * k)];
}

/** A pencil line across a table row, stretched to the row's width. Same id, same wobble. */
export function RowRule({ id, double = false }: { id: string; double?: boolean }) {
  const paths = useMemo(() => {
    const r = new Rough(hashSeed(id));
    return double ? [r.line(0, 2.5, 1000, 3.5, 0.55), r.line(0, 4, 1000, 3, 0.55)] : [r.line(0, 3, 1000, 3, 0.55)];
  }, [id, double]);
  return (
    <svg className="rule" viewBox="0 0 1000 6" preserveAspectRatio="none" aria-hidden>
      {paths.map((d, i) => (
        <path key={i} pathLength={1} d={d} />
      ))}
    </svg>
  );
}

const stroke = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Hand-drawn folder, hachured in a colour derived from its id. */
export function FolderSketch({ id }: { id: string }) {
  const { outline, lip, fill } = useMemo(() => {
    const r = new Rough(hashSeed(id));
    const body: Pt[] = [[3, 5.5], [14, 5.5], [17.5, 9], [37, 9], [37, 29], [3, 29]];
    return {
      fill: r.hachure(rectPts(3, 12, 34, 17), 3.4, -41, 1, 0.35),
      outline: r.poly(body, true, 0.45),
      lip: r.line(3, 12.5, 37, 12, 0.4),
    };
  }, [id]);
  return (
    <svg className="node-icon node-icon--folder" viewBox="0 0 40 32" aria-hidden>
      <path d={fill} stroke={pick(FILL_COLORS, id)} strokeWidth={1.5} {...stroke} />
      <path d={outline} stroke={INK} strokeWidth={1.5} {...stroke} />
      <path d={lip} stroke={INK} strokeWidth={1.3} {...stroke} />
    </svg>
  );
}

type Mark = "circle" | "box" | "diamond" | "triangle";
const MARKS: readonly Mark[] = ["circle", "box", "diamond", "triangle"];

/**
 * A blank sheet with a folded corner and one small doodle, varied per drawing
 * id so a list doesn't look like wallpaper. It is an icon, not a preview: the
 * doodle says nothing about what the drawing contains.
 */
export function DrawingSketch({ id }: { id: string }) {
  const { page, fold, lines, mark, hatch } = useMemo(() => {
    const r = new Rough(hashSeed(id));
    const kind = pick(MARKS, `${id}:mark`);
    const [cx, cy, s] = [21, 21.5, 6.5];
    const shape: Pt[] =
      kind === "diamond"
        ? [[cx, cy - s - 1], [cx + s + 1, cy], [cx, cy + s + 1], [cx - s - 1, cy]]
        : kind === "triangle"
          ? [[cx, cy - s - 0.5], [cx + s + 1, cy + s], [cx - s - 1, cy + s]]
          : rectPts(cx - s, cy - s, s * 2, s * 2);
    return {
      page: r.poly([[8.5, 1.5], [26.5, 1.5], [33, 8], [33, 31], [8.5, 31]], true, 0.35),
      fold: r.poly([[26.5, 1.5], [26.5, 8], [33, 8]], false, 0.25),
      lines: r.line(12.5, 6.5, 20.5, 6.5, 0.3) + r.line(12.5, 10, 23.5, 10, 0.3),
      mark: kind === "circle" ? r.ellipse(cx, cy, s, s, 0.4) : r.poly(shape, true, 0.3),
      hatch: r.hachure(kind === "circle" ? circlePts(cx, cy, s) : shape, 2.6, -41, 0.8, 0.25),
    };
  }, [id]);
  return (
    <svg
      className="node-icon node-icon--drawing"
      viewBox="0 0 40 32"
      style={{ "--tilt": `${(hashSeed(`${id}:tilt`) % 9) - 4}deg` } as CSSProperties}
      aria-hidden
    >
      <path d="M10.5 3.5h18l6.5 6.5v23H10.5z" fill="rgb(27 27 31 / 0.14)" />
      <path d="M8.5 1.5h18l6.5 6.5v23H8.5z" fill="#fff" />
      <path d={hatch} stroke={pick(FILL_COLORS, `${id}:fill`)} strokeWidth={1.3} {...stroke} />
      <path d={mark} stroke={INK} strokeWidth={1.3} {...stroke} />
      <path d={lines} stroke="#adb5bd" strokeWidth={1.5} {...stroke} />
      <path d={page + fold} stroke={INK} strokeWidth={1.4} {...stroke} />
    </svg>
  );
}

const circlePts = (cx: number, cy: number, r: number): Pt[] =>
  Array.from({ length: 16 }, (_, i) => [cx + Math.cos((i / 16) * Math.PI * 2) * r, cy + Math.sin((i / 16) * Math.PI * 2) * r] as const);

/* ---- margin doodles: decoration beside the sheet on wide screens ------------------------------ */

const r1 = new Rough(41);
const DROP_ARROW = smooth(r1.wobble([[40, 58], [56, 86], [92, 100], [126, 94]], 1)) + r1.head(127, 94, -0.15, 10);

const r2 = new Rough(57);
const SUN = [
  r2.ellipse(30, 30, 14, 14, 0.5),
  Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    return r2.line(30 + Math.cos(a) * 21, 30 + Math.sin(a) * 21, 30 + Math.cos(a) * 28, 30 + Math.sin(a) * 28, 0.3);
  }).join(""),
];

const r3 = new Rough(73);
const PLANE_BODY: Pt[] = [[118, 14], [60, 34], [80, 42]];
const PLANE_WING: Pt[] = [[80, 42], [88, 60], [118, 14]];
/** Every other step along a curve: a dashed flight path that still draws itself. */
function dashedCurve(r: Rough, [p0, p1, p2, p3]: readonly [Pt, Pt, Pt, Pt], steps: number): string {
  const at = (t: number): Pt => {
    const u = 1 - t;
    const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
  };
  let d = "";
  for (let i = 0; i < steps; i += 2) {
    const [a, b] = [at(i / steps), at((i + 1) / steps)];
    d += r.line(a[0], a[1], b[0], b[1], 0.2);
  }
  return d;
}
const PLANE = {
  fill: r3.hachure(PLANE_BODY, 4.5, -41, 1.5, 0.35),
  outline: r3.poly(PLANE_BODY, true, 0.5) + r3.poly(PLANE_WING, false, 0.5) + r3.line(80, 42, 96, 35, 0.4),
  trail: dashedCurve(r3, [[54, 42], [26, 46], [34, 72], [2, 76]], 13),
};

const r4 = new Rough(89);
const STAR_PTS: Pt[] = Array.from({ length: 10 }, (_, i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 5;
  const rad = i % 2 ? 9.5 : 22;
  return [30 + Math.cos(a) * rad, 30 + Math.sin(a) * rad] as const;
});
const STAR = { outline: r4.poly(STAR_PTS, true, 0.35), fill: r4.hachure(STAR_PTS, 4, -41, 1, 0.3) };

/** Quiet doodles in the board's margins. Pure decoration: hidden from assistive tech and on small screens. */
export function MarginDoodles({ dropHint }: { dropHint: boolean }) {
  return (
    <div className="margin" aria-hidden>
      {dropHint && (
        <svg className="margin__doodle margin__doodle--drop" viewBox="0 0 136 112" width="136" height="112">
          <text x="6" y="22" transform="rotate(-6 6 22)">
            drop files
          </text>
          <text x="10" y="44" transform="rotate(-6 10 44)">
            on the sheet
          </text>
          <path pathLength={1} d={DROP_ARROW} stroke="var(--primary)" strokeWidth={2.1} {...stroke} />
        </svg>
      )}
      <svg className="margin__doodle margin__doodle--sun" viewBox="0 0 60 60" width="60" height="60">
        {SUN.map((d, i) => (
          <path key={i} pathLength={1} d={d} stroke="#f59f00" strokeWidth={2} {...stroke} />
        ))}
      </svg>
      <svg className="margin__doodle margin__doodle--plane" viewBox="0 0 124 80" width="124" height="80">
        <path pathLength={1} d={PLANE.trail} stroke="#adb5bd" strokeWidth={1.6} {...stroke} />
        <path pathLength={1} d={PLANE.fill} stroke="#74c0fc" strokeWidth={1.5} {...stroke} />
        <path pathLength={1} d={PLANE.outline} stroke={INK} strokeWidth={1.8} {...stroke} />
      </svg>
      <svg className="margin__doodle margin__doodle--star" viewBox="0 0 60 60" width="60" height="60">
        <path pathLength={1} d={STAR.fill} stroke="#ffd43b" strokeWidth={1.6} {...stroke} />
        <path pathLength={1} d={STAR.outline} stroke={INK} strokeWidth={1.7} {...stroke} />
      </svg>
    </div>
  );
}
