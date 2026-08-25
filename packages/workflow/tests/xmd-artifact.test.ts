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
import { DatabaseSync } from "node:sqlite";
import { readXmdArtifact, writeXmdArtifact } from "../src/deno/artifact/mod.ts";
import type {
  DetachedXmdArtifact,
  VerifiedXmdArtifact,
  XmdArtifactWriteResult,
} from "../src/deno/artifact/mod.ts";
import { XmdArtifactContainerLayout } from "../src/deno/artifact/write.ts";
import { canonicalJsonText, sha256Hex } from "../src/deno/artifact/manifest.ts";
import { XMD_ARTIFACT_APPLICATION_ID } from "../src/deno/artifact/schema.ts";
import { APPLICATION_ID as LIVE_RUN_APPLICATION_ID } from "../src/deno/schema.ts";
import * as publishedDeno from "../deno.ts";
import * as publishedRoot from "../mod.ts";
import { richArtifact } from "./support/artifact-fixture.ts";

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
    return new TextDecoder().decode(row?.["content"] as Uint8Array);
  } finally {
    database.close();
  }
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
    expect(read.answers).toEqual(contents.answers);
    expect(read.agentSessions).toEqual(contents.agentSessions);
    expect(read.definition).toEqual(contents.definition);

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
      last = { kind: String(row?.["kind"]), identity: String(row?.["identity"]) };
    } finally {
      database.close();
    }

    const broken = yield* damaged(path, join(directory, "broken.xmd"), (target) => {
      rewrite(target, last.kind, last.identity, "not what this record is");
    });

    // The copy this one was damaged from still opens, so the damage is what
    // decides the outcome rather than something the fixture was already wrong
    // about.
    expect((yield* opened(path)).run.status).toBe("failed");

    // The early status row is still perfectly readable, and the open still
    // returns nothing at all.
    expect(storedText(broken, "workflow-run", "null")).toContain('"status":"failed"');
    const failure = yield* refused(broken);
    expect(failure.message).not.toContain("failed"); // no lifecycle leaked into the answer
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
        const repository = JSON.parse(
          storedText(path, "workspace-repository", canonicalJsonText("product")),
        ) as Record<string, unknown>;
        const twin = { ...repository, name: "product-twin" };
        const content = encoder.encode(canonicalJsonText(twin as never));
        target
          .prepare(
            "INSERT INTO xmd_artifact_content (kind, identity, encoding, length, sha256, content) " +
              "VALUES ('workspace-repository', ?, 'canonical-json', ?, ?, ?)",
          )
          .run(canonicalJsonText("product-twin"), content.byteLength, sha256Hex(content), content);
      },
    );
    const danglingRoot = yield* damaged(path, join(directory, "dangling-root.xmd"), (target) => {
      const row = JSON.parse(storedText(path, "journal-event", journalIdentity)) as Record<
        string,
        unknown
      >;
      rewrite(
        target,
        "journal-event",
        journalIdentity,
        canonicalJsonText({ ...row, workspaceRootId: "0".repeat(64) } as never),
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

    const forbiddenNames =
      /retrieval|credential|token|password|secret|connection|statement|transaction|database|lock|handle|sessionDirectory|hostPath/i;
    walk(read, (key, value) => {
      expect(forbiddenNames.test(key)).toBe(false);
      expect(typeof value).not.toBe("function");
      if (typeof value === "string") {
        expect(value.includes(directory)).toBe(false);
      }
    });

    // The caller's own snapshot is no longer connected to what was sealed.
    (contents.journal as unknown as { eventId: string }[])[0]!.eventId = "tampered";
    (contents.blobs[0]!.content as Uint8Array)[0] = 0;
    const rereadAfterCallerMutation = yield* opened(path);
    expect(rereadAfterCallerMutation.identity).toBe(read.identity);
    expect(rereadAfterCallerMutation.journal[0]?.eventId).toBe("event-0");

    // Nor is the returned graph something a caller can edit.
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.journal)).toBe(true);
    expect(Object.isFrozen(read.run)).toBe(true);
    expect(() => {
      (read as { identity: string }).identity = "rewritten";
    }).toThrow();
    const reread = yield* opened(path);
    expect(reread.identity).toBe(read.identity);
  });

  it("C8 holds the semantic invariants a live run holds", function* () {
    const directory = yield* useArtifactDirectory();
    const { path } = yield* sealed(directory);

    const stopReason = yield* damaged(path, join(directory, "stop-reason.xmd"), (target) => {
      const run = JSON.parse(storedText(path, "workflow-run", "null")) as Record<string, unknown>;
      rewrite(
        target,
        "workflow-run",
        "null",
        canonicalJsonText({
          ...run,
          stopReason: { kind: "journal", eventId: "no-such-event" },
        } as never),
      );
    });
    const currentRoot = yield* damaged(path, join(directory, "current-root.xmd"), (target) => {
      const frontier = JSON.parse(storedText(path, "artifact-frontier", "null")) as Record<
        string,
        unknown
      >;
      rewrite(
        target,
        "artifact-frontier",
        "null",
        canonicalJsonText({ ...frontier, currentWorkspaceRootId: "1".repeat(64) } as never),
      );
    });
    const frontierEvent = yield* damaged(path, join(directory, "frontier-event.xmd"), (target) => {
      const frontier = JSON.parse(storedText(path, "artifact-frontier", "null")) as Record<
        string,
        unknown
      >;
      rewrite(
        target,
        "artifact-frontier",
        "null",
        canonicalJsonText({ ...frontier, finalEventId: "event-0" } as never),
      );
    });
    const rootReferences = yield* damaged(
      path,
      join(directory, "root-references.xmd"),
      (target) => {
        const rootId = rootIdentities(path)[0]!;
        const root = JSON.parse(storedText(path, "workspace-root", rootId)) as Record<
          string,
          unknown
        >;
        rewrite(
          target,
          "workspace-root",
          rootId,
          canonicalJsonText({ ...root, blobHashes: [] } as never),
        );
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
      const worktree = JSON.parse(storedText(path, "workspace-worktree", identity)) as Record<
        string,
        unknown
      >;
      target
        .prepare("DELETE FROM xmd_artifact_content WHERE kind = ? AND identity = ?")
        .run("workspace-worktree", identity);
      const replaced = { ...worktree, repositoryName: "absent" };
      const content = encoder.encode(canonicalJsonText(replaced as never));
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
    const suspensionRequest = yield* damaged(path, join(directory, "suspension.xmd"), (target) => {
      const identity = firstIdentity(path, "suspension-answer");
      const answer = JSON.parse(storedText(path, "suspension-answer", identity)) as Record<
        string,
        unknown
      >;
      rewrite(
        target,
        "suspension-answer",
        identity,
        canonicalJsonText({ ...answer, requestEventId: "no-such-event" } as never),
      );
    });
    const agentMapping = yield* damaged(path, join(directory, "agent.xmd"), (target) => {
      const identity = firstIdentity(path, "agent-session");
      const session = JSON.parse(storedText(path, "agent-session", identity)) as Record<
        string,
        unknown
      >;
      rewrite(
        target,
        "agent-session",
        identity,
        canonicalJsonText({ ...session, sessionIdentity: "somebody else's session" } as never),
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
      agentMapping,
      closureHash,
      closureMembership,
    ];
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
    const surfaces: Record<string, unknown>[] = [
      publishedDeno as unknown as Record<string, unknown>,
      publishedRoot as unknown as Record<string, unknown>,
    ];
    const encodingNames =
      /^(XMD_ARTIFACT_|readXmdArtifact|writeXmdArtifact|initializeXmdArtifactSchema|verifyXmdArtifact)/;
    for (const surface of surfaces) {
      for (const [name, value] of Object.entries(surface)) {
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
      .map((row) => String(row["identity"]));
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
    return String(row?.["identity"]);
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
    const member = (value as Record<PropertyKey, unknown>)[key];
    visit(String(key), member);
    walk(member, visit, seen);
  }
}
