import { useCallback, useEffect, useRef, useState } from "react";
import { exportToSvg } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { SnapshotInfo, SnapshotReason } from "@exidraw/shared";
import { api, errorMessage } from "../api";
import { ConfirmDialog } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { formatDate, formatRelative } from "../util";

const REASON_LABEL: Record<SnapshotReason, string> = {
  auto: "Autosave",
  manual: "Saved version",
  agent: "Before agent edit",
  restore: "Before restore",
};

interface Props {
  roomId: string;
  canRestore: boolean;
  excalidraw: ExcalidrawImperativeAPI;
  onClose: () => void;
}

/** Version history: list snapshots, preview one, restore it, or save the current state. */
export function HistoryDrawer({ roomId, canRestore, excalidraw, onClose }: Props) {
  const notify = useToast();
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null);
  const [selected, setSelected] = useState<SnapshotInfo | null>(null);
  const [confirming, setConfirming] = useState<SnapshotInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSnapshots((await api.snapshots(roomId)).snapshots);
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }, [roomId, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveNow = async () => {
    setBusy(true);
    try {
      await api.createSnapshot(roomId);
      notify("Version saved", "success");
      await load();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (s: SnapshotInfo) => {
    try {
      await api.restoreSnapshot(roomId, s.id);
      notify(`Restored version from ${formatDate(s.createdAt)}`, "success");
      setConfirming(null);
      setSelected(null);
      await load();
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  };

  return (
    <aside className="drawer" aria-label="Version history">
      <div className="drawer__header">
        <h2>Version history</h2>
        <button className="icon-btn" aria-label="Close history" onClick={onClose}>
          ×
        </button>
      </div>
      {canRestore && (
        <button className="btn btn--block" disabled={busy} onClick={() => void saveNow()}>
          Save current version
        </button>
      )}
      {selected && <SnapshotPreview roomId={roomId} snapshot={selected} excalidraw={excalidraw} />}
      {!snapshots && <p className="muted">Loading…</p>}
      {snapshots?.length === 0 && <p className="muted">No versions yet. Versions are saved automatically every few minutes while people edit.</p>}
      <ul className="drawer__list">
        {snapshots?.map((s) => (
          <li key={s.id} className={selected?.id === s.id ? "selected" : ""}>
            <button className="drawer__item" onClick={() => setSelected(selected?.id === s.id ? null : s)}>
              <span className="drawer__when" title={formatDate(s.createdAt)}>
                {formatRelative(s.createdAt)}
              </span>
              <span className="muted">
                {REASON_LABEL[s.reason]}
                {s.createdBy ? ` · ${s.createdBy.name}` : ""} · {s.elementCount} element{s.elementCount === 1 ? "" : "s"}
              </span>
            </button>
            {canRestore && selected?.id === s.id && (
              <button className="btn btn--primary" onClick={() => setConfirming(s)}>
                Restore this version
              </button>
            )}
          </li>
        ))}
      </ul>
      {confirming && (
        <ConfirmDialog
          title="Restore version"
          message={`Replace the drawing with the version from ${formatDate(confirming.createdAt)}? The current state is saved as a version first, so this can be undone.`}
          confirmLabel="Restore"
          onClose={() => setConfirming(null)}
          onConfirm={() => restore(confirming)}
        />
      )}
    </aside>
  );
}

function SnapshotPreview({ roomId, snapshot, excalidraw }: { roomId: string; snapshot: SnapshotInfo; excalidraw: ExcalidrawImperativeAPI }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      const { elements } = await api.snapshot(roomId, snapshot.id);
      const live = elements.filter((e) => !e.isDeleted);
      const svg = await exportToSvg({
        elements: live,
        files: excalidraw.getFiles(),
        appState: { exportBackground: true, viewBackgroundColor: "#ffffff", theme: "light" },
        exportPadding: 16,
      });
      if (cancelled || !ref.current) return;
      svg.setAttribute("width", "100%");
      svg.removeAttribute("height");
      ref.current.replaceChildren(svg);
    })().catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [roomId, snapshot.id, excalidraw]);

  return (
    <div className="drawer__preview">
      {error ? <p className="muted">{error}</p> : <div ref={ref} className="drawer__svg" />}
    </div>
  );
}
