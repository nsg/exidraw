import { randomBytes } from "node:crypto";
import {
  computeEffectiveRole,
  summarizeAccess,
  roleAtLeast,
  REQUIRED_ROLE,
  MAX_FOLDER_DEPTH,
  computeSceneVersion,
} from "@exidraw/shared";
import type {
  AccessEntry,
  Subject,
  NodeKind,
  Grant,
  Role,
  FolderInfo,
  RoomInfo,
  TreeResponse,
  SearchResponse,
  GrantsResponse,
  GrantInput,
  SceneElement,
} from "@exidraw/shared";
import type { Store } from "./db.js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
export const id = (bytes = 16) => randomBytes(bytes).toString("base64url");
type Row = Record<string, any>;
export class Tree {
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {}
  row(kind: NodeKind, nodeId: string): Row {
    const r = this.store.get<Row>(
      `SELECT * FROM ${kind === "folder" ? "folders" : "rooms"} WHERE id=?${kind === "room" ? " AND deleted_at IS NULL" : ""}`,
      nodeId,
    );
    if (!r) throw new HttpError("not_found", `${kind} ${nodeId}`);
    return r;
  }
  ancestors(kind: NodeKind, nodeId: string): Row[] {
    const row = this.row(kind, nodeId);
    let parent = kind === "room" ? row.folder_id : row.parent_id;
    const result: Row[] = [];
    const seen = new Set<string>();
    while (parent) {
      if (seen.has(parent)) throw new HttpError("internal", "Folder cycle");
      seen.add(parent);
      const p = this.row("folder", parent);
      result.push(p);
      parent = p.parent_id;
    }
    return result;
  }
  grants(kind: NodeKind, nodeId: string): Grant[] {
    return this.store
      .all<Row>(
        // A linked grant shows the user's current e-mail, which may differ from the one granted.
        "SELECT g.*,u.name AS display_name,u.email AS user_email FROM grants g LEFT JOIN users u ON u.id=g.principal_user_id WHERE node_kind=? AND node_id=? ORDER BY g.id",
        kind,
        nodeId,
      )
      .map((g) => ({
        id: g.id,
        node: { kind, id: nodeId },
        principal:
          g.principal_kind === "all"
            ? { kind: "all" }
            : {
                kind: "user",
                email: g.user_email ?? g.principal_email,
                userId: g.principal_user_id,
                displayName: g.display_name ?? null,
              },
        role: g.role,
        createdAt: g.created_at,
        createdBy: g.created_by,
      }));
  }
  role(subject: Subject, kind: NodeKind, nodeId: string): Role | null {
    return computeEffectiveRole(subject, [
      ...this.grants(kind, this.row(kind, nodeId).id),
      ...this.ancestors(kind, nodeId).flatMap((p) =>
        this.grants("folder", p.id),
      ),
    ]);
  }
  require(
    subject: Subject,
    kind: NodeKind,
    nodeId: string,
    operation: keyof typeof REQUIRED_ROLE,
  ): Role {
    const role = this.role(subject, kind, nodeId);
    if (!roleAtLeast(role, REQUIRED_ROLE.viewNode))
      throw new HttpError("not_found", `${kind} ${nodeId}`);
    if (!roleAtLeast(role, REQUIRED_ROLE[operation]))
      throw new HttpError(
        "forbidden",
        `need ${REQUIRED_ROLE[operation]} on ${kind} ${nodeId} (you have ${role})`,
      );
    return role!;
  }
  folder(subject: Subject, r: Row): FolderInfo {
    return {
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      role: this.role(subject, "folder", r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  room(subject: Subject, nodeId: string): RoomInfo {
    const role = this.require(subject, "room", nodeId, "viewNode"),
      r = this.row("room", nodeId);
    return {
      id: r.id,
      folderId: r.folder_id,
      name: r.name,
      role,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      url: `${this.config.publicUrl}/r/${r.id}`,
    };
  }
  // A listing uses one consistent in-memory tree, discarded after the request.
  private listing(subject: Subject) {
    const folders = this.store.all<Row>(
      "SELECT * FROM folders ORDER BY name,id",
    );
    const rooms = this.store.all<Row>(
      "SELECT * FROM rooms WHERE deleted_at IS NULL ORDER BY name,id",
    );
    const grants = this.store.all<Row>("SELECT * FROM grants");
    const users = new Map(
      this.store.all<Row>("SELECT id,email,name FROM users").map((u) => [u.id, u]),
    );
    const folderById = new Map(folders.map((f) => [f.id, f]));
    const direct = new Map<string, Pick<Grant, "principal" | "role">[]>();
    for (const g of grants) {
      const key = `${g.node_kind}:${g.node_id}`;
      const matching = direct.get(key) ?? [];
      matching.push({
        principal:
          g.principal_kind === "all"
            ? { kind: "all" }
            : {
                kind: "user",
                email: users.get(g.principal_user_id)?.email ?? g.principal_email,
                userId: g.principal_user_id,
                displayName: users.get(g.principal_user_id)?.name ?? null,
              },
        role: g.role,
      });
      direct.set(key, matching);
    }
    const chains = new Map<string, Pick<Grant, "principal" | "role">[]>();
    const chain = (folderId: string): Pick<Grant, "principal" | "role">[] => {
      const cached = chains.get(folderId);
      if (cached) return cached;
      const folder = folderById.get(folderId);
      if (!folder) throw new HttpError("internal", "Broken folder parent");
      const result = [
        ...(direct.get(`folder:${folderId}`) ?? []),
        ...(folder.parent_id ? chain(folder.parent_id) : []),
      ];
      chains.set(folderId, result);
      return result;
    };
    const folderRoles = new Map(
      folders.map((f) => [f.id, computeEffectiveRole(subject, chain(f.id))]),
    );
    const roomRoles = new Map(
      rooms.map((r) => [
        r.id,
        computeEffectiveRole(subject, [
          ...(direct.get(`room:${r.id}`) ?? []),
          ...chain(r.folder_id),
        ]),
      ]),
    );
    const visible = new Set<string>();
    const mark = (folderId: string) => {
      let folder = folderById.get(folderId);
      while (folder && !visible.has(folder.id)) {
        visible.add(folder.id);
        folder = folderById.get(folder.parent_id);
      }
    };
    for (const f of folders)
      if (roleAtLeast(folderRoles.get(f.id), REQUIRED_ROLE.viewNode))
        mark(f.id);
    for (const r of rooms)
      if (roleAtLeast(roomRoles.get(r.id), REQUIRED_ROLE.viewNode))
        mark(r.folder_id);
    // A folder's summary as its children inherit it: "set here" becomes "from this folder".
    // Memoised per folder, so every row costs its own grants plus one merge.
    const inheritedBy = new Map<string, AccessEntry[]>();
    const inheritedFrom = (folderId: string | null): AccessEntry[] => {
      if (!folderId) return [];
      const cached = inheritedBy.get(folderId);
      if (cached) return cached;
      const folder = folderById.get(folderId);
      if (!folder) throw new HttpError("internal", "Broken folder parent");
      const from = { kind: "folder" as const, id: folder.id, name: folder.name };
      const result = summarizeAccess(
        [{ from, grants: direct.get(`folder:${folderId}`) ?? [] }],
        inheritedFrom(folder.parent_id),
      );
      inheritedBy.set(folderId, result);
      return result;
    };
    // Only for nodes whose grants the caller may read anyway.
    const access = (
      role: Role | null | undefined,
      kind: NodeKind,
      nodeId: string,
      parentId: string | null,
    ): { access?: AccessEntry[] } => {
      if (!roleAtLeast(role, REQUIRED_ROLE.readGrants)) return {};
      return {
        access: summarizeAccess(
          [{ from: null, grants: direct.get(`${kind}:${nodeId}`) ?? [] }],
          inheritedFrom(parentId),
        ),
      };
    };
    const folderInfo = (f: Row): FolderInfo => ({
      id: f.id,
      parentId: f.parent_id,
      name: f.name,
      role: folderRoles.get(f.id) ?? null,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
      ...access(folderRoles.get(f.id), "folder", f.id, f.parent_id),
    });
    const roomInfo = (r: Row): RoomInfo => ({
      id: r.id,
      folderId: r.folder_id,
      name: r.name,
      role: roomRoles.get(r.id)!,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      url: `${this.config.publicUrl}/r/${r.id}`,
      ...access(roomRoles.get(r.id), "room", r.id, r.folder_id),
    });
    return {
      folders,
      rooms,
      folderById,
      roomRoles,
      visible,
      folderInfo,
      roomInfo,
    };
  }
  list(subject: Subject, folderId = "root"): TreeResponse {
    const graph = this.listing(subject),
      folder = graph.folderById.get(folderId);
    if (!folder || !graph.visible.has(folderId))
      throw new HttpError("not_found", `folder ${folderId}`);
    const breadcrumbs: Array<{
      id: string;
      name: string;
    }> = [];
    let parent = graph.folderById.get(folder.parent_id);
    while (parent) {
      breadcrumbs.unshift({ id: parent.id, name: parent.name });
      parent = graph.folderById.get(parent.parent_id);
    }
    return {
      folder: graph.folderInfo(folder),
      breadcrumbs,
      folders: graph.folders
        .filter((f) => f.parent_id === folderId && graph.visible.has(f.id))
        .map(graph.folderInfo),
      rooms: graph.rooms
        .filter(
          (r) =>
            r.folder_id === folderId &&
            roleAtLeast(graph.roomRoles.get(r.id), REQUIRED_ROLE.viewNode),
        )
        .map(graph.roomInfo),
    };
  }
  search(
    subject: Subject,
    q: string,
    inContent = false,
    scene?: (roomId: string) => SceneElement[],
  ): SearchResponse {
    const query = q.toLowerCase(),
      graph = this.listing(subject);
    const folders = graph.folders
      .filter(
        (f) => f.name.toLowerCase().includes(query) && graph.visible.has(f.id),
      )
      .map(graph.folderInfo);
    const rooms: SearchResponse["rooms"] = [];
    for (const r of graph.rooms) {
      if (!roleAtLeast(graph.roomRoles.get(r.id), REQUIRED_ROLE.viewNode))
        continue;
      let snippet: string | undefined;
      if (inContent) {
        const es = scene
          ? scene(r.id)
          : JSON.parse(
              this.store.get<Row>(
                "SELECT elements FROM scenes WHERE room_id=?",
                r.id,
              )?.elements ?? "[]",
            );
        const match = es.find(
          (e: any) =>
            !e.isDeleted &&
            typeof e.text === "string" &&
            e.text.toLowerCase().includes(query),
        );
        if (match)
          snippet = match.text.slice(
            Math.max(0, match.text.toLowerCase().indexOf(query) - 60),
            match.text.toLowerCase().indexOf(query) + 180,
          );
      }
      if (r.name.toLowerCase().includes(query) || snippet !== undefined)
        rooms.push({
          ...graph.roomInfo(r),
          ...(snippet !== undefined ? { snippet } : {}),
        });
    }
    return { folders, rooms };
  }
  createFolder(subject: Subject, parentId: string, name: string): FolderInfo {
    this.require(subject, "folder", parentId, "createChild");
    if (this.ancestors("folder", parentId).length + 1 > MAX_FOLDER_DEPTH)
      throw new HttpError("invalid", "Maximum folder depth exceeded");
    const nodeId = id(),
      now = Date.now();
    this.store.run(
      "INSERT INTO folders(id,parent_id,name,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?)",
      nodeId,
      parentId,
      name,
      now,
      now,
      subject.userId,
    );
    return this.folder(subject, this.row("folder", nodeId));
  }
  createRoom(subject: Subject, folderId: string, name: string): RoomInfo {
    return this.createRoomWithElements(subject, folderId, name, []);
  }
  createRoomWithElements(
    subject: Subject,
    folderId: string,
    name: string,
    elements: SceneElement[],
  ): RoomInfo {
    this.require(subject, "folder", folderId, "createChild");
    const nodeId = id(9),
      now = Date.now(),
      sceneVersion = computeSceneVersion(elements),
      json = JSON.stringify(elements);
    this.store.transaction(() => {
      this.store.run(
        "INSERT INTO rooms(id,folder_id,name,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?)",
        nodeId,
        folderId,
        name,
        now,
        now,
        subject.userId,
      );
      this.store.run(
        "INSERT INTO scenes(room_id,elements,scene_version,updated_at) VALUES(?,?,?,?)",
        nodeId,
        json,
        sceneVersion,
        now,
      );
    });
    return this.room(subject, nodeId);
  }
  update(
    subject: Subject,
    kind: NodeKind,
    nodeId: string,
    body: {
      name?: string;
      parentId?: string;
      folderId?: string;
    },
  ) {
    this.require(subject, kind, nodeId, "viewNode");
    const dest = kind === "folder" ? body.parentId : body.folderId;
    if (body.name !== undefined)
      this.require(subject, kind, nodeId, "renameNode");
    if (dest !== undefined) {
      this.require(subject, kind, nodeId, "moveNode");
      this.require(subject, "folder", dest, "createChild");
      if (kind === "folder") {
        if (nodeId === "root")
          throw new HttpError("invalid", "Cannot move root");
        const chain = [
          dest,
          ...this.ancestors("folder", dest).map((f) => f.id),
        ];
        if (chain.includes(nodeId))
          throw new HttpError("invalid", "Folder cycle");
        const subtreeDepth = (folderId: string): number =>
          Math.max(
            0,
            ...this.store
              .all<Row>("SELECT id FROM folders WHERE parent_id=?", folderId)
              .map((f) => 1 + subtreeDepth(f.id)),
          );
        if (chain.length + subtreeDepth(nodeId) > MAX_FOLDER_DEPTH)
          throw new HttpError("invalid", "Maximum folder depth exceeded");
      }
    }
    const r = this.row(kind, nodeId);
    this.store.run(
      `UPDATE ${kind === "folder" ? "folders" : "rooms"} SET name=?, ${kind === "folder" ? "parent_id" : "folder_id"}=?, updated_at=? WHERE id=?`,
      body.name ?? r.name,
      dest ?? (kind === "folder" ? r.parent_id : r.folder_id),
      Date.now(),
      nodeId,
    );
    if (kind === "folder") return this.folder(subject, this.row(kind, nodeId));
    return this.room(subject, nodeId);
  }
  delete(subject: Subject, kind: NodeKind, nodeId: string): void {
    this.require(subject, kind, nodeId, "deleteNode");
    if (kind === "folder") {
      if (nodeId === "root")
        throw new HttpError("conflict", "Cannot delete root");
      if (
        this.store.get("SELECT id FROM folders WHERE parent_id=?", nodeId) ||
        this.store.get(
          "SELECT id FROM rooms WHERE folder_id=? AND deleted_at IS NULL",
          nodeId,
        )
      )
        throw new HttpError("conflict", "Folder is not empty");
      this.store.transaction(() => {
        this.store.run(
          "UPDATE rooms SET folder_id=? WHERE folder_id=? AND deleted_at IS NOT NULL",
          "root",
          nodeId,
        );
        this.store.run(
          "DELETE FROM grants WHERE node_kind='folder' AND node_id=?",
          nodeId,
        );
        this.store.run("DELETE FROM folders WHERE id=?", nodeId);
      });
    } else
      this.store.run(
        "UPDATE rooms SET deleted_at=?,updated_at=? WHERE id=?",
        Date.now(),
        Date.now(),
        nodeId,
      );
  }
  readGrants(subject: Subject, kind: NodeKind, nodeId: string): GrantsResponse {
    const effective = this.require(subject, kind, nodeId, "readGrants");
    return {
      node: { kind, id: nodeId, name: this.row(kind, nodeId).name },
      grants: this.grants(kind, nodeId),
      inherited: this.ancestors(kind, nodeId).map((f) => ({
        from: { kind: "folder", id: f.id, name: f.name },
        grants: this.grants("folder", f.id),
      })),
      effective,
    };
  }
  putGrants(
    subject: Subject,
    kind: NodeKind,
    nodeId: string,
    grants: GrantInput[],
  ): GrantsResponse {
    const previous = this.readGrants(subject, kind, nodeId);
    this.require(subject, kind, nodeId, "writeGrants");
    const keys = new Set();
    for (const g of grants) {
      const key = g.kind === "all" ? "all" : g.email.toLowerCase();
      if (keys.has(key)) throw new HttpError("invalid", "Duplicate principal");
      keys.add(key);
    }
    this.store.transaction(() => {
      this.store.run(
        "DELETE FROM grants WHERE node_kind=? AND node_id=?",
        kind,
        nodeId,
      );
      for (const g of grants)
        this.store.run(
          "INSERT INTO grants(node_kind,node_id,principal_kind,principal_email,principal_user_id,role,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)",
          kind,
          nodeId,
          g.kind,
          g.kind === "all" ? null : g.email.toLowerCase(),
          g.kind === "all"
            ? null
            : (this.store.get<Row>(
                "SELECT id FROM users WHERE email=?",
                g.email.toLowerCase(),
              )?.id ?? null),
          g.role,
          Date.now(),
          subject.userId,
        );
    });
    return {
      ...previous,
      grants: this.grants(kind, nodeId),
      effective: this.role(subject, kind, nodeId) ?? previous.effective,
    };
  }
}
