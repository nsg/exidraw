import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { paperBorder } from "./sketch";

/** The login card: a sheet of paper taped to the board, outlined in pencil. */
export function PaperCard({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // The outline follows the card as it grows (providers loading, errors, user lists).
  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const measure = () => {
      const [w, h] = [card.offsetWidth, card.offsetHeight];
      setSize((prev) => (prev?.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  const [outline, retrace] = size ? paperBorder(size.w, size.h) : ["", ""];
  return (
    <main className="login__paper" ref={ref}>
      <div className="login__tape" aria-hidden />
      {size && (
        <svg className="login__border" width={size.w + 12} height={size.h + 12} viewBox={`0 0 ${size.w + 12} ${size.h + 12}`} aria-hidden>
          <path pathLength={1} d={outline} />
          <path pathLength={1} d={retrace} />
        </svg>
      )}
      {children}
    </main>
  );
}

/** Handwritten "start here!" with an arrow pointing at the right edge of its parent's first control. */
export function StartHint({ label }: { label: string }) {
  return (
    <div className="login__hint" aria-hidden>
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
    <span className="login__scribble">
      {children}
      <svg viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden>
        <path pathLength={1} d="M2 8c14-5 30-6 48-3s34 4 48-2" />
      </svg>
    </span>
  );
}

export function MicrosoftLogo() {
  return (
    <span className="login__ms-logo" aria-hidden>
      <svg viewBox="0 0 21 21">
        <rect x="0" y="0" width="10" height="10" fill="#f25022" />
        <rect x="11" y="0" width="10" height="10" fill="#7fba00" />
        <rect x="0" y="11" width="10" height="10" fill="#00a4ef" />
        <rect x="11" y="11" width="10" height="10" fill="#ffb900" />
      </svg>
    </span>
  );
}

export function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M3 8h9.5M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden>
      <rect x="2.5" y="6" width="9" height="6.5" rx="1.5" />
      <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" />
    </svg>
  );
}
