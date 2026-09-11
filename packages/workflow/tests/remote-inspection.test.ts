/**
 * Tier WRH — what a remote inspection projects to, and what it refuses.
 *
 * The owner-side facts — that reading takes no acquisition, and that one
 * answer comes from one committed reading — are proved against a real Durable
 * Object in `tests/cloudflare/remote-read-plane.vitest.ts`. These are the other
 * half: that the provider-neutral values a caller receives are the shared
 * projection, and that an anchored sequence which does not hold together
 * publishes nothing at all.
 */

import { serializeDurableEvent } from "@executablemd/durable-streams";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, scoped } from "effection";
import {
  cloudflareReadPlane,
  FORK_SOURCE_ANSWER_BYTES,
  PUBLIC_ANSWER_BYTES,
  type ReadTransport,
} from "../src/cloudflare/read-client.ts";
import type { RemoteReadPlane } from "../src/remote/read.ts";
import { sha256Hex } from "../src/workspace/sha256.ts";
import { compareUtf8, WORKSPACE_ROOT_DOMAIN } from "../src/workspace/root-manifest.ts";
import { useRemoteLifecycleReads } from "../src/remote/inspection.ts";
import { WorkflowLifecycle } from "../src/lifecycle/api.ts";
import { WorkflowRecordMalformedError, WorkflowRunIdMismatchError } from "../src/storage/errors.ts";

const RUN_ID = "5cktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";
const ROOT = "a".repeat(64);

function runRecord(): Record<string, unknown> {
  return {
    runId: RUN_ID,
    definition: {
      version: 1,
      kind: "git",
      objectFormat: "sha1",
      objectId: "0".repeat(40),
      rootDocumentPath: "README.md",
    },
    base: "main",
    props: {},
    status: "running",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
}

function inspection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record: runRecord(),
    executions: [],
    retrieval: null,
    journalFrontier: null,
    currentWorkspaceRootId: ROOT,
    lineage: null,
    ...overrides,
  };
}

function event(name: string): string {
  return JSON.stringify({
    type: "yield",
    coroutineId: "root",
    description: { type: "test", name },
    result: { status: "ok", value: name },
  });
}

/** An owner whose answers a test writes, recording what it was asked. */
function plane(answer: (read: Record<string, unknown>) => Record<string, unknown>) {
  const asked: Record<string, unknown>[] = [];
  const transport: ReadTransport = {
    // deno-lint-ignore require-yield
    *send(_admission, body: string): Operation<string> {
      const value: unknown = JSON.parse(body);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("expected one read operation");
      }
      const operation = Object.fromEntries(Object.entries(value));
      asked.push(operation);
      return JSON.stringify(answer(operation));
    },
  };
  return { asked, transport };
}

/** The bytes as the private protocol carries them. */
function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text);
}

/**
 * Where a real owner says a page ended.
 *
 * A cursor is the position of the last member the page carried, inside the
 * anchored selection it belongs to — not a name, and not a value beside the
 * rows, so a scripted owner has to derive it the way a real one does.
 */
function cursorOf(from: number, rows: readonly unknown[], after: number | null): number | null {
  return rows.length === 0 ? after : from + rows.length - 1;
}

/** Install the read operations over one scripted owner, for one body. */
function* installed<T>(
  answer: (read: Record<string, unknown>) => Record<string, unknown>,
  body: (opened: RemoteReadPlane) => Operation<T>,
): Operation<T> {
  return yield* scoped(function* () {
    const held = plane(answer);
    const opened = cloudflareReadPlane(
      held.transport,
      "release-1",
      // deno-lint-ignore require-yield
      function* () {
        return "token";
      },
      RUN_ID,
    );
    yield* useRemoteLifecycleReads(opened);
    // The plane itself is handed to the body: a fork source is private, and no
    // public lifecycle operation returns one.
    return yield* body(opened);
  });
}

describe("a remote run's inspection", () => {
  it("refuses a request for another run before it reaches the owner", function* () {
    const other = "6dktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";
    const held = plane(() => ({ outcome: "performed", value: inspection() }));
    const seen = yield* scoped(function* () {
      yield* useRemoteLifecycleReads(
        // deno-lint-ignore require-yield
        cloudflareReadPlane(
          held.transport,
          "release-1",
          function* () {
            return "token";
          },
          RUN_ID,
        ),
      );
      return {
        inspected: yield* WorkflowLifecycle.operations.inspect(other),
        history: yield* WorkflowLifecycle.operations.history(other),
      };
    });

    expect([seen.inspected.ok, seen.history.ok]).toEqual([false, false]);
    // Refused here, so the owner was never asked and nothing of the bound run
    // came back.
    expect(held.asked).toEqual([]);
    for (const outcome of [seen.inspected, seen.history]) {
      expect(outcome.ok === false && outcome.error).toEqual(expect.any(WorkflowRunIdMismatchError));
      expect(String(outcome.ok === false && outcome.error)).not.toContain(RUN_ID);
    }
  });

  it("lists nothing for an owner holding no run, and fails on a damaged one", function* () {
    const empty = yield* installed(
      () => ({ outcome: "refused", refusal: "command:absent" }),
      () => WorkflowLifecycle.operations.list(),
    );
    // Pristine storage lists nothing rather than failing: there is no run, and
    // that is a complete answer.
    expect(empty.ok && empty.value).toEqual([]);

    const damaged = yield* installed(
      () => ({ outcome: "refused", refusal: "storage:corrupt" }),
      () => WorkflowLifecycle.operations.list(),
    );
    // Anything else fails whole rather than reporting a healthy subset.
    expect(damaged.ok).toBe(false);
    expect(String(damaged.ok === false && damaged.error)).not.toContain("storage:");
  });

  it("answers one frozen snapshot, and a bound owner's list of one", function* () {
    const seen = yield* installed(
      () => ({ outcome: "performed", value: inspection() }),
      function* () {
        return {
          inspected: yield* WorkflowLifecycle.operations.inspect(RUN_ID),
          listed: yield* WorkflowLifecycle.operations.list(),
        };
      },
    );

    expect(seen.inspected.ok).toBe(true);
    if (seen.inspected.ok) {
      expect(seen.inspected.value.record.runId).toBe(RUN_ID);
      expect(seen.inspected.value.currentWorkspaceRootId).toBe(ROOT);
      // Nothing callable, and nothing a caller can change.
      expect(Object.isFrozen(seen.inspected.value)).toBe(true);
      expect(seen.inspected.value.journalFrontier).toBe(undefined);
      expect(seen.inspected.value.lineage).toBe(undefined);
    }
    // The plane is bound to one owner, so its whole visible domain is that
    // owner: one coherent snapshot, and no enumeration of anything else.
    expect(seen.listed.ok && seen.listed.value).toHaveLength(1);
  });

  it("projects history through the shared projection, across anchored pages", function* () {
    const history = yield* installed(
      (read) => {
        if (read["operation"] !== "history") {
          return { outcome: "performed", value: inspection() };
        }
        // Two pages, anchored to the terminal event the first one chose.
        if (read["after"] === null) {
          return {
            outcome: "performed",
            value: {
              anchor: "event-2",
              after: null,
              rows: [{ eventId: "event-1", record: event("first"), workspaceRootId: ROOT }],
              done: false,
              retainedRoots: [],
              provenance: [],
            },
          };
        }
        return {
          outcome: "performed",
          value: {
            anchor: "event-2",
            after: "event-1",
            rows: [{ eventId: "event-2", record: event("second"), workspaceRootId: ROOT }],
            done: true,
            retainedRoots: [ROOT],
            provenance: [
              { eventId: "event-1", sourceRunId: "somewhere", sourceEventId: "event-9" },
            ],
          },
        };
      },
      () => WorkflowLifecycle.operations.history(RUN_ID),
    );

    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.value.map((entry) => entry.eventId)).toEqual(["event-1", "event-2"]);
      // The shared projection's own members, not a second interpretation.
      expect(history.value[0]?.forkability).not.toBe(undefined);
      expect(history.value[0]?.inherited).toEqual({
        sourceRunId: "somewhere",
        sourceEventId: "event-9",
      });
      expect(history.value[1]?.inherited).toBe(undefined);
      // No retained record bytes reach the public answer.
      expect(JSON.stringify(history.value)).not.toContain('\\"type\\":\\"yield');
    }
  });

  it("publishes nothing when an anchored sequence does not hold together", function* () {
    const first = {
      anchor: "event-2",
      after: null,
      rows: [{ eventId: "event-1", record: event("first"), workspaceRootId: ROOT }],
      done: false,
      retainedRoots: [],
      provenance: [],
    };
    // Each of these is a second page that belongs to some other snapshot.
    const broken: Record<string, Record<string, unknown>> = {
      "a changed anchor": { ...first, anchor: "event-9", after: "event-1" },
      "a cursor it was not asked to continue": { ...first, after: "event-7" },
      "a repeated event": { ...first, after: "event-1" },
      "a page that terminates short of its anchor": {
        ...first,
        after: "event-1",
        rows: [{ eventId: "event-3", record: event("third"), workspaceRootId: ROOT }],
        done: true,
      },
      "an empty page of a non-empty snapshot": { ...first, after: "event-1", rows: [] },
      "a member this build does not declare": { ...first, after: "event-1", extra: true },
    };

    for (const [description, second] of Object.entries(broken)) {
      const outcome = yield* installed(
        (read) => ({
          outcome: "performed",
          value: read["after"] === null ? first : second,
        }),
        () => WorkflowLifecycle.operations.history(RUN_ID),
      );
      expect([description, outcome.ok]).toEqual([description, false]);
      if (!outcome.ok) {
        expect([description, outcome.error]).toEqual([
          description,
          expect.any(WorkflowRecordMalformedError),
        ]);
        // Nothing of the page, and nothing of the protocol.
        expect(String(outcome.error)).not.toContain("event-");
      }
    }
  });

  it("refuses an inspection that describes another run", function* () {
    const outcome = yield* installed(
      () => ({
        outcome: "performed",
        value: inspection({
          record: { ...runRecord(), runId: "6dktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa" },
        }),
      }),
      () => WorkflowLifecycle.operations.inspect(RUN_ID),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toEqual(expect.any(WorkflowRecordMalformedError));
    expect(String(outcome.ok === false && outcome.error)).not.toContain("6dktgrv");
  });

  it("hands back a refusal as a storage failure, with nothing private in it", function* () {
    const outcome = yield* installed(
      () => ({ outcome: "refused", refusal: "command:absent" }),
      () => WorkflowLifecycle.operations.inspect(RUN_ID),
    );
    expect(outcome.ok).toBe(false);
    expect(String(outcome.ok === false && outcome.error)).not.toContain("command:");
  });

  it("refuses a fork source whose transported closure does not hold", function* () {
    // One representative of each distinct structural failure, driven through
    // the fork-source client itself rather than inferred from the history
    // pager. A destination built from any of these could not restore the
    // Workspace it was given.
    const BLOB = new TextEncoder().encode("file bytes");
    const blobHash = sha256Hex(BLOB);
    const contentManifest = JSON.stringify({
      version: 1,
      chunks: [{ hash: blobHash, size: BLOB.length }],
    });
    const encoded = new TextEncoder().encode(contentManifest);
    const manifestHash = sha256Hex(encoded);
    const rootManifest = JSON.stringify({
      format: 1,
      entries: [
        { path: "/", kind: "directory", mode: 493, mtime: 0 },
        {
          path: "/file.txt",
          kind: "file",
          mode: 420,
          mtime: 0,
          size: BLOB.length,
          manifest: manifestHash,
          hardlink: null,
        },
      ],
    });
    const rootId = sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${rootManifest}`);

    const sound = {
      inherited: [
        { eventId: "event-work", record: event("work"), workspaceRootId: rootId, position: 0 },
      ],
      roots: [
        {
          rootId,
          formatVersion: 1,
          manifest: rootManifest,
          manifestHashes: [manifestHash],
          blobHashes: [blobHash],
        },
      ],
      manifests: [{ hash: manifestHash, size: BLOB.length, lastSeen: 0, encoded: base64(encoded) }],
      blobs: [{ hash: blobHash, size: BLOB.length, lastSeen: 0, content: base64(BLOB) }],
      checkouts: [],
    };

    const damaged: Record<string, (held: typeof sound) => typeof sound> = {
      "a manifest that is not its own digest": (held) => ({
        ...held,
        manifests: [{ ...held.manifests[0], hash: "d".repeat(64) }],
      }),
      "a manifest describing another size": (held) => ({
        ...held,
        manifests: [{ ...held.manifests[0], size: 999 }],
      }),
      "a root whose references do not follow from its manifest": (held) => ({
        ...held,
        roots: [{ ...held.roots[0], manifestHashes: [] }],
      }),
      "a blob that is not its own digest": (held) => ({
        ...held,
        blobs: [{ ...held.blobs[0], hash: "e".repeat(64) }],
      }),
      "a blob disagreeing with the chunk that names it": (held) => ({
        ...held,
        blobs: [{ ...held.blobs[0], size: 999 }],
      }),
      // Two wrong sizes that agree with each other: the blob row and the
      // chunk both say eleven while the bytes are ten. Every one-dimensional
      // comparison passes, so only the byte length catches it.
      "coordinated sizes that disagree with the bytes": (held) => {
        const wide = JSON.stringify({
          version: 1,
          chunks: [{ hash: blobHash, size: BLOB.length + 1 }],
        });
        const wideBytes = new TextEncoder().encode(wide);
        const wideHash = sha256Hex(wideBytes);
        const wideRoot = JSON.stringify({
          format: 1,
          entries: [
            { path: "/", kind: "directory", mode: 493, mtime: 0 },
            {
              path: "/file.txt",
              kind: "file",
              mode: 420,
              mtime: 0,
              size: BLOB.length + 1,
              manifest: wideHash,
              hardlink: null,
            },
          ],
        });
        const wideRootId = sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${wideRoot}`);
        return {
          inherited: [
            {
              eventId: "event-work",
              record: event("work"),
              workspaceRootId: wideRootId,
              position: 0,
            },
          ],
          roots: [
            {
              rootId: wideRootId,
              formatVersion: 1,
              manifest: wideRoot,
              manifestHashes: [wideHash],
              blobHashes: [blobHash],
            },
          ],
          manifests: [
            { hash: wideHash, size: BLOB.length + 1, lastSeen: 0, encoded: base64(wideBytes) },
          ],
          blobs: [{ hash: blobHash, size: BLOB.length + 1, lastSeen: 0, content: base64(BLOB) }],
          checkouts: [],
        };
      },
      // The root claims a file length the content it names does not produce.
      "a root file size the content does not produce": (held) => {
        const wrongRoot = JSON.stringify({
          format: 1,
          entries: [
            { path: "/", kind: "directory", mode: 493, mtime: 0 },
            {
              path: "/file.txt",
              kind: "file",
              mode: 420,
              mtime: 0,
              size: BLOB.length + 5,
              manifest: manifestHash,
              hardlink: null,
            },
          ],
        });
        const wrongRootId = sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${wrongRoot}`);
        return {
          ...held,
          inherited: [
            {
              eventId: "event-work",
              record: event("work"),
              workspaceRootId: wrongRootId,
              position: 0,
            },
          ],
          roots: [{ ...held.roots[0], rootId: wrongRootId, manifest: wrongRoot }],
        };
      },
      // A manifest that is sound in itself — its own digest, its own size —
      // and simply nothing the selection asked for.
      "a manifest nothing selected requires": (held) => {
        const spare = new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            chunks: [
              { hash: blobHash, size: BLOB.length },
              { hash: blobHash, size: BLOB.length },
            ],
          }),
        );
        return {
          ...held,
          // In the section's own order, so what is refused is the extra
          // manifest and not the sequence that carried it.
          manifests: [
            ...held.manifests,
            {
              hash: sha256Hex(spare),
              size: BLOB.length * 2,
              lastSeen: 0,
              encoded: base64(spare),
            },
          ].toSorted((left, right) => (left.hash < right.hash ? -1 : 1)),
        };
      },
      "a row naming a root the selection did not carry": (held) => ({
        ...held,
        inherited: [{ ...held.inherited[0], workspaceRootId: "a".repeat(64) }],
      }),
    };

    for (const [description, damage] of Object.entries(damaged)) {
      const held = damage(sound);
      const outcome = yield* installed(
        (read) => {
          const section = String(read["section"]);
          const found = Reflect.get(held, section);
          const rows = Array.isArray(found) ? found : [];
          const rootOf = held.roots[0];
          return {
            outcome: "performed",
            value: {
              anchor: "anchor-1",
              after: null,
              section,
              checkpointEventId: "event-work",
              checkpointWorkspaceRootId: rootOf?.rootId ?? rootId,
              runRecordWorkspaceRootId: rootOf?.rootId ?? rootId,
              rootImportWorkspaceRootId: rootOf?.rootId ?? rootId,
              rows,
              from: 0,
              cursor: cursorOf(0, rows, null),
              done: true,
              total: rows.length,
            },
          };
        },
        (opened) => opened.forkSource("event-work"),
      );
      expect([description, outcome.ok]).toEqual([description, false]);
      if (!outcome.ok) {
        // Nothing of the bytes, the hashes or the protocol.
        expect(String(outcome.error)).not.toContain(blobHash);
        expect(String(outcome.error)).not.toContain("command:");
      }
    }
  });

  it("accepts a fork source whose closure holds, and refuses a moved anchor", function* () {
    const BLOB = new TextEncoder().encode("file bytes");
    const blobHash = sha256Hex(BLOB);
    const encoded = new TextEncoder().encode(
      JSON.stringify({ version: 1, chunks: [{ hash: blobHash, size: BLOB.length }] }),
    );
    const manifestHash = sha256Hex(encoded);
    const rootManifest = JSON.stringify({
      format: 1,
      entries: [
        { path: "/", kind: "directory", mode: 493, mtime: 0 },
        {
          path: "/file.txt",
          kind: "file",
          mode: 420,
          mtime: 0,
          size: BLOB.length,
          manifest: manifestHash,
          hardlink: null,
        },
      ],
    });
    const rootId = sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${rootManifest}`);
    // One record spelled the way its source retained it, which is not the
    // spelling re-encoding the parsed event would produce.
    const spelled = JSON.stringify(JSON.parse(event("work")), null, 2);
    const sections: Record<string, unknown[]> = {
      inherited: [{ eventId: "event-work", record: spelled, workspaceRootId: rootId, position: 0 }],
      roots: [
        {
          rootId,
          formatVersion: 1,
          manifest: rootManifest,
          manifestHashes: [manifestHash],
          blobHashes: [blobHash],
        },
      ],
      manifests: [{ hash: manifestHash, size: BLOB.length, lastSeen: 0, encoded: base64(encoded) }],
      blobs: [{ hash: blobHash, size: BLOB.length, lastSeen: 0, content: base64(BLOB) }],
      checkouts: [],
    };
    const answer = (anchorFor: (section: string) => string) => (read: Record<string, unknown>) => {
      const section = String(read["section"]);
      const rows = sections[section] ?? [];
      return {
        outcome: "performed",
        value: {
          anchor: anchorFor(section),
          after: null,
          section,
          checkpointEventId: "event-work",
          checkpointWorkspaceRootId: rootId,
          runRecordWorkspaceRootId: rootId,
          rootImportWorkspaceRootId: rootId,
          rows,
          from: 0,
          cursor: cursorOf(0, rows, null),
          done: true,
          total: rows.length,
        },
      };
    };

    const whole = yield* installed(
      answer(() => "anchor-1"),
      (opened) => opened.forkSource("event-work"),
    );
    expect(whole.ok).toBe(true);
    if (whole.ok) {
      expect(whole.value.inherited.map((row) => row.eventId)).toEqual(["event-work"]);
      // Byte for byte: a destination retains these bytes, and a spelling
      // rebuilt from the parse would be a history it never inherited.
      expect(whole.value.inherited[0]?.record).toBe(spelled);
      expect(spelled).not.toBe(event("work"));
      expect(whole.value.roots.map((root) => root.rootId)).toEqual([rootId]);
      expect(whole.value.blobs[0]?.content).toEqual(BLOB);
    }

    // The checkouts section arrives from a selection that has moved on.
    const moved = yield* installed(
      answer((section) => (section === "checkouts" ? "anchor-2" : "anchor-1")),
      (opened) => opened.forkSource("event-work"),
    );
    expect(moved.ok).toBe(false);
    expect(moved.ok === false && moved.error).toEqual(expect.any(WorkflowRecordMalformedError));
  });

  it("refuses a fork-source sequence that does not describe one selection", function* () {
    // A selection is one answer carried over several pages. These are the ways
    // a sequence can stop being that answer: a page that describes a different
    // selection, a page that advances past what it carried, and a graph of
    // checkouts a destination could not retain.
    const BLOB = new TextEncoder().encode("file bytes");
    const blobHash = sha256Hex(BLOB);
    const encoded = new TextEncoder().encode(
      JSON.stringify({ version: 1, chunks: [{ hash: blobHash, size: BLOB.length }] }),
    );
    const manifestHash = sha256Hex(encoded);
    const directory = (path: string) => ({ path, kind: "directory", mode: 493, mtime: 0 });
    const rootManifest = JSON.stringify({
      format: 1,
      // Canonical order: the root, then every path by its UTF-8 bytes. Seven
      // directories, because a checkout identity that collides under a
      // separator still needs a place of its own.
      entries: [
        directory("/"),
        {
          path: "/file.txt",
          kind: "file",
          mode: 420,
          mtime: 0,
          size: BLOB.length,
          manifest: manifestHash,
          hardlink: null,
        },
        ...["/five", "/four", "/one", "/seven", "/six", "/three", "/two"].map((path) =>
          directory(path),
        ),
      ],
    });
    const rootId = sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${rootManifest}`);
    const repository = (name: string, checkoutPath: string) => ({
      kind: "repository",
      name,
      locator: `https://git.example.invalid/${name}.git`,
      locatorFingerprint: "b".repeat(64),
      requestedBase: null,
      creationCommit: "9".repeat(40),
      primaryBranch: "main",
      objectFormat: "sha1",
      checkoutPath,
    });
    const worktree = (repositoryName: string, name: string, checkoutPath: string) => ({
      kind: "worktree",
      repositoryName,
      name,
      requestedBranch: "topic",
      requestedBase: null,
      creationCommit: "9".repeat(40),
      checkoutPath,
    });
    const alpha = repository("alpha", "/one");
    const beta = repository("beta", "/two");
    const ALPHA_KEY = JSON.stringify(["repository", "alpha"]);
    const BETA_KEY = JSON.stringify(["repository", "beta"]);
    // A prefix of three, so a permutation of two of them is a thing a page can
    // carry and a sequence can be asked to accept.
    const journal = ["a", "b", "c"].map((name, position) => ({
      eventId: `event-${name}`,
      record: event(name),
      workspaceRootId: rootId,
      position,
    }));

    interface Page {
      readonly after: number | null;
      readonly from: number;
      readonly rows: readonly unknown[];
      readonly cursor: number | null;
      readonly done: boolean;
      readonly total: number;
    }
    interface Plan {
      readonly heads: { checkpoint: string; runRecord: string; rootImport: string };
      readonly sections: Record<string, readonly Page[]>;
    }

    /** One page carrying a whole section, as an owner with little to say sends. */
    const whole = (section: string, rows: readonly unknown[]): Page[] => [
      {
        after: null,
        from: 0,
        rows,
        cursor: cursorOf(0, rows, null),
        done: true,
        total: rows.length,
      },
    ];
    const sound: Plan = {
      heads: { checkpoint: rootId, runRecord: rootId, rootImport: rootId },
      sections: {
        inherited: whole("inherited", journal),
        roots: whole("roots", [
          {
            rootId,
            formatVersion: 1,
            manifest: rootManifest,
            manifestHashes: [manifestHash],
            blobHashes: [blobHash],
          },
        ]),
        manifests: whole("manifests", [
          { hash: manifestHash, size: BLOB.length, lastSeen: 0, encoded: base64(encoded) },
        ]),
        blobs: whole("blobs", [
          { hash: blobHash, size: BLOB.length, lastSeen: 0, content: base64(BLOB) },
        ]),
        checkouts: whole("checkouts", [alpha, beta]),
      },
    };
    const checkouts = (pages: readonly Page[]): Plan => ({
      ...sound,
      sections: { ...sound.sections, checkouts: pages },
    });
    const inherited = (pages: readonly Page[]): Plan => ({
      ...sound,
      sections: { ...sound.sections, inherited: pages },
    });

    const broken: Record<string, Plan> = {
      "a head naming a Workspace root the selection did not carry": {
        ...sound,
        heads: { ...sound.heads, runRecord: "c".repeat(64) },
      },
      "a head that is no Workspace root identity at all": {
        ...sound,
        heads: { ...sound.heads, rootImport: "the root import" },
      },
      "a checkout in a directory the checkpoint Workspace does not hold": checkouts(
        whole("checkouts", [repository("alpha", "/nowhere")]),
      ),
      "a Worktree of a Repository the selection did not carry": checkouts(
        whole("checkouts", [alpha, worktree("gamma", "topic", "/two")]),
      ),
      "two checkouts in one directory": checkouts(
        whole("checkouts", [alpha, repository("beta", "/one")]),
      ),
      "a page that redeclares the size of its section": checkouts([
        { after: null, from: 0, rows: [alpha], cursor: 0, done: false, total: 2 },
        {
          after: 0,
          from: 1,
          rows: [beta],
          cursor: 1,
          done: true,
          total: 3,
        },
      ]),
      "a cursor naming a member the page did not carry": checkouts([
        { after: null, from: 0, rows: [alpha], cursor: 1, done: false, total: 2 },
        {
          after: 1,
          from: 1,
          rows: [beta],
          cursor: 1,
          done: true,
          total: 2,
        },
      ]),
      "a page repeating what an earlier page carried": checkouts([
        { after: null, from: 0, rows: [alpha], cursor: 0, done: false, total: 2 },
        {
          after: 0,
          from: 1,
          rows: [alpha],
          cursor: 0,
          done: true,
          total: 2,
        },
      ]),
      "a section arriving out of the order it is sorted in": checkouts([
        { after: null, from: 0, rows: [beta], cursor: 0, done: false, total: 2 },
        { after: 0, from: 1, rows: [alpha], cursor: 1, done: true, total: 2 },
      ]),
      "a section ending short of what it declared": checkouts([
        {
          after: null,
          from: 0,
          rows: [alpha, beta],
          cursor: 1,
          done: true,
          total: 3,
        },
      ]),
      "an unfinished page carrying nothing to continue from": checkouts([
        { after: null, from: 0, rows: [], cursor: null, done: false, total: 2 },
      ]),
      "a page beginning past where the sequence had reached": checkouts([
        { after: null, from: 0, rows: [alpha], cursor: 0, done: false, total: 3 },
        {
          after: 0,
          from: 2,
          rows: [beta],
          cursor: 1,
          done: true,
          total: 3,
        },
      ]),
      "one Repository selected twice in one page": checkouts([
        {
          after: null,
          from: 0,
          rows: [alpha, alpha],
          cursor: 0,
          done: true,
          total: 2,
        },
      ]),
      "a locator fingerprint that is no digest": checkouts(
        whole("checkouts", [{ ...alpha, locatorFingerprint: "the fingerprint" }]),
      ),
      "an object format this build does not write": checkouts(
        whole("checkouts", [{ ...alpha, objectFormat: "sha3" }]),
      ),
      "a checkout path that is no Workspace path": checkouts(
        whole("checkouts", [{ ...alpha, checkoutPath: "one" }]),
      ),
      // Two rows exchanged inside one page. Their event ids are still unique,
      // the page still begins where the sequence reached, and the cursor still
      // names the row the page ended on — only the positions travelling with
      // the rows say the journal never held them this way.
      "two inherited rows exchanged inside one page": inherited(
        whole("inherited", [journal[1], journal[0], journal[2]]),
      ),
      "two inherited rows exchanged across a page boundary": inherited([
        {
          after: null,
          from: 0,
          rows: [journal[0], journal[2]],
          cursor: 1,
          done: false,
          total: 3,
        },
        { after: 1, from: 2, rows: [journal[1]], cursor: 2, done: true, total: 3 },
      ]),
      "a root import naming a Workspace root the selection did not carry": {
        ...sound,
        heads: { ...sound.heads, rootImport: "d".repeat(64) },
      },
    };

    const answering = (plan: Plan) => (read: Record<string, unknown>) => {
      const section = String(read["section"]);
      const pages = plan.sections[section] ?? [];
      const asked = read["after"];
      const after = typeof asked === "number" ? asked : null;
      const page = pages.find((candidate) => candidate.after === after);
      if (page === undefined) {
        // A page nothing scripted: the client asked to continue from somewhere
        // this owner never sent it.
        return { outcome: "refused", refusal: "command:absent" };
      }
      return {
        outcome: "performed",
        value: {
          anchor: "anchor-1",
          after,
          section,
          checkpointEventId: "event-work",
          checkpointWorkspaceRootId: plan.heads.checkpoint,
          runRecordWorkspaceRootId: plan.heads.runRecord,
          rootImportWorkspaceRootId: plan.heads.rootImport,
          rows: page.rows,
          from: page.from,
          cursor: page.cursor,
          done: page.done,
          total: page.total,
        },
      };
    };

    // The same prefix over two pages, with positions that continue across the
    // boundary: accepted, in the source's order, with the records untouched.
    const paged = yield* installed(
      answering(
        inherited([
          {
            after: null,
            from: 0,
            rows: [journal[0], journal[1]],
            cursor: 1,
            done: false,
            total: 3,
          },
          { after: 1, from: 2, rows: [journal[2]], cursor: 2, done: true, total: 3 },
        ]),
      ),
      (opened) => opened.forkSource("event-work"),
    );
    expect([paged.ok, paged.ok === false && String(paged.error)]).toEqual([true, false]);
    if (paged.ok) {
      expect(paged.value.inherited.map((row) => row.eventId)).toEqual([
        "event-a",
        "event-b",
        "event-c",
      ]);
      expect(paged.value.inherited.map((row) => row.record)).toEqual(
        journal.map((row) => row.record),
      );
    }

    // Names the retained schema accepts and a separator does not survive.
    // `("a:b", "c")` and `("a", "b:c")` join to one string under a colon;
    // `("a/b", "c")` and `("a", "b/c")` join to one string under a slash. All
    // four are distinct Worktrees of Repositories that came with them.
    const colliding: Plan = checkouts(
      whole("checkouts", [
        repository("a", "/three"),
        repository("a/b", "/five"),
        repository("a:b", "/one"),
        worktree("a", "b/c", "/seven"),
        worktree("a", "b:c", "/four"),
        worktree("a/b", "c", "/six"),
        worktree("a:b", "c", "/two"),
      ]),
    );
    const distinct = yield* installed(answering(colliding), (opened) =>
      opened.forkSource("event-work"),
    );
    expect([distinct.ok, distinct.ok === false && String(distinct.error)]).toEqual([true, false]);
    if (distinct.ok) {
      expect(
        distinct.value.checkouts
          .filter((one) => one.kind === "worktree")
          .map((one) => [one.repositoryName, one.name]),
      ).toEqual([
        ["a", "b/c"],
        ["a", "b:c"],
        ["a/b", "c"],
        ["a:b", "c"],
      ]);
    }

    // The same scripting, undamaged, is accepted: every refusal below is the
    // damage and not the shape of the script.
    const held = yield* installed(answering(sound), (opened) => opened.forkSource("event-work"));
    expect(held.ok).toBe(true);
    if (held.ok) {
      expect(held.value.checkouts.map((checkout) => checkout.name)).toEqual(["alpha", "beta"]);
    }

    for (const [description, plan] of Object.entries(broken)) {
      const outcome = yield* installed(answering(plan), (opened) =>
        opened.forkSource("event-work"),
      );
      expect([description, outcome.ok]).toEqual([description, false]);
      if (!outcome.ok) {
        expect(String(outcome.error)).not.toContain("repository:");
        expect(String(outcome.error)).not.toContain("command:");
      }
    }
  });

  it("holds a root to the canonical reference arrays a destination will derive", function* () {
    // Two files, so a root's references are an array with an order rather than
    // a single value. A destination compares its own derivation element for
    // element when it retains the root, so the set being right is not enough.
    const files = ["first bytes", "second bytes"].map((text) => {
      const bytes = new TextEncoder().encode(text);
      const blobHash = sha256Hex(bytes);
      const encoded = new TextEncoder().encode(
        JSON.stringify({ version: 1, chunks: [{ hash: blobHash, size: bytes.length }] }),
      );
      return { bytes, blobHash, encoded, manifestHash: sha256Hex(encoded) };
    });
    const rootManifest = JSON.stringify({
      format: 1,
      entries: [
        { path: "/", kind: "directory", mode: 493, mtime: 0 },
        ...files.map((file, index) => ({
          path: `/file-${index}.txt`,
          kind: "file",
          mode: 420,
          mtime: 0,
          size: file.bytes.length,
          manifest: file.manifestHash,
          hardlink: null,
        })),
      ],
    });
    const rootId = sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${rootManifest}`);
    const manifestHashes = files.map((file) => file.manifestHash).toSorted(compareUtf8);
    const blobHashes = files.map((file) => file.blobHash).toSorted(compareUtf8);
    const sections = (root: Record<string, unknown>): Record<string, unknown[]> => ({
      inherited: [
        { eventId: "event-work", record: event("work"), workspaceRootId: rootId, position: 0 },
      ],
      roots: [root],
      manifests: files
        .map((file) => ({
          hash: file.manifestHash,
          size: file.bytes.length,
          lastSeen: 0,
          encoded: base64(file.encoded),
        }))
        .toSorted((left, right) => compareUtf8(left.hash, right.hash)),
      blobs: files
        .map((file) => ({
          hash: file.blobHash,
          size: file.bytes.length,
          lastSeen: 0,
          content: base64(file.bytes),
        }))
        .toSorted((left, right) => compareUtf8(left.hash, right.hash)),
      checkouts: [],
    });
    const answering = (root: Record<string, unknown>) => (read: Record<string, unknown>) => {
      const section = String(read["section"]);
      const rows = sections(root)[section] ?? [];
      return {
        outcome: "performed",
        value: {
          anchor: "anchor-1",
          after: null,
          section,
          checkpointEventId: "event-work",
          checkpointWorkspaceRootId: rootId,
          runRecordWorkspaceRootId: rootId,
          rootImportWorkspaceRootId: rootId,
          rows,
          from: 0,
          cursor: cursorOf(0, rows, null),
          done: true,
          total: rows.length,
        },
      };
    };
    const canonical = {
      rootId,
      formatVersion: 1,
      manifest: rootManifest,
      manifestHashes,
      blobHashes,
    };

    const held = yield* installed(answering(canonical), (opened) =>
      opened.forkSource("event-work"),
    );
    expect([held.ok, held.ok === false && String(held.error)]).toEqual([true, false]);
    if (held.ok) {
      expect(held.value.roots[0]?.manifestHashes).toEqual(manifestHashes);
      expect(held.value.roots[0]?.blobHashes).toEqual(blobHashes);
    }

    const damaged: Record<string, Record<string, unknown>> = {
      "content references in an order a root is never retained with": {
        ...canonical,
        manifestHashes: manifestHashes.toReversed(),
      },
      "blob references in an order a root is never retained with": {
        ...canonical,
        blobHashes: blobHashes.toReversed(),
      },
      "one content reference carried twice": {
        ...canonical,
        manifestHashes: [manifestHashes[0], ...manifestHashes],
      },
      "one blob reference carried twice": {
        ...canonical,
        blobHashes: [blobHashes[0], ...blobHashes],
      },
    };
    for (const [description, root] of Object.entries(damaged)) {
      const outcome = yield* installed(answering(root), (opened) =>
        opened.forkSource("event-work"),
      );
      expect([description, outcome.ok]).toEqual([description, false]);
    }
  });

  it("reads a history answer larger than a fork source's own ceiling", function* () {
    // A retained record may be as large as the transaction that wrote it, and
    // history is paged by count rather than by bytes, so a single valid row can
    // carry more than any fork-source page ever will. What a fork source's
    // arithmetic bounds is fork-source pages.
    const wide = "w".repeat(1_200_000);
    // The canonical retained spelling, terminating newline included: what a
    // journal holds is what `serializeDurableEvent()` wrote, and the owner
    // accepts a record only when it round-trips to exactly that.
    const record = serializeDurableEvent({
      type: "yield",
      coroutineId: "root",
      description: { type: "test", name: "wide" },
      result: { status: "ok", value: wide },
    });
    const answer = (rows: unknown[]) => ({
      anchor: "event-wide",
      after: null,
      rows,
      done: true,
      retainedRoots: [ROOT],
      provenance: [],
    });
    const page = answer([{ eventId: "event-wide", record, workspaceRootId: ROOT }]);
    const bytes = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify({ outcome: "performed", value })).length;

    // Between the two ceilings: too large for a fork-source answer, and well
    // within what public history has always carried.
    expect(new TextEncoder().encode(record).length).toBeGreaterThan(1_200_000);
    expect(bytes(page)).toBeGreaterThan(FORK_SOURCE_ANSWER_BYTES);
    expect(bytes(page)).toBeLessThan(PUBLIC_ANSWER_BYTES);

    const history = yield* installed(
      (read) => ({
        outcome: "performed",
        value: read["operation"] === "history" ? page : inspection(),
      }),
      () => WorkflowLifecycle.operations.history(RUN_ID),
    );
    expect([history.ok, history.ok === false && String(history.error)]).toEqual([true, false]);
    if (history.ok) {
      expect(history.value.map((entry) => entry.eventId)).toEqual(["event-wide"]);
      expect(history.value[0]?.workspaceRootId).toBe(ROOT);
      const held = history.value[0]?.event;
      expect(held?.type).toBe("yield");
      expect(held?.type === "yield" && held.result).toEqual({ status: "ok", value: wide });
    }

    // The same bytes as a fork-source answer are refused before they are read,
    // so what admits the history answer is the operation asked and not a
    // ceiling raised for everyone.
    const forked = yield* installed(
      () => ({ outcome: "performed", value: page }),
      (opened) => opened.forkSource("event-wide"),
    );
    expect(forked.ok).toBe(false);
    expect(forked.ok === false && forked.error).toEqual(expect.any(WorkflowRecordMalformedError));

    // And a history answer past its own ceiling still fails closed.
    const huge = answer([
      { eventId: "event-wide", record, workspaceRootId: ROOT },
      { eventId: "event-wider", record, workspaceRootId: ROOT },
    ]);
    expect(bytes(huge)).toBeGreaterThan(PUBLIC_ANSWER_BYTES);
    const refused = yield* installed(
      (read) => ({
        outcome: "performed",
        value: read["operation"] === "history" ? huge : inspection(),
      }),
      () => WorkflowLifecycle.operations.history(RUN_ID),
    );
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toEqual(expect.any(WorkflowRecordMalformedError));
  });
});
