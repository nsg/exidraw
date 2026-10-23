import type { ReactNode } from "react";
import { Doodle, type DoodleKind } from "../sketch/doodles";
import { PencilLoader, SheetOnBoard, Squiggle } from "../sketch/Paper";

/** A small note taped to the board: not found, no access, could not connect. */
export function StatusPage({ title, doodle, children }: { title: string; doodle: DoodleKind; children: ReactNode }) {
  return (
    <div className="board-page status-page">
      <SheetOnBoard width="note">
        <Doodle kind={doodle} />
        <h1 className="status-page__title">{title}</h1>
        <Squiggle className="status-page__squiggle" />
        {children}
      </SheetOnBoard>
    </div>
  );
}

/** Full-page loading state: handwriting on the empty board. */
export function Splash({ label }: { label?: string }) {
  return (
    <div className="board-page splash">
      <div className="board" aria-hidden />
      <PencilLoader label={label} />
    </div>
  );
}
