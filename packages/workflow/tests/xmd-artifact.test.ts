/**
 * Tier XA — the sealed XMD artifact container and its verifier.
 *
 * An artifact is evidence that left the machine that produced it. So every test
 * here works on a real file: a real SQLite container, opened the way a stranger
 * would open it, damaged the way somebody with write access could damage it.
 * Nothing stands in for the filesystem, for SQLite, or for the hashes.
 *
 * The claims are grouped the way a reviewer reads them: that version 1 is a
 * distinct sealed container, that its identity is about the evidence rather
 * than the encoding, that the inventory is complete, that verification finishes
 * before any of it is returned, that each way of not being an artifact has its
 * own answer, that opening never writes, that the returned value carries no
 * authority, that the reader holds the semantic invariants a live run holds,
 * and that none of the private encoding is public API.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { copyFile, exists, readdir, rm, stat, writeTextFile } from "@effectionx/fs";
import { ensure, type Operation, type Result, until } from "effection";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmod, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readXmdArtifact, writeXmdArtifact } from "../src/deno/artifact/mod.ts";
import type {
  DetachedXmdArtifact,
  VerifiedXmdArtifact,
  XmdArtifactAgentBundle,
  XmdArtifactAgentPortability,
  XmdArtifactPortableAgentSession,
  XmdArtifactUnavailableAgentSession,
  XmdArtifactWriteResult,
} from "../src/deno/artifact/mod.ts";
import type { XmdArtifactEncoding } from "../src/deno/artifact/types.ts";
import { XmdArtifactContainerLayout } from "../src/deno/artifact/write.ts";
import {
  buildXmdArtifactManifest,
  canonicalJsonText,
  sha256Hex,
} from "../src/deno/artifact/manifest.ts";
import { encodeXmdArtifactInventory } from "../src/deno/artifact/records.ts";
import { type JsonObject, parseJsonObject, parseJsonValue } from "../src/storage/members.ts";
import { XMD_ARTIFACT_APPLICATION_ID } from "../src/deno/artifact/schema.ts";
import { APPLICATION_ID as LIVE_RUN_APPLICATION_ID } from "../src/deno/schema.ts";
import * as publishedDeno from "../deno.ts";
import * as publishedRoot from "../mod.ts";
import {
  agentBundle,
  BUNDLE_PATH_CANARY,
  BUNDLE_SECRET_CANARY,
  CHECKPOINT_TOKENS,
  finalizedArtifact,
  FINALIZED_SESSIONS,
  richArtifact,
  SUSPENSIONS,
  wait,
} from "./support/artifact-fixture.ts";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { SUSPENSION_ANSWER } from "../src/suspension/answer.ts";

const encoder = new TextEncoder();

function useArtifactDirectory(): Operation<string> {
  return useTempDirectory("xmd-artifact-");
}

function* sealed(
  directory: string,
  name = "evidence.xmd",
  contents: DetachedXmdArtifact = richArtifact(),
): Operation<{ path: string; result: XmdArtifactWriteResult }> {
  const path = join(directory, name);
  const written = yield* writeXmdArtifact(path, contents);
  if (!written.ok) {
    throw written.error;
  }
  return { path, result: written.value };
}

function* opened(path: string): Operation<VerifiedXmdArtifact> {
  const result = yield* readXmdArtifact(path);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function* refused(path: string): Operation<Error> {
  const result: Result<VerifiedXmdArtifact> = yield* readXmdArtifact(path);
  if (result.ok) {
    throw new Error(`the artifact at ${path} was accepted`);
  }
  return result.error;
}

/** A copy, damaged. Observation never writes to the file it is reading. */
function* damaged(
  source: string,
  target: string,
  damage: (database: DatabaseSync) => void,
): Operation<string> {
  yield* copyFile(source, target);
  const database = new DatabaseSync(target);
  try {
    damage(database);
  } finally {
    database.close();
  }
  return target;
}

/** Rewrite one content row so it stays self-consistent about its own bytes. */
function rewrite(database: DatabaseSync, kind: string, identity: string, text: string): void {
  const content = encoder.encode(text);
  database
    .prepare(
      "UPDATE xmd_artifact_content SET content = ?, length = ?, sha256 = ? " +
        "WHERE kind = ? AND identity = ?",
    )
    .run(content, content.byteLength, sha256Hex(content), kind, identity);
}

/** One row's stored content, as text. */
function storedText(path: string, kind: string, identity: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT content FROM xmd_artifact_content WHERE kind = ? AND identity = ?")
      .get(kind, identity);
    const content = row?.["content"];
    if (!(content instanceof Uint8Array)) {
      throw new Error(`no ${kind} record is stored under ${identity}`);
    }
    return new TextDecoder().decode(content);
  } finally {
    database.close();
  }
}

/** How many rows of one kind a sealed container holds. */
function rowsOfKind(path: string, kind: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT count(*) AS rows FROM xmd_artifact_content WHERE kind = ?")
      .get(kind);
    return Number(row?.["rows"]);
  } finally {
    database.close();
  }
}

/**
 * One stored record, parsed as the JSON object it is.
 *
 * Parsed rather than asserted, so a damage helper that edits a member builds
 * its replacement out of a value the same parser the reader uses admitted.
 */
function storedRecord(path: string, kind: string, identity: string): JsonObject {
  return parseJsonObject(
    JSON.parse(storedText(path, kind, identity)),
    "$",
    (reason) => new Error(`the stored ${kind} record ${reason}`),
  );
}

/** The same snapshot, with some journal records replaced by event id. */
function withRecords(
  contents: DetachedXmdArtifact,
  replacements: Readonly<Record<string, DurableEvent>>,
): DetachedXmdArtifact {
  return {
    ...contents,
    journal: contents.journal.map((row) => {
      const replacement = replacements[row.eventId];
      return replacement === undefined
        ? row
        : { ...row, record: serializeDurableEvent(replacement) };
    }),
  };
}

/**
 * The answered wait, re-cut so its answer is `null` and its publication carries
 * no value member.
 *
 * The wait's schema is rebuilt to accept null, and its fingerprint with it, so
 * what refuses this snapshot is the missing member rather than a value the
 * schema would have rejected first.
 */
function valuelessConsumedAnswer(): DetachedXmdArtifact {
  const contents = richArtifact();
  const nullWait = wait(
    SUSPENSIONS.consumed.id,
    { kind: "approval", release: "1.4" },
    {
      type: "null",
    },
  );
  const valueless: DurableEvent = {
    type: "yield",
    coroutineId: "root",
    description: {
      type: SUSPENSION_ANSWER,
      name: nullWait.id,
      suspensionId: nullWait.id,
    },
    result: { status: "ok" },
  };
  return {
    ...withRecords(contents, { "event-5": nullWait.request, "event-6": valueless }),
    answers: contents.answers.map((row) =>
      row.suspensionId === nullWait.id
        ? { ...row, answer: null, requestFingerprint: nullWait.fingerprint }
        : row,
    ),
  };
}

/**
 * The answered wait, re-cut under an identity this run's positions do not
 * derive, consistently across its request, its publication and its row.
 */
function forgedOwnWait(id: string): DetachedXmdArtifact {
  const contents = richArtifact();
  const forged = wait(
    id,
    SUSPENSIONS.consumed.payload.request,
    SUSPENSIONS.consumed.payload.responseSchema,
  );
  return {
    ...withRecords(contents, {
      "event-5": forged.request,
      "event-6": forged.publication({ approved: true }),
    }),
    answers: contents.answers.map((row) =>
      row.suspensionId === SUSPENSIONS.consumed.id ? { ...row, suspensionId: forged.id } : row,
    ),
  };
}

/**
 * The wait this run is stopped at, forged, and its retained row dropped.
 *
 * Leaving the row would make this a row naming a request for another wait,
 * which a different check already answers. Removing it is what leaves the
 * request standing alone, reached by nothing.
 */
function forgedUnansweredWait(id: string): DetachedXmdArtifact {
  const contents = richArtifact();
  const forged = wait(
    id,
    SUSPENSIONS.pending.payload.request,
    SUSPENSIONS.pending.payload.responseSchema,
  );
  return {
    ...withRecords(contents, { "event-7": forged.request }),
    answers: contents.answers.filter((row) => row.suspensionId !== SUSPENSIONS.pending.id),
  };
}

/** One member of a parsed record, as the object it has to be. */
function parsedObject(value: unknown): JsonObject {
  return parseJsonObject(value, "$", (reason) => new Error(`the member ${reason}`));
}

/** One text column of one row, checked rather than coerced. */
function textColumn(row: Record<string, unknown> | undefined, column: string): string {
  const value = row?.[column];
  if (typeof value !== "string") {
    throw new Error(`the row carries no ${column}`);
  }
  return value;
}

/** A SQLite database that is not an artifact, under an artifact's name. */
function foreignDatabase(path: string, applicationId: number): string {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA application_id = ${applicationId}`);
    database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    database.prepare("INSERT INTO notes (id, body) VALUES (1, ?)").run("nothing to do with XMD");
  } finally {
    database.close();
  }
  return path;
}

/** The portable classification the finalized fixture carries. */
function portableOf(contents: DetachedXmdArtifact): XmdArtifactPortableAgentSession {
  const record = contents.agentEvidence?.portability.find(
    (each) => each.availability === "portable",
  );
  if (record === undefined || record.availability !== "portable") {
    throw new Error("the finalized snapshot classifies no session as portable");
  }
  return record;
}

/** The same snapshot, carrying the Agent evidence it is handed. */
function evidenced(
  base: DetachedXmdArtifact,
  portability: readonly XmdArtifactAgentPortability[],
  bundles: readonly XmdArtifactAgentBundle[],
): DetachedXmdArtifact {
  return { ...base, agentEvidence: { portability, bundles } };
}

/** The finalized snapshot, with its portable classification changed. */
function mutatedPortable(
  change: (record: XmdArtifactPortableAgentSession) => XmdArtifactAgentPortability,
): DetachedXmdArtifact {
  const base = finalizedArtifact();
  const evidence = base.agentEvidence;
  if (evidence === undefined) {
    throw new Error("the finalized snapshot carries no Agent evidence");
  }
  return evidenced(
    base,
    evidence.portability.map((record) =>
      record.availability === "portable" ? change(record) : record,
    ),
    evidence.bundles,
  );
}

/** The finalized snapshot, with one unavailable classification changed. */
function mutatedUnavailable(
  reason: "checkpoint-token-unavailable" | "provider-capability-unavailable",
  change: (record: XmdArtifactUnavailableAgentSession) => XmdArtifactAgentPortability,
): DetachedXmdArtifact {
  const base = finalizedArtifact();
  const evidence = base.agentEvidence;
  if (evidence === undefined) {
    throw new Error("the finalized snapshot carries no Agent evidence");
  }
  return evidenced(
    base,
    evidence.portability.map((record) =>
      record.availability === "unavailable" && record.reason === reason ? change(record) : record,
    ),
    evidence.bundles,
  );
}

/** The artifact identity one snapshot's inventory derives, with no file at all. */
function derivedIdentity(contents: DetachedXmdArtifact): string {
  return buildXmdArtifactManifest(encodeXmdArtifactInventory(contents), (kind) => {
    throw new Error(`the snapshot offers more than one ${kind} record under one identity`);
  }).identity;
}

/** One byte column of one row, checked rather than coerced. */
function bytesColumn(row: Record<string, unknown> | undefined, column: string): Uint8Array {
  const value = row?.[column];
  if (!(value instanceof Uint8Array)) {
    throw new Error(`the row carries no ${column}`);
  }
  return value;
}

function encodingOf(value: string): XmdArtifactEncoding {
  if (value === "canonical-json" || value === "utf8" || value === "bytes") {
    return value;
  }
  throw new Error(`the row declares no encoding this artifact version has`);
}

/**
 * A copy, damaged, and then sealed again over what the damage left.
 *
 * The stored manifest and identity are recomputed from the rows that are
 * actually there, so a damaged file reaches the profile gate instead of being
 * turned away by the header comparison that runs before it. Proving that
 * comparison still wins is a separate case, which damages and does not reseal.
 */
function* resealed(
  source: string,
  target: string,
  damage: (database: DatabaseSync) => void,
): Operation<string> {
  yield* copyFile(source, target);
  const database = new DatabaseSync(target);
  try {
    damage(database);
    const entries = database
      .prepare("SELECT kind, identity, encoding, content FROM xmd_artifact_content")
      .all()
      .map((row) => ({
        kind: textColumn(row, "kind"),
        identity: parseJsonValue(
          JSON.parse(textColumn(row, "identity")),
          "$",
          (reason) => new Error(`a stored identity ${reason}`),
        ),
        encoding: encodingOf(textColumn(row, "encoding")),
        content: bytesColumn(row, "content"),
      }));
    const built = buildXmdArtifactManifest(entries, (kind) => {
      throw new Error(`two ${kind} records under one identity`);
    });
    database
      .prepare("UPDATE xmd_artifact_header SET manifest = ?, identity = ? WHERE id = 1")
      .run(built.bytes, built.identity);
  } finally {
    database.close();
  }
  return target;
}

function insertRow(
  database: DatabaseSync,
  kind: string,
  identity: Json,
  encoding: XmdArtifactEncoding,
  content: Uint8Array,
): void {
  database
    .prepare(
      "INSERT INTO xmd_artifact_content (kind, identity, encoding, length, sha256, content) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      kind,
      canonicalJsonText(identity),
      encoding,
      content.byteLength,
      sha256Hex(content),
      content,
    );
}

function dropRow(database: DatabaseSync, kind: string, identity: string): void {
  database
    .prepare("DELETE FROM xmd_artifact_content WHERE kind = ? AND identity = ?")
    .run(kind, identity);
}

function rewriteBytes(
  database: DatabaseSync,
  kind: string,
  identity: string,
  content: Uint8Array,
): void {
  database
    .prepare(
      "UPDATE xmd_artifact_content SET content = ?, length = ?, sha256 = ? " +
        "WHERE kind = ? AND identity = ?",
    )
    .run(content, content.byteLength, sha256Hex(content), kind, identity);
}

const PORTABILITY_KIND = "agent-session-portability";
const BUNDLE_KIND = "agent-session-bundle-bytes";

/** One stored portability record, edited in place. */
function editPortability(
  source: string,
  sessionKey: string,
  edit: (record: JsonObject) => JsonObject,
): (database: DatabaseSync) => void {
  const identity = canonicalJsonText(sessionKey);
  return (database) => {
    rewrite(
      database,
      PORTABILITY_KIND,
      identity,
      canonicalJsonText(edit(storedRecord(source, PORTABILITY_KIND, identity))),
    );
  };
}

/** The association rows one stored record carries. */
function storedAssociations(record: JsonObject): JsonObject[] {
  const value = record["associations"];
  if (!Array.isArray(value)) {
    throw new Error("the stored record carries no associations");
  }
  return value.map(parsedObject);
}

/** The same record, without one member. */
function without(record: JsonObject, member: string): JsonObject {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== member));
}

/** What the file is, and what is beside it. */
function* fingerprint(path: string, directory: string) {
  return {
    bytes: sha256Hex(yield* until(readFile(path))),
    mode: (yield* stat(path)).mode,
    siblings: (yield* readdir(directory)).sort(),
  };
}

describe("XMD artifact container version 1", () => {
  it("C1 seals a distinct container and refuses a live run store as one", function* () {
    const directory = yield* useArtifactDirectory();
    const { path, result } = yield* sealed(directory);

    expect(path.endsWith(".xmd")).toBe(true);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(Number(database.prepare("PRAGMA application_id").get()?.["application_id"])).toBe(
        XMD_ARTIFACT_APPLICATION_ID,
      );
      expect(Number(database.prepare("PRAGMA user_version").get()?.["user_version"])).toBe(1);
      expect(
        Number(
          database.prepare("SELECT artifact_version FROM xmd_artifact_header").get()?.[
            "artifact_version"
          ],
        ),
      ).toBe(1);
    } finally {
      database.close();
    }

    // The writer already read it back; reading it again is the ordinary open a
    // second machine performs.
    const reopened = yield* opened(path);
    expect(reopened.identity).toBe(result.identity);

    const live = foreignDatabase(join(directory, "run.xmd"), LIVE_RUN_APPLICATION_ID);
    expect((yield* refused(live)).name).toBe("XmdArtifactLiveRunError");
  });

  it("C2 identifies the evidence rather than the encoding", function* () {
    const directory = yield* useArtifactDirectory();
    const contents = richArtifact();

    const compact = yield* XmdArtifactContainerLayout.with({ pageSize: 512 }, function* () {
      return yield* sealed(directory, "compact.xmd", contents);
    });
    const roomy = yield* XmdArtifactContainerLayout.with(
      { pageSize: 8192, vacuum: true },
      function* () {
        return yield* sealed(directory, "roomy.xmd", contents);
      },
    );

    expect(roomy.result.identity).toBe(compact.result.identity);
    expect(roomy.result.fileSha256).not.toBe(compact.result.fileSha256);
    expect(compact.result.fileSha256).toBe(sha256Hex(yield* until(readFile(compact.path))));
    expect(roomy.result.fileSha256).toBe(sha256Hex(yield* until(readFile(roomy.path))));
  });

  it("C3 round-trips every retained record family", function* () {
    const directory = yield* useArtifactDirectory();
    const contents = richArtifact();
    const { path } = yield* sealed(directory, "evidence.xmd", contents);
    const read = yield* opened(path);

    expect(read.frontier).toEqual(contents.frontier);
    expect(read.run).toEqual(contents.run);
    expect(read.executions).toEqual(contents.executions);
    expect(read.lineage).toEqual(contents.lineage);
    expect(read.journal).toEqual(contents.journal);
    expect(read.repositories).toEqual(contents.repositories);
    expect(read.worktrees).toEqual(contents.worktrees);
    // Compared as a set: the reader returns content in canonical identity
    // order, which is a property of the format rather than of the fixture.
    const bySuspension = (rows: readonly { suspensionId: string }[]) =>
      [...rows].sort((left, right) => left.suspensionId.localeCompare(right.suspensionId));
    expect(bySuspension(read.answers)).toEqual(bySuspension(contents.answers));
    expect(read.agentSessions).toEqual(contents.agentSessions);
    expect(read.definition).toEqual(contents.definition);
    // Merged legacy V1 holds neither Agent kind, so it carries no evidence
    // member at all rather than an empty one a caller could read as a decision.
    expect(read.agentEvidence).toBeUndefined();

    // Workspace roots and their content survive as bytes, not as a summary.
    expect(read.roots.map((root) => root.rootId).sort()).toEqual(
      contents.roots.map((root) => root.rootId).sort(),
    );
    expect(read.roots.map((root) => root.manifest).sort()).toEqual(
      contents.roots.map((root) => root.manifest).sort(),
    );
    // A hardlink group, a symbolic link and a non-default mode are metadata a
    // summary would drop, so each is asserted against the retained manifest.
    const current = read.roots.find(
      (root) => root.rootId === contents.frontier.currentWorkspaceRootId,
    );
    expect(current?.manifest).toContain('"hardlink":"h0"');
    expect(current?.manifest).toContain('"kind":"symlink"');
    expect(current?.manifest).toContain('"mode":493');

    const blobs = new Map(
      read.blobs.map((blob) => [Buffer.from(blob.hash).toString("hex"), blob.content]),
    );
    for (const blob of contents.blobs) {
      const hash = Buffer.from(blob.hash).toString("hex");
      expect(Buffer.compare(Buffer.from(blobs.get(hash) ?? []), Buffer.from(blob.content))).toBe(0);
    }
    expect(read.manifests.length).toBe(contents.manifests.length);
    // One component the run never expanded is still in the closure.
    expect(read.definition.components.map((component) => component.name)).toEqual([
      "Checklist",
      "Unused",
    ]);
  });

  it("C4 verifies the whole file before returning any of it", function* () {
    const directory = yield* useArtifactDirectory();
    const { path } = yield* sealed(directory);

    // The lexically last entry: nothing a caller asking for status would want,
    // and the one a lazy reader would never reach.
    const database = new DatabaseSync(path, { readOnly: true });
    let last: { kind: string; identity: string };
    try {
      const row = database
        .prepare(
          "SELECT kind, identity FROM xmd_artifact_content ORDER BY kind DESC, identity DESC",
        )
        .get();
      last = { kind: textColumn(row, "kind"), identity: textColumn(row, "identity") };
    } finally {
      database.close();
    }

    const broken = yield* damaged(path, join(directory, "broken.xmd"), (target) => {
      rewrite(target, last.kind, last.identity, "not what this record is");
    });

    // The copy this one was damaged from still opens, so the damage is what
    // decides the outcome rather than something the fixture was already wrong
    // about.
    expect((yield* opened(path)).run.status).toBe("suspended");

    // The early status row is still perfectly readable, and the open still
    // returns nothing at all.
    expect(storedText(broken, "workflow-run", "null")).toContain('"status":"suspended"');
    const failure = yield* refused(broken);
    expect(failure.message).not.toContain("suspended"); // no lifecycle leaked into the answer
    expect(yield* readXmdArtifact(broken)).toMatchObject({ ok: false });
  });

  it("C5 answers each way of not being an artifact with its own refusal", function* () {
    const directory = yield* useArtifactDirectory();
    const { path } = yield* sealed(directory);
    const journalIdentity = canonicalJsonText("event-0");

    const wrongName = join(directory, "evidence.sqlite");
    yield* copyFile(path, wrongName);

    const absent = join(directory, "absent.xmd");

    const foreign = foreignDatabase(join(directory, "foreign.xmd"), 0);

    const notADatabase = join(directory, "text.xmd");
    yield* writeTextFile(notADatabase, "this is not a SQLite database at all\n");

    const futureContainer = yield* damaged(
      path,
      join(directory, "future-container.xmd"),
      (target) => {
        target.exec("PRAGMA user_version = 2");
      },
    );
    const futureFormat = yield* damaged(path, join(directory, "future-format.xmd"), (target) => {
      target.exec("UPDATE xmd_artifact_header SET artifact_version = 2");
    });
    const extraView = yield* damaged(path, join(directory, "extra-view.xmd"), (target) => {
      target.exec("CREATE VIEW peek AS SELECT kind FROM xmd_artifact_content");
    });
    const extraIndex = yield* damaged(path, join(directory, "extra-index.xmd"), (target) => {
      target.exec("CREATE INDEX by_encoding ON xmd_artifact_content(encoding)");
    });
    const extraTrigger = yield* damaged(path, join(directory, "extra-trigger.xmd"), (target) => {
      target.exec("CREATE TRIGGER guard AFTER INSERT ON xmd_artifact_content BEGIN SELECT 1; END");
    });
    const missingTable = yield* damaged(path, join(directory, "missing-table.xmd"), (target) => {
      target.exec("DROP TABLE xmd_artifact_content");
    });
    const changedTable = handBuiltContainer(join(directory, "changed-table.xmd"));

    const missingEntry = yield* damaged(path, join(directory, "missing-entry.xmd"), (target) => {
      target.exec(
        "DELETE FROM xmd_artifact_content WHERE kind = 'definition-source-component-content'",
      );
    });
    const extraEntry = yield* damaged(path, join(directory, "extra-entry.xmd"), (target) => {
      const content = encoder.encode("a record nothing declares");
      target
        .prepare(
          "INSERT INTO xmd_artifact_content (kind, identity, encoding, length, sha256, content) " +
            "VALUES ('journal-record', ?, 'utf8', ?, ?, ?)",
        )
        .run(canonicalJsonText("event-99"), content.byteLength, sha256Hex(content), content);
    });
    const unknownKind = yield* damaged(path, join(directory, "unknown-kind.xmd"), (target) => {
      const content = encoder.encode("{}");
      target
        .prepare(
          "INSERT INTO xmd_artifact_content (kind, identity, encoding, length, sha256, content) " +
            "VALUES ('nobody-declared-this', 'null', 'canonical-json', ?, ?, ?)",
        )
        .run(content.byteLength, sha256Hex(content), content);
    });
    const duplicateRecord = yield* damaged(
      path,
      join(directory, "duplicate-record.xmd"),
      (target) => {
        const repository = storedRecord(path, "workspace-repository", canonicalJsonText("product"));
        const twin = { ...repository, name: "product-twin" };
        const content = encoder.encode(canonicalJsonText(twin));
        target
          .prepare(
            "INSERT INTO xmd_artifact_content (kind, identity, encoding, length, sha256, content) " +
              "VALUES ('workspace-repository', ?, 'canonical-json', ?, ?, ?)",
          )
          .run(canonicalJsonText("product-twin"), content.byteLength, sha256Hex(content), content);
      },
    );
    const danglingRoot = yield* damaged(path, join(directory, "dangling-root.xmd"), (target) => {
      const row = storedRecord(path, "journal-event", journalIdentity);
      rewrite(
        target,
        "journal-event",
        journalIdentity,
        canonicalJsonText({ ...row, workspaceRootId: "0".repeat(64) }),
      );
    });
    const unparseableRecord = yield* damaged(path, join(directory, "unparseable.xmd"), (target) => {
      rewrite(target, "journal-event", journalIdentity, '{"nothing":"declares this"}');
    });
    const contentMismatch = yield* damaged(
      path,
      join(directory, "content-mismatch.xmd"),
      (target) => {
        // Only the bytes: the row still declares the length and hash of what used
        // to be there, which is what a byte-level check exists to catch.
        target
          .prepare("UPDATE xmd_artifact_content SET content = ? WHERE kind = ? AND identity = ?")
          .run(
            encoder.encode("x".repeat(storedText(path, "journal-record", journalIdentity).length)),
            "journal-record",
            journalIdentity,
          );
      },
    );
    const manifestMismatch = yield* damaged(
      path,
      join(directory, "manifest-mismatch.xmd"),
      (target) => {
        target.exec("UPDATE xmd_artifact_header SET manifest = X'7b7d'");
      },
    );
    const identityMismatch = yield* damaged(
      path,
      join(directory, "identity-mismatch.xmd"),
      (target) => {
        target.prepare("UPDATE xmd_artifact_header SET identity = ?").run("a".repeat(64));
      },
    );

    const cases: readonly [string, string][] = [
      [wrongName, "XmdArtifactPathError"],
      [directory, "XmdArtifactPathError"],
      [absent, "XmdArtifactUnreadableError"],
      [foreign, "XmdArtifactForeignContainerError"],
      [notADatabase, "XmdArtifactForeignContainerError"],
      [futureContainer, "XmdArtifactContainerVersionError"],
      [futureFormat, "XmdArtifactFormatVersionError"],
      [extraView, "XmdArtifactSchemaError"],
      [extraIndex, "XmdArtifactSchemaError"],
      [extraTrigger, "XmdArtifactSchemaError"],
      [missingTable, "XmdArtifactSchemaError"],
      [changedTable, "XmdArtifactSchemaError"],
      [missingEntry, "XmdArtifactInventoryError"],
      [extraEntry, "XmdArtifactInventoryError"],
      [unknownKind, "XmdArtifactInventoryError"],
      [duplicateRecord, "XmdArtifactInventoryError"],
      [danglingRoot, "XmdArtifactInventoryError"],
      [unparseableRecord, "XmdArtifactRecordError"],
      [contentMismatch, "XmdArtifactContentError"],
      [manifestMismatch, "XmdArtifactManifestMismatchError"],
      [identityMismatch, "XmdArtifactIdentityMismatchError"],
    ];

    const answers: string[] = [];
    for (const [candidate] of cases) {
      answers.push((yield* refused(candidate)).name);
    }
    expect(answers).toEqual(cases.map(([, name]) => name));

    // Which of two answers a file gets when it has earned both. The artifact
    // format version is asked before the schema is compared, so a container
    // declaring a format this build does not implement is an unsupported
    // version whatever its tables look like — this build has no way to know
    // whether the object it does not recognize is damage or is what that later
    // format declares.
    const futureFormatAndSchema = yield* damaged(
      path,
      join(directory, "future-format-and-schema.xmd"),
      (target) => {
        target.exec("UPDATE xmd_artifact_header SET artifact_version = 2");
        target.exec("CREATE VIEW later AS SELECT kind FROM xmd_artifact_content");
      },
    );
    expect((yield* refused(futureFormatAndSchema)).name).toBe("XmdArtifactFormatVersionError");

    // The other side of that order: a version this build does implement, whose
    // structure it does not, is still damage rather than a version.
    const missingHeader = yield* damaged(path, join(directory, "missing-header.xmd"), (target) => {
      target.exec("DROP TABLE xmd_artifact_header");
    });
    expect((yield* refused(missingHeader)).name).toBe("XmdArtifactSchemaError");
    expect((yield* refused(missingTable)).name).toBe("XmdArtifactSchemaError");

    // A symbolic link is refused as itself rather than followed into the file
    // it currently happens to name.
    const link = join(directory, "link.xmd");
    yield* until(symlink(path, link));
    expect((yield* refused(link)).name).toBe("XmdArtifactPathError");
  });

  it("C6 opens without writing anything, even to a read-only directory", function* () {
    const directory = yield* useArtifactDirectory();
    const room = join(directory, "room");
    yield* until(mkdir(room));
    const { path } = yield* sealed(room);
    const broken = yield* damaged(path, join(room, "broken.xmd"), (target) => {
      target.prepare("UPDATE xmd_artifact_header SET identity = ?").run("b".repeat(64));
    });
    const foreign = foreignDatabase(join(room, "foreign.xmd"), 0);

    const before = yield* fingerprint(path, room);
    yield* until(chmod(room, 0o555));
    // Restored through the scope rather than a `finally`, so a failed
    // assertion still leaves a directory the temporary root can remove.
    yield* ensure(() => until(chmod(room, 0o755)));

    yield* opened(path);
    yield* refused(broken);
    yield* refused(foreign);
    yield* refused(join(room, "absent.xmd"));

    const after = yield* fingerprint(path, room);
    expect(after).toEqual(before);
    for (const suffix of ["-journal", "-wal", "-shm", ".lock", ".executor"]) {
      expect(after.siblings.some((name) => name.endsWith(suffix))).toBe(false);
    }
  });

  it("C7 returns a value carrying no host authority", function* () {
    const directory = yield* useArtifactDirectory();
    const contents = richArtifact();
    const { path } = yield* sealed(directory, "evidence.xmd", contents);
    const read = yield* opened(path);
    const sealedFixture = richArtifact();

    // A provider checkpoint token is retained evidence rather than authority
    // over the host that issued it, so the ban is on the names that would carry
    // authority — and the two members that may be called `token` are named.
    const forbiddenNames =
      /retrieval|credential|authentication|password|secret|connection|statement|transaction|database|lock|handle|sessionDirectory|hostPath/i;
    const detached = (value: unknown) => {
      walk(value, (key, member) => {
        expect(forbiddenNames.test(key)).toBe(false);
        if (/token/i.test(key)) {
          expect(["token", "tokenKind"]).toContain(key);
        }
        expect(typeof member).not.toBe("function");
        if (typeof member === "string") {
          expect(member.includes(directory)).toBe(false);
        }
      });
    };
    detached(read);

    // The caller's own snapshot is no longer connected to what was sealed.
    // `Reflect.set` rather than a cast: the members are readonly because they
    // are, and the test is about what happens at runtime.
    expect(Reflect.set(contents.journal[0] ?? {}, "eventId", "tampered")).toBe(true);
    const callerBlob = contents.blobs[0];
    if (callerBlob !== undefined) {
      callerBlob.content[0] = (callerBlob.content[0] ?? 0) ^ 0xff;
    }
    const rereadAfterCallerMutation = yield* opened(path);
    expect(rereadAfterCallerMutation.identity).toBe(read.identity);
    expect(rereadAfterCallerMutation.journal[0]?.eventId).toBe("event-0");

    // Nor is the returned graph something a caller can edit.
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.journal)).toBe(true);
    expect(Object.isFrozen(read.run)).toBe(true);
    expect(Object.isFrozen(read.run.props)).toBe(true);
    expect(Reflect.set(read, "identity", "rewritten")).toBe(false);
    expect(read.identity).not.toBe("rewritten");

    // Byte-bearing leaves are the ones a freeze cannot reach, so each is proved
    // by attempting the two edits a caller could make: replacing the member,
    // and writing into what a read of it returned. The second is re-read
    // through the member again rather than through the array that was handed
    // over — the claim is about the evidence, not about the caller's copy.
    const leaves: readonly (() => Uint8Array | undefined)[] = [
      () => read.blobs[0]?.content,
      () => read.blobs[0]?.hash,
      () => read.manifests[0]?.encoded,
      () => read.manifests[0]?.hash,
    ];
    for (const leaf of leaves) {
      const before = leaf();
      expect(before).toBeInstanceOf(Uint8Array);
      expect(before?.length ?? 0).toBeGreaterThan(0);
      const handed = leaf() ?? new Uint8Array();
      handed[0] = (handed[0] ?? 0) ^ 0xff;
      expect(Buffer.from(leaf() ?? new Uint8Array()).toString("hex")).toBe(
        Buffer.from(before ?? new Uint8Array()).toString("hex"),
      );
    }
    expect(Reflect.set(read.blobs[0] ?? {}, "content", new Uint8Array([1]))).toBe(false);
    expect(Reflect.set(read.manifests[0] ?? {}, "encoded", new Uint8Array([1]))).toBe(false);
    // And after every one of those attempts the bytes are still the ones that
    // were sealed. Matched by hash rather than by position: the reader returns
    // its content in canonical identity order, which is not the order a fixture
    // happened to list it in.
    const returnedBlob = read.blobs[0];
    const sealedBlob = sealedFixture.blobs.find(
      (candidate) =>
        Buffer.compare(
          Buffer.from(candidate.hash),
          Buffer.from(returnedBlob?.hash ?? new Uint8Array()),
        ) === 0,
    );
    expect(sealedBlob).toBeDefined();
    expect(Buffer.from(returnedBlob?.content ?? new Uint8Array()).toString("hex")).toBe(
      Buffer.from(sealedBlob?.content ?? new Uint8Array()).toString("hex"),
    );

    const reread = yield* opened(path);
    expect(reread.identity).toBe(read.identity);

    // The same two claims about the values this version added. A descriptor,
    // its nested provider identities and its ordered associations are frozen;
    // a bundle's bytes cannot be, so they answer with a copy the way every
    // other byte leaf does.
    const finalized = yield* sealed(directory, "finalized.xmd", finalizedArtifact());
    const evidence = (yield* opened(finalized.path)).agentEvidence;
    expect(evidence).toBeDefined();
    detached(evidence);
    const classification = evidence?.portability[0];
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence?.portability)).toBe(true);
    expect(Object.isFrozen(classification)).toBe(true);
    expect(Object.isFrozen(classification?.associations)).toBe(true);
    expect(Object.isFrozen(classification?.associations[0])).toBe(true);
    expect(Reflect.set(classification ?? {}, "availability", "portable")).toBe(false);
    expect(Reflect.set(classification?.associations[0] ?? {}, "token", "rewritten")).toBe(false);

    const sealedBundle = agentBundle();
    const carried = evidence?.bundles[0];
    expect(Reflect.set(carried ?? {}, "bytes", new Uint8Array([1]))).toBe(false);
    const handedBundle = carried?.bytes ?? new Uint8Array();
    handedBundle[0] = (handedBundle[0] ?? 0) ^ 0xff;
    expect(Buffer.from(carried?.bytes ?? new Uint8Array()).toString("hex")).toBe(
      Buffer.from(sealedBundle).toString("hex"),
    );
  });

  it("C8 holds the semantic invariants a live run holds", function* () {
    const directory = yield* useArtifactDirectory();
    const { path } = yield* sealed(directory);

    const stopReason = yield* damaged(path, join(directory, "stop-reason.xmd"), (target) => {
      const run = storedRecord(path, "workflow-run", "null");
      rewrite(
        target,
        "workflow-run",
        "null",
        canonicalJsonText({
          ...run,
          stopReason: { kind: "journal", eventId: "no-such-event" },
        }),
      );
    });
    const currentRoot = yield* damaged(path, join(directory, "current-root.xmd"), (target) => {
      const frontier = storedRecord(path, "artifact-frontier", "null");
      rewrite(
        target,
        "artifact-frontier",
        "null",
        canonicalJsonText({ ...frontier, currentWorkspaceRootId: "1".repeat(64) }),
      );
    });
    const frontierEvent = yield* damaged(path, join(directory, "frontier-event.xmd"), (target) => {
      const frontier = storedRecord(path, "artifact-frontier", "null");
      rewrite(
        target,
        "artifact-frontier",
        "null",
        canonicalJsonText({ ...frontier, finalEventId: "event-0" }),
      );
    });
    const rootReferences = yield* damaged(
      path,
      join(directory, "root-references.xmd"),
      (target) => {
        const rootId = rootIdentities(path)[0]!;
        const root = storedRecord(path, "workspace-root", rootId);
        rewrite(target, "workspace-root", rootId, canonicalJsonText({ ...root, blobHashes: [] }));
      },
    );
    const blobBytes = yield* damaged(path, join(directory, "blob-bytes.xmd"), (target) => {
      const identity = firstIdentity(path, "dofs-blob-bytes");
      // Kept self-consistent about its own bytes, so what refuses it is the
      // DOFS record that says what those bytes were supposed to hash to.
      rewrite(target, "dofs-blob-bytes", identity, "different bytes entirely");
    });
    const worktreeRelation = yield* damaged(path, join(directory, "worktree.xmd"), (target) => {
      const identity = firstIdentity(path, "workspace-worktree");
      const worktree = storedRecord(path, "workspace-worktree", identity);
      target
        .prepare("DELETE FROM xmd_artifact_content WHERE kind = ? AND identity = ?")
        .run("workspace-worktree", identity);
      const replaced = { ...worktree, repositoryName: "absent" };
      const content = encoder.encode(canonicalJsonText(replaced));
      target
        .prepare(
          "INSERT INTO xmd_artifact_content (kind, identity, encoding, length, sha256, content) " +
            "VALUES ('workspace-worktree', ?, 'canonical-json', ?, ?, ?)",
        )
        .run(
          canonicalJsonText(["absent", String(worktree["name"])]),
          content.byteLength,
          sha256Hex(content),
          content,
        );
    });
    // Every way a retained answer can fail to be an answer to the history it
    // names. Each rewrites one member of one row and leaves the rest of the
    // artifact exactly as it was.
    const answerIdentity = (suspension: "consumed" | "pending"): string =>
      canonicalJsonText(
        suspension === "consumed" ? SUSPENSIONS.consumed.id : SUSPENSIONS.pending.id,
      );
    const damageAnswer = (
      name: string,
      suspension: "consumed" | "pending",
      edit: (answer: JsonObject) => JsonObject,
    ) =>
      damaged(path, join(directory, name), (target) => {
        const identity = answerIdentity(suspension);
        rewrite(
          target,
          "suspension-answer",
          identity,
          canonicalJsonText(edit(storedRecord(path, "suspension-answer", identity))),
        );
      });

    const suspensionRequest = yield* damageAnswer("suspension-absent.xmd", "pending", (answer) => ({
      ...answer,
      requestEventId: "no-such-event",
    }));
    // event-4 is the retained Git effect: a real event, and not a wait.
    const suspensionNotARequest = yield* damageAnswer(
      "suspension-not-a-request.xmd",
      "pending",
      (answer) => ({ ...answer, requestEventId: "event-4" }),
    );
    // event-1 is the *other* wait's request: a real suspension request, for
    // somebody else.
    const suspensionWrongWait = yield* damageAnswer(
      "suspension-wrong-wait.xmd",
      "pending",
      (answer) => ({ ...answer, requestEventId: "event-1" }),
    );
    const suspensionFingerprint = yield* damageAnswer(
      "suspension-fingerprint.xmd",
      "pending",
      (answer) => ({ ...answer, requestFingerprint: "c".repeat(64) }),
    );
    // The pending wait's schema is `{"type":"string"}`.
    const suspensionSchema = yield* damageAnswer("suspension-schema.xmd", "pending", (answer) => ({
      ...answer,
      answer: { not: "a string" },
    }));
    const suspensionUnpublished = yield* damageAnswer(
      "suspension-unpublished.xmd",
      "pending",
      (answer) => ({ ...answer, state: "consumed", consumedAt: "2026-01-02T03:45:00.000Z" }),
    );
    const suspensionAlreadyPublished = yield* damageAnswer(
      "suspension-already-published.xmd",
      "consumed",
      (answer) => {
        const { consumedAt: _consumed, ...rest } = answer;
        return { ...rest, state: "pending" };
      },
    );
    // The publication side. Each rewrites the retained record of the answer
    // event this run published, leaving the row that points at it untouched, so
    // what refuses them is the authentication of the publication itself.
    const damagePublication = (name: string, edit: (event: JsonObject) => JsonObject) =>
      damaged(path, join(directory, name), (target) => {
        const identity = canonicalJsonText("event-6");
        const published = parseJsonObject(
          JSON.parse(storedText(path, "journal-record", identity)),
          "$",
          (reason) => new Error(`the published answer ${reason}`),
        );
        rewrite(target, "journal-record", identity, JSON.stringify(edit(published)));
      });

    const publicationIdentity = yield* damagePublication("publication-identity.xmd", (event) => ({
      ...event,
      description: {
        ...parsedObject(event["description"]),
        suspensionId: SUSPENSIONS.pending.id,
      },
    }));
    const publicationPosition = yield* damagePublication("publication-position.xmd", (event) => ({
      ...event,
      // Another coroutine entirely, where the yield behind it is the retained
      // Git effect rather than the request it claims to answer.
      coroutineId: "root.0",
    }));
    const publicationFailed = yield* damagePublication("publication-failed.xmd", (event) => ({
      ...event,
      result: { status: "err", error: { message: "the wait was never ended" } },
    }));
    const publicationValue = yield* damagePublication("publication-value.xmd", (event) => ({
      ...event,
      result: { status: "ok", value: { approved: false } },
    }));
    // The inherited publication rewritten to claim this run's answered wait:
    // two publications for one wait, and one of them nowhere near its request.
    const publicationDuplicate = yield* damaged(
      path,
      join(directory, "publication-duplicate.xmd"),
      (target) => {
        const identity = canonicalJsonText("event-2");
        const published = parseJsonObject(
          JSON.parse(storedText(path, "journal-record", identity)),
          "$",
          (reason) => new Error(`the published answer ${reason}`),
        );
        rewrite(
          target,
          "journal-record",
          identity,
          JSON.stringify({
            ...published,
            description: {
              type: "suspension_answer",
              name: SUSPENSIONS.consumed.id,
              suspensionId: SUSPENSIONS.consumed.id,
            },
          }),
        );
      },
    );
    // A publication for a wait no request in this artifact ever opened.
    const publicationStray = yield* damaged(
      path,
      join(directory, "publication-stray.xmd"),
      (target) => {
        const identity = canonicalJsonText("event-2");
        const published = parseJsonObject(
          JSON.parse(storedText(path, "journal-record", identity)),
          "$",
          (reason) => new Error(`the published answer ${reason}`),
        );
        rewrite(
          target,
          "journal-record",
          identity,
          JSON.stringify({
            ...published,
            description: {
              type: "suspension_answer",
              name: "0".repeat(32),
              suspensionId: "0".repeat(32),
            },
          }),
        );
      },
    );

    const agentMapping = yield* damaged(path, join(directory, "agent.xmd"), (target) => {
      const identity = firstIdentity(path, "agent-session");
      const session = storedRecord(path, "agent-session", identity);
      rewrite(
        target,
        "agent-session",
        identity,
        canonicalJsonText({ ...session, sessionIdentity: "somebody else's session" }),
      );
    });
    const closureHash = yield* damaged(path, join(directory, "closure.xmd"), (target) => {
      rewrite(target, "definition-source-root-content", "null", "# A different document\n");
    });
    const closureMembership = yield* damaged(path, join(directory, "membership.xmd"), (target) => {
      const identity = canonicalJsonText("Unused");
      target
        .prepare("DELETE FROM xmd_artifact_content WHERE kind = ? AND identity = ?")
        .run("definition-source-component", identity);
      target
        .prepare("DELETE FROM xmd_artifact_content WHERE kind = ? AND identity = ?")
        .run("definition-source-component-content", identity);
    });

    const corruptions = [
      stopReason,
      currentRoot,
      frontierEvent,
      rootReferences,
      blobBytes,
      worktreeRelation,
      suspensionRequest,
      suspensionNotARequest,
      suspensionWrongWait,
      suspensionFingerprint,
      suspensionSchema,
      suspensionUnpublished,
      suspensionAlreadyPublished,
      publicationIdentity,
      publicationPosition,
      publicationFailed,
      publicationValue,
      publicationDuplicate,
      publicationStray,
      agentMapping,
      closureHash,
      closureMembership,
    ];
    // Two the writer must refuse outright. Neither can be produced by damaging
    // a sealed file, because a sealed file is one this build already accepted —
    // these are snapshots that would otherwise be written and given a canonical
    // identity, so the refusal has to happen before any container exists.
    const unwritable: readonly (readonly [string, DetachedXmdArtifact])[] = [
      // An inherited request agreeing with its adjacent publication about the
      // wait's name and disagreeing about its identity. No answer row points at
      // it, so only the structural pairing can catch it.
      [
        "inherited-identity.xmd",
        withRecords(richArtifact(), {
          "event-1": {
            ...SUSPENSIONS.inherited.request,
            description: {
              ...SUSPENSIONS.inherited.request.description,
              suspensionId: "9".repeat(32),
            },
          },
        }),
      ],
      // A wait whose identity is forged consistently: the request it was
      // published as, the answer published behind it, and the row that points
      // at both all agree. Nothing compares them to each other any more; what
      // refuses it is that no position in this run derives that identity.
      ["forged-answered.xmd", forgedOwnWait("f".repeat(32))],
      // The same forgery on the wait this run is stopped at, with its retained
      // row removed — so no answer row and no publication reaches the request,
      // and only holding the request itself to its position can catch it.
      ["forged-unanswered.xmd", forgedUnansweredWait("e".repeat(32))],
      // A consumed answer of `null`, published as a success that carries no
      // value at all. Normalizing the absent member to null would read these
      // two different histories as one.
      ["valueless-publication.xmd", valuelessConsumedAnswer()],
    ];

    for (const [name, snapshot] of unwritable) {
      const written = yield* writeXmdArtifact(join(directory, name), snapshot);
      expect(written.ok).toBe(false);
      expect(written.ok ? "" : written.error.name).toBe("XmdArtifactInventoryError");
      // Refused before a container is accepted, so nothing is left behind.
      expect(yield* exists(join(directory, name))).toBe(false);
    }

    // Each refusal is named, because the manifest comparison that runs after
    // these gates would refuse every one of them too — and a suite that only
    // asked "did it fail" could not tell which check was doing the work.
    const outcomes: string[] = [];
    for (const candidate of corruptions) {
      outcomes.push((yield* refused(candidate)).name);
    }
    expect(outcomes).toEqual(corruptions.map(() => "XmdArtifactInventoryError"));
  });

  // deno-lint-ignore require-yield
  it("C9 keeps the private encoding out of every published entrypoint", function* () {
    const surfaces = [Object.entries(publishedDeno), Object.entries(publishedRoot)];
    const encodingNames =
      /^(XMD_ARTIFACT_|readXmdArtifact|writeXmdArtifact|initializeXmdArtifactSchema|verifyXmdArtifact)/;
    for (const surface of surfaces) {
      for (const [name, value] of surface) {
        expect(encodingNames.test(name)).toBe(false);
        if (typeof value === "string") {
          expect(value.includes("xmd_artifact_")).toBe(false);
          expect(value.includes("CREATE TABLE")).toBe(false);
        }
      }
    }
    // Stated as a fact about what is reachable, not about what was imported:
    // an entrypoint that grew an artifact export would fail here.
    expect(Object.keys(publishedDeno).some((name) => name.toLowerCase().includes("artifact"))).toBe(
      false,
    );
    expect(Object.keys(publishedRoot).some((name) => name.toLowerCase().includes("artifact"))).toBe(
      false,
    );
  });
});

/**
 * Tier XA — version 1, finalized with Agent portability evidence.
 *
 * The container, its identity domain and its verifier are the ones C1–C9
 * already hold; what is new is that a sealed artifact says, for every logical
 * Agent session that contributed a retained Prompt, either how a fork would
 * continue it or exactly why nothing could. So these cases are about the two
 * profiles version 1 now has: that merged legacy artifacts still open and gain
 * nothing, that a finalized one is total, and that the confidential bytes it
 * carries stay bytes.
 */
describe("XMD artifact version 1 Agent portability evidence", () => {
  it("F2 makes every Agent term and retained byte part of the identity", function* () {
    const base = finalizedArtifact();
    const baseline = derivedIdentity(base);
    const portable = portableOf(base);
    const evidence = base.agentEvidence;
    const flipped = agentBundle();
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;

    // Encoding participation, not semantic validity: what is being asked is
    // whether one changed term reaches the manifest, and a term that only
    // reached it in valid combinations would not be part of the identity.
    const variations: readonly (readonly [string, DetachedXmdArtifact])[] = [
      [
        "sessionKey",
        mutatedPortable((record) => ({ ...record, sessionKey: `${record.sessionKey}x` })),
      ],
      [
        "sessionIdentity",
        mutatedPortable((record) => ({ ...record, sessionIdentity: `${record.sessionIdentity}x` })),
      ],
      ["provider", mutatedPortable((record) => ({ ...record, provider: "other" }))],
      ["agentCommand", mutatedPortable((record) => ({ ...record, agentCommand: "other" }))],
      ["policy", mutatedPortable((record) => ({ ...record, policy: "allow-all" }))],
      ["bundleKind", mutatedPortable((record) => ({ ...record, bundleKind: "other" }))],
      ["compatibilityId", mutatedPortable((record) => ({ ...record, compatibilityId: "other" }))],
      [
        "identityAllocationMode",
        mutatedPortable((record) => ({ ...record, identityAllocationMode: "caller-allocated" })),
      ],
      [
        "bundleLength",
        mutatedPortable((record) => ({ ...record, bundleLength: record.bundleLength + 1 })),
      ],
      ["bundleSha256", mutatedPortable((record) => ({ ...record, bundleSha256: "0".repeat(64) }))],
      [
        "sourceProviderSession.kind",
        mutatedPortable((record) => ({
          ...record,
          sourceProviderSession: { ...record.sourceProviderSession, kind: "other/kind" },
        })),
      ],
      [
        "sourceProviderSession.value",
        mutatedPortable((record) => ({
          ...record,
          sourceProviderSession: { ...record.sourceProviderSession, value: "other-value" },
        })),
      ],
      [
        "bundledProviderSession.kind",
        mutatedPortable((record) => ({
          ...record,
          bundledProviderSession: { ...record.bundledProviderSession, kind: "other/kind" },
        })),
      ],
      [
        "bundledProviderSession.value",
        mutatedPortable((record) => ({
          ...record,
          bundledProviderSession: { ...record.bundledProviderSession, value: "other-value" },
        })),
      ],
      [
        "association.eventId",
        mutatedPortable((record) => ({
          ...record,
          associations: record.associations.map((association, index) =>
            index === 0 ? { ...association, eventId: "event-0" } : association,
          ),
        })),
      ],
      [
        "association.tokenKind",
        mutatedPortable((record) => ({
          ...record,
          associations: record.associations.map((association, index) =>
            index === 0 ? { ...association, tokenKind: "other/kind" } : association,
          ),
        })),
      ],
      [
        "association.token",
        mutatedPortable((record) => ({
          ...record,
          associations: record.associations.map((association, index) =>
            index === 0 ? { ...association, token: "other-token" } : association,
          ),
        })),
      ],
      [
        "association order",
        mutatedPortable((record) => ({
          ...record,
          associations: [...record.associations].reverse(),
        })),
      ],
      [
        "availability",
        mutatedPortable((record) => ({
          sessionKey: record.sessionKey,
          sessionIdentity: record.sessionIdentity,
          provider: record.provider,
          agentCommand: record.agentCommand,
          policy: record.policy,
          associations: record.associations,
          availability: "unavailable",
          reason: "provider-capability-unavailable",
        })),
      ],
      [
        "reason",
        mutatedUnavailable("checkpoint-token-unavailable", (record) => ({
          ...record,
          reason: "provider-capability-unavailable",
        })),
      ],
      [
        "one bundle byte",
        evidenced(base, evidence?.portability ?? [], [
          { sessionKey: portable.sessionKey, bytes: flipped },
        ]),
      ],
    ];

    // The evidence takes part at all: the same snapshot without it is a
    // different artifact.
    const { agentEvidence: _dropped, ...legacy } = base;
    expect(derivedIdentity(legacy)).not.toBe(baseline);

    const derived = variations.map(
      ([name, contents]) => [name, derivedIdentity(contents)] as const,
    );
    // Named rather than counted, so a term that stopped participating says
    // which one it was.
    expect(derived.filter(([, identity]) => identity === baseline).map(([name]) => name)).toEqual(
      [],
    );
    expect(new Set([baseline, ...derived.map(([, identity]) => identity)]).size).toBe(
      variations.length + 1,
    );
  });

  it("F3 opens both frozen historical artifacts and synthesizes nothing", function* () {
    // Bytes an earlier reader and writer actually emitted, generated once at
    // the commits named beside them and never regenerated by this build.
    const historical = [
      {
        name: "the merged PR #610 writer, from richArtifact()",
        generatedAt: "b952af602437e0c1db2137a74453504ae7541da5",
        path: fileURLToPath(new URL("./fixtures/legacy-v1-610.xmd", import.meta.url)),
        fileSha256: "bc812c577bbeebcf4801d29ac0d1fdf5eaf1d7e4d0b2c64e51f3f6867f46bfa8",
        identity: "02dc7d81e0cd6c4712a4f9aeb2b38535c641cd8658f16dd212caf4993bfc74ca",
        runId: "release-1.4",
        status: "suspended",
        journal: 8,
        finalEventId: "event-7",
      },
      {
        name: "the PR #615 head, through `xmd workflow export`",
        generatedAt: "0962ea2d69abab66c5ad39ea06ea931ae0a93f8a",
        path: fileURLToPath(new URL("./fixtures/legacy-v1-615-export.xmd", import.meta.url)),
        fileSha256: "520bb74ee4edd70d7fecd5077acdd7c2cd4b79b6551f7cd0aa122dc9920a42e3",
        identity: "c1857b0dd95724adf0a28a22de3c47da6698943c33a50fa11e3e4875ecc686ef",
        runId: "release-1",
        status: "completed",
        journal: 6,
        finalEventId: "c64f8a11-5d7e-4151-867a-833ff7255cb4",
      },
    ];

    for (const frozen of historical) {
      expect(sha256Hex(yield* until(readFile(frozen.path)))).toBe(frozen.fileSha256);
      const read = yield* opened(frozen.path);
      expect(read.identity).toBe(frozen.identity);
      expect(read.run.runId).toBe(frozen.runId);
      expect(read.run.status).toBe(frozen.status);
      expect(read.journal.length).toBe(frozen.journal);
      expect(read.frontier.finalEventId).toBe(frozen.finalEventId);
      expect(read.definition.root.content.length).toBeGreaterThan(0);
      // No record, no token, no bundle and no marker is reconstructed for it.
      expect(read.agentEvidence).toBeUndefined();
      expect(rowsOfKind(frozen.path, "agent-session-portability")).toBe(0);
      expect(rowsOfKind(frozen.path, "agent-session-bundle-bytes")).toBe(0);
    }

    // A legacy artifact that does hold retained Prompts: the sessions stay
    // unclassified, because merged legacy V1 never promised a classification.
    const directory = yield* useArtifactDirectory();
    const { agentEvidence: _dropped, ...legacy } = finalizedArtifact();
    const { path } = yield* sealed(directory, "legacy-prompts.xmd", legacy);
    const read = yield* opened(path);
    expect(read.agentEvidence).toBeUndefined();
    expect(read.journal.length).toBe(finalizedArtifact().journal.length);
    expect(read.agentSessions.length).toBe(4);
    expect(read.journal.filter((row) => row.record.includes("agent_prompt")).length).toBe(5);
  });

  it("F4 classifies every session or refuses the file", function* () {
    const directory = yield* useArtifactDirectory();
    const contents = finalizedArtifact();
    const { path } = yield* sealed(directory, "finalized.xmd", contents);

    const read = yield* opened(path);
    const byKey = (records: readonly XmdArtifactAgentPortability[]) =>
      [...records].sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
    expect(byKey(read.agentEvidence?.portability ?? [])).toEqual(
      byKey(contents.agentEvidence?.portability ?? []),
    );
    expect(portableOf(read).associations.map((association) => association.token)).toEqual([
      CHECKPOINT_TOKENS.portableFirst,
      CHECKPOINT_TOKENS.portableSecond,
    ]);
    expect(read.agentEvidence?.bundles.length).toBe(1);

    const portableKey = FINALIZED_SESSIONS.portable.sessionKey;
    const incompleteKey = FINALIZED_SESSIONS.incomplete.sessionKey;
    const uncapturedKey = FINALIZED_SESSIONS.uncaptured.sessionKey;
    const idle = richArtifact().agentSessions[0];
    if (idle === undefined) {
      throw new Error("the rich snapshot retains no Agent session mapping");
    }
    const promptless = {
      sessionKey: idle.sessionKey,
      sessionIdentity: idle.sessionIdentity,
      provider: idle.provider,
      agentCommand: idle.agentCommand,
      policy: idle.policy,
      associations: [],
      availability: "unavailable",
      reason: "provider-capability-unavailable",
    };

    const turns = contents.journal.slice(richArtifact().journal.length).map((row) => row.eventId);
    const firstTurn = turns[0] ?? "";
    const secondTurn = turns[1] ?? "";
    const incompleteTurn = turns[2] ?? "";
    const failedTurn = turns[3] ?? "";

    const withAssociations = (key: string, change: (associations: JsonObject[]) => JsonObject[]) =>
      editPortability(path, key, (record) => ({
        ...record,
        associations: change(storedAssociations(record)),
      }));

    const cases: readonly (readonly [string, string, (database: DatabaseSync) => void])[] = [
      [
        "nothing classified beside retained bundle bytes",
        "XmdArtifactInventoryError",
        (database) => {
          for (const key of [portableKey, incompleteKey, uncapturedKey]) {
            dropRow(database, PORTABILITY_KIND, canonicalJsonText(key));
          }
        },
      ],
      [
        "one Prompt-contributing session unclassified",
        "XmdArtifactInventoryError",
        (database) => dropRow(database, PORTABILITY_KIND, canonicalJsonText(incompleteKey)),
      ],
      [
        "a record for a session that retained no Prompt",
        "XmdArtifactInventoryError",
        (database) =>
          insertRow(
            database,
            PORTABILITY_KIND,
            idle.sessionKey,
            "canonical-json",
            encoder.encode(canonicalJsonText(promptless)),
          ),
      ],
      [
        "bundle bytes for a session that retained no Prompt",
        "XmdArtifactInventoryError",
        (database) =>
          insertRow(database, BUNDLE_KIND, idle.sessionKey, "bytes", encoder.encode("orphan")),
      ],
      [
        "a record stored under another session's identity",
        "XmdArtifactInventoryError",
        editPortability(path, portableKey, (record) => ({ ...record, sessionKey: incompleteKey })),
      ],
      [
        "a record missing a member the union declares",
        "XmdArtifactRecordError",
        editPortability(path, portableKey, (record) => without(record, "policy")),
      ],
      [
        "an association carrying an empty token",
        "XmdArtifactRecordError",
        withAssociations(portableKey, (associations) =>
          associations.map((association, index) =>
            index === 0 ? { ...association, token: "" } : association,
          ),
        ),
      ],
      [
        "an availability the union does not declare",
        "XmdArtifactRecordError",
        editPortability(path, portableKey, (record) => ({ ...record, availability: "maybe" })),
      ],
      [
        "an unavailable reason the union does not declare",
        "XmdArtifactRecordError",
        editPortability(path, incompleteKey, (record) => ({ ...record, reason: "unknown" })),
      ],
      [
        "an identity allocation mode the union does not declare",
        "XmdArtifactRecordError",
        editPortability(path, portableKey, (record) => ({
          ...record,
          identityAllocationMode: "host-allocated",
        })),
      ],
      [
        "a portable record carrying an unavailable member",
        "XmdArtifactRecordError",
        editPortability(path, portableKey, (record) => ({
          ...record,
          reason: "provider-capability-unavailable",
        })),
      ],
      [
        "an unavailable record carrying a portable member",
        "XmdArtifactRecordError",
        editPortability(path, incompleteKey, (record) => ({
          ...record,
          bundleKind: "acp/session-bundle",
        })),
      ],
      [
        "a record disagreeing with the mapping it classifies",
        "XmdArtifactInventoryError",
        editPortability(path, portableKey, (record) => ({ ...record, policy: "allow-all" })),
      ],
      [
        "a portable record naming a source session nobody asserted",
        "XmdArtifactInventoryError",
        editPortability(path, portableKey, (record) => ({
          ...record,
          sourceProviderSession: { kind: "acp/sessionId", value: "sess_other" },
        })),
      ],
      [
        "a retained Prompt whose session mapping is gone",
        "XmdArtifactInventoryError",
        (database) => dropRow(database, "agent-session", canonicalJsonText(portableKey)),
      ],
      [
        "a dangling association",
        "XmdArtifactInventoryError",
        withAssociations(portableKey, (associations) =>
          associations.map((association, index) =>
            index === 0 ? { ...association, eventId: "event-999" } : association,
          ),
        ),
      ],
      [
        "a repeated association",
        "XmdArtifactInventoryError",
        withAssociations(portableKey, (associations) => [
          associations[0] ?? {},
          associations[0] ?? {},
        ]),
      ],
      [
        "reordered associations",
        "XmdArtifactInventoryError",
        withAssociations(portableKey, (associations) => [...associations].reverse()),
      ],
      [
        "an association naming an event that is not a Prompt",
        "XmdArtifactInventoryError",
        withAssociations(portableKey, (associations) =>
          associations.map((association, index) =>
            index === 0 ? { ...association, eventId: "event-0" } : association,
          ),
        ),
      ],
      [
        "an association naming another session's Prompt",
        "XmdArtifactInventoryError",
        withAssociations(portableKey, (associations) =>
          associations.map((association, index) =>
            index === 1 ? { ...association, eventId: incompleteTurn } : association,
          ),
        ),
      ],
      [
        "an association naming a Prompt that failed",
        "XmdArtifactInventoryError",
        withAssociations(incompleteKey, (associations) => [
          ...associations,
          { eventId: failedTurn, tokenKind: "acp/checkpoint", token: "checkpoint-canary-eps-2f7" },
        ]),
      ],
      [
        "an association naming a Prompt that was cancelled",
        "XmdArtifactInventoryError",
        (database) => {
          const identity = canonicalJsonText(failedTurn);
          const event = parsedObject(JSON.parse(storedText(path, "journal-record", identity)));
          const result = parsedObject(event["result"]);
          const record = parsedObject(result["value"]);
          rewrite(
            database,
            "journal-record",
            identity,
            JSON.stringify({
              ...event,
              result: { ...result, value: { ...record, status: "cancelled" } },
            }),
          );
          withAssociations(incompleteKey, (associations) => [
            ...associations,
            {
              eventId: failedTurn,
              tokenKind: "acp/checkpoint",
              token: "checkpoint-canary-zeta-6b1",
            },
          ])(database);
        },
      ],
      [
        "a portable record that covers only some of its Prompts",
        "XmdArtifactInventoryError",
        withAssociations(portableKey, (associations) => associations.slice(0, 1)),
      ],
      [
        "an unavailable record claiming a capability reason it cannot have",
        "XmdArtifactInventoryError",
        editPortability(path, incompleteKey, (record) => ({
          ...record,
          reason: "provider-capability-unavailable",
        })),
      ],
      [
        "an unavailable record claiming intrinsic loss it does not have",
        "XmdArtifactInventoryError",
        editPortability(path, uncapturedKey, (record) => ({
          ...record,
          reason: "checkpoint-token-unavailable",
        })),
      ],
      [
        "a portable record with no bundle",
        "XmdArtifactInventoryError",
        (database) => dropRow(database, BUNDLE_KIND, canonicalJsonText(portableKey)),
      ],
      [
        "an unavailable record carrying bundle bytes",
        "XmdArtifactInventoryError",
        (database) =>
          insertRow(database, BUNDLE_KIND, incompleteKey, "bytes", encoder.encode("captured")),
      ],
      [
        "a bundle length that is not the bytes",
        "XmdArtifactInventoryError",
        editPortability(path, portableKey, (record) => ({
          ...record,
          bundleLength: agentBundle().byteLength + 1,
        })),
      ],
      [
        "a bundle hash that is not the bytes",
        "XmdArtifactInventoryError",
        editPortability(path, portableKey, (record) => ({
          ...record,
          bundleSha256: "0".repeat(64),
        })),
      ],
      [
        "a bundle hash in upper case",
        "XmdArtifactRecordError",
        editPortability(path, portableKey, (record) => ({
          ...record,
          bundleSha256: sha256Hex(agentBundle()).toUpperCase(),
        })),
      ],
      [
        "a bundle byte that changed",
        "XmdArtifactInventoryError",
        (database) => {
          const bytes = agentBundle();
          bytes[0] = (bytes[0] ?? 0) ^ 0xff;
          rewriteBytes(database, BUNDLE_KIND, canonicalJsonText(portableKey), bytes);
        },
      ],
    ];

    // The reseal is not what refuses these: an undamaged copy, sealed again
    // over exactly the rows it already held, still opens under its own identity.
    const control = yield* resealed(path, join(directory, "resealed.xmd"), (database) => {
      database.exec("PRAGMA user_version = 1");
    });
    expect((yield* opened(control)).identity).toBe(read.identity);

    const outcomes: string[] = [];
    for (const [index, [name, , damage]] of cases.entries()) {
      const target = yield* resealed(path, join(directory, `f4-${index}.xmd`), damage);
      const failure = yield* refused(target);
      outcomes.push(`${name}: ${failure.name}`);
      // A refusal returns no value at all, never a partial projection.
      expect(yield* readXmdArtifact(target)).toMatchObject({ ok: false });
    }
    expect(outcomes).toEqual(cases.map(([name, expected]) => `${name}: ${expected}`));

    // The same edit, without recomputing the header: the comparison that runs
    // before any profile interpretation is what answers, and it says so.
    const stale = yield* damaged(
      path,
      join(directory, "stale.xmd"),
      editPortability(path, portableKey, (record) => ({ ...record, policy: "allow-all" })),
    );
    expect((yield* refused(stale)).name).toBe("XmdArtifactManifestMismatchError");

    // Two things no file can hold, because the container's own key merges them.
    // A caller's snapshot can still offer them, so the writer refuses before a
    // container exists.
    const evidence = contents.agentEvidence;
    const twice: readonly (readonly [string, DetachedXmdArtifact])[] = [
      [
        "record-twice.xmd",
        evidenced(
          contents,
          [...(evidence?.portability ?? []), portableOf(contents)],
          evidence?.bundles ?? [],
        ),
      ],
      [
        "bundle-twice.xmd",
        evidenced(contents, evidence?.portability ?? [], [
          ...(evidence?.bundles ?? []),
          { sessionKey: portableKey, bytes: agentBundle() },
        ]),
      ],
    ];
    for (const [name, snapshot] of twice) {
      const written = yield* writeXmdArtifact(join(directory, name), snapshot);
      expect(written.ok ? "" : written.error.name).toBe("XmdArtifactInventoryError");
      expect(yield* exists(join(directory, name))).toBe(false);
    }
  });

  it("F5 identifies finalized evidence rather than the file it sits in", function* () {
    const directory = yield* useArtifactDirectory();
    const room = join(directory, "room");
    yield* until(mkdir(room));
    const contents = finalizedArtifact();

    const compact = yield* XmdArtifactContainerLayout.with({ pageSize: 512 }, function* () {
      return yield* sealed(room, "compact.xmd", contents);
    });
    const roomy = yield* XmdArtifactContainerLayout.with(
      { pageSize: 8192, vacuum: true },
      function* () {
        return yield* sealed(room, "roomy.xmd", contents);
      },
    );
    expect(roomy.result.identity).toBe(compact.result.identity);
    expect(roomy.result.fileSha256).not.toBe(compact.result.fileSha256);

    const before = yield* fingerprint(compact.path, room);
    yield* until(chmod(room, 0o555));
    yield* ensure(() => until(chmod(room, 0o755)));
    yield* opened(compact.path);
    const after = yield* fingerprint(compact.path, room);
    expect(after).toEqual(before);
    for (const suffix of ["-journal", "-wal", "-shm", ".lock"]) {
      expect(after.siblings.some((name) => name.endsWith(suffix))).toBe(false);
    }
  });

  it("F6 admits no host authority into a descriptor and keeps bundles opaque", function* () {
    const directory = yield* useArtifactDirectory();
    const { path } = yield* sealed(directory, "finalized.xmd", finalizedArtifact());
    const portableKey = FINALIZED_SESSIONS.portable.sessionKey;

    // Exact-schema exclusion rather than payload inspection: each of these is
    // an unknown descriptor member, and `session_options.env` is refused as one
    // rather than by anybody looking at what it holds.
    const forbidden: readonly (readonly [string, JsonObject])[] = [
      ["credential", { credential: "whatever this host holds" }],
      ["endpoint", { endpoint: "https://provider.invalid/sessions" }],
      ["session_options", { session_options: { env: { HOME: "/home/exporter" } } }],
      ["liveStore", { liveStore: "provider-session-store" }],
      ["hostPath", { hostPath: "/home/exporter/.agent" }],
    ];
    const outcomes: string[] = [];
    for (const [index, [name, member]] of forbidden.entries()) {
      const target = yield* resealed(
        path,
        join(directory, `f6-${index}.xmd`),
        editPortability(path, portableKey, (record) => ({ ...record, ...member })),
      );
      outcomes.push(`${name}: ${(yield* refused(target)).name}`);
    }
    expect(outcomes).toEqual(forbidden.map(([name]) => `${name}: XmdArtifactRecordError`));

    // The payload itself is never scanned and never scrubbed, so both canaries
    // come back exactly — and one changed byte is a different bundle.
    const read = yield* opened(path);
    const carried = new TextDecoder().decode(
      read.agentEvidence?.bundles[0]?.bytes ?? new Uint8Array(),
    );
    expect(carried).toContain(BUNDLE_SECRET_CANARY);
    expect(carried).toContain(BUNDLE_PATH_CANARY);
    expect(Buffer.from(read.agentEvidence?.bundles[0]?.bytes ?? []).toString("hex")).toBe(
      Buffer.from(agentBundle()).toString("hex"),
    );
    const flipped = agentBundle();
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(sha256Hex(flipped)).not.toBe(sha256Hex(agentBundle()));
  });
});

describe("XMD artifact writer", () => {
  it("refuses a destination it would have to replace, and cleans up after itself", function* () {
    const directory = yield* useArtifactDirectory();
    const { path } = yield* sealed(directory);

    const again = yield* writeXmdArtifact(path, richArtifact());
    expect(again.ok).toBe(false);
    expect(again.ok ? "" : again.error.name).toBe("XmdArtifactDestinationError");

    const wrongName = yield* writeXmdArtifact(join(directory, "evidence.db"), richArtifact());
    expect(wrongName.ok ? "" : wrongName.error.name).toBe("XmdArtifactDestinationError");

    // A snapshot this build could not read back creates nothing at all.
    const broken = richArtifact();
    const target = join(directory, "never.xmd");
    const refusal = yield* writeXmdArtifact(target, {
      ...broken,
      frontier: { ...broken.frontier, finalEventId: "event-0" },
    });
    expect(refusal.ok).toBe(false);
    expect(yield* exists(target)).toBe(false);
  });
});

/** Every Workspace root identity the artifact stores, in canonical order. */
function rootIdentities(path: string): string[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT identity FROM xmd_artifact_content WHERE kind = 'workspace-root' ORDER BY identity",
      )
      .all()
      .map((row) => textColumn(row, "identity"));
  } finally {
    database.close();
  }
}

function firstIdentity(path: string, kind: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT identity FROM xmd_artifact_content WHERE kind = ? ORDER BY identity")
      .get(kind);
    return textColumn(row, "identity");
  } finally {
    database.close();
  }
}

/**
 * A container carrying version 1's marker and a table shaped differently.
 *
 * Built rather than edited because SQLite will not let a connection rewrite a
 * `CREATE TABLE` statement in place, and a schema that drifted is exactly what
 * exact structural recognition exists to catch.
 */
function handBuiltContainer(path: string): string {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA application_id = ${XMD_ARTIFACT_APPLICATION_ID}`);
    database.exec(`CREATE TABLE xmd_artifact_header (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  artifact_version INTEGER NOT NULL,
  container_version INTEGER NOT NULL,
  manifest BLOB NOT NULL,
  identity TEXT NOT NULL
) STRICT`);
    database.exec(`CREATE TABLE xmd_artifact_content (
  kind TEXT NOT NULL,
  identity TEXT NOT NULL,
  encoding TEXT NOT NULL,
  length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (kind, identity)
) STRICT, WITHOUT ROWID`);
    database
      .prepare(
        "INSERT INTO xmd_artifact_header (id, artifact_version, container_version, manifest, " +
          "identity) VALUES (1, 1, 1, ?, ?)",
      )
      .run(encoder.encode("{}"), createHash("sha256").update("").digest("hex"));
    database.exec("PRAGMA user_version = 1");
  } finally {
    database.close();
  }
  return path;
}

/** Every own property of a returned graph, by name and value. */
function walk(
  value: unknown,
  visit: (key: string, value: unknown) => void,
  seen = new Set(),
): void {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const member: unknown = Reflect.get(value, key);
    visit(String(key), member);
    walk(member, visit, seen);
  }
}
