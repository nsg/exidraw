import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementResultingChanges,
} from "node:sqlite";
const migrations = [
  `
CREATE TABLE users (
 id TEXT PRIMARY KEY, auth_mode TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL, avatar_url TEXT, created_at INTEGER NOT NULL, last_login_at INTEGER NOT NULL, UNIQUE(auth_mode,subject)
);
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE TABLE tokens (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
 last_used_at INTEGER, revoked_at INTEGER
);
CREATE TABLE folders (
 id TEXT PRIMARY KEY, parent_id TEXT REFERENCES folders(id), name TEXT NOT NULL, created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, created_by TEXT, UNIQUE(parent_id,name)
);
CREATE TABLE rooms (
 id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES folders(id), name TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT NOT NULL, deleted_at INTEGER
);
CREATE INDEX rooms_folder ON rooms(folder_id);
CREATE TABLE scenes (
 room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE, elements TEXT NOT NULL,
 scene_version INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE grants (
 id INTEGER PRIMARY KEY, node_kind TEXT NOT NULL CHECK(node_kind IN ('folder','room')), node_id TEXT NOT NULL,
 principal_kind TEXT NOT NULL CHECK(principal_kind IN ('all','user')), principal_email TEXT,
 principal_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, role TEXT NOT NULL CHECK(role IN ('viewer','editor','owner')),
 created_at INTEGER NOT NULL, created_by TEXT NOT NULL, UNIQUE(node_kind,node_id,principal_kind,principal_email)
);
CREATE INDEX grants_node ON grants(node_kind,node_id);
CREATE TABLE files (
 room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, file_id TEXT NOT NULL, mime_type TEXT NOT NULL,
 size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, PRIMARY KEY(room_id,file_id)
);
CREATE TABLE snapshots (
 id INTEGER PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
 created_by TEXT, reason TEXT NOT NULL, scene_version INTEGER NOT NULL, element_count INTEGER NOT NULL, elements_gz BLOB NOT NULL
);
CREATE INDEX snapshots_room ON snapshots(room_id,created_at);
`,
  `ALTER TABLE scenes ADD COLUMN tombstone_times TEXT NOT NULL DEFAULT '{}';`,
  ["scenes", "snapshots"].map((table) => `
UPDATE ${table} SET scene_version=CAST(MAX(0,MIN(scene_version,9007199254740991)) AS INTEGER);
CREATE TRIGGER ${table}_safe_scene_version_insert BEFORE INSERT ON ${table}
WHEN typeof(NEW.scene_version) != 'integer' OR NEW.scene_version < 0 OR NEW.scene_version > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'Unsafe scene version'); END;
CREATE TRIGGER ${table}_safe_scene_version_update BEFORE UPDATE OF scene_version ON ${table}
WHEN typeof(NEW.scene_version) != 'integer' OR NEW.scene_version < 0 OR NEW.scene_version > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'Unsafe scene version'); END;
`).join("\n"),
];
export class Store {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(dataDir: string) {
    if (dataDir !== ":memory:") mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(
      dataDir === ":memory:" ? dataDir : join(dataDir, "exidraw.db"),
    );
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
      );
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)",
      );
      const version = Number(
        this.get("SELECT value FROM meta WHERE key='schema_version'")?.value ??
          0,
      );
      if (
        !Number.isInteger(version) ||
        version < 0 ||
        version > migrations.length
      )
        throw new Error(`Unsupported database schema version ${version}`);
      for (let i = version; i < migrations.length; i++)
        this.transaction(() => {
          this.db.exec(migrations[i]!);
          this.run(
            "INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            String(i + 1),
          );
          const now = Date.now();
          this.run(
            "INSERT OR IGNORE INTO folders(id,parent_id,name,created_at,updated_at,created_by) VALUES('root',NULL,'Root',?,?,NULL)",
            now,
            now,
          );
        });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  // SQL results are intentionally generic: each service owns its row shape.
  get<T = any>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T = any>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SQLInputValue[]): StatementResultingChanges {
    for (const value of params)
      if ((typeof value === "number" &&
        (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) ||
        (typeof value === "bigint" &&
          (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))))
        throw new RangeError("Unsafe numeric database parameter");
    return this.db.prepare(sql).run(...params);
  }
  transaction<T>(fn: () => T): T {
    const savepoint = `exidraw_${this.depth}`;
    this.db.exec(this.depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec(
        this.depth === 1 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`,
      );
      return result;
    } catch (error) {
      this.db.exec(
        this.depth === 1
          ? "ROLLBACK"
          : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`,
      );
      throw error;
    } finally {
      this.depth--;
    }
  }
  close(): void {
    this.db.close();
  }
}
