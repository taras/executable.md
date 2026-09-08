/**
 * Tier WRH12 — what a completed run replays on, and where it comes from.
 *
 * A completed replay imports nothing and performs nothing, so everything it is
 * held to has to come from what the run already retains. Two halves of that are
 * settled here, over values, because both hosts reach the same function: which
 * root document the recorded result was a result of, and which component
 * imports the history is allowed to contain.
 *
 * The load-bearing word throughout is *definition*. Journal data supplies the
 * bytes; the immutable run record supplies the identity those bytes have to
 * agree with. A history that names another document, another path or another
 * object id is refused before anything is replayed from it — and every refusal
 * says so without repeating a path, a source or a recorded value.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation, Result } from "effection";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { replaysRetainedResult, retainedReplay } from "../src/replay.ts";
import type { RetainedReplay } from "../src/replay.ts";
import { WorkflowReplayHistoryError } from "../src/replay.ts";
import { WorkflowBundleHistoryError } from "../src/bundle.ts";
import { forkRunRecordEvent } from "../src/journal-events.ts";
import type { JournalEntry } from "../src/storage/api.ts";
import type { WorkflowComponentEntry } from "../src/storage/definition.ts";
import type { WorkflowRunRecord, WorkflowRunStatus } from "../src/storage/record.ts";

const ROOT_ID = "a".repeat(64);
const COMMIT = "0".repeat(40);
const SOURCE = "# Retained\n\ndone.\n";

function record(
  overrides: {
    readonly status?: WorkflowRunStatus;
    readonly rootDocumentPath?: string;
    readonly components?: readonly WorkflowComponentEntry[];
  } = {},
): WorkflowRunRecord {
  const components = overrides.components;
  return {
    runId: "replay-1",
    definition: {
      version: 1,
      kind: "git",
      objectFormat: "sha1",
      objectId: COMMIT,
      rootDocumentPath: overrides.rootDocumentPath ?? "flows/root.md",
      ...(components === undefined ? {} : { components }),
    },
    base: "main",
    props: {},
    status: overrides.status ?? "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

let identity = 0;

function entry(event: DurableEvent): JournalEntry {
  identity += 1;
  return { eventId: `event-${identity}`, event, workspaceRootId: ROOT_ID };
}

/** The root import canonical execution records, as this run recorded it. */
function rootImport(value: Json): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: "import_component", name: "__root__" },
    result: { status: "ok", value },
  };
}

/** One bundled component import, as canonical execution records one. */
function componentImport(name: string, value: Json): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: "import_component", name },
    result: { status: "ok", value },
  };
}

function rootClose(value: Json): DurableEvent {
  return { type: "close", coroutineId: "root", result: { status: "ok", value } };
}

/** The terminal core writes when it fails before importing a root document. */
function preRootClose(path: string, source: string, target: string | null): DurableEvent {
  const message = "refused before the root import";
  return rootClose({
    status: "err",
    output: "",
    error: { name: "Error", message, segment: { message } },
    root_binding: { path, source, target },
  });
}

/** An ordinary completed history: the import, then the result. */
function completedHistory(
  path = "flows/root.md",
  content = SOURCE,
  extra: readonly DurableEvent[] = [],
): JournalEntry[] {
  return [
    entry(rootImport({ kind: "repository", path, content })),
    ...extra.map((event) => entry(event)),
    entry(rootClose({ status: "ok", output: "done.\n", value: "done.\n" })),
  ];
}

function reason(outcome: Result<RetainedReplay>): string {
  if (outcome.ok) {
    throw new Error("expected the retained state to be refused");
  }
  expect(outcome.error).toEqual(expect.any(WorkflowReplayHistoryError));
  return outcome.error.message;
}

function admitted(outcome: Result<RetainedReplay>): RetainedReplay {
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/** The run record canonical execution retains before it imports anything. */
const RUN_RECORD = forkRunRecordEvent({ runId: "replay-1", base: "main", pinnedCommit: COMMIT });

/** Run every admission one installation carries over one retained history. */
function* admit(
  installations: readonly ExecutionInstallation[],
  retained: readonly DurableEvent[],
): Operation<Error | undefined> {
  for (const installation of installations) {
    for (const admission of installation.admissions ?? []) {
      try {
        yield* admission(retained);
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  return undefined;
}

describe("the root a completed run replays on", () => {
  // deno-lint-ignore require-yield
  it("is the document the retained import selected", function* () {
    const replay = admitted(retainedReplay(record(), completedHistory()));

    expect(replay.root).toEqual({ path: "flows/root.md", source: SOURCE, retained: true });
  });

  // deno-lint-ignore require-yield
  it("carries the exact target the import resolved to", function* () {
    const history = [
      entry(
        rootImport({ kind: "repository", path: "flows/root.md", content: SOURCE, target: "Stage" }),
      ),
      entry(rootClose({ status: "ok", output: "", value: "" })),
    ];

    expect(admitted(retainedReplay(record(), history)).root).toEqual({
      path: "flows/root.md",
      source: SOURCE,
      retained: true,
      target: "Stage",
    });
  });

  // deno-lint-ignore require-yield
  it("carries the selector a recorded failed selection was asked for", function* () {
    const history = [
      entry(
        rootImport({
          kind: "target-failure",
          path: "flows/root.md",
          content: SOURCE,
          failure: { kind: "no-match", selector: "Missing*", matches: [], available: ["Retained"] },
        }),
      ),
      entry(rootClose({ status: "err", output: "", error: { name: "E", message: "m" } })),
    ];

    expect(admitted(retainedReplay(record(), history)).root).toEqual({
      path: "flows/root.md",
      source: SOURCE,
      retained: true,
      target: "Missing*",
    });
  });

  // deno-lint-ignore require-yield
  it("comes from the terminal when the run failed before importing anything", function* () {
    const history = [entry(preRootClose("flows/root.md", SOURCE, null))];

    expect(admitted(retainedReplay(record(), history)).root).toEqual({
      path: "flows/root.md",
      source: SOURCE,
      retained: true,
    });
  });

  // deno-lint-ignore require-yield
  it("is refused when it is not the document the definition names", function* () {
    const shifted = completedHistory("flows/other.md");
    expect(reason(retainedReplay(record(), shifted))).toContain(
      "not the document its definition names",
    );

    const bound = [entry(preRootClose("flows/other.md", SOURCE, null))];
    expect(reason(retainedReplay(record(), bound))).toContain(
      "not the document its definition names",
    );
  });
});

describe("retained state that describes no completed run", () => {
  // deno-lint-ignore require-yield
  it("refuses a run that has not ended", function* () {
    const live: readonly WorkflowRunStatus[] = ["running", "suspended", "interrupted", "cancelled"];
    for (const status of live) {
      const outcome = retainedReplay(record({ status }), completedHistory());
      expect([status, reason(outcome).includes("not terminal")]).toEqual([status, true]);
      expect([status, replaysRetainedResult(status)]).toEqual([status, false]);
    }
    const ended: readonly WorkflowRunStatus[] = ["completed", "failed"];
    for (const status of ended) {
      expect([status, replaysRetainedResult(status)]).toEqual([status, true]);
    }
  });

  // deno-lint-ignore require-yield
  it("refuses a lifecycle row that claims completion with no recorded result", function* () {
    const history = [
      entry(rootImport({ kind: "repository", path: "flows/root.md", content: SOURCE })),
    ];

    expect(reason(retainedReplay(record(), history))).toContain("records no document result");
  });

  // deno-lint-ignore require-yield
  it("refuses a history that continues past the result it records", function* () {
    const after = entry({
      type: "yield",
      coroutineId: "root",
      description: { type: "workspace", name: "write" },
      result: { status: "ok", value: "later" },
    });

    expect(reason(retainedReplay(record(), [...completedHistory(), after]))).toContain(
      "continues past the document result",
    );
    expect(
      reason(
        retainedReplay(record(), [
          ...completedHistory(),
          entry(rootClose({ status: "ok", output: "", value: "" })),
        ]),
      ),
    ).toContain("continues past the document result");
  });

  // deno-lint-ignore require-yield
  it("refuses a history recording more than one root import", function* () {
    const history = [
      entry(rootImport({ kind: "repository", path: "flows/root.md", content: SOURCE })),
      entry(rootImport({ kind: "repository", path: "flows/root.md", content: SOURCE })),
      entry(rootClose({ status: "ok", output: "", value: "" })),
    ];

    expect(reason(retainedReplay(record(), history))).toContain("more than one root document");
  });

  // deno-lint-ignore require-yield
  it("refuses a root import this version cannot read", function* () {
    const unreadable: Json[] = [
      { kind: "repository", path: "flows/root.md" },
      { kind: "repository", path: "flows/root.md", content: SOURCE, extra: 1 },
      { kind: "repository", path: "flows/root.md", content: SOURCE, target: 7 },
      { kind: "registered", origin: "somewhere", reserved: false },
      { kind: "workflow", path: "flows/root.md", sourceHash: "abc", content: SOURCE },
      "not an object at all",
    ];

    for (const value of unreadable) {
      const history = [
        entry(rootImport(value)),
        entry(rootClose({ status: "ok", output: "", value: "" })),
      ];
      const said = reason(retainedReplay(record(), history));
      expect([JSON.stringify(value), said.includes("cannot be read by this version")]).toEqual([
        JSON.stringify(value),
        true,
      ]);
    }
  });

  // deno-lint-ignore require-yield
  it("refuses a root import that failed, and a terminal carrying no binding", function* () {
    const failed = [
      entry({
        type: "yield",
        coroutineId: "root",
        description: { type: "import_component", name: "__root__" },
        result: { status: "err", error: { name: "Error", message: "gone" } },
      }),
      entry(rootClose({ status: "ok", output: "", value: "" })),
    ];
    expect(reason(retainedReplay(record(), failed))).toContain("cannot be read by this version");

    const unbound = [entry(rootClose({ status: "ok", output: "", value: "" }))];
    expect(reason(retainedReplay(record(), unbound))).toContain("cannot be read by this version");
  });

  // deno-lint-ignore require-yield
  it("says what refused without repeating anything the history held", function* () {
    const planted = "PLANTED-SECRET-VALUE";
    const history = [
      entry(rootImport({ kind: "repository", path: `flows/${planted}.md`, content: planted })),
      entry(rootClose({ status: "ok", output: planted, value: planted })),
    ];

    const said = reason(retainedReplay(record(), history));
    expect(said).not.toContain(planted);
    expect(said.length).toBeLessThan(300);
  });
});

describe("the bundle a completed replay is held to", () => {
  const declared: readonly WorkflowComponentEntry[] = [
    { name: "Stage", path: "flows/Stage.md", sourceHash: "1".repeat(40) },
    { name: "Unused", path: "flows/Unused.md", sourceHash: "2".repeat(40) },
  ];

  it("grants no authority to import anything", function* () {
    const replay = admitted(retainedReplay(record({ components: declared }), completedHistory()));

    // Two installations, and neither offers an execution view: a completed
    // replay resolves no name, so there is nothing for one to resolve against.
    expect(replay.installations).toHaveLength(2);
    for (const installation of replay.installations) {
      expect(installation.bundle).toBe(undefined);
      expect(installation.components).toBe(undefined);
    }
  });

  it("admits an import the definition declares, by path and object id", function* () {
    const replay = admitted(retainedReplay(record({ components: declared }), completedHistory()));
    const held = componentImport("Stage", {
      kind: "workflow",
      path: "flows/Stage.md",
      sourceHash: "1".repeat(40),
      content: "staged.\n",
    });

    expect(yield* admit(replay.installations, [RUN_RECORD, held])).toBe(undefined);
  });

  it("refuses one recorded under another path, hash or name", function* () {
    const replay = admitted(retainedReplay(record({ components: declared }), completedHistory()));
    const wrong: DurableEvent[] = [
      componentImport("Stage", {
        kind: "workflow",
        path: "flows/Elsewhere.md",
        sourceHash: "1".repeat(40),
        content: "staged.\n",
      }),
      componentImport("Stage", {
        kind: "workflow",
        path: "flows/Stage.md",
        sourceHash: "9".repeat(40),
        content: "staged.\n",
      }),
      componentImport("Undeclared", {
        kind: "workflow",
        path: "flows/Stage.md",
        sourceHash: "1".repeat(40),
        content: "staged.\n",
      }),
      componentImport("Stage", {
        kind: "repository",
        path: "flows/Stage.md",
        content: "staged.\n",
      }),
    ];

    for (const event of wrong) {
      const refused = yield* admit(replay.installations, [RUN_RECORD, event]);
      expect(refused).toEqual(expect.any(WorkflowBundleHistoryError));
    }
  });

  it("leaves a declared member the history never imported alone", function* () {
    const replay = admitted(retainedReplay(record({ components: declared }), completedHistory()));

    // `Unused` is declared and was never imported. Nothing reads it, nothing
    // fetches it, and its absence from the history is not a refusal.
    expect(yield* admit(replay.installations, [RUN_RECORD])).toBe(undefined);
  });
});
