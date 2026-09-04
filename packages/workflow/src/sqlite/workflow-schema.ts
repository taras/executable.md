/**
 * The version-1 WorkflowRun schema, as SQLite holds it.
 *
 * Two adapters keep a run in an embedded SQLite database — the Deno host in a
 * file it opens with `node:sqlite`, the Cloudflare owner in the storage of one
 * Durable Object — and they must agree about what version 1 *is*. A second copy
 * of this DDL under a second adapter would be two schemas that happen to look
 * alike, and the first amendment either of them missed would be a run neither
 * could recognize.
 *
 * So the declaration lives here once, and each adapter keeps what is genuinely
 * its own: how a connection is opened, how an error is translated, and how the
 * identity of the schema is carried. That last one differs because it has to.
 * Deno writes `PRAGMA application_id` and `PRAGMA user_version` into the SQLite
 * header; Cloudflare's Durable Object storage refuses both pragmas outright, so
 * that adapter carries the same two values in a table of its own. The logical
 * version is one; only its physical carrier is per-adapter.
 *
 * Nothing here owns a connection, a path, a transaction or any lifecycle
 * authority, and nothing here names a runtime. It is a description of a shape
 * and the arithmetic for comparing a database against it.
 */

/**
 * The bytes `XMD1` as a 32-bit integer, written into the SQLite header.
 *
 * A database carries what wrote it, so a file that is perfectly valid SQLite
 * and belongs to something else is refused on sight rather than through the
 * confusing shape of its missing tables.
 */
export const APPLICATION_ID = 0x584d4431;

/** The only schema version this build reads or writes. */
export const SCHEMA_VERSION = 1;

/**
 * The largest value the schema version can be carried in.
 *
 * The logical carrier is SQLite's `user_version`, a signed 32-bit integer. Any
 * host holding this schema has to represent the same versions, so the bound is
 * the carrier's rather than one adapter's.
 */
export const MAX_SCHEMA_VERSION = 0x7fffffff;

/**
 * Whether a retained value could name a schema version at all.
 *
 * Version numbering starts at 1 and rises. Zero is a database carrying the XMD
 * identity without a complete schema, which is a partial initialization and so
 * damage; a negative or out-of-range value is retained data that no build of
 * this project ever wrote. Neither is a version this build has not learned, so
 * neither may travel as one.
 */
export function isSchemaVersion(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_SCHEMA_VERSION;
}

const STATUSES = "'running', 'suspended', 'interrupted', 'completed', 'failed', 'cancelled'";

/**
 * A stop reason is three columns wide and has three legal shapes.
 *
 * Spreading the variant across columns is what lets SQLite hold the invariant
 * rather than the code that writes rows: a host reason with an event id, or a
 * journal reason with a code, is refused by the database itself.
 */
function coherentStopReason(): string {
  return `CHECK (
    (stop_reason_kind IS NULL AND stop_reason_code IS NULL AND stop_reason_event_id IS NULL)
    OR (stop_reason_kind = 'host' AND stop_reason_code IS NOT NULL AND stop_reason_event_id IS NULL)
    OR (stop_reason_kind = 'journal' AND stop_reason_code IS NULL AND stop_reason_event_id IS NOT NULL)
  )`;
}

/**
 * Version 1, one table at a time.
 *
 * Kept as separate definitions so verification can compare what a file holds
 * with what this build writes, rather than settling for the table's name.
 *
 * The complete version-1 shape includes the pinned DOFS objects, retained
 * Workspace roots, journal and metadata. Dependency order is explicit: DOFS
 * content precedes root references, and roots precede the journal rows that
 * name them.
 */
interface DeclaredObject {
  readonly type: "table" | "index";
  readonly sql: string;
}

export const OBJECTS: ReadonlyMap<string, DeclaredObject> = new Map([
  [
    "vfs_meta",
    {
      type: "table",
      sql: `CREATE TABLE vfs_meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  )`,
    },
  ],
  [
    "vfs_nodes",
    {
      type: "table",
      sql: `CREATE TABLE vfs_nodes (
    inode         INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT    NOT NULL CHECK(type IN ('file','dir','symlink')),
    mode          INTEGER NOT NULL DEFAULT 493,
    mtime         INTEGER NOT NULL,
    rev           INTEGER NOT NULL DEFAULT 0,
    mount_root    TEXT,
    stub_size     INTEGER,
    manifest_hash BLOB,
    link_target   TEXT,
    size          INTEGER NOT NULL DEFAULT 0
  )`,
    },
  ],
  [
    "vfs_dirents",
    {
      type: "table",
      sql: `CREATE TABLE vfs_dirents (
    parent_inode INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    child_inode  INTEGER NOT NULL,
    PRIMARY KEY (parent_inode, name)
  ) WITHOUT ROWID`,
    },
  ],
  [
    "vfs_dirents_by_child",
    {
      type: "index",
      sql: "CREATE INDEX vfs_dirents_by_child ON vfs_dirents(child_inode)",
    },
  ],
  [
    "vfs_nodes_by_rev",
    {
      type: "index",
      sql: "CREATE INDEX vfs_nodes_by_rev ON vfs_nodes(rev)",
    },
  ],
  [
    "vfs_nodes_by_manifest_hash",
    {
      type: "index",
      sql: `CREATE INDEX vfs_nodes_by_manifest_hash
    ON vfs_nodes(manifest_hash) WHERE manifest_hash IS NOT NULL`,
    },
  ],
  [
    "vfs_blobs",
    {
      type: "table",
      sql: `CREATE TABLE vfs_blobs (
    hash      BLOB    PRIMARY KEY,
    size      INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
    },
  ],
  [
    "vfs_blob_bytes",
    {
      type: "table",
      sql: `CREATE TABLE vfs_blob_bytes (
    hash  BLOB PRIMARY KEY REFERENCES vfs_blobs(hash) ON DELETE CASCADE,
    bytes BLOB NOT NULL
  )`,
    },
  ],
  [
    "vfs_chunks",
    {
      type: "table",
      sql: `CREATE TABLE vfs_chunks (
    inode INTEGER NOT NULL,
    idx   INTEGER NOT NULL,
    hash  BLOB    NOT NULL,
    size  INTEGER NOT NULL,
    PRIMARY KEY (inode, idx)
  ) WITHOUT ROWID`,
    },
  ],
  [
    "vfs_chunks_by_hash",
    {
      type: "index",
      sql: "CREATE INDEX vfs_chunks_by_hash ON vfs_chunks(hash)",
    },
  ],
  [
    "vfs_manifests",
    {
      type: "table",
      sql: `CREATE TABLE vfs_manifests (
    hash      BLOB    PRIMARY KEY,
    size      INTEGER NOT NULL,
    encoded   BLOB    NOT NULL,
    last_seen INTEGER NOT NULL DEFAULT 0
  )`,
    },
  ],
  [
    "vfs_changes",
    {
      type: "table",
      sql: `CREATE TABLE vfs_changes (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    rev  INTEGER NOT NULL,
    path TEXT    NOT NULL,
    op   TEXT    NOT NULL CHECK(op IN ('delete'))
  )`,
    },
  ],
  [
    "vfs_changes_by_rev",
    {
      type: "index",
      sql: "CREATE INDEX vfs_changes_by_rev ON vfs_changes(rev)",
    },
  ],
  [
    "vfs_changes_by_path",
    {
      type: "index",
      sql: "CREATE INDEX vfs_changes_by_path ON vfs_changes(path, id DESC)",
    },
  ],
  [
    "_vfs_watermark",
    {
      type: "table",
      sql: `CREATE TABLE _vfs_watermark (
    k       TEXT    NOT NULL,
    backend TEXT    NOT NULL DEFAULT 'default',
    v       INTEGER NOT NULL,
    PRIMARY KEY (k, backend)
  )`,
    },
  ],
  [
    "_vfs_fetch_cursor",
    {
      type: "table",
      sql: `CREATE TABLE _vfs_fetch_cursor (
    k       TEXT    NOT NULL CHECK(k = 'fetch'),
    backend TEXT    NOT NULL DEFAULT 'default',
    path    TEXT,
    PRIMARY KEY (k, backend)
  )`,
    },
  ],
  [
    "_vfs_mounts",
    {
      type: "table",
      sql: `CREATE TABLE _vfs_mounts (
    root    TEXT PRIMARY KEY,
    kind    TEXT NOT NULL,
    indexed INTEGER NOT NULL DEFAULT 0,
    mode    TEXT NOT NULL DEFAULT 'read-only'
            CHECK(mode IN ('read-only', 'read-write'))
  )`,
    },
  ],
  [
    "workspace_roots",
    {
      type: "table",
      sql: `CREATE TABLE workspace_roots (
  root_id TEXT PRIMARY KEY CHECK (
    length(root_id) = 64 AND root_id NOT GLOB '*[^0-9a-f]*'
  ),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  manifest TEXT NOT NULL CHECK (json_valid(manifest))
) STRICT`,
    },
  ],
  [
    "workspace_root_manifest_refs",
    {
      type: "table",
      sql: `CREATE TABLE workspace_root_manifest_refs (
  root_id TEXT NOT NULL REFERENCES workspace_roots(root_id) ON DELETE CASCADE,
  manifest_hash BLOB NOT NULL REFERENCES vfs_manifests(hash) ON DELETE RESTRICT,
  PRIMARY KEY (root_id, manifest_hash)
) STRICT, WITHOUT ROWID`,
    },
  ],
  [
    "workspace_root_blob_refs",
    {
      type: "table",
      sql: `CREATE TABLE workspace_root_blob_refs (
  root_id TEXT NOT NULL REFERENCES workspace_roots(root_id) ON DELETE CASCADE,
  blob_hash BLOB NOT NULL,
  PRIMARY KEY (root_id, blob_hash),
  FOREIGN KEY (blob_hash) REFERENCES vfs_blobs(hash) ON DELETE RESTRICT,
  FOREIGN KEY (blob_hash) REFERENCES vfs_blob_bytes(hash) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`,
    },
  ],
  [
    "agent_sessions",
    {
      type: "table",
      sql: `CREATE TABLE agent_sessions (
  session_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  agent_command TEXT NOT NULL,
  session_identity TEXT NOT NULL,
  policy TEXT NOT NULL,
  assertion_kind TEXT NOT NULL,
  assertion_value TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT`,
    },
  ],
  [
    "workspace_state",
    {
      type: "table",
      sql: `CREATE TABLE workspace_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  current_root_id TEXT NOT NULL REFERENCES workspace_roots(root_id) ON DELETE RESTRICT
) STRICT`,
    },
  ],
  [
    "journal_events",
    {
      type: "table",
      sql: `CREATE TABLE journal_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  record TEXT NOT NULL CHECK (json_valid(record)),
  workspace_root_id TEXT NOT NULL REFERENCES workspace_roots(root_id) ON DELETE RESTRICT
) STRICT`,
    },
  ],
  [
    "workflow_run",
    {
      type: "table",
      sql: `CREATE TABLE workflow_run (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_id TEXT NOT NULL,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  base TEXT NOT NULL,
  props TEXT NOT NULL CHECK (json_valid(props) AND json_type(props) = 'object'),
  status TEXT NOT NULL CHECK (status IN (${STATUSES})),
  stop_reason_kind TEXT CHECK (stop_reason_kind IS NULL OR stop_reason_kind IN ('host', 'journal')),
  stop_reason_code TEXT,
  stop_reason_event_id TEXT REFERENCES journal_events (event_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ${coherentStopReason()}
) STRICT`,
    },
  ],
  [
    "definition_retrieval",
    {
      type: "table",
      sql: `CREATE TABLE definition_retrieval (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  metadata TEXT NOT NULL CHECK (json_valid(metadata)),
  revision INTEGER NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  updated_at TEXT NOT NULL
) STRICT`,
    },
  ],
  [
    "document_executions",
    {
      type: "table",
      sql: `CREATE TABLE document_executions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  stop_status TEXT CHECK (stop_status IS NULL OR stop_status IN (${STATUSES})),
  stop_reason_kind TEXT CHECK (stop_reason_kind IS NULL OR stop_reason_kind IN ('host', 'journal')),
  stop_reason_code TEXT,
  stop_reason_event_id TEXT REFERENCES journal_events (event_id),
  CHECK ((stopped_at IS NULL) = (stop_status IS NULL)),
  CHECK (stop_status IS NOT NULL OR stop_reason_kind IS NULL),
  ${coherentStopReason()}
) STRICT`,
    },
  ],
  [
    "workspace_repositories",
    {
      type: "table",
      sql: `CREATE TABLE workspace_repositories (
  name TEXT PRIMARY KEY CHECK (length(name) > 0),
  locator TEXT NOT NULL CHECK (length(locator) > 0),
  locator_fingerprint TEXT NOT NULL CHECK (
    length(locator_fingerprint) = 64 AND locator_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  requested_base TEXT CHECK (requested_base IS NULL OR length(requested_base) > 0),
  creation_commit TEXT NOT NULL CHECK (length(creation_commit) > 0),
  primary_branch TEXT NOT NULL CHECK (length(primary_branch) > 0),
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  checkout_path TEXT NOT NULL UNIQUE CHECK (
    length(checkout_path) > 0 AND substr(checkout_path, 1, 1) = '/'
  )
) STRICT`,
    },
  ],
  [
    "workspace_worktrees",
    {
      type: "table",
      sql: `CREATE TABLE workspace_worktrees (
  repository_name TEXT NOT NULL REFERENCES workspace_repositories(name) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) > 0),
  requested_branch TEXT NOT NULL CHECK (length(requested_branch) > 0),
  requested_base TEXT CHECK (requested_base IS NULL OR length(requested_base) > 0),
  creation_commit TEXT NOT NULL CHECK (length(creation_commit) > 0),
  checkout_path TEXT NOT NULL UNIQUE CHECK (
    length(checkout_path) > 0 AND substr(checkout_path, 1, 1) = '/'
  ),
  PRIMARY KEY (repository_name, name)
) STRICT, WITHOUT ROWID`,
    },
  ],
  [
    "workflow_suspension_answers",
    {
      type: "table",
      sql: `CREATE TABLE workflow_suspension_answers (
  suspension_id TEXT PRIMARY KEY,
  request_event_id TEXT NOT NULL REFERENCES journal_events(event_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  answer TEXT NOT NULL CHECK (json_valid(answer)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'consumed')),
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
) STRICT`,
    },
  ],
  [
    "workflow_fork_lineage",
    {
      type: "table",
      sql: `CREATE TABLE workflow_fork_lineage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_run_id TEXT NOT NULL CHECK (length(source_run_id) > 0),
  checkpoint_event_id TEXT NOT NULL CHECK (length(checkpoint_event_id) > 0),
  checkpoint_workspace_root_id TEXT NOT NULL
    REFERENCES workspace_roots(root_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT`,
    },
  ],
  [
    "journal_event_provenance",
    {
      type: "table",
      sql: `CREATE TABLE journal_event_provenance (
  event_id TEXT PRIMARY KEY REFERENCES journal_events(event_id) ON DELETE RESTRICT,
  source_run_id TEXT NOT NULL CHECK (length(source_run_id) > 0),
  source_event_id TEXT NOT NULL CHECK (length(source_event_id) > 0)
) STRICT, WITHOUT ROWID`,
    },
  ],
]);

export const EXPECTED_SCHEMA = Object.freeze(
  [...OBJECTS.entries()].map(([name, object]) =>
    Object.freeze({ name, type: object.type, sql: normalize(object.sql) }),
  ),
);

/** Objects version 1 declares, including the pinned Cloudflare structure. */
export const REQUIRED_OBJECTS: readonly string[] = Object.freeze([...OBJECTS.keys()]);

/** Tables version 1 declares. */
export const REQUIRED_TABLES: readonly string[] = Object.freeze(
  [...OBJECTS.entries()].filter(([, object]) => object.type === "table").map(([name]) => name),
);

/** Version 1 in full. */
export const SCHEMA_SQL = [...OBJECTS.values()]
  .filter((object) => object.type === "table" && !object.sql.startsWith("CREATE TABLE vfs_"))
  .filter((object) => !object.sql.startsWith("CREATE TABLE _vfs_"))
  .map((object) => `${object.sql};`)
  .join("\n\n");

/** One object a database declares, as `sqlite_schema` reports it. */
export interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

/** One statement's shape, independent of how it was laid out. */
export function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Every in-place amendment to version 1, newest first.
 *
 * Each entry names what that amendment added. Peeling them off in order is what
 * reconstructs the shapes that once claimed to be a complete version 1, so a
 * database an earlier build produced is refused as an incomplete pre-release
 * rather than as arbitrary damage.
 */
const AMENDMENTS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["workflow_fork_lineage", "journal_event_provenance"]),
  Object.freeze(["workflow_suspension_answers"]),
  Object.freeze(["workspace_repositories", "workspace_worktrees"]),
]);

/** What the newest amendment added. Its presence marks a current-shape database. */
const LATEST_AMENDMENT: readonly string[] = AMENDMENTS[0] ?? [];

/** The very first pre-release shape, before Workspace root retention existed. */
const EARLIEST_PRE_RELEASE_SHAPE: readonly string[] = [
  "definition_retrieval",
  "document_executions",
  "journal_events",
  "workflow_run",
];

/**
 * Every later shape that once claimed to be a complete version 1.
 *
 * Newest first: version 1 minus the newest amendment, then minus the one before
 * it, and so on.
 */
const PRIOR_COMPLETE_SHAPES: readonly (readonly string[])[] = Object.freeze(
  AMENDMENTS.map((_, index) => {
    const removed = new Set(AMENDMENTS.slice(0, index + 1).flat());
    return Object.freeze(REQUIRED_OBJECTS.filter((name) => !removed.has(name)));
  }),
);

/**
 * Whether these declarations describe an earlier shape that once claimed to be
 * a complete version 1.
 *
 * The very first pre-release held only the run, journal and execution tables.
 * Every shape after it is version 1 minus whichever amendments had not been
 * made yet, and each is named here so the refusal reads as an incomplete
 * pre-release rather than as corruption.
 */
export function isIncompletePreReleaseShape(objects: readonly SchemaObject[]): boolean {
  const present = new Set(objects.map((object) => object.name));
  if (LATEST_AMENDMENT.some((name) => present.has(name))) {
    return false;
  }
  const earliest = new Set(EARLIEST_PRE_RELEASE_SHAPE);
  if (present.size === earliest.size && [...present].every((name) => earliest.has(name))) {
    return objects.every((object) => object.type === "table");
  }
  return PRIOR_COMPLETE_SHAPES.some((shape) => {
    const expected = new Set(shape);
    return present.size === expected.size && [...present].every((name) => expected.has(name));
  });
}

/** What a structural disagreement is, without either adapter's error types. */
export type StructureFailure =
  | { readonly kind: "incomplete-pre-release" }
  | { readonly kind: "undeclared-object"; readonly name: string }
  | { readonly kind: "misshapen-object"; readonly name: string }
  | { readonly kind: "missing-objects"; readonly names: readonly string[] };

/**
 * Compare what a database declares with what this build writes.
 *
 * Answers with the disagreement rather than raising one, because the two
 * adapters report the same finding as different failures: a path names the
 * file the Deno host refused, and a Durable Object has no path to name.
 *
 * Recognizing a schema is not reading its table names. A dropped constraint and
 * a column that is gone both leave the name intact, so the stored definition of
 * every object is compared with the definition version 1 declares.
 */
export function declaredStructureFailure(
  objects: readonly SchemaObject[],
): StructureFailure | undefined {
  if (isIncompletePreReleaseShape(objects)) {
    return { kind: "incomplete-pre-release" };
  }
  for (const object of objects) {
    const expected = OBJECTS.get(object.name);
    if (expected === undefined) {
      return { kind: "undeclared-object", name: object.name };
    }
    if (object.type !== expected.type || normalize(object.sql) !== normalize(expected.sql)) {
      return { kind: "misshapen-object", name: object.name };
    }
  }
  const present = new Set(objects.map((object) => object.name));
  const missing = REQUIRED_OBJECTS.filter((name) => !present.has(name));
  if (missing.length > 0) {
    return { kind: "missing-objects", names: missing };
  }
  return undefined;
}

/** Whether any object version 1 declares is present at all. */
export function hasAnyDeclaredObject(objects: readonly SchemaObject[]): boolean {
  return objects.some((object) => OBJECTS.has(object.name));
}
