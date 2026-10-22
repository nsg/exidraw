import { useEffect, useRef, useState } from "react";
import { SPA_ROUTES, type RoomInfo, type SearchResponse, type TreeResponse } from "@exidraw/shared";
import { api, errorMessage } from "../api";
import { Modal } from "../components/Modal";
import { absoluteUrl } from "../util";
import { FolderIcon, PickerBreadcrumbs, RoomIcon } from "../components/MoveDialog";
import {
  DRAWING_FILE_ACCEPT,
  ImportError,
  drawingNameFromFile,
  parseDrawingFile,
  parseExportedDrawing,
  type DrawingData,
} from "../importing";

interface InsertDialogProps {
  room: RoomInfo;
  /** Adds the drawing to the scene; may throw (e.g. element limit), which keeps the dialog open. */
  onInsert: (data: DrawingData, name: string) => void;
  onClose: () => void;
}

/** "Insert drawing…": copy a drawing from a file or from another room into this one. */
export function InsertDialog({ room, onInsert, onClose }: InsertDialogProps) {
  const [source, setSource] = useState<"file" | "drawing">("file");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Latest load; bumped on unmount, so a load finishing after Cancel/Escape
  // (or one superseded by another pick) is dropped and never closes a dialog
  // opened since.
  const loadSeq = useRef(0);
  useEffect(
    () => () => {
      loadSeq.current++;
    },
    [],
  );

  const insert = async (name: string, load: () => Promise<DrawingData>) => {
    const seq = ++loadSeq.current;
    setBusy(`Loading “${name}”…`);
    setError(null);
    try {
      const data = await load();
      if (seq !== loadSeq.current) return;
      onInsert(data, name);
      onClose();
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err instanceof ImportError ? err.message : errorMessage(err));
      setBusy(null);
    }
  };

  return (
    <Modal
      title="Insert drawing"
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <div className="insert">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" className="tabs__tab" aria-selected={source === "file"} onClick={() => setSource("file")}>
            From a file
          </button>
          <button
            type="button"
            role="tab"
            className="tabs__tab"
            aria-selected={source === "drawing"}
            onClick={() => setSource("drawing")}
          >
            From another drawing
          </button>
        </div>
        {error && <div className="alert alert--error">{error}</div>}
        {source === "file" ? (
          <div className="insert__file">
            <p className="muted">An .excalidraw file, or a PNG or SVG exported from Excalidraw with the scene embedded.</p>
            <input
              ref={fileInput}
              type="file"
              accept={DRAWING_FILE_ACCEPT}
              aria-label="Drawing file"
              hidden
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (file) void insert(drawingNameFromFile(file.name), () => parseDrawingFile(file));
              }}
            />
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => fileInput.current?.click()}>
              Choose file…
            </button>
          </div>
        ) : (
          <DrawingPicker
            startFolderId={room.folderId}
            currentRoomId={room.id}
            disabled={!!busy}
            onPick={(r) =>
              void insert(r.name, async () => ({
                ...(await parseExportedDrawing(await api.exportJson(r.id), r.name)),
                sourceUrl: absoluteUrl(SPA_ROUTES.room(r.id)),
              }))
            }
          />
        )}
        {busy && <p className="muted">{busy}</p>}
      </div>
    </Modal>
  );
}

/** Any drawing the user can view: search, or browse folders like the move picker. */
function DrawingPicker({
  startFolderId,
  currentRoomId,
  disabled,
  onPick,
}: {
  startFolderId: string;
  currentRoomId: string;
  disabled: boolean;
  onPick: (room: RoomInfo) => void;
}) {
  const [folderId, setFolderId] = useState(startFolderId);
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setTree(null);
    api.tree(folderId).then(
      (t) => current && setTree(t),
      (err) => current && setError(errorMessage(err)),
    );
    return () => {
      current = false;
    };
  }, [folderId]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      api.search(q).then(
        (r) => current && setResults(r),
        (err) => current && setError(errorMessage(err)),
      );
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const listing = results ?? tree;
  return (
    <div className="picker">
      <input
        className="search"
        type="search"
        placeholder="Search drawings…"
        aria-label="Search drawings"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!results && tree && <PickerBreadcrumbs tree={tree} onOpen={setFolderId} />}
      {error && <div className="alert alert--error">{error}</div>}
      <ul className="picker__list">
        {!listing && <li className="muted">Loading…</li>}
        {listing?.folders.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              className="picker__item"
              onClick={() => {
                setQuery("");
                setFolderId(f.id);
              }}
            >
              <FolderIcon /> {f.name}
            </button>
          </li>
        ))}
        {listing?.rooms.map((r) => (
          <li key={r.id}>
            <button type="button" className="picker__item" disabled={disabled} onClick={() => onPick(r)}>
              <RoomIcon /> {r.name}
              {r.id === currentRoomId && <span className="muted">(this drawing)</span>}
            </button>
          </li>
        ))}
        {listing && listing.folders.length + listing.rooms.length === 0 && (
          <li className="muted">{results ? "Nothing matches your search." : "This folder is empty."}</li>
        )}
      </ul>
    </div>
  );
}
