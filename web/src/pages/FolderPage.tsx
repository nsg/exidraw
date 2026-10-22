import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  MAX_ELEMENTS_PER_ROOM,
  REQUIRED_ROLE,
  ROOT_FOLDER_ID,
  SPA_ROUTES,
  roleAtLeast,
  type FolderInfo,
  type Role,
  type RoomInfo,
  type SearchResponse,
  type TreeResponse,
} from "@exidraw/shared";
import { api, ApiRequestError, errorMessage } from "../api";
import { ConfirmDialog, PromptDialog } from "../components/Modal";
import { ShareDialog, type ShareTarget } from "../components/ShareDialog";
import { FolderIcon, MoveDialog, RoomIcon, type MoveTarget } from "../components/MoveDialog";
import { useToast } from "../components/Toasts";
import {
  DRAWING_FILE_ACCEPT,
  ImportError,
  drawingNameFromFile,
  parseDrawingFile,
  skippedNote,
  uploadElements,
} from "../importing";
import { NotFoundPage } from "./NotFoundPage";
import { ROLE_LABEL, absoluteUrl, copyText, folderLabel, formatDate, formatRelative } from "../util";

type Row = { kind: "folder"; node: FolderInfo } | { kind: "room"; node: RoomInfo };

type DialogState =
  | { type: "newFolder" }
  | { type: "newRoom" }
  | { type: "rename"; row: Row }
  | { type: "delete"; row: Row }
  | { type: "move"; target: MoveTarget }
  | { type: "share"; target: ShareTarget }
  | null;

export function FolderPage() {
  const { folderId = ROOT_FOLDER_ID } = useParams();
  const navigate = useNavigate();
  // Where the user is now; an upload that finishes after they moved on must not pull them back.
  const location = useLocation();
  const here = useRef(location.key);
  here.current = location.key;
  useEffect(
    () => () => {
      here.current = "";
    },
    [],
  );
  const notify = useToast();
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const uploadingRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Latest folder requested; a slower response for a folder we left is dropped.
  const wantedFolder = useRef(folderId);
  wantedFolder.current = folderId;
  const load = useCallback(async () => {
    try {
      const res = await api.tree(folderId);
      if (wantedFolder.current !== folderId) return;
      setTree(res);
      setNotFound(false);
      setError(null);
    } catch (err) {
      if (wantedFolder.current !== folderId) return;
      if (err instanceof ApiRequestError && err.status === 404) setNotFound(true);
      else setError(errorMessage(err));
    }
  }, [folderId]);

  useEffect(() => {
    setTree(null);
    setNotFound(false);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    document.title = tree ? `${folderLabel(tree.folder)} · exidraw` : "exidraw";
  }, [tree]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const timer = window.setTimeout(() => {
      api.search(q).then(setResults, (err) => notify(errorMessage(err), "error"));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, notify]);

  const role = tree?.folder.role ?? null;
  const canCreate = roleAtLeast(role, REQUIRED_ROLE.createChild);

  /** One new drawing per file; a single file opens it, several stay here with a summary. */
  const upload = async (files: File[]) => {
    if (!tree || files.length === 0 || uploadingRef.current) return;
    uploadingRef.current = true;
    setUploading(true);
    const startedAt = here.current;
    const created: RoomInfo[] = [];
    try {
      for (const file of files) {
        try {
          const { room, skippedWebPages } = await uploadDrawing(tree.folder.id, file);
          created.push(room);
          const note = skippedNote({ skippedWebPages });
          if (note) notify(`“${file.name}”: ${note}`);
        } catch (err) {
          notify(uploadErrorMessage(file.name, err), "error");
        }
      }
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
    const moved = here.current !== startedAt;
    if (files.length === 1 && created.length === 1) {
      if (moved) notify(`Uploaded “${created[0]!.name}”`, "success");
      else navigate(SPA_ROUTES.room(created[0]!.id));
    } else if (created.length > 0) {
      notify(`Uploaded ${created.length} drawing${created.length === 1 ? "" : "s"}`, "success");
      if (!moved) await load();
    }
  };
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  // Files dragged anywhere over the page upload into this folder.
  const acceptDrops = canCreate && dialog === null;
  useEffect(() => {
    if (!acceptDrops) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void uploadRef.current([...e.dataTransfer!.files]);
    };
    const listeners = { dragenter: enter, dragleave: leave, dragover: over, drop } as const;
    for (const [type, fn] of Object.entries(listeners)) window.addEventListener(type, fn as EventListener);
    return () => {
      for (const [type, fn] of Object.entries(listeners)) window.removeEventListener(type, fn as EventListener);
      setDragging(false);
    };
  }, [acceptDrops]);

  if (notFound) return <NotFoundPage message="This folder does not exist, or you do not have access to it." />;
  if (error) return <div className="alert alert--error">{error}</div>;
  if (!tree) return <p className="muted">Loading…</p>;

  const canShare = roleAtLeast(role, REQUIRED_ROLE.writeGrants);

  const rows: Row[] = results
    ? [
        ...results.folders.map((f) => ({ kind: "folder" as const, node: f })),
        ...results.rooms.map((r) => ({ kind: "room" as const, node: r })),
      ]
    : [
        ...tree.folders.map((f) => ({ kind: "folder" as const, node: f })),
        ...tree.rooms.map((r) => ({ kind: "room" as const, node: r })),
      ];

  const closeDialog = () => setDialog(null);

  return (
    <div className="folder-page">
      <div className="page-header">
        <nav className="breadcrumbs" aria-label="Breadcrumbs">
          {tree.breadcrumbs.map((b) => (
            <span key={b.id}>
              <Link to={b.id === ROOT_FOLDER_ID ? SPA_ROUTES.root : SPA_ROUTES.folder(b.id)}>{folderLabel(b)}</Link>
              <span className="sep">/</span>
            </span>
          ))}
          <h1>{folderLabel(tree.folder)}</h1>
          {role && <span className={`badge badge--${role}`}>{ROLE_LABEL[role]}</span>}
        </nav>
        <div className="page-header__actions">
          <input
            className="search"
            type="search"
            placeholder="Search drawings…"
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {canShare && (
            <button
              className="btn"
              onClick={() =>
                setDialog({ type: "share", target: { kind: "folder", id: tree.folder.id, name: folderLabel(tree.folder) } })
              }
            >
              Share
            </button>
          )}
          {canCreate && (
            <>
              <button className="btn" onClick={() => setDialog({ type: "newFolder" })}>
                New folder
              </button>
              <UploadButton uploading={uploading} onClick={() => fileInput.current?.click()} />
              <button className="btn btn--primary" onClick={() => setDialog({ type: "newRoom" })}>
                New drawing
              </button>
            </>
          )}
        </div>
      </div>

      {results && (
        <p className="muted">
          {rows.length} result{rows.length === 1 ? "" : "s"} for “{query.trim()}”
        </p>
      )}

      {rows.length === 0 ? (
        <div className="empty">
          {results ? (
            <p>Nothing matches your search.</p>
          ) : (
            <>
              <p>This folder is empty.</p>
              {canCreate && (
                <>
                  <div className="empty__actions">
                    <button className="btn btn--primary" onClick={() => setDialog({ type: "newRoom" })}>
                      Create a drawing
                    </button>
                    <UploadButton uploading={uploading} onClick={() => fileInput.current?.click()} />
                  </div>
                  <p className="hint">You can also drop .excalidraw files here.</p>
                </>
              )}
            </>
          )}
        </div>
      ) : (
        <table className="nodes">
          <thead>
            <tr>
              <th>Name</th>
              <th>Your access</th>
              <th>Updated</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <NodeRow
                key={`${row.kind}:${row.node.id}`}
                row={row}
                onAction={(action) => {
                  const name = row.node.name;
                  const parentId = row.kind === "folder" ? (row.node.parentId ?? ROOT_FOLDER_ID) : row.node.folderId;
                  switch (action) {
                    case "rename":
                      return setDialog({ type: "rename", row });
                    case "delete":
                      return setDialog({ type: "delete", row });
                    case "move":
                      return setDialog({ type: "move", target: { kind: row.kind, id: row.node.id, name, parentId } });
                    case "share":
                      return setDialog({
                        type: "share",
                        target: {
                          kind: row.kind,
                          id: row.node.id,
                          name,
                          ...(row.kind === "room" ? { linkPath: SPA_ROUTES.room(row.node.id) } : {}),
                        },
                      });
                    case "copy":
                      return void copyText(absoluteUrl(SPA_ROUTES.room(row.node.id))).then(
                        (ok) => ok && notify("Link copied", "success"),
                      );
                  }
                }}
              />
            ))}
          </tbody>
        </table>
      )}

      {canCreate && (
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={DRAWING_FILE_ACCEPT}
          aria-label="Upload drawings"
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = "";
            void upload(files);
          }}
        />
      )}
      {dragging && (
        <div className="drop-hint" data-testid="drop-hint">
          <p>Drop Excalidraw files to upload them to “{folderLabel(tree.folder)}”</p>
        </div>
      )}

      {dialog?.type === "newFolder" && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          submitLabel="Create"
          onClose={closeDialog}
          onSubmit={async (name) => {
            try {
              await api.createFolder({ parentId: tree.folder.id, name });
              closeDialog();
              await load();
            } catch (err) {
              notify(errorMessage(err), "error");
            }
          }}
        />
      )}
      {dialog?.type === "newRoom" && (
        <PromptDialog
          title="New drawing"
          label="Drawing name"
          submitLabel="Create"
          onClose={closeDialog}
          onSubmit={async (name) => {
            try {
              const room = await api.createRoom({ folderId: tree.folder.id, name });
              navigate(SPA_ROUTES.room(room.id));
            } catch (err) {
              notify(errorMessage(err), "error");
            }
          }}
        />
      )}
      {dialog?.type === "rename" && (
        <PromptDialog
          title={`Rename ${dialog.row.kind === "folder" ? "folder" : "drawing"}`}
          label="Name"
          initial={dialog.row.node.name}
          submitLabel="Rename"
          onClose={closeDialog}
          onSubmit={async (name) => {
            try {
              if (dialog.row.kind === "folder") await api.updateFolder(dialog.row.node.id, { name });
              else await api.updateRoom(dialog.row.node.id, { name });
              closeDialog();
              await load();
            } catch (err) {
              notify(errorMessage(err), "error");
            }
          }}
        />
      )}
      {dialog?.type === "delete" && (
        <ConfirmDialog
          title={`Delete ${dialog.row.kind === "folder" ? "folder" : "drawing"}`}
          message={
            dialog.row.kind === "folder"
              ? `Delete the folder “${dialog.row.node.name}”? Only empty folders can be deleted.`
              : `Delete “${dialog.row.node.name}”? Anyone currently editing it will be disconnected.`
          }
          confirmLabel="Delete"
          danger
          onClose={closeDialog}
          onConfirm={async () => {
            try {
              if (dialog.row.kind === "folder") await api.deleteFolder(dialog.row.node.id);
              else await api.deleteRoom(dialog.row.node.id);
              closeDialog();
              await load();
            } catch (err) {
              const msg =
                err instanceof ApiRequestError && err.code === "conflict" ? "The folder is not empty." : errorMessage(err);
              notify(msg, "error");
            }
          }}
        />
      )}
      {dialog?.type === "move" && <MoveDialog target={dialog.target} onClose={closeDialog} onMoved={() => void load()} />}
      {dialog?.type === "share" && <ShareDialog target={dialog.target} onClose={closeDialog} />}
    </div>
  );
}

function UploadButton({ uploading, onClick }: { uploading: boolean; onClick: () => void }) {
  return (
    <button className="btn" disabled={uploading} title="Upload .excalidraw files, or PNG/SVG exports with the scene embedded" onClick={onClick}>
      {uploading ? "Uploading…" : "Upload"}
    </button>
  );
}

async function uploadDrawing(folderId: string, file: File): Promise<{ room: RoomInfo; skippedWebPages: number }> {
  const { elements, files, skippedWebPages } = await parseDrawingFile(file);
  if (elements.length > MAX_ELEMENTS_PER_ROOM) {
    throw new ImportError("invalid", `“${file.name}” has more than ${MAX_ELEMENTS_PER_ROOM.toLocaleString()} elements.`);
  }
  const room = await api.importRoom({
    folderId,
    name: drawingNameFromFile(file.name),
    elements: uploadElements(elements, file.name),
    files: Object.fromEntries(Object.values(files).map((f) => [f.id, { mimeType: f.mimeType, dataURL: f.dataURL }])),
  });
  return { room, skippedWebPages };
}

function uploadErrorMessage(fileName: string, err: unknown): string {
  if (err instanceof ImportError) return err.message;
  if (err instanceof ApiRequestError && err.status === 413) {
    return `“${fileName}” is too large: an image in it is over the size limit, or the file exceeds the upload limit.`;
  }
  return `Could not upload “${fileName}”: ${errorMessage(err)}`;
}

type RowAction = "rename" | "delete" | "move" | "share" | "copy";

function NodeRow({ row, onAction }: { row: Row; onAction: (a: RowAction) => void }) {
  const role: Role | null = row.node.role;
  const href = row.kind === "folder" ? SPA_ROUTES.folder(row.node.id) : SPA_ROUTES.room(row.node.id);
  const actions: Array<{ action: RowAction; label: string; danger?: boolean }> = [
    ...(row.kind === "room" ? [{ action: "copy" as const, label: "Copy link" }] : []),
    ...(roleAtLeast(role, REQUIRED_ROLE.renameNode) ? [{ action: "rename" as const, label: "Rename" }] : []),
    ...(roleAtLeast(role, REQUIRED_ROLE.moveNode) ? [{ action: "move" as const, label: "Move…" }] : []),
    ...(roleAtLeast(role, REQUIRED_ROLE.writeGrants) ? [{ action: "share" as const, label: "Share…" }] : []),
    ...(roleAtLeast(role, REQUIRED_ROLE.deleteNode) ? [{ action: "delete" as const, label: "Delete", danger: true }] : []),
  ];
  return (
    <tr data-testid={`node-${row.kind}`}>
      <td>
        <Link to={href} className="node-link">
          {row.kind === "folder" ? <FolderIcon /> : <RoomIcon />}
          <span>{row.node.name}</span>
        </Link>
      </td>
      <td>{role ? <span className={`badge badge--${role}`}>{ROLE_LABEL[role]}</span> : <span className="muted">—</span>}</td>
      <td title={formatDate(row.node.updatedAt)}>{formatRelative(row.node.updatedAt)}</td>
      <td className="nodes__actions">
        {actions.length > 0 && <RowMenu label={row.node.name} actions={actions} onAction={onAction} />}
      </td>
    </tr>
  );
}

function RowMenu({
  label,
  actions,
  onAction,
}: {
  label: string;
  actions: Array<{ action: RowAction; label: string; danger?: boolean }>;
  onAction: (a: RowAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="icon-btn" aria-label={`Actions for ${label}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <ul className="menu__list" role="menu">
          {actions.map((a) => (
            <li key={a.action}>
              <button
                role="menuitem"
                className={a.danger ? "danger" : ""}
                onClick={() => {
                  setOpen(false);
                  onAction(a.action);
                }}
              >
                {a.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
