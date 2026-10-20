/**
 * Image file sync (ARCHITECTURE.md § 9): upload images whose bytes we hold
 * but the room's file store may not, download images we lack. Mirrors
 * upstream's FileManager minus encryption.
 */
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawImageElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, DataURL, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { api, ApiRequestError } from "../api";

const UPLOAD_CONCURRENCY = 2;
const DOWNLOAD_THROTTLE_MS = 500;
const DOWNLOAD_MAX_ATTEMPTS = 5;
const DOWNLOAD_RETRY_BASE_MS = 2_000;
/**
 * A "pending" image this old is fetched anyway: its uploader may have left
 * after the bytes reached the server but before marking the element saved.
 */
const STALE_PENDING_MS = 30_000;

function isImage(e: { type: string }): e is ExcalidrawImageElement {
  return e.type === "image";
}

function dataUrlToBlob(dataURL: string, mimeType: string): Blob {
  const comma = dataURL.indexOf(",");
  const meta = dataURL.slice(0, comma);
  const payload = dataURL.slice(comma + 1);
  if (!meta.endsWith(";base64")) return new Blob([decodeURIComponent(payload)], { type: mimeType });
  const bin = atob(payload);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function blobToDataUrl(blob: Blob): Promise<DataURL> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as DataURL);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export class FileSync {
  /** File ids known to exist in this room's file store (uploaded or downloaded by us). */
  private readonly onServer = new Set<string>();
  private readonly uploading = new Set<string>();
  private readonly failedUploads = new Set<string>();
  private readonly uploadQueue: string[] = [];
  private activeUploads = 0;
  private readonly downloading = new Set<string>();
  private readonly downloadFailures = new Map<string, { attempts: number; retryAt: number }>();
  private downloadTimer: number | null = null;
  private stopped = false;

  constructor(
    private readonly roomId: string,
    private readonly excalidraw: ExcalidrawImperativeAPI,
    private readonly canUpload: () => boolean,
    private readonly onError: (message: string) => void,
  ) {}

  stop(): void {
    this.stopped = true;
    this.uploadQueue.length = 0;
    if (this.downloadTimer !== null) window.clearTimeout(this.downloadTimer);
  }

  /** After a (re)connect: give failed downloads a fresh chance. */
  resetFailures(): void {
    this.downloadFailures.clear();
  }

  /**
   * Called on local changes. Uploads the bytes of every live image we hold
   * locally that the room's store is not known to have: freshly inserted
   * ("pending") images, and also "saved" ones pasted from another room or the
   * library (the store is per room; PUT is idempotent).
   */
  checkUploads(): void {
    if (this.stopped || !this.canUpload()) return;
    const files = this.excalidraw.getFiles();
    for (const e of this.excalidraw.getSceneElementsIncludingDeleted()) {
      if (!isImage(e) || e.isDeleted || !e.fileId || e.status === "error") continue;
      const id = e.fileId;
      if (!files[id] || this.uploading.has(id) || this.failedUploads.has(id)) continue;
      if (this.onServer.has(id)) {
        if (e.status === "pending") this.markStatus(id, "saved", false);
        continue;
      }
      this.uploading.add(id);
      this.uploadQueue.push(id);
    }
    this.pumpUploads();
  }

  private pumpUploads(): void {
    while (!this.stopped && this.activeUploads < UPLOAD_CONCURRENCY && this.uploadQueue.length > 0) {
      const id = this.uploadQueue.shift()!;
      if (!this.canUpload()) {
        this.uploading.delete(id);
        continue;
      }
      this.activeUploads++;
      void this.upload(id).finally(() => {
        this.activeUploads--;
        this.uploading.delete(id);
        this.pumpUploads();
      });
    }
  }

  private async upload(fileId: string): Promise<void> {
    const file: BinaryFileData | undefined = this.excalidraw.getFiles()[fileId];
    if (!file) return;
    try {
      await api.putFile(this.roomId, fileId, dataUrlToBlob(file.dataURL, file.mimeType));
      this.onServer.add(fileId);
      // Pending → saved; saved images (pasted) get a version bump so
      // collaborators who already failed to fetch them try again.
      this.markStatus(fileId, "saved", true);
    } catch (err) {
      if (this.stopped) return;
      this.failedUploads.add(fileId);
      const tooLarge = err instanceof ApiRequestError && err.status === 413;
      this.onError(tooLarge ? "Image is too large to upload." : "Image upload failed.");
      this.markStatus(fileId, "error", false);
    }
  }

  /** Set the status of every live image using `fileId` (version bump → broadcast). */
  private markStatus(fileId: string, status: "saved" | "error", bumpSaved: boolean): void {
    let changed = false;
    const next = this.excalidraw.getSceneElementsIncludingDeleted().map((e) => {
      if (!isImage(e) || e.isDeleted || e.fileId !== fileId) return e;
      if (e.status === "pending" || (bumpSaved && e.status === "saved")) {
        changed = true;
        return newElementWith(e, { status }, true);
      }
      return e;
    });
    if (changed) this.excalidraw.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
  }

  /** Called after remote elements arrive: fetch images we lack (throttled). */
  scheduleDownloads(delay = DOWNLOAD_THROTTLE_MS): void {
    if (this.downloadTimer !== null || this.stopped) return;
    this.downloadTimer = window.setTimeout(() => {
      this.downloadTimer = null;
      this.downloadMissing();
    }, delay);
  }

  private downloadMissing(): void {
    const files = this.excalidraw.getFiles();
    const now = Date.now();
    let nextCheck = Infinity;
    for (const e of this.excalidraw.getSceneElementsIncludingDeleted()) {
      if (!isImage(e) || e.isDeleted || !e.fileId || files[e.fileId] || this.downloading.has(e.fileId)) continue;
      if (e.status === "pending" && now - e.updated <= STALE_PENDING_MS) {
        nextCheck = Math.min(nextCheck, e.updated + STALE_PENDING_MS + 1);
        continue;
      }
      if (e.status !== "saved" && e.status !== "pending") continue;
      const id = e.fileId;
      const failure = this.downloadFailures.get(id);
      if (failure?.attempts === DOWNLOAD_MAX_ATTEMPTS) continue;
      if (failure && failure.retryAt > now) {
        nextCheck = Math.min(nextCheck, failure.retryAt);
        continue;
      }
      this.downloading.add(id);
      void this.download(id).finally(() => this.downloading.delete(id));
    }
    if (nextCheck !== Infinity) this.scheduleDownloads(Math.max(DOWNLOAD_THROTTLE_MS, nextCheck - now));
  }

  private async download(fileId: FileId): Promise<void> {
    try {
      const blob = await api.getFile(this.roomId, fileId);
      const dataURL = await blobToDataUrl(blob);
      if (this.stopped) return;
      this.onServer.add(fileId);
      this.downloadFailures.delete(fileId);
      this.excalidraw.addFiles([{ id: fileId, dataURL, mimeType: blob.type as BinaryFileData["mimeType"], created: Date.now() }]);
    } catch {
      const attempts = (this.downloadFailures.get(fileId)?.attempts ?? 0) + 1;
      const delay = DOWNLOAD_RETRY_BASE_MS * 2 ** (attempts - 1);
      this.downloadFailures.set(fileId, { attempts, retryAt: Date.now() + delay });
      this.scheduleDownloads(delay);
    }
  }
}
