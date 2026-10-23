import { INK, Rough, smooth, type Pt } from "./rough";

/**
 * Small doodles for the board's status notes (not found, no access, offline).
 * Generated once per page load; they are decoration and hidden from assistive tech.
 */
export type DoodleKind = "lost" | "locked" | "offline";

const stroke = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ellipse = (cx: number, cy: number, r: number): Pt[] =>
  Array.from({ length: 18 }, (_, i) => [cx + Math.cos((i / 18) * Math.PI * 2) * r, cy + Math.sin((i / 18) * Math.PI * 2) * r] as const);

const lost = (() => {
  const r = new Rough(101);
  return {
    fill: r.hachure(ellipse(34, 32, 16), 4.2, -41, 1.5, 0.35),
    ink: r.ellipse(34, 32, 19, 19, 0.6) + r.line(48, 46, 66, 64, 0.5) + r.line(51, 44, 68, 61, 0.5),
    mark: smooth(r.wobble([[28, 27], [31, 21], [38, 21], [40, 27], [34, 32], [34, 36]], 0.6)) + r.line(34, 41, 34.4, 42, 0.2),
  };
})();

const locked = (() => {
  const r = new Rough(103);
  const body: Pt[] = [[16, 34], [56, 33], [57, 64], [15, 65]];
  return {
    fill: r.hachure(body, 4.2, -41, 1.5, 0.35),
    ink: r.poly(body, true, 0.6) + smooth(r.wobble([[24, 34], [24, 22], [30, 13], [42, 13], [48, 22], [48, 33]], 0.6)),
    mark: r.ellipse(36, 45, 3.6, 3.6, 0.3) + r.line(36, 49, 36, 56, 0.3),
  };
})();

const offline = (() => {
  const r = new Rough(107);
  const cloud: Pt[] = [[14, 52], [8, 44], [12, 34], [22, 32], [26, 20], [40, 15], [52, 22], [56, 31], [66, 33], [70, 43], [64, 52]];
  return {
    fill: r.hachure(cloud, 4.2, -41, 2, 0.35),
    ink: smooth(r.wobble([...cloud, [14, 52]], 0.8)),
    mark: r.line(32, 58, 46, 70, 0.4) + r.line(46, 58, 32, 70, 0.4),
  };
})();

const DOODLES = { lost, locked, offline } as const;
const ACCENT: Record<DoodleKind, string> = { lost: "#74c0fc", locked: "#ffd43b", offline: "#b197fc" };

export function Doodle({ kind }: { kind: DoodleKind }) {
  const d = DOODLES[kind];
  return (
    <svg className="doodle" viewBox="0 0 76 76" width="76" height="76" aria-hidden>
      <path pathLength={1} d={d.fill} stroke={ACCENT[kind]} strokeWidth={1.6} {...stroke} />
      <path pathLength={1} d={d.ink} stroke={INK} strokeWidth={2} {...stroke} />
      <path pathLength={1} d={d.mark} stroke={kind === "offline" ? "#c92a2a" : INK} strokeWidth={2.2} {...stroke} />
    </svg>
  );
}
