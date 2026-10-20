import { useEffect, useState } from "react";
import { ROOT_FOLDER_ID, roleAtLeast, type NodeKind, type TreeResponse } from "@exidraw/shared";
import { api, errorMessage } from "../api";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";
import { folderLabel } from "../util";

export interface MoveTarget {
  kind: NodeKind;
  id: string;
  name: string;
  /** current parent folder */
  parentId: string;
}

/** Simple folder picker: browse the tree, move into any folder you can edit. */
export function MoveDialog({ target, onClose, onMoved }: { target: MoveTarget; onClose: () => void; onMoved: () => void }) {
  const notify = useToast();
  const [folderId, setFolderId] = useState(target.parentId);
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTree(null);
    api.tree(folderId).then(setTree, (err) => setError(errorMessage(err)));
  }, [folderId]);

  const canDrop = !!tree && roleAtLeast(tree.folder.role, "editor") && tree.folder.id !== target.parentId;

  const move = async () => {
    if (!tree) return;
    setBusy(true);
    try {
      if (target.kind === "folder") await api.updateFolder(target.id, { parentId: tree.folder.id });
      else await api.updateRoom(target.id, { folderId: tree.folder.id });
      notify(`Moved to ${folderLabel(tree.folder)}`, "success");
      onMoved();
      onClose();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Move “${target.name}”`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!canDrop || busy} onClick={() => void move()}>
            Move here
          </button>
        </>
      }
    >
      {error && <div className="alert alert--error">{error}</div>}
      {tree && (
        <div className="picker">
          <div className="breadcrumbs">
            {[...tree.breadcrumbs, tree.folder].map((b, i, all) => (
              <span key={b.id}>
                {i < all.length - 1 ? (
                  <button type="button" className="link" onClick={() => setFolderId(b.id)}>
                    {folderLabel(b)}
                  </button>
                ) : (
                  <strong>{folderLabel(b)}</strong>
                )}
                {i < all.length - 1 && <span className="sep">/</span>}
              </span>
            ))}
          </div>
          <ul className="picker__list">
            {tree.folders
              .filter((f) => !(target.kind === "folder" && f.id === target.id))
              .map((f) => (
                <li key={f.id}>
                  <button type="button" className="picker__item" onClick={() => setFolderId(f.id)}>
                    <FolderIcon /> {f.name}
                  </button>
                </li>
              ))}
            {tree.folders.length === 0 && <li className="muted">No sub-folders</li>}
          </ul>
          {!roleAtLeast(tree.folder.role, "editor") && (
            <p className="hint">You cannot add items to this folder.</p>
          )}
          {tree.folder.id === target.parentId && tree.folder.id !== ROOT_FOLDER_ID && (
            <p className="hint">This is the current location.</p>
          )}
        </div>
      )}
    </Modal>
  );
}

export function FolderIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden>
      <path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v7.7a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z" fill="currentColor" opacity=".85" />
    </svg>
  );
}

export function RoomIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden>
      <rect x="3" y="3" width="14" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="m6.5 13 4.5-4.5 2 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
