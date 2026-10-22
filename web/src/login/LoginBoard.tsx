import { useEffect, useRef, type ReactNode } from "react";
import { startBoard } from "./board";

/**
 * Full-viewport whiteboard behind the login card: dotted grid, self-drawing
 * doodles with wandering collaborator cursors, and a faint editor toolbar.
 * All of it is decoration (aria-hidden, no pointer events); `children` (the
 * card) sit on a stage above it that scrolls if the card outgrows the viewport.
 */
export function LoginBoard({ children }: { children: ReactNode }) {
  const grid = useRef<HTMLDivElement>(null);
  const doodles = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const cursors = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!grid.current || !doodles.current || !svg.current || !cursors.current || !stage.current) return;
    const parts = { grid: grid.current, doodles: doodles.current, svg: svg.current, cursors: cursors.current, stage: stage.current };
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let stop = startBoard(parts, reducedMotion.matches);
    // The OS setting can flip while the page is open: restart in the matching mode.
    const restart = () => {
      stop();
      stop = startBoard(parts, reducedMotion.matches);
    };
    reducedMotion.addEventListener("change", restart);
    return () => {
      reducedMotion.removeEventListener("change", restart);
      stop();
    };
  }, []);

  return (
    <div className="login">
      <div className="login__layer login__grid" ref={grid} aria-hidden />
      <div className="login__layer login__glow" aria-hidden />
      <div className="login__layer" ref={doodles} aria-hidden>
        <svg className="login__doodles" ref={svg}>
          <defs>
            <filter id="login-lift" x="-20%" y="-20%" width="140%" height="150%">
              <feDropShadow dx="0" dy="6" stdDeviation="6" floodColor="#1b1b1f" floodOpacity=".14" />
            </filter>
          </defs>
        </svg>
        <div className="login__cursors" ref={cursors} />
      </div>
      <FauxToolbar />
      <div className="login__island login__zoom" aria-hidden>
        <span>&minus;</span>
        <span>100%</span>
        <span>+</span>
      </div>
      <div className="login__stage" ref={stage}>
        {children}
      </div>
    </div>
  );
}

/** Excalidraw's shape toolbar, pencil selected. It's a whiteboard, after all. */
function FauxToolbar() {
  return (
    <div className="login__island login__toolbar" aria-hidden>
      <i>
        <svg viewBox="0 0 20 20">
          <rect x="4.5" y="9" width="11" height="8" rx="2" />
          <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
        </svg>
      </i>
      <span className="login__toolbar-sep" />
      <i>
        <svg viewBox="0 0 20 20">
          <path d="M5 3.5 15.5 9l-4.6 1.3L8.4 15z" />
        </svg>
        <small>1</small>
      </i>
      <i>
        <svg viewBox="0 0 20 20">
          <rect x="3" y="5" width="14" height="10" rx="2" />
        </svg>
        <small>2</small>
      </i>
      <i>
        <svg viewBox="0 0 20 20">
          <path d="M10 2.8 17.2 10 10 17.2 2.8 10z" />
        </svg>
        <small>3</small>
      </i>
      <i>
        <svg viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="7" />
        </svg>
        <small>4</small>
      </i>
      <i>
        <svg viewBox="0 0 20 20">
          <path d="M4 16 16 4M9.5 4H16v6.5" />
        </svg>
        <small>5</small>
      </i>
      <i className="login__tool--on">
        <svg viewBox="0 0 20 20">
          <path d="m4 16 1-4 8.3-8.3a2.1 2.1 0 0 1 3 3L8 15z" />
          <path d="m12 5 3 3" />
        </svg>
        <small>7</small>
      </i>
      <i>
        <svg viewBox="0 0 20 20">
          <path d="M5 5h10M10 5v11" />
        </svg>
        <small>8</small>
      </i>
      <i>
        <svg viewBox="0 0 20 20">
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <path d="m3.5 14 4-4 3 3 2-2 4 4" />
          <circle cx="13" cy="7.5" r="1.2" />
        </svg>
        <small>9</small>
      </i>
    </div>
  );
}
