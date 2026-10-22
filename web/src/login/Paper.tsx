import { useRef, type ReactNode } from "react";
import { PencilOutline, useElementSize } from "../sketch/Paper";

/** The login card: a sheet of paper taped to the board, outlined in pencil. */
export function PaperCard({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  // The outline follows the card as it grows (providers loading, errors, user lists).
  const size = useElementSize(ref);
  return (
    <main className="login__paper" ref={ref}>
      <div className="login__tape" aria-hidden />
      {size && <PencilOutline size={size} className="login__border" />}
      {children}
    </main>
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
