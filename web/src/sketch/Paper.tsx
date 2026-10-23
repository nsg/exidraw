import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Rough, hashSeed, paperBorder } from "./rough";

export interface Size {
  w: number;
  h: number;
}

/** The element's layout size (ignoring transforms), kept up to date as it grows and shrinks. */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const [w, h] = [el.offsetWidth, el.offsetHeight];
      setSize((prev) => (prev?.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Double pencil outline for a sheet of `size`, to be placed 6px up and left of it. */
export function PencilOutline({
  size,
  className,
  roughness,
}: {
  size: Size;
  className: string;
  roughness?: readonly [number, number];
}) {
  const { w, h } = size;
  // Keyed on the values: callers may pass a fresh array every render.
  const [r0, r1] = roughness ?? [];
  const [outline, retrace] = useMemo(() => paperBorder(w, h, r0 === undefined ? undefined : [r0, r1 ?? r0]), [w, h, r0, r1]);
  return (
    <svg className={className} width={w + 12} height={h + 12} viewBox={`0 0 ${w + 12} ${h + 12}`} aria-hidden>
      <path pathLength={1} d={outline} />
      <path pathLength={1} d={retrace} />
    </svg>
  );
}

/** Long edges get a gentler hand than the login card's, or a big sheet looks crumpled. */
export function sheetRoughness({ w, h }: Size): [number, number] {
  const k = Math.min(1, 440 / Math.max(w, h));
  return [Math.max(0.45, 1.1 * k), Math.max(0.55, 1.3 * k)];
}

/**
 * The app's board: a dotted grid with one sheet of paper taped to it, outlined
 * in pencil. `children` go on the sheet, `margin` beside it. `width` picks the
 * desk: the folder listing's, a narrower page, or a small note.
 */
export function SheetOnBoard({
  margin,
  width = "wide",
  children,
}: {
  margin?: ReactNode;
  width?: "wide" | "narrow" | "note";
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const size = useElementSize(ref);
  return (
    <>
      <div className="board" aria-hidden />
      <div className={`desk desk--${width}`}>
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

/**
 * A pencil line stretched to its box: across it by default, down it with
 * `vertical`. Same id, same wobble.
 */
export function PencilRule({
  id,
  double = false,
  vertical = false,
  className = "rule",
}: {
  id: string;
  double?: boolean;
  vertical?: boolean;
  className?: string;
}) {
  const paths = useMemo(() => {
    const r = new Rough(hashSeed(id));
    return double ? [r.line(0, 2.5, 1000, 3.5, 0.55), r.line(0, 4, 1000, 3, 0.55)] : [r.line(0, 3, 1000, 3, 0.55)];
  }, [id, double]);
  return (
    <svg
      className={`${className}${vertical ? ` ${className}--vertical` : ""}`}
      viewBox={vertical ? "0 0 6 1000" : "0 0 1000 6"}
      preserveAspectRatio="none"
      aria-hidden
    >
      {paths.map((d, i) => (
        <path key={i} pathLength={1} d={d} transform={vertical ? "matrix(0 1 1 0 0 0)" : undefined} />
      ))}
    </svg>
  );
}

const CROSS = (() => {
  const r = new Rough(23);
  return r.line(5, 5.5, 15, 15, 0.45) + r.line(15.5, 4.5, 4.5, 15.5, 0.45);
})();

/** A quick pencil ×, for close and remove buttons. Inherits the text colour. */
export function CrossIcon() {
  return (
    <svg className="cross-icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden>
      <path d={CROSS} />
    </svg>
  );
}

const LOADER = (() => {
  const r = new Rough(31);
  return r.line(2, 9, 30, 6, 0.6) + r.line(30, 6, 58, 10, 0.6) + r.line(58, 10, 86, 5, 0.6);
})();

/** "Loading…" in handwriting, with a pencil stroke that keeps drawing itself until it unmounts. */
export function PencilLoader({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <p className={`pencil-loader${className ? ` ${className}` : ""}`}>
      {label}
      <svg viewBox="0 0 88 14" width="88" height="14" aria-hidden>
        <path pathLength={1} d={LOADER} />
      </svg>
    </p>
  );
}

/** Handwritten "start here!" with an arrow pointing at the left edge of its parent's control. */
export function StartHint({ label }: { label: string }) {
  return (
    <div className="start-hint" aria-hidden>
      <span>{label}</span>
      <svg viewBox="0 0 190 96">
        <path pathLength={1} d="M74 38c14 22 46 42 104 40" />
        <path pathLength={1} d="M165 67l13 11-14 9" />
      </svg>
    </div>
  );
}

/** A hand-drawn squiggle, stretched to its box. */
export function Squiggle({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden>
      <path pathLength={1} d="M2 8c14-5 30-6 48-3s34 4 48-2" />
    </svg>
  );
}

/** Text with a hand-drawn squiggle underneath. */
export function Scribble({ children }: { children: ReactNode }) {
  return (
    <span className="scribble">
      {children}
      <Squiggle />
    </span>
  );
}
