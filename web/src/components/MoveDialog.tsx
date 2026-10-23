import { useEffect, useState } from "react";
import { ROOT_FOLDER_ID, roleAtLeast, type NodeKind, type TreeResponse } from "@exidraw/shared";
import { api, errorMessage } from "../api";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";
import { folderLabel } from "../util";
import { FolderSketch } from "../folder/Sheet";
import { PencilLoader } from "../sketch/Paper";

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
          <button type="button" className="sketch-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="sketch-btn sketch-btn--primary" disabled={!canDrop || busy} onClick={() => void move()}>
            Move here
          </button>
        </>
      }
    >
      {error && <div className="alert alert--error">{error}</div>}
      {!tree && !error && <PencilLoader className="pencil-loader--small" />}
      {tree && (
        <div className="picker">
          <PickerBreadcrumbs tree={tree} onOpen={setFolderId} />
          <ul className="picker__list">
            {tree.folders
              .filter((f) => !(target.kind === "folder" && f.id === target.id))
              .map((f) => (
                <li key={f.id}>
                  <button type="button" className="picker__item" onClick={() => setFolderId(f.id)}>
                    <FolderSketch id={f.id} />
                    <span className="picker__name">{f.name}</span>
                  </button>
                </li>
              ))}
            {tree.folders.length === 0 && <li className="picker__none">No sub-folders</li>}
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

/** Path of the folder being browsed in a picker; ancestors are clickable. */
export function PickerBreadcrumbs({ tree, onOpen }: { tree: TreeResponse; onOpen: (folderId: string) => void }) {
  return (
    <div className="crumbs picker__crumbs">
      {[...tree.breadcrumbs, tree.folder].map((b, i, all) => (
        <span key={b.id}>
          {i < all.length - 1 ? (
            <button type="button" className="crumbs__link" onClick={() => onOpen(b.id)}>
              {folderLabel(b)}
            </button>
          ) : (
            <strong>{folderLabel(b)}</strong>
          )}
          {i < all.length - 1 && <span className="sep">/</span>}
        </span>
      ))}
    </div>
  );
}
