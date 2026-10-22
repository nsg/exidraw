import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX, type MouseEvent, type ReactNode } from "react";
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
import { AccessDialog, AccessSummary, PeopleIcon, accessTitle } from "../components/AccessDialog";
import { MoveDialog, type MoveTarget } from "../components/MoveDialog";
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
import { DrawingSketch, FolderSketch, MarginDoodles, RowRule, SheetOnBoard } from "../folder/Sheet";
import {
  DeleteIcon,
  DotsIcon,
  DropIcon,
  LinkIcon,
  MoveIcon,
  NewFolderIcon,
  PlusIcon,
  RenameIcon,
  SearchIcon,
  ShareIcon,
  UploadIcon,
} from "../folder/icons";
import { PencilOutline, Scribble, StartHint, useElementSize } from "../sketch/Paper";
import { ROLE_LABEL, absoluteUrl, copyText, folderLabel, formatDate, formatRelative } from "../util";

type Row = { kind: "folder"; node: FolderInfo } | { kind: "room"; node: RoomInfo };

type DialogState =
  | { type: "newFolder" }
  | { type: "newRoom" }
  | { type: "rename"; row: Row }
  | { type: "delete"; row: Row }
  | { type: "move"; target: MoveTarget }
  | { type: "share"; target: ShareTarget }
  | { type: "access"; target: ShareTarget; role: Role | null }
  | null;

/** The sheet's entrance (drop, tape, pencil strokes) plays once per page load, not per folder or search. */
let introPlayed = false;
/** How long the entrance stays on once the listing shows; its last strokes end before this. */
const INTRO_MS = 3200;

function rowTarget(row: Row): ShareTarget {
  return {
    kind: row.kind,
    id: row.node.id,
    name: row.node.name,
    ...(row.kind === "room" ? { linkPath: SPA_ROUTES.room(row.node.id) } : {}),
  };
}

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
  const [intro, setIntro] = useState(() => !introPlayed);
  useEffect(() => {
    introPlayed = true;
  }, []);

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

  // Rows and doodles animate from when they mount, so a slow first load must not cut the entrance short.
  const loaded = tree !== null;
  useEffect(() => {
    if (!intro || !loaded) return;
    const timer = window.setTimeout(() => setIntro(false), INTRO_MS);
    return () => window.clearTimeout(timer);
  }, [intro, loaded]);

  // Bumped to re-run the current search, e.g. after sharing changed the access column.
  const [searchRun, setSearchRun] = useState(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    // A response for an older query or run must not overwrite a newer one, or bring results back.
    let current = true;
    const timer = window.setTimeout(() => {
      api.search(q).then(
        (res) => current && setResults(res),
        (err) => current && notify(errorMessage(err), "error"),
      );
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query, searchRun, notify]);

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
  const pageClass = `folder-page${intro ? " folder-page--intro" : ""}`;
  // Same element tree as below, so the sheet stays put while a folder loads.
  if (!tree) {
    return (
      <div className={pageClass}>
        <SheetOnBoard>
          <p className="sheet__loading">Loading…</p>
        </SheetOnBoard>
      </div>
    );
  }

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
  // Only owners get the access lists; without any, the column would just be empty.
  const showAccess = rows.some((row) => row.node.access);
  const folderCount = rows.filter((row) => row.kind === "folder").length;
  const roomCount = rows.length - folderCount;

  const closeDialog = () => setDialog(null);
  const folderTarget: ShareTarget = { kind: "folder", id: tree.folder.id, name: folderLabel(tree.folder) };
  const pickFiles = () => fileInput.current?.click();

  return (
    <div className={pageClass}>
      <SheetOnBoard margin={<MarginDoodles dropHint={canCreate} />}>
        <nav className="sheet__head" aria-label="Breadcrumbs">
          {tree.breadcrumbs.length > 0 && (
            <span className="crumbs">
              {tree.breadcrumbs.map((b) => (
                <span key={b.id}>
                  <Link to={b.id === ROOT_FOLDER_ID ? SPA_ROUTES.root : SPA_ROUTES.folder(b.id)}>{folderLabel(b)}</Link>
                  <span className="sep">/</span>
                </span>
              ))}
            </span>
          )}
          <h1 className="sheet__title">
            <Scribble>{folderLabel(tree.folder)}</Scribble>
          </h1>
          {role && (
            <span className="sheet__meta">
              <RoleMark role={role} />
              <button
                className="access-button"
                aria-label="Who has access"
                title={tree.folder.access ? accessTitle(tree.folder.access) : "Who has access"}
                onClick={() => setDialog({ type: "access", target: folderTarget, role })}
              >
                {tree.folder.access && tree.folder.access.length > 0 ? (
                  <AccessSummary entries={tree.folder.access} />
                ) : (
                  <>
                    <PeopleIcon />
                    {tree.folder.access ? "Not shared" : "Who has access"}
                  </>
                )}
              </button>
            </span>
          )}
        </nav>

        <div className="sheet__tools">
          <label className="sheet__search">
            <SearchIcon />
            <input
              type="search"
              placeholder="Search drawings…"
              aria-label="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <span className="spacer" />
          {canShare && (
            <button className="sketch-btn" onClick={() => setDialog({ type: "share", target: folderTarget })}>
              <ShareIcon />
              Share
            </button>
          )}
          {canCreate && (
            <>
              <button className="sketch-btn" onClick={() => setDialog({ type: "newFolder" })}>
                <NewFolderIcon />
                New folder
              </button>
              <UploadButton uploading={uploading} onClick={pickFiles} />
              <button className="sketch-btn sketch-btn--primary sheet__new" onClick={() => setDialog({ type: "newRoom" })}>
                <PlusIcon />
                New drawing
              </button>
            </>
          )}
        </div>

        {results && (
          <p className="sheet__results">
            {rows.length} result{rows.length === 1 ? "" : "s"} for “{query.trim()}”
          </p>
        )}

        {rows.length === 0 ? (
          <div className="sheet__empty">
            {results ? (
              <p className="sheet__empty-title">Nothing matches your search.</p>
            ) : (
              <>
                <p className="sheet__empty-title">This folder is empty.</p>
                {canCreate && (
                  <>
                    <div className="sheet__empty-actions">
                      <span className="sheet__cta">
                        <StartHint label="start here!" />
                        <button className="sketch-btn sketch-btn--primary" onClick={() => setDialog({ type: "newRoom" })}>
                          <PlusIcon />
                          Create a drawing
                        </button>
                      </span>
                      <UploadButton uploading={uploading} onClick={pickFiles} />
                    </div>
                    <p className="hint">You can also drop .excalidraw files here.</p>
                  </>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            <table className="listing">
              <thead>
                <tr>
                  <th>
                    Name
                    <RowRule id="listing-head" double />
                  </th>
                  <th className="listing__role">Your access</th>
                  <th className="listing__updated">Updated</th>
                  {showAccess && <th className="listing__access">Who has access</th>}
                  <th className="listing__actions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <NodeRow
                    key={`${row.kind}:${row.node.id}`}
                    row={row}
                    index={i}
                    inFolder={!results}
                    showAccess={showAccess}
                    onAccess={() => setDialog({ type: "access", target: rowTarget(row), role: row.node.role })}
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
                          return setDialog({ type: "share", target: rowTarget(row) });
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
            <footer className="sheet__foot">
              <span>
                {plural(folderCount, "folder")}, {plural(roomCount, "drawing")}
              </span>
              {canCreate && (
                <span className="sheet__drop-hint">
                  <DropIcon />
                  drop .excalidraw files anywhere on this sheet
                </span>
              )}
            </footer>
          </>
        )}
      </SheetOnBoard>

      {canCreate && (
        <button className="sketch-btn sketch-btn--primary fab" onClick={() => setDialog({ type: "newRoom" })}>
          <PlusIcon />
          New drawing
        </button>
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
          <div className="drop-hint__note">
            <span className="drop-hint__big" aria-hidden>
              drop it here!
            </span>
            <p>Drop Excalidraw files to upload them to “{folderLabel(tree.folder)}”</p>
          </div>
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
      {dialog?.type === "share" && (
        <ShareDialog
          target={dialog.target}
          onClose={closeDialog}
          onSaved={() => {
            void load();
            setSearchRun((n) => n + 1);
          }}
        />
      )}
      {dialog?.type === "access" && (
        <AccessDialog
          target={dialog.target}
          role={dialog.role}
          onManage={() => setDialog({ type: "share", target: dialog.target })}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}

function UploadButton({ uploading, onClick }: { uploading: boolean; onClick: () => void }) {
  return (
    <button
      className="sketch-btn"
      disabled={uploading}
      title="Upload .excalidraw files, or PNG/SVG exports with the scene embedded"
      onClick={onClick}
    >
      <UploadIcon />
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
type MenuAction = { action: RowAction; label: string; danger?: boolean };

const ACTION_ICONS: Record<RowAction, () => JSX.Element> = {
  copy: LinkIcon,
  rename: RenameIcon,
  move: MoveIcon,
  share: ShareIcon,
  delete: DeleteIcon,
};

/** Rows after this many enter together, so a long list doesn't keep trickling in. */
const MAX_STAGGER = 12;

function NodeRow({
  row,
  index,
  inFolder,
  showAccess,
  onAccess,
  onAction,
}: {
  row: Row;
  index: number;
  /** listed inside its folder (not search results), so inherited access is the folder's */
  inFolder: boolean;
  /** the listing has a "who has access" column */
  showAccess: boolean;
  onAccess: () => void;
  onAction: (a: RowAction) => void;
}) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const role: Role | null = row.node.role;
  const href = row.kind === "folder" ? SPA_ROUTES.folder(row.node.id) : SPA_ROUTES.room(row.node.id);
  const actions: MenuAction[] = [
    ...(row.kind === "room" ? [{ action: "copy" as const, label: "Copy link" }] : []),
    ...(roleAtLeast(role, REQUIRED_ROLE.renameNode) ? [{ action: "rename" as const, label: "Rename" }] : []),
    ...(roleAtLeast(role, REQUIRED_ROLE.moveNode) ? [{ action: "move" as const, label: "Move…" }] : []),
    ...(roleAtLeast(role, REQUIRED_ROLE.writeGrants) ? [{ action: "share" as const, label: "Share…" }] : []),
    ...(roleAtLeast(role, REQUIRED_ROLE.deleteNode) ? [{ action: "delete" as const, label: "Delete", danger: true }] : []),
  ];
  // The whole row opens the item; the name stays the real link for keyboards and new tabs.
  const openRow = (e: MouseEvent<HTMLTableRowElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((e.target as Element).closest("a, button, input, .menu")) return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    navigate(href);
  };
  return (
    <tr
      data-testid={`node-${row.kind}`}
      className={`listing__row listing__row--${row.kind}${menuOpen ? " is-hot" : ""}`}
      style={{ "--i": Math.min(index, MAX_STAGGER) } as CSSProperties}
      onClick={openRow}
    >
      <td className="listing__name">
        <span className="listing__swipe" aria-hidden />
        <svg className="listing__pointer" viewBox="0 0 42 24" aria-hidden>
          <path pathLength={1} d="M2 15c9-6 20-7 33-3" />
          <path pathLength={1} d="M28 5l9 7-9 6" />
        </svg>
        <RowRule id={row.node.id} />
        <span className="listing__name-in">
          {row.kind === "folder" ? <FolderSketch id={row.node.id} /> : <DrawingSketch id={row.node.id} />}
          <Link to={href}>{row.node.name}</Link>
        </span>
      </td>
      <td className="listing__role">{role ? <RoleMark role={role} /> : <span className="muted">—</span>}</td>
      <td className="listing__updated" title={formatDate(row.node.updatedAt)}>
        {formatRelative(row.node.updatedAt)}
      </td>
      {showAccess && (
        <td className="listing__access">
          {row.node.access ? (
            <button
              className="access-button"
              aria-label={`Who has access to ${row.node.name}`}
              title={accessTitle(row.node.access)}
              onClick={onAccess}
            >
              <AccessSummary entries={row.node.access} sameAsFolder={inFolder} />
            </button>
          ) : (
            <span className="listing__hidden" title="Only owners can see who has access">
              —
            </span>
          )}
        </td>
      )}
      <td className="listing__actions">
        {actions.length > 0 && (
          <RowMenu label={row.node.name} actions={actions} open={menuOpen} onOpenChange={setMenuOpen} onAction={onAction} />
        )}
      </td>
    </tr>
  );
}

function RowMenu({
  label,
  actions,
  open,
  onOpenChange,
  onAction,
}: {
  label: string;
  actions: MenuAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (a: RowAction) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: globalThis.MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onOpenChange(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open, onOpenChange]);
  return (
    <div className="menu" ref={ref}>
      <button className="dots" aria-label={`Actions for ${label}`} aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <DotsIcon />
      </button>
      {open && (
        <MenuPaper>
          <ul className="pop__list" role="menu">
            {actions.map((a) => {
              const Icon = ACTION_ICONS[a.action];
              return (
                <li key={a.action} className={a.danger ? "pop__danger" : undefined}>
                  <button
                    role="menuitem"
                    className={a.danger ? "danger" : ""}
                    onClick={() => {
                      onOpenChange(false);
                      onAction(a.action);
                    }}
                  >
                    <Icon />
                    {a.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </MenuPaper>
      )}
    </div>
  );
}

/** A taped scrap of paper for the ⋯ menu, outlined in pencil. */
function MenuPaper({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  return (
    <div className="pop" ref={ref}>
      <div className="pop__tape" aria-hidden />
      {size && <PencilOutline size={size} className="pop__border" roughness={[0.6, 0.8]} />}
      {children}
    </div>
  );
}

/** Your role, as a highlighter swipe. */
function RoleMark({ role }: { role: Role }) {
  return <span className={`marker marker--${role}`}>{ROLE_LABEL[role]}</span>;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
