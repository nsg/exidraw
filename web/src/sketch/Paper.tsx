import { useLayoutEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { paperBorder } from "./rough";

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
  const [outline, retrace] = useMemo(() => paperBorder(w, h, roughness), [w, h, roughness]);
  return (
    <svg className={className} width={w + 12} height={h + 12} viewBox={`0 0 ${w + 12} ${h + 12}`} aria-hidden>
      <path pathLength={1} d={outline} />
      <path pathLength={1} d={retrace} />
    </svg>
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

/** Text with a hand-drawn squiggle underneath. */
export function Scribble({ children }: { children: ReactNode }) {
  return (
    <span className="scribble">
      {children}
      <svg viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden>
        <path pathLength={1} d="M2 8c14-5 30-6 48-3s34 4 48-2" />
      </svg>
    </span>
  );
}
