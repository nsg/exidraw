import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
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
  const notify = useToast();
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);

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

  if (notFound) return <NotFoundPage message="This folder does not exist, or you do not have access to it." />;
  if (error) return <div className="alert alert--error">{error}</div>;
  if (!tree) return <p className="muted">Loading…</p>;

  const role = tree.folder.role;
  const canCreate = roleAtLeast(role, REQUIRED_ROLE.createChild);
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
                <button className="btn btn--primary" onClick={() => setDialog({ type: "newRoom" })}>
                  Create a drawing
                </button>
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
