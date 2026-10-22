import { isElementEnvelope } from "@exidraw/shared";
import type { ImportRoomBody, SceneElement, Subject } from "@exidraw/shared";
import type { FileStore } from "./files.js";
import type { Tree } from "./tree.js";
import { HttpError } from "./errors.js";

export function importRoom(
  tree: Tree,
  files: FileStore,
  subject: Subject,
  body: ImportRoomBody,
  onCleanupError: (error: unknown) => void = () => {},
) {
  tree.require(subject, "folder", body.folderId, "createChild");
  for (const [index, element] of body.elements.entries())
    if (!isElementEnvelope(element))
      throw new HttpError("invalid", `Invalid element envelope at index ${index}`);

  const elements = body.elements as SceneElement[],
    seen = new Set<string>(),
    duplicates = new Set<string>();
  for (const element of elements) {
    if (seen.has(element.id)) duplicates.add(element.id);
    seen.add(element.id);
  }
  if (duplicates.size)
    throw new HttpError(
      "invalid",
      `Duplicate element ids: ${JSON.stringify([...duplicates].slice(0, 10))}`,
    );

  const kept = elements.filter((element) => !element.isDeleted),
    referenced = new Set<unknown>(),
    accepted = new Map<string, ReturnType<FileStore["decodeDataURL"]>>();
  for (const element of kept)
    if (element.type === "image") referenced.add(element.fileId);
  for (const [fileId, file] of Object.entries(body.files))
    if (referenced.has(fileId)) {
      const dataURL = (file as { dataURL?: unknown } | null)?.dataURL;
      if (typeof dataURL !== "string")
        throw new HttpError("invalid", `File ${fileId} has no dataURL`);
      accepted.set(fileId, files.decodeDataURL(fileId, dataURL));
    }

  const initial = kept.map((element) =>
    element.type === "image" &&
    typeof element.fileId === "string" &&
    accepted.has(element.fileId) &&
    element.status !== "saved"
      ? { ...element, status: "saved" as const }
      : element,
  );
  const room = tree.createRoomWithElements(
    subject, body.folderId, body.name, initial,
  );
  try {
    for (const [fileId, file] of accepted)
      files.put(room.id, fileId, file.mimeType, file.bytes, subject.userId);
  } catch (error) {
    // A full disk can fail the cleanup too; report the original error anyway.
    try {
      tree.store.transaction(() => {
        // Scenes, files and snapshots cascade; polymorphic grants do not.
        tree.store.run(
          "DELETE FROM grants WHERE node_kind='room' AND node_id=?", room.id,
        );
        tree.store.run("DELETE FROM rooms WHERE id=?", room.id);
      });
    } catch (cleanupError) {
      onCleanupError(cleanupError);
    }
    throw error;
  }
  return room;
}
