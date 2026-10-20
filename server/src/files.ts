import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { join } from "node:path";
import type { SceneElement, SceneFiles, FileInfo } from "@exidraw/shared";
import type { Store } from "./db.js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import { id } from "./tree.js";
const MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
  "image/bmp",
  "image/x-icon",
]);
export class FileStore {
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {}
  validate(fileId: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(fileId))
      throw new HttpError("invalid", "Invalid fileId");
  }
  private path(roomId: string, fileId: string) {
    this.validate(fileId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId))
      throw new HttpError("invalid", "Invalid roomId");
    return join(this.config.dataDir, "files", roomId, fileId);
  }
  info(roomId: string, fileId: string): FileInfo | undefined {
    this.validate(fileId);
    const r = this.store.get<any>(
      "SELECT * FROM files WHERE room_id=? AND file_id=?",
      roomId,
      fileId,
    );
    return r
      ? {
          fileId: r.file_id,
          mimeType: r.mime_type,
          sizeBytes: r.size_bytes,
          createdAt: r.created_at,
        }
      : undefined;
  }
  put(
    roomId: string,
    fileId: string,
    mimeType: string,
    bytes: Buffer,
    userId: string,
  ): {
    info: FileInfo;
    created: boolean;
  } {
    this.validate(fileId);
    const old = this.info(roomId, fileId);
    if (old) return { info: old, created: false };
    if (!MIMES.has(mimeType))
      throw new HttpError("invalid", "Unsupported image mime type");
    if (bytes.length > this.config.maxFileBytes)
      throw new HttpError("too_large", "File exceeds MAX_FILE_BYTES");
    const path = this.path(roomId, fileId);
    mkdirSync(join(this.config.dataDir, "files", roomId), { recursive: true });
    const temp = `${path}.${id()}.tmp`;
    try {
      writeFileSync(temp, bytes, { flag: "wx" });
      const file = openSync(temp, "r");
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temp, path);
      const directory = openSync(join(this.config.dataDir, "files", roomId), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      this.store.run(
        "INSERT INTO files(room_id,file_id,mime_type,size_bytes,created_at,created_by) VALUES(?,?,?,?,?,?)",
        roomId,
        fileId,
        mimeType,
        bytes.length,
        Date.now(),
        userId,
      );
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
    return { info: this.info(roomId, fileId)!, created: true };
  }
  get(roomId: string, fileId: string) {
    const info = this.info(roomId, fileId);
    if (!info) throw new HttpError("not_found", "file");
    return { info, bytes: readFileSync(this.path(roomId, fileId)) };
  }
  sceneFiles(roomId: string, elements: SceneElement[]): SceneFiles {
    const result: SceneFiles = {};
    for (const e of elements) {
      if (e.isDeleted || e.type !== "image" || !e.fileId || result[e.fileId])
        continue;
      // Failed/pending uploads remain valid scene elements. Excalidraw exports
      // them as placeholders until their binary has arrived.
      if (!this.info(roomId, e.fileId)) continue;
      const file = this.get(roomId, e.fileId);
      result[e.fileId] = {
        id: e.fileId,
        dataURL:
          `data:${file.info.mimeType};base64,${file.bytes.toString("base64")}` as any,
        mimeType: file.info.mimeType as any,
        created: file.info.createdAt,
      };
    }
    return result;
  }
}
