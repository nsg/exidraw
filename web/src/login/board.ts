/**
 * The login page's living whiteboard: doodles draw themselves, a few cursors
 * wander around and every now and then select, erase and redraw one of them,
 * and the board drifts a little with the mouse.
 *
 * Imperative on purpose: hundreds of SVG paths animated every frame would be
 * wasted work for React. Everything runs off one requestAnimationFrame loop
 * whose clock stands still while the tab is hidden, and `startBoard` returns a
 * dispose function that stops the loop, cancels every pending step and removes
 * what it added to the DOM.
 */
import { HAND_FONT, Rough } from "../sketch/rough";
import { DOODLES, Sketch, svgEl, type DoodleSpec, type DrawOp } from "./sketch";

export interface BoardParts {
  /** Doodles are drawn into this SVG; its viewBox tracks the viewport. */
  svg: SVGSVGElement;
  /** Layer for the collaborator cursors, same coordinates as `svg`. */
  cursors: HTMLElement;
  /** Parallax layers. */
  grid: HTMLElement;
  doodles: HTMLElement;
  /** Holds the paper card; its first child is the card doodles must stay clear of. */
  stage: HTMLElement;
}

interface Point {
  x: number;
  y: number;
}

const MOBILE_MAX_WIDTH = 700;
/** A doodle more covered by the card than this (area fraction) is not shown. */
const MAX_COVERED = 0.15;
/** A doodle is not picked for a redraw again within this many ms. */
const REDRAW_COOLDOWN = 7000;
const CURSOR_PATH = "M3 2.5v17.2l4.6-4.3 2.9 6.5 3.2-1.4-2.8-6.3h6.4z";
const PEOPLE = {
  anna: { name: "Anna", color: "#f76707" },
  jonas: { name: "Jonas", color: "#1c7ed6" },
  mia: { name: "Mia", color: "#d6336c" },
} as const;

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/** Mostly ease-in-out with a little constant speed, so long strokes never stall. */
const easeStroke = (t: number) => t * 0.15 + easeInOut(t) * 0.85;
const round = (n: number) => Math.round(n * 10) / 10;

class Cancelled extends Error {}
const ignoreCancelled = (err: unknown) => {
  if (!(err instanceof Cancelled)) console.error(err);
};

interface Task {
  step: (now: number) => boolean;
  resolve: () => void;
  reject: (err: Cancelled) => void;
}

/** A requestAnimationFrame clock that only advances while it runs. */
class Clock {
  /** Milliseconds of running time. */
  now = 0;
  onFrame: (() => void) | null = null;
  private tasks = new Set<Task>();
  private raf = 0;
  private last = 0;
  private running = false;
  private disposed = false;

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  pause(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.pause();
    this.disposed = true;
    for (const task of this.tasks) task.reject(new Cancelled());
    this.tasks.clear();
  }

  /** Calls `fn` with eased progress 0..1 once now and then every frame; resolves at 1. */
  tween(ms: number, fn?: (t: number) => void, ease: (t: number) => number = (t) => t): Promise<void> {
    if (this.disposed) return Promise.reject(new Cancelled());
    const start = this.now;
    fn?.(ease(0));
    return new Promise((resolve, reject) => {
      this.tasks.add({
        resolve,
        reject,
        step: (now) => {
          const t = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
          fn?.(ease(t));
          return t >= 1;
        },
      });
    });
  }

  sleep(ms: number): Promise<void> {
    return this.tween(ms);
  }

  private frame = (time: number) => {
    // Clamped, so a long frame (or a missed visibilitychange) can't fast-forward everything.
    this.now += Math.min(100, Math.max(0, time - this.last));
    this.last = time;
    for (const task of [...this.tasks]) {
      if (task.step(this.now)) {
        this.tasks.delete(task);
        task.resolve();
      }
    }
    this.onFrame?.();
    if (this.running) this.raf = requestAnimationFrame(this.frame);
  };
}

interface Doodle {
  spec: DoodleSpec;
  g: SVGGElement;
  seed: number;
  /** Being drawn or redrawn right now. */
  busy: boolean;
  drawn: boolean;
  /** No spot in this layout, or it would sit under the card. */
  hidden: boolean;
  /** Clock time the last (re)draw finished. */
  last: number;
  /** Local → board transform, kept in step with the group's transform attribute. */
  matrix: DOMMatrix;
  /** Local bounding box of the last build. */
  box: DOMRect | null;
}

/** A draw op plus everything measured up front, so frame callbacks only write. */
type Prepared =
  | { kind: "path"; el: SVGPathElement; speed: number; length: number; samples: Point[] }
  | { kind: "fill"; el: SVGPathElement; box: DOMRect }
  | { kind: "text"; el: SVGTextElement; reveal: SVGRectElement; box: DOMRect };

/** Longest gap between the precomputed points a cursor follows along a stroke. */
const SAMPLE_STEP = 5;
const MAX_SAMPLES = 400;

/** Reads only: geometry queries force a layout, so they are batched before any write. */
function measure(op: DrawOp, followed: boolean): Prepared {
  switch (op.kind) {
    case "path": {
      const length = op.el.getTotalLength();
      // Only a stroke a cursor follows needs its points.
      const n = Math.min(MAX_SAMPLES, Math.max(1, Math.ceil(length / SAMPLE_STEP)));
      const samples = followed
        ? Array.from({ length: n + 1 }, (_, i) => {
            const p = op.el.getPointAtLength((length * i) / n);
            return { x: p.x, y: p.y };
          })
        : [];
      return { ...op, length, samples };
    }
    case "fill":
      return { ...op, box: op.el.getBBox() };
    case "text":
      return { ...op, box: op.el.getBBox() };
  }
}

/** Writes only: the undrawn state. */
function hide(op: Prepared): void {
  if (op.kind === "path") {
    op.el.style.strokeDasharray = `${op.length} ${op.length + 2}`;
    op.el.style.strokeDashoffset = String(op.length);
  } else if (op.kind === "fill") {
    op.el.style.opacity = "0";
  } else {
    const { box } = op;
    setAttrs(op.reveal, { x: box.x - 4, y: box.y - 8, height: box.height + 16, width: 0 });
  }
}

/** Point at progress t (0..1) along a stroke's precomputed samples. */
function along(samples: readonly Point[], t: number): Point {
  const pos = t * (samples.length - 1);
  const i = Math.min(samples.length - 2, Math.floor(pos));
  const [a, b] = [samples[i]!, samples[i + 1] ?? samples[i]!];
  const k = pos - i;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

function finish(op: Prepared): void {
  if (op.kind === "path") {
    op.el.style.strokeDasharray = "";
    op.el.style.strokeDashoffset = "";
  } else if (op.kind === "fill") {
    op.el.style.opacity = "";
  } else {
    const { box } = op;
    setAttrs(op.reveal, { x: box.x - 4, y: box.y - 8, height: box.height + 16, width: box.width + 8 });
  }
}

function setAttrs(el: Element, attrs: Record<string, string | number>): void {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
}

/** Local doodle coordinates → board (CSS px) coordinates. */
function toBoard(d: Doodle, x: number, y: number): Point {
  const m = d.matrix;
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** The doodle's local bounding box; measured once per build. */
function boxOf(d: Doodle): DOMRect {
  return (d.box ??= d.g.getBBox());
}

class Cursor {
  readonly el: HTMLDivElement;
  x = 0;
  y = 0;

  constructor(
    readonly color: string,
    name: string,
    at: Point,
    parent: HTMLElement,
    private clock: Clock,
  ) {
    this.el = document.createElement("div");
    this.el.className = "login__cursor";
    const svg = svgEl("svg", { viewBox: "0 0 22 24" }, this.el);
    svgEl("path", { d: CURSOR_PATH, fill: color, stroke: "#fff", "stroke-width": 1.6, "stroke-linejoin": "round" }, svg);
    const tag = document.createElement("span");
    tag.className = "login__cursor-tag";
    tag.style.background = color;
    tag.textContent = name;
    this.el.appendChild(tag);
    parent.appendChild(this.el);
    this.set(at);
  }

  set(p: Point): void {
    this.x = p.x;
    this.y = p.y;
    this.el.style.transform = `translate(${round(p.x)}px,${round(p.y)}px)`;
  }

  /** Move along a gently bent curve, like a hand on a mouse. */
  glide(to: Point, ms?: number): Promise<void> {
    const [fx, fy] = [this.x, this.y];
    const [dx, dy] = [to.x - fx, to.y - fy];
    const dist = Math.hypot(dx, dy);
    if (dist < 1.5) return Promise.resolve();
    const duration = ms ?? Math.min(1100, Math.max(90, dist * 1.15 + (dist > 120 ? 180 : 0)));
    const bend = (Math.random() - 0.5) * dist * 0.35;
    const [mx, my] = [fx + dx / 2 - (dy / dist) * bend, fy + dy / 2 + (dx / dist) * bend];
    return this.clock.tween(
      duration,
      (t) => {
        const u = 1 - t;
        this.set({ x: u * u * fx + 2 * u * t * mx + t * t * to.x, y: u * u * fy + 2 * u * t * my + t * t * to.y });
      },
      easeInOut,
    );
  }

  async wander(ms: number, bounds: () => { w: number; h: number }): Promise<void> {
    const end = this.clock.now + ms;
    while (this.clock.now < end) {
      const { w, h } = bounds();
      const to = {
        x: Math.max(20, Math.min(w - 90, this.x + (Math.random() - 0.5) * 130)),
        y: Math.max(20, Math.min(h - 40, this.y + (Math.random() - 0.5) * 90)),
      };
      await this.glide(to, 700 + Math.random() * 700);
      await this.clock.sleep(200 + Math.random() * 700);
    }
  }
}

/** Starts the board; returns a function that stops it and cleans up. */
export function startBoard(parts: BoardParts, reducedMotion: boolean): () => void {
  const board = new Board(parts, reducedMotion);
  void board.start().catch(ignoreCancelled);
  return () => board.dispose();
}

class Board {
  private clock = new Clock();
  private doodles: Doodle[];
  private cursors: Cursor[] = [];
  private width = 0;
  private height = 0;
  private mobile = false;
  private disposed = false;
  private resizeTimer = 0;
  private resizeObserver: ResizeObserver | null = null;
  /** Parallax: pointer target and eased position, both -0.5..0.5 of the viewport. */
  private target = { x: 0, y: 0 };
  private drift = { x: 0, y: 0 };

  constructor(
    private parts: BoardParts,
    private reducedMotion: boolean,
  ) {
    this.doodles = DOODLES.map((spec, i) => ({
      spec,
      g: svgEl("g", {}, parts.svg),
      seed: i * 31 + 7,
      busy: false,
      drawn: false,
      hidden: false,
      last: 0,
      matrix: new DOMMatrix(),
      box: null,
    }));
  }

  async start(): Promise<void> {
    // Text reveals are measured, so the handwriting font must be in first.
    await document.fonts.load(`20px ${HAND_FONT}`).catch(() => undefined);
    if (this.disposed) return;
    this.layout();
    addEventListener("resize", this.onResize);
    this.resizeObserver = new ResizeObserver(this.onResize);
    const card = this.card();
    if (card) this.resizeObserver.observe(card);

    if (this.reducedMotion) {
      // Fully drawn and still: no cursors moving, no parallax.
      for (const d of this.doodles) void this.render(d, { instant: true });
      this.placeStillCursors();
      return;
    }

    document.addEventListener("visibilitychange", this.onVisibility);
    addEventListener("pointermove", this.onPointerMove, { passive: true });
    document.addEventListener("pointerout", this.onPointerOut);
    this.clock.onFrame = this.parallax;
    if (document.visibilityState === "visible") this.clock.start();

    const [w, h] = [this.width, this.height];
    const by = (id: DoodleSpec["id"]) => this.doodles.find((d) => d.spec.id === id)!;
    const anna = this.cursor(PEOPLE.anna, { x: -40, y: h * 0.42 });
    const jonas = this.cursor(PEOPLE.jonas, { x: w + 40, y: h * 0.3 });
    const mia = this.cursor(PEOPLE.mia, { x: w * 0.62, y: h + 40 });
    // Each cursor draws one doodle, then loops: wander, pick a doodle nearby, redraw it.
    // The rest draw themselves, quickly, without a cursor.
    const plan: Array<[Cursor | null, Doodle, number]> = this.mobile
      ? [
          [anna, by("roadmap"), 250],
          [jonas, by("flow"), 500],
          [mia, by("smiley"), 900],
          [null, by("ideas"), 700],
        ]
      : [
          [anna, by("flow"), 150],
          [jonas, by("wireframe"), 350],
          [mia, by("smiley"), 900],
          [null, by("chart"), 300],
          [null, by("roadmap"), 450],
          [null, by("ideas"), 750],
          [null, by("sun"), 1300],
        ];
    for (const [cursor, doodle, delay] of plan) {
      if (cursor) void this.life(cursor, doodle, delay).catch(ignoreCancelled);
      else void this.selfDraw(doodle, delay).catch(ignoreCancelled);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clock.dispose();
    clearTimeout(this.resizeTimer);
    this.resizeObserver?.disconnect();
    removeEventListener("resize", this.onResize);
    removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("pointerout", this.onPointerOut);
    document.removeEventListener("visibilitychange", this.onVisibility);
    for (const d of this.doodles) d.g.remove();
    for (const c of this.cursors) c.el.remove();
    for (const el of [this.parts.grid, this.parts.doodles, this.parts.stage]) el.style.transform = "";
  }

  private card(): HTMLElement | null {
    return this.parts.stage.firstElementChild instanceof HTMLElement ? this.parts.stage.firstElementChild : null;
  }

  private cursor(person: { name: string; color: string }, at: Point): Cursor {
    const cursor = new Cursor(person.color, person.name, at, this.parts.cursors, this.clock);
    this.cursors.push(cursor);
    return cursor;
  }

  /* ---- layout ---------------------------------------------------------------------- */

  /**
   * Desktop: doodles sit around the viewport centre, scaled with the viewport.
   * Mobile: a few, smaller, in the bands above and below the card. Either way a
   * doodle that would end up mostly under the card is hidden.
   */
  private layout(): void {
    const [w, h] = [innerWidth, innerHeight];
    this.width = w;
    this.height = h;
    this.mobile = w < MOBILE_MAX_WIDTH;
    this.parts.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const k = Math.max(0.72, Math.min(1.15, Math.min(w / 1440, h / 900)));
    const card = this.card();
    // Offsets ignore the card's tilt and the parallax drift, which is what we want here.
    const box = card && {
      left: card.offsetLeft,
      top: card.offsetTop,
      right: card.offsetLeft + card.offsetWidth,
      bottom: card.offsetTop + card.offsetHeight,
    };

    for (const d of this.doodles) {
      const { w: dw, h: dh, desktop, mobile } = d.spec;
      let place: { x: number; y: number; scale: number; rotate: number } | null = null;
      if (!this.mobile) {
        const [dx, dy, scale, rotate] = desktop;
        place = { x: w / 2 + dx * Math.max(k, Math.min(1.25, w / 1440)), y: h / 2 + dy * k, scale: scale * k, rotate };
      } else if (mobile) {
        const [band, dx, dy, scale, rotate] = mobile;
        const [top, bottom] = [box?.top ?? 0, box?.bottom ?? h];
        const y = band === "top" ? (top - dh * scale) / 2 + dy : bottom + (h - 16 - bottom - dh * scale) / 2 + dy;
        place = { x: w / 2 + dx, y, scale, rotate };
      }
      let covered = 0;
      if (place && box) {
        const [pw, ph] = [dw * place.scale, dh * place.scale];
        const overlapX = Math.min(place.x + pw, box.right) - Math.max(place.x, box.left);
        const overlapY = Math.min(place.y + ph, box.bottom) - Math.max(place.y, box.top);
        covered = (Math.max(0, overlapX) * Math.max(0, overlapY)) / (pw * ph);
      }
      d.hidden = !place || covered > MAX_COVERED;
      // `visibility`, not `display`: a hidden doodle may be mid-draw and still needs geometry.
      d.g.setAttribute("visibility", d.hidden ? "hidden" : "visible");
      if (place) {
        const [x, y, scale] = [round(place.x), round(place.y), round(place.scale * 100) / 100];
        d.g.setAttribute("transform", `translate(${x} ${y}) rotate(${place.rotate}) scale(${scale})`);
        d.matrix = new DOMMatrix().translate(x, y).rotate(place.rotate).scale(scale);
      }
    }
  }

  private onResize = () => {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (this.disposed) return;
      this.layout();
      // Doodles that just came into view (e.g. after rotating a phone) appear fully drawn.
      for (const d of this.doodles) if (!d.hidden && !d.drawn && !d.busy) void this.render(d, { instant: true });
      if (this.reducedMotion) this.placeStillCursors();
    }, 120);
  };

  /** Reduced motion: cursors parked on a doodle each, as if mid-edit. */
  private placeStillCursors(): void {
    for (const c of this.cursors) c.el.remove();
    this.cursors = [];
    const spots: Array<[{ name: string; color: string }, DoodleSpec["id"], number, number]> = this.mobile
      ? [
          [PEOPLE.anna, "roadmap", 0.8, 0.85],
          [PEOPLE.jonas, "flow", 0.62, 0.4],
        ]
      : [
          [PEOPLE.anna, "flow", 0.72, 0.3],
          [PEOPLE.jonas, "wireframe", 0.6, 0.62],
          [PEOPLE.mia, "smiley", 0.32, 0.8],
        ];
    for (const [person, id, fx, fy] of spots) {
      const d = this.doodles.find((x) => x.spec.id === id);
      if (!d || d.hidden) continue;
      const b = boxOf(d);
      this.cursor(person, toBoard(d, b.x + b.width * fx, b.y + b.height * fy));
    }
  }

  /* ---- motion ---------------------------------------------------------------------- */

  private onVisibility = () => {
    if (document.visibilityState === "visible") this.clock.start();
    else this.clock.pause();
  };

  private onPointerMove = (e: PointerEvent) => {
    this.target = { x: e.clientX / this.width - 0.5, y: e.clientY / this.height - 0.5 };
  };

  private onPointerOut = (e: PointerEvent) => {
    if (!e.relatedTarget) this.target = { x: 0, y: 0 };
  };

  /** Background, doodles and card drift by different amounts, for a bit of depth. */
  private parallax = () => {
    const { target, drift } = this;
    if (Math.abs(target.x - drift.x) + Math.abs(target.y - drift.y) < 1e-4) return;
    drift.x += (target.x - drift.x) * 0.06;
    drift.y += (target.y - drift.y) * 0.06;
    const move = (el: HTMLElement, by: number) => (el.style.transform = `translate3d(${round(drift.x * by)}px,${round(drift.y * by)}px,0)`);
    move(this.parts.grid, -16);
    move(this.parts.doodles, -34);
    move(this.parts.stage, 8);
  };

  /* ---- drawing --------------------------------------------------------------------- */

  /** Rebuilds the doodle with a fresh wobble and draws it stroke by stroke. */
  private async render(d: Doodle, opts: { speed?: number; cursor?: Cursor; instant?: boolean } = {}): Promise<void> {
    const { speed = 1, cursor, instant = false } = opts;
    d.seed++;
    const rough = new Rough(d.seed * 977 + 13);
    d.g.replaceChildren();
    d.g.style.opacity = "";
    const sketch = new Sketch(d.g, rough);
    d.spec.build(sketch, rough);
    // All reads first (one layout), then all writes.
    const ops = sketch.ops.map((op) => measure(op, !instant && !!cursor));
    d.box = d.g.getBBox();
    if (!instant) {
      ops.forEach(hide);
      for (const op of ops) await this.drawOp(d, op, speed, cursor);
    }
    ops.forEach(finish);
    d.drawn = true;
  }

  private async drawOp(d: Doodle, op: Prepared, speed: number, cursor?: Cursor): Promise<void> {
    const { clock } = this;
    if (op.kind === "fill") {
      const b = op.box;
      if (cursor) await cursor.glide(toBoard(d, b.x + b.width * 0.55, b.y + b.height * 0.45));
      return clock.tween(320, (t) => (op.el.style.opacity = String(t)));
    }
    if (op.kind === "text") {
      const b = op.box;
      const y = b.y + b.height * 0.62;
      if (cursor) await cursor.glide(toBoard(d, b.x, y));
      return clock.tween(Math.max(260, ((b.width * 7) / speed) * 0.45), (t) => {
        op.reveal.setAttribute("width", String((b.width + 8) * t));
        cursor?.set(toBoard(d, b.x + b.width * t, y + Math.sin(t * 28) * 2.5));
      });
    }
    const { el, length, samples } = op;
    if (cursor) {
      const p = along(samples, 0);
      await cursor.glide(toBoard(d, p.x, p.y));
    }
    return clock.tween(
      Math.max(160, length / (speed * op.speed)),
      (t) => {
        el.style.strokeDashoffset = String(length * (1 - t));
        if (cursor) {
          const p = along(samples, t);
          cursor.set(toBoard(d, p.x, p.y));
        }
      },
      easeStroke,
    );
  }

  /** Draws without a cursor; claimed up front so a resize doesn't draw it instantly meanwhile. */
  private selfDraw(d: Doodle, delay: number): Promise<void> {
    return this.claim(d, async () => {
      await this.clock.sleep(delay);
      await this.render(d, { speed: this.mobile ? 1.5 : 1.6 });
    });
  }

  /** Select the doodle, erase it, then draw it again following the cursor. */
  private async redraw(d: Doodle, cursor: Cursor): Promise<void> {
    const b = boxOf(d);
    const c = toBoard(d, b.x + b.width / 2, b.y + b.height / 2);
    await cursor.glide({ x: c.x + b.width * 0.25, y: c.y + b.height * 0.2 });
    const pad = 10;
    const selection = svgEl(
      "rect",
      {
        x: b.x - pad,
        y: b.y - pad,
        width: b.width + pad * 2,
        height: b.height + pad * 2,
        rx: 4,
        fill: cursor.color,
        "fill-opacity": 0.04,
        stroke: cursor.color,
        "stroke-width": 1.6,
        "stroke-dasharray": "6 4",
        "vector-effect": "non-scaling-stroke",
      },
      d.g,
    );
    await this.clock.sleep(650);
    await this.clock.tween(380, (t) => (d.g.style.opacity = String(1 - t)));
    selection.remove();
    await this.clock.sleep(250);
    await this.render(d, { speed: 0.62, cursor });
  }

  private async life(cursor: Cursor, first: Doodle, delay: number): Promise<void> {
    // Claimed before the delay, like selfDraw, so a resize meanwhile doesn't draw it instantly.
    await this.claim(first, async () => {
      await this.clock.sleep(delay);
      if (!first.hidden) await this.render(first, { speed: 1.15, cursor });
    });
    const bounds = () => ({ w: this.width, h: this.height });
    for (;;) {
      await cursor.wander(1400 + Math.random() * 2200, bounds);
      const now = this.clock.now;
      const pool = this.doodles.filter((d) => !d.hidden && d.drawn && !d.busy && now - d.last > REDRAW_COOLDOWN);
      if (!pool.length) continue;
      // Prefer nearby doodles, so cursors don't cross the card all the time.
      const weights = pool.map((d) => {
        const b = boxOf(d);
        const c = toBoard(d, b.x + b.width / 2, b.y + b.height / 2);
        return 1 / Math.pow(Math.hypot(c.x - cursor.x, c.y - cursor.y) + 150, 2);
      });
      let pick = Math.random() * weights.reduce((a, b) => a + b, 0);
      let chosen = pool[0]!;
      for (let i = 0; i < pool.length; i++) {
        pick -= weights[i]!;
        if (pick <= 0) {
          chosen = pool[i]!;
          break;
        }
      }
      await this.claim(chosen, () => this.redraw(chosen, cursor));
    }
  }

  /** Runs `work` with the doodle marked busy, so no one else picks it meanwhile. */
  private async claim(d: Doodle, work: () => Promise<void>): Promise<void> {
    d.busy = true;
    try {
      await work();
    } finally {
      d.busy = false;
    }
    d.last = this.clock.now;
  }
}
