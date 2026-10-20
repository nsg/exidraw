import { ROOT_FOLDER_ID, type Role } from "@exidraw/shared";

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatDate(ms: number): string {
  return dtf.format(ms);
}

/** "5 minutes ago", falling back to an absolute date after a week. */
export function formatRelative(ms: number, now = Date.now()): string {
  const diff = (ms - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(diff / 86400), "day");
  return dtf.format(ms);
}

export const ROLE_LABEL: Record<Role, string> = { viewer: "Viewer", editor: "Editor", owner: "Owner" };

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** Absolute URL of an in-app path. */
export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

/** Only same-site absolute paths are valid post-login destinations. */
export function safeReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}

/** Display name of a folder; the root is "All drawings" whatever the server calls it. */
export function folderLabel(folder: { id: string; name: string }): string {
  return folder.id === ROOT_FOLDER_ID ? "All drawings" : folder.name;
}
