import type { ReactNode } from "react";

/** 16px line icons for the sketch buttons and menus; they inherit the text colour. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="line-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      {children}
    </svg>
  );
}

export function SearchIcon() {
  return (
    <Icon>
      <circle cx="7" cy="7" r="4.6" />
      <path d="m10.5 10.6 3.6 3.4" />
    </Icon>
  );
}

export function ShareIcon() {
  return (
    <Icon>
      <circle cx="12" cy="3.5" r="2" />
      <circle cx="4" cy="8" r="2" />
      <circle cx="12" cy="12.5" r="2" />
      <path d="m5.8 7 4.4-2.4M5.8 9l4.4 2.4" />
    </Icon>
  );
}

export function NewFolderIcon() {
  return (
    <Icon>
      <path d="M1.8 4.2c0-.8.4-1.3 1.2-1.3h3l1.5 1.6h5.4c.8 0 1.3.5 1.3 1.3v6.6c0 .8-.5 1.3-1.3 1.3H3c-.8 0-1.2-.5-1.2-1.3z" />
      <path d="M8 7v4M6 9h4" />
    </Icon>
  );
}

export function UploadIcon() {
  return (
    <Icon>
      <path d="M8 10.5V2.5M4.8 5.5 8 2.3l3.2 3.2M2.5 10v2.5c0 .7.5 1.2 1.2 1.2h8.6c.7 0 1.2-.5 1.2-1.2V10" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  );
}

export function LinkIcon() {
  return (
    <Icon>
      <path d="M7 9.5a2.8 2.8 0 0 0 4 0l2.3-2.3a2.8 2.8 0 0 0-4-4L8.6 4" />
      <path d="M9 6.5a2.8 2.8 0 0 0-4 0L2.7 8.8a2.8 2.8 0 0 0 4 4l.7-.7" />
    </Icon>
  );
}

export function RenameIcon() {
  return (
    <Icon>
      <path d="m2.5 13.5.8-3.2 7.4-7.4a1.6 1.6 0 0 1 2.3 2.3l-7.4 7.4z" />
      <path d="m9.6 4 2.3 2.3" />
    </Icon>
  );
}

export function MoveIcon() {
  return (
    <Icon>
      <path d="M1.8 4.2c0-.8.4-1.3 1.2-1.3h3l1.5 1.6h5.4c.8 0 1.3.5 1.3 1.3v6.6c0 .8-.5 1.3-1.3 1.3H3c-.8 0-1.2-.5-1.2-1.3z" />
      <path d="M6 9h4.5M8.8 7.2 10.6 9l-1.8 1.8" />
    </Icon>
  );
}

export function DeleteIcon() {
  return (
    <Icon>
      <path d="M2.5 4.2h11M6 4V2.6h4V4M3.8 4.4l.7 9h7l.7-9" />
    </Icon>
  );
}

export function DropIcon() {
  return (
    <Icon>
      <path d="M8 2v8M4.8 7 8 10.2 11.2 7M2.5 10.5v2.3c0 .7.5 1.2 1.2 1.2h8.6c.7 0 1.2-.5 1.2-1.2v-2.3" />
    </Icon>
  );
}

/** Three slightly uneven dots. */
export function DotsIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
      <circle cx="4.5" cy="10.3" r="1.6" fill="currentColor" />
      <circle cx="10" cy="9.6" r="1.6" fill="currentColor" />
      <circle cx="15.5" cy="10.2" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <Icon>
      <path d="M5.5 5.2V3.4c0-.7.5-1.1 1.1-1.1h6c.7 0 1.1.4 1.1 1.1v6.1c0 .7-.4 1.1-1.1 1.1h-1.8" />
      <path d="M3.4 5.4h6c.7 0 1.1.4 1.1 1.1v6.1c0 .7-.4 1.1-1.1 1.1h-6c-.7 0-1.1-.4-1.1-1.1V6.5c0-.7.4-1.1 1.1-1.1z" />
    </Icon>
  );
}

export function HistoryIcon() {
  return (
    <Icon>
      <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" />
      <path d="M2.3 2.6v2.6h2.6M8 5v3.2l2.2 1.4" />
    </Icon>
  );
}

export function BackIcon() {
  return (
    <Icon>
      <path d="M13.5 8.2H3M6.6 4.4 2.8 8.2l3.8 3.7" />
    </Icon>
  );
}
