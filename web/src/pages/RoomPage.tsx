import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI, LibraryItems, UIOptions } from "@excalidraw/excalidraw/types";
import {
  REQUIRED_ROLE,
  ROOT_FOLDER_ID,
  SPA_ROUTES,
  roleAtLeast,
  type Role,
  type RoomInfo,
  type SceneElement,
} from "@exidraw/shared";
import { api, ApiRequestError, errorMessage } from "../api";
import { CollabClient, type ConnectionStatus, type FatalReason } from "../collab/CollabClient";
import { ShareDialog } from "../components/ShareDialog";
import { useToast } from "../components/Toasts";
import { Brand, UserMenu } from "../components/Layout";
import { HistoryDrawer } from "../room/HistoryDrawer";
import { InsertDialog } from "../room/InsertDialog";
import { insertIntoScene, interceptDrawingDrops } from "../room/insertScene";
import { ImportError, skippedNote, type DrawingData } from "../importing";
import { NotFoundPage } from "./NotFoundPage";
import { useSession } from "../session";
import { absoluteUrl, copyText } from "../util";

const THEME_KEY = "exidraw.theme";
/** The personal shape library lives in this browser only (it is not part of any room). */
const LIBRARY_KEY = "exidraw.library";

function loadLibrary(): LibraryItems {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as LibraryItems) : [];
  } catch {
    return [];
  }
}

/** Read-only view of the live room for the e2e suite (no secrets; same data the UI shows). */
declare global {
  interface Window {
    __exidraw?: {
      elements: () => readonly SceneElement[];
      fileIds: () => string[];
      role: () => Role;
      status: () => ConnectionStatus;
    };
  }
}

const UI_OPTIONS: Partial<UIOptions> = {
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    // Background colour is per-viewer app state, not part of the shared scene.
    changeViewBackgroundColor: false,
    export: { saveFileToDisk: true },
  },
};

export function RoomPage() {
  const { roomId = "" } = useParams();
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [error, setError] = useState<{ notFound: boolean; message: string } | null>(null);

  useEffect(() => {
    let current = true; // ignore a slow response for a room we already navigated away from
    setRoom(null);
    setError(null);
    api.room(roomId).then(
      (r) => current && setRoom(r),
      (err) =>
        current && setError({ notFound: err instanceof ApiRequestError && err.status === 404, message: errorMessage(err) }),
    );
    return () => {
      current = false;
    };
  }, [roomId]);

  if (error) {
    return error.notFound ? (
      <NotFoundPage message="This drawing does not exist, or you do not have access to it." />
    ) : (
      <div className="splash">{error.message}</div>
    );
  }
  if (!room) return <div className="splash">Loading…</div>;
  return <RoomEditor key={room.id} initialRoom={room} />;
}

const FATAL_TEXT: Record<FatalReason, string> = {
  unauthenticated: "Your session has expired.",
  forbidden: "You no longer have access to this drawing.",
  not_found: "This drawing does not exist, or you do not have access to it.",
  deleted: "This drawing was deleted.",
};

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Live",
  reconnecting: "Reconnecting…",
};

function RoomEditor({ initialRoom }: { initialRoom: RoomInfo }) {
  const notify = useToast();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [room, setRoom] = useState(initialRoom);
  const [role, setRole] = useState<Role>(initialRoom.role);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [synced, setSynced] = useState(false);
  const [fatal, setFatal] = useState<FatalReason | null>(null);
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [panel, setPanel] = useState<"share" | "history" | null>(null);
  const [inserting, setInserting] = useState(false);
  const clientRef = useRef<CollabClient | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const roleRef = useRef(role);
  roleRef.current = role;

  useEffect(() => {
    document.title = `${room.name} · exidraw`;
  }, [room.name]);

  useEffect(() => {
    if (!excalidraw) return;
    const client = new CollabClient(initialRoom.id, excalidraw, initialRoom.role, {
      onStatus: setStatus,
      onRole: setRole,
      onRoom: setRoom,
      onPresence: () => {},
      onSynced: () => {
        setSynced(true);
        fitToContent(excalidraw);
      },
      onFatal: (reason) => {
        if (reason === "unauthenticated") {
          // Re-check the session: it turns anonymous and the router sends us to
          // the login page with this room as returnTo.
          void refresh();
        } else {
          setFatal(reason);
        }
      },
      onWarning: (m) => notify(m, "error"),
    });
    clientRef.current = client;
    client.start();
    window.__exidraw = {
      elements: () => excalidraw.getSceneElements() as readonly SceneElement[],
      fileIds: () => Object.keys(excalidraw.getFiles()),
      role: () => roleRef.current,
      status: () => statusRef.current,
    };
    return () => {
      client.stop();
      clientRef.current = null;
      delete window.__exidraw;
    };
  }, [excalidraw, initialRoom.id, initialRoom.role, refresh, notify]);

  /** Throws `ImportError` (element limit); callers show the message. */
  const insertDrawing = useCallback(
    (data: DrawingData, name: string, at?: { x: number; y: number }) => {
      if (!excalidraw) return;
      // The role may have changed while the drawing was loading.
      if (!roleAtLeast(roleRef.current, REQUIRED_ROLE.writeScene)) {
        throw new ImportError("invalid", "You can no longer edit this drawing.");
      }
      insertIntoScene(excalidraw, data, at);
      // onChange broadcasts too; flushing here does not depend on it.
      clientRef.current?.onLocalChange();
      const note = skippedNote(data);
      notify(`Inserted “${name}”${note ? ` (${note})` : ""}`, "success");
    },
    [excalidraw, notify],
  );

  useEffect(() => {
    if (!excalidraw || !canvasRef.current) return;
    return interceptDrawingDrops(excalidraw, canvasRef.current, {
      canEdit: () => roleAtLeast(roleRef.current, REQUIRED_ROLE.writeScene),
      onDrawing: (data, name, at) => {
        try {
          insertDrawing(data, name, at);
        } catch (err) {
          notify(errorMessage(err), "error");
        }
      },
      onLibrary: (fileName) => notify(`Added “${fileName}” to your library`, "success"),
      onError: (m) => notify(m, "error"),
    });
  }, [excalidraw, insertDrawing, notify]);

  useEffect(() => blockExternalImagePaste(() => notify("Images from web pages cannot be pasted; save the image and drop it in.", "error")), [notify]);

  const initialData = useMemo(() => {
    const theme = localStorage.getItem(THEME_KEY);
    return {
      appState: { theme: theme === "dark" ? ("dark" as const) : ("light" as const) },
      libraryItems: loadLibrary(),
    };
  }, []);

  const lastTheme = useRef(initialData.appState.theme);
  const onChange = useCallback(
    (_elements: unknown, appState: AppState) => {
      clientRef.current?.onLocalChange();
      if (appState.theme !== lastTheme.current) {
        lastTheme.current = appState.theme;
        localStorage.setItem(THEME_KEY, appState.theme);
      }
      // Clicking an avatar starts Excalidraw's "follow" mode, which needs viewport
      // relaying we do not implement; keep the jump-to-cursor and drop the follow.
      if (appState.userToFollow && excalidraw) {
        excalidraw.updateScene({ appState: { userToFollow: null } });
      }
    },
    [excalidraw],
  );

  const onPointerUpdate = useCallback(
    (p: { pointer: { x: number; y: number; tool: "pointer" | "laser" }; button: "up" | "down" }) =>
      clientRef.current?.onPointerUpdate(p),
    [],
  );

  const canEdit = roleAtLeast(role, REQUIRED_ROLE.writeScene);
  const canShare = roleAtLeast(role, REQUIRED_ROLE.writeGrants);
  const folderHref = room.folderId === ROOT_FOLDER_ID ? SPA_ROUTES.root : SPA_ROUTES.folder(room.folderId);

  const copyLink = async () => {
    if (await copyText(absoluteUrl(SPA_ROUTES.room(room.id)))) notify("Link copied", "success");
  };

  if (fatal) {
    return (
      <div className="splash">
        <p>{FATAL_TEXT[fatal]}</p>
        <Link className="btn" to={SPA_ROUTES.root}>
          Back to drawings
        </Link>
      </div>
    );
  }

  return (
    <div className="room">
      <header className="room__header">
        <Link to={SPA_ROUTES.root} className="room__brand" aria-label="All drawings">
          <Brand />
        </Link>
        <Link to={folderHref} className="room__back" title="Back to folder">
          ←
        </Link>
        <RoomName room={room} canRename={canEdit} onRenamed={setRoom} />
        {!canEdit && (
          <span className="badge" data-testid="view-only">
            View only
          </span>
        )}
        <span className={`status status--${status}`} data-testid="connection-status" title={STATUS_TEXT[status]}>
          <span className="status__dot" />
          {STATUS_TEXT[status]}
        </span>
        <span className="spacer" />
        <button className="btn btn--ghost" onClick={() => setPanel(panel === "history" ? null : "history")}>
          History
        </button>
        {canShare ? (
          <button className="btn btn--primary" onClick={() => setPanel("share")}>
            Share
          </button>
        ) : (
          <button className="btn" onClick={() => void copyLink()}>
            Copy link
          </button>
        )}
        <UserMenu />
      </header>
      <div className="room__canvas" ref={canvasRef}>
        <Excalidraw
          excalidrawAPI={setExcalidraw}
          initialData={initialData}
          isCollaborating
          viewModeEnabled={!canEdit}
          aiEnabled={false}
          name={room.name}
          UIOptions={UI_OPTIONS}
          onChange={onChange}
          onPointerUpdate={onPointerUpdate}
          onLibraryChange={(items) => localStorage.setItem(LIBRARY_KEY, JSON.stringify(items))}
          handleKeyboardGlobally
          autoFocus
          validateEmbeddable={false}
        >
          <MainMenu>
            <MainMenu.Item onSelect={() => navigate(folderHref)}>Back to folder</MainMenu.Item>
            <MainMenu.Item onSelect={() => void copyLink()}>Copy link</MainMenu.Item>
            <MainMenu.Item onSelect={() => setPanel("history")}>Version history</MainMenu.Item>
            {canEdit && <MainMenu.Item onSelect={() => setInserting(true)}>Insert drawing…</MainMenu.Item>}
            <MainMenu.Separator />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.Help />
            {canEdit && <MainMenu.DefaultItems.ClearCanvas />}
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ToggleTheme />
          </MainMenu>
        </Excalidraw>
        {!synced && <div className="room__overlay">Loading drawing…</div>}
        {panel === "history" && excalidraw && (
          <HistoryDrawer roomId={room.id} canRestore={canEdit} excalidraw={excalidraw} onClose={() => setPanel(null)} />
        )}
      </div>
      {inserting && canEdit && (
        <InsertDialog room={room} onInsert={insertDrawing} onClose={() => setInserting(false)} />
      )}
      {panel === "share" && (
        <ShareDialog
          target={{ kind: "room", id: room.id, name: room.name, linkPath: SPA_ROUTES.room(room.id) }}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}

/**
 * First load only: bring existing content into view. Without this a drawing
 * that starts at (0,0) opens with its top-left shapes under the toolbar and
 * menu button. The offsets keep content clear of the top toolbar and the
 * bottom zoom/undo bar; zoom never exceeds 100 % so small drawings stay crisp.
 */
function fitToContent(excalidraw: ExcalidrawImperativeAPI): void {
  const elements = excalidraw.getSceneElements();
  if (elements.length === 0) return;
  excalidraw.scrollToContent(elements, {
    fitToViewport: true,
    viewportZoomFactor: 0.9,
    animate: false,
    maxZoom: 1,
    canvasOffsets: { top: 72, bottom: 64, left: 16, right: 16 },
  });
}

function RoomName({ room, canRename, onRenamed }: { room: RoomInfo; canRename: boolean; onRenamed: (r: RoomInfo) => void }) {
  const notify = useToast();
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <h1 className="room__name">
        {canRename ? (
          <button className="room__name-btn" title="Rename" onClick={() => setEditing(true)}>
            {room.name}
          </button>
        ) : (
          room.name
        )}
      </h1>
    );
  }
  const finish = async (value: string) => {
    setEditing(false);
    const name = value.trim();
    if (!name || name === room.name) return;
    try {
      onRenamed(await api.updateRoom(room.id, { name }));
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  };
  return (
    <input
      className="room__name-input"
      aria-label="Drawing name"
      defaultValue={room.name}
      autoFocus
      maxLength={120}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => void finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

/**
 * Excalidraw turns pasted HTML <img src="https://…"> into images by fetching
 * the URL itself, before the `onPaste` prop is consulted. That would make the
 * browser call third-party origins, so such pastes are intercepted (capture
 * phase, ahead of Excalidraw's document listener) and re-dispatched as plain
 * text only. Pasted image files are unaffected.
 */
function blockExternalImagePaste(onBlocked: () => void): () => void {
  const handler = (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!data || !event.isTrusted || data.files.length > 0) return;
    const html = data.getData("text/html");
    if (!html || !/<img\b/i.test(html)) return;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const external = [...doc.images].some((img) => {
      const src = img.getAttribute("src") ?? "";
      if (src.startsWith("data:")) return false;
      try {
        return new URL(src, window.location.href).origin !== window.location.origin;
      } catch {
        return true;
      }
    });
    if (!external) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const text = data.getData("text/plain");
    if (text) {
      const plain = new DataTransfer();
      plain.setData("text/plain", text);
      event.target?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: plain, bubbles: true, cancelable: true }));
    } else {
      onBlocked();
    }
  };
  window.addEventListener("paste", handler, { capture: true });
  return () => window.removeEventListener("paste", handler, { capture: true });
}
