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
import { retainedReplay } from "../src/replay.ts";
import { rootOutcome } from "../src/lifecycle/policy.ts";
import { DOCUMENT_FAILED } from "../src/lifecycle/policy.ts";
import type { RetainedReplay } from "../src/replay.ts";
import { WorkflowReplayHistoryError } from "../src/replay.ts";
import { WorkflowBundleHistoryError } from "../src/bundle.ts";
import { forkRunRecordEvent } from "../src/journal-events.ts";
import type { JournalEntry } from "../src/storage/api.ts";
import type { WorkflowComponentEntry } from "../src/storage/definition.ts";
import type {
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStopReason,
} from "../src/storage/record.ts";

const ROOT_ID = "a".repeat(64);
const COMMIT = "0".repeat(40);
const SOURCE = "# Retained\n\ndone.\n";

function record(
  overrides: {
    readonly status?: WorkflowRunStatus;
    readonly stopReason?: WorkflowStopReason;
    readonly rootDocumentPath?: string;
    readonly objectFormat?: "sha1" | "sha256";
    readonly components?: readonly WorkflowComponentEntry[];
  } = {},
): WorkflowRunRecord {
  const components = overrides.components;
  const stopReason = overrides.stopReason;
  return {
    runId: "replay-1",
    definition: {
      version: 1,
      kind: "git",
      objectFormat: overrides.objectFormat ?? "sha1",
      objectId: COMMIT,
      rootDocumentPath: overrides.rootDocumentPath ?? "flows/root.md",
      ...(components === undefined ? {} : { components }),
    },
    base: "main",
    props: {},
    status: overrides.status ?? "completed",
    ...(stopReason === undefined ? {} : { stopReason }),
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

/** A document that decided it failed, as canonical core records one. */
function documentFailure(output = ""): Json {
  const message = "the document refused";
  return { status: "err", output, error: { name: "Error", message, segment: { message } } };
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

/** The reason a failure no retained row identifies is named by. */
const HOST: WorkflowStopReason = { kind: "host", code: DOCUMENT_FAILED };

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
      entry(rootClose(documentFailure())),
    ];

    expect(
      admitted(retainedReplay(record({ status: "failed", stopReason: HOST }), history)).root,
    ).toEqual({
      path: "flows/root.md",
      source: SOURCE,
      retained: true,
      target: "Missing*",
    });
  });

  // deno-lint-ignore require-yield
  it("comes from the terminal when the run failed before importing anything", function* () {
    const history = [entry(preRootClose("flows/root.md", SOURCE, null))];

    // The document failed, so the run failed, and no retained row says where —
    // which is exactly what the one categorical code is for.
    expect(
      admitted(retainedReplay(record({ status: "failed", stopReason: HOST }), history)).root,
    ).toEqual({
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
    expect(reason(retainedReplay(record({ status: "failed", stopReason: HOST }), bound))).toContain(
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

describe("the lifecycle row and the recorded result have to agree", () => {
  /** One history whose root result is the outcome this case is about. */
  function ending(close: DurableEvent): { entries: JournalEntry[]; closeEventId: string } {
    const entries = [
      entry(rootImport({ kind: "repository", path: "flows/root.md", content: SOURCE })),
      entry(close),
    ];
    return { entries, closeEventId: entries[1]?.eventId ?? "" };
  }

  const failure = { name: "Error", message: "the run did not finish" };

  // deno-lint-ignore require-yield
  it("accepts a successful result under a completed run", function* () {
    const { entries } = ending(rootClose({ status: "ok", output: "", value: "" }));

    expect(admitted(retainedReplay(record(), entries)).root.path).toBe("flows/root.md");
  });

  // deno-lint-ignore require-yield
  it("accepts a failed result under a failed run naming that exact event", function* () {
    const { entries, closeEventId } = ending({
      type: "close",
      coroutineId: "root",
      result: { status: "err", error: failure },
    });

    const outcome = retainedReplay(
      record({ status: "failed", stopReason: { kind: "journal", eventId: closeEventId } }),
      entries,
    );
    expect(admitted(outcome).root.path).toBe("flows/root.md");
  });

  // deno-lint-ignore require-yield
  it("refuses every pairing the settled lifecycle cannot produce", function* () {
    const errored: DurableEvent = {
      type: "close",
      coroutineId: "root",
      result: { status: "err", error: failure },
    };
    const cancelled: DurableEvent = {
      type: "close",
      coroutineId: "root",
      result: { status: "cancelled" },
    };
    const succeeded = rootClose({ status: "ok", output: "", value: "" });

    const cases: { says: string; close: DurableEvent; status: WorkflowRunStatus; reason?: true }[] =
      [
        { says: "a successful result under a failed run", close: succeeded, status: "failed" },
        { says: "a failed result under a completed run", close: errored, status: "completed" },
        { says: "a cancelled result under a completed run", close: cancelled, status: "completed" },
        { says: "a cancelled result under a failed run", close: cancelled, status: "failed" },
        { says: "a failed run naming no reason at all", close: errored, status: "failed" },
        {
          says: "a failed run naming another event",
          close: errored,
          status: "failed",
          reason: true,
        },
      ];

    for (const { says, close, status, reason: elsewhere } of cases) {
      const { entries } = ending(close);
      const outcome = retainedReplay(
        record({
          status,
          ...(elsewhere === true
            ? { stopReason: { kind: "journal", eventId: "event-somewhere-else" } }
            : {}),
        }),
        entries,
      );
      expect([says, reason(outcome).includes("describe different outcomes")]).toEqual([says, true]);
    }
  });

  // deno-lint-ignore require-yield
  it("refuses a failed run whose reason is a host code rather than the event", function* () {
    const { entries } = ending({
      type: "close",
      coroutineId: "root",
      result: { status: "err", error: failure },
    });

    const outcome = retainedReplay(
      record({ status: "failed", stopReason: { kind: "host", code: "document-execution-failed" } }),
      entries,
    );
    expect(reason(outcome)).toContain("describe different outcomes");
  });

  // deno-lint-ignore require-yield
  it("refuses a completed run carrying a stop reason of its own", function* () {
    const { entries, closeEventId } = ending(rootClose({ status: "ok", output: "", value: "" }));

    const outcome = retainedReplay(
      record({ status: "completed", stopReason: { kind: "journal", eventId: closeEventId } }),
      entries,
    );
    expect(reason(outcome)).toContain("describe different outcomes");
  });
});

/** One retained effect, settled the way its own operation settled. */
function effect(name: string, settled: "ok" | "err"): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: "call", name },
    result:
      settled === "ok"
        ? { status: "ok", value: name }
        : { status: "err", error: { message: `${name} failed`, name: "Error" } },
  };
}

describe("what the root recorded, as one outcome", () => {
  // deno-lint-ignore require-yield
  it("reads the document's own result, not the coroutine's settlement", function* () {
    // The coroutine returned, so its settlement is `ok`. What it returned is a
    // document that failed, and that is what the run is.
    const failing = [
      entry(rootImport({ kind: "repository", path: "flows/root.md", content: SOURCE })),
      entry(rootClose(documentFailure("partial\n"))),
    ];
    expect(
      admitted(retainedReplay(record({ status: "failed", stopReason: HOST }), failing)).root,
    ).toEqual({ path: "flows/root.md", source: SOURCE, retained: true });
    // And a completed row over the same history is the disagreement.
    expect(reason(retainedReplay(record(), failing))).toContain("describe different outcomes");
  });

  // deno-lint-ignore require-yield
  it("names the exact retained row the failure stopped at", function* () {
    const rows = [
      entry(rootImport({ kind: "repository", path: "flows/root.md", content: SOURCE })),
      entry(effect("early", "err")),
      entry(effect("between", "ok")),
      entry(effect("late", "err")),
      entry(rootClose(documentFailure("partial\n"))),
    ];
    const late = rows[3]?.eventId ?? "";
    const early = rows[1]?.eventId ?? "";
    const between = rows[2]?.eventId ?? "";

    // The last row that failed, and only that one.
    expect(
      admitted(
        retainedReplay(
          record({ status: "failed", stopReason: { kind: "journal", eventId: late } }),
          rows,
        ),
      ).root.path,
    ).toBe("flows/root.md");

    const wrong: WorkflowStopReason[] = [
      { kind: "journal", eventId: early },
      { kind: "journal", eventId: between },
      { kind: "journal", eventId: "event-somewhere-else" },
      HOST,
      { kind: "host", code: "invented-code" },
    ];
    for (const stopReason of wrong) {
      const outcome = retainedReplay(record({ status: "failed", stopReason }), rows);
      expect([
        JSON.stringify(stopReason),
        reason(outcome).includes("describe different outcomes"),
      ]).toEqual([JSON.stringify(stopReason), true]);
    }
    // And a failure that names nothing at all.
    expect(reason(retainedReplay(record({ status: "failed" }), rows))).toContain(
      "describe different outcomes",
    );
  });

  // deno-lint-ignore require-yield
  it("refuses a document result this version cannot read", function* () {
    const message = "the document refused";
    const malformed: Json[] = [
      { status: "err" },
      { status: "err", output: "" },
      { status: "err", output: "", error: { name: "Error", message } },
      { status: "err", output: "", error: { name: "Error", message, segment: {} } },
      { status: "err", output: 7, error: { name: "Error", message, segment: { message } } },
      { status: "ok", output: "" },
      { status: "ok", output: "", value: "", extra: 1 },
      { status: "abandoned", output: "", value: "" },
      "not an object at all",
    ];

    for (const value of malformed) {
      const history = [
        entry(rootImport({ kind: "repository", path: "flows/root.md", content: SOURCE })),
        entry(rootClose(value)),
      ];
      const said = reason(retainedReplay(record(), history));
      expect([JSON.stringify(value), said.includes("cannot be read by this version")]).toEqual([
        JSON.stringify(value),
        true,
      ]);
      // And it says nothing about what it read.
      expect(said).not.toContain("abandoned");
    }
  });

  // deno-lint-ignore require-yield
  it("recognizes the exact terminal core writes before it imports anything", function* () {
    const message = "refused before the root import";
    const binding = { path: "flows/root.md", source: SOURCE, target: null };
    const failure = { name: "Error", message, segment: { message } };

    // The one form core can produce here, and the run it describes.
    const valid = [
      entry(rootClose({ status: "err", output: "", error: failure, root_binding: binding })),
    ];
    expect(retainedReplay(record({ status: "failed", stopReason: HOST }), valid).ok).toBe(true);

    const impossible: Json[] = [
      // A binding that is not one.
      { status: "err", output: "", error: failure, root_binding: 7 },
      { status: "err", output: "", error: failure, root_binding: [] },
      // A binding missing a member, carrying an extra one, or mistyping one.
      {
        status: "err",
        output: "",
        error: failure,
        root_binding: { path: "flows/root.md", source: SOURCE },
      },
      { status: "err", output: "", error: failure, root_binding: { ...binding, extra: 1 } },
      { status: "err", output: "", error: failure, root_binding: { ...binding, path: 7 } },
      { status: "err", output: "", error: failure, root_binding: { ...binding, source: 7 } },
      { status: "err", output: "", error: failure, root_binding: { ...binding, target: 7 } },
      // A binding on a result core could not have written it beside: nothing is
      // rendered before the root import, no segment failed, and a failure that
      // aggregated others got past it.
      { status: "err", output: "partial\n", error: failure, root_binding: binding },
      {
        status: "err",
        output: "",
        error: { name: "Error", message, segment: { message: "something else" } },
        root_binding: binding,
      },
      {
        status: "err",
        output: "",
        error: { name: "Error", message, segment: { message, source: "flows/root.md" } },
        root_binding: binding,
      },
      {
        status: "err",
        output: "",
        error: { name: "Error", message, segment: { message }, errors: [] },
        root_binding: binding,
      },
      { status: "ok", output: "", value: "", root_binding: binding },
    ];

    for (const value of impossible) {
      const said = reason(
        retainedReplay(record({ status: "failed", stopReason: HOST }), [entry(rootClose(value))]),
      );
      expect([JSON.stringify(value), said.includes("cannot be read by this version")]).toEqual([
        JSON.stringify(value),
        true,
      ]);
    }
  });

  // deno-lint-ignore require-yield
  it("correlates the terminal with the import history around it", function* () {
    const message = "refused before the root import";
    const bound = {
      status: "err",
      output: "",
      error: { name: "Error", message, segment: { message } },
      root_binding: { path: "flows/root.md", source: SOURCE, target: null },
    };
    const imported = rootImport({ kind: "repository", path: "flows/root.md", content: SOURCE });
    const succeeded = { status: "ok", output: "done.\n", value: "done.\n" };

    // The two histories any execution can produce.
    const canonical: { says: string; entries: JournalEntry[]; status: WorkflowRunStatus }[] = [
      {
        says: "imported, then a result",
        entries: [entry(imported), entry(rootClose(succeeded))],
        status: "completed",
      },
      {
        says: "no import, and the bound failure",
        entries: [entry(rootClose(bound))],
        status: "failed",
      },
    ];
    for (const { says, entries, status } of canonical) {
      expect([says, rootOutcome(entries)?.kind]).toEqual([says, "outcome"]);
      const outcome = retainedReplay(
        record({ status, ...(status === "failed" ? { stopReason: HOST } : {}) }),
        entries,
      );
      expect([says, outcome.ok]).toEqual([says, true]);
    }

    // And the ones none can. A binding is written only by a run that imported
    // nothing; an ordinary result is written only by one that imported.
    const impossible: { says: string; entries: JournalEntry[]; status: WorkflowRunStatus }[] = [
      {
        says: "imported, then the bound failure",
        entries: [entry(imported), entry(rootClose(bound))],
        status: "failed",
      },
      {
        says: "no import, and an ordinary failure",
        entries: [entry(rootClose(documentFailure("partial\n")))],
        status: "failed",
      },
      {
        says: "no import, and a success",
        entries: [entry(rootClose(succeeded))],
        status: "completed",
      },
      {
        says: "an import that failed, then a result",
        entries: [
          entry({
            type: "yield",
            coroutineId: "root",
            description: { type: "import_component", name: "__root__" },
            result: { status: "err", error: { message: "gone", name: "Error" } },
          }),
          entry(rootClose(succeeded)),
        ],
        status: "completed",
      },
      {
        says: "an import another coroutine recorded",
        entries: [
          entry({
            type: "yield",
            coroutineId: "child",
            description: { type: "import_component", name: "__root__" },
            result: {
              status: "ok",
              value: { kind: "repository", path: "flows/root.md", content: SOURCE },
            },
          }),
          entry(rootClose(succeeded)),
        ],
        status: "completed",
      },
    ];
    for (const { says, entries, status } of impossible) {
      // Stale recovery classifies it as damage rather than publishing from it.
      expect([says, rootOutcome(entries)?.kind]).toEqual([says, "damaged"]);
      // And admission refuses it rather than building a root from it.
      const said = reason(
        retainedReplay(
          record({ status, ...(status === "failed" ? { stopReason: HOST } : {}) }),
          entries,
        ),
      );
      expect([says, said.includes("cannot be read by this version")]).toEqual([says, true]);
    }
  });

  // deno-lint-ignore require-yield
  it("admits the shapes canonical execution actually writes", function* () {
    const message = "the document refused";
    const written: { value: Json; status: WorkflowRunStatus }[] = [
      { value: { status: "ok", output: "done\n", value: "done\n" }, status: "completed" },
      { value: { status: "ok", output: "", value: null }, status: "completed" },
      {
        value: {
          status: "err",
          output: "partial\n",
          error: {
            name: "Error",
            message,
            segment: { message, source: "flows/root.md" },
            cause: "because",
            errors: [{ name: "Error", message }],
          },
        },
        status: "failed",
      },
    ];

    for (const { value, status } of written) {
      const history = [
        entry(rootImport({ kind: "repository", path: "flows/root.md", content: SOURCE })),
        entry(rootClose(value)),
      ];
      const outcome = retainedReplay(
        record({ status, ...(status === "failed" ? { stopReason: HOST } : {}) }),
        history,
      );
      expect([JSON.stringify(value), outcome.ok]).toEqual([JSON.stringify(value), true]);
    }
  });
});

/**
 * The object ids `git hash-object -t blob` gives these exact bytes.
 *
 * Committed constants rather than a computation, because a test that derived
 * them from the same function it is checking would agree with itself. They came
 * from Git, and `packages/workflow/tests/git-blob.test.ts` holds the arithmetic
 * to Git's own answers and to FIPS 180-4's published ones.
 */
const STAGED = "staged.\n";
const STAGED_SHA1 = "4eb53b7fd720524e22040757b43e821f817ff0eb";
const STAGED_SHA256 = "bee278bf729e0ac11f0bd6bf2ec94b1536d51883bd6e426ac32ec0a94afe76ca";
const UNUSED_SHA1 = "0b42d358385c85db1957138c7a200ad153514209";
/** Four characters and seven bytes, so Git's framing cannot use the string length. */
const WIDE = "caf\u00e9 \u{1f409}\n";
const WIDE_SHA1 = "c4ae463ec163e7b0b1a47ca6f0d5a2205d3643dc";

describe("the bundle a completed replay is held to", () => {
  const declared: readonly WorkflowComponentEntry[] = [
    { name: "Stage", path: "flows/Stage.md", sourceHash: STAGED_SHA1 },
    { name: "Unused", path: "flows/Unused.md", sourceHash: UNUSED_SHA1 },
  ];

  /** One retained import of the declared `Stage`, as canonical execution wrote it. */
  function staged(overrides: Record<string, Json> = {}): DurableEvent {
    return componentImport("Stage", {
      kind: "workflow",
      path: "flows/Stage.md",
      sourceHash: STAGED_SHA1,
      content: STAGED,
      ...overrides,
    });
  }

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

  it("admits an import whose bytes are the object the definition names", function* () {
    const replay = admitted(retainedReplay(record({ components: declared }), completedHistory()));

    expect(yield* admit(replay.installations, [RUN_RECORD, staged()])).toBe(undefined);
  });

  it("admits the same under sha256, and where bytes outnumber characters", function* () {
    const cases: { format: "sha1" | "sha256"; hash: string; content: string }[] = [
      { format: "sha256", hash: STAGED_SHA256, content: STAGED },
      { format: "sha1", hash: WIDE_SHA1, content: WIDE },
    ];

    for (const { format, hash, content } of cases) {
      const components: readonly WorkflowComponentEntry[] = [
        { name: "Stage", path: "flows/Stage.md", sourceHash: hash },
      ];
      const replay = admitted(
        retainedReplay(record({ components, objectFormat: format }), completedHistory()),
      );
      const held = componentImport("Stage", {
        kind: "workflow",
        path: "flows/Stage.md",
        sourceHash: hash,
        content,
      });
      expect([format, yield* admit(replay.installations, [RUN_RECORD, held])]).toEqual([
        format,
        undefined,
      ]);

      // The same identity, other bytes. Repeating an object id is not being it.
      const altered = componentImport("Stage", {
        kind: "workflow",
        path: "flows/Stage.md",
        sourceHash: hash,
        content: `${content}ALTERED\n`,
      });
      expect(yield* admit(replay.installations, [RUN_RECORD, altered])).toEqual(
        expect.any(WorkflowBundleHistoryError),
      );
    }
  });

  it("refuses altered bytes under the object id the definition declares", function* () {
    const replay = admitted(retainedReplay(record({ components: declared }), completedHistory()));
    // The exact declared path and object id, and content that is not that
    // object. This is the record a history rewritten in place would carry.
    const altered = staged({ content: "ALTERED\n" });

    const refused = yield* admit(replay.installations, [RUN_RECORD, altered]);
    expect(refused).toEqual(expect.any(WorkflowBundleHistoryError));
    // And it says nothing about what it read.
    expect(String(refused)).not.toContain("ALTERED");
    expect(String(refused)).not.toContain("flows/Stage.md");
  });

  it("refuses one recorded under another path, hash, name or kind", function* () {
    const replay = admitted(retainedReplay(record({ components: declared }), completedHistory()));
    const wrong: DurableEvent[] = [
      staged({ path: "flows/Elsewhere.md" }),
      // A different object id, and content that really is that object: the
      // definition still does not name it.
      componentImport("Stage", {
        kind: "workflow",
        path: "flows/Stage.md",
        sourceHash: UNUSED_SHA1,
        content: "never imported.\n",
      }),
      componentImport("Undeclared", {
        kind: "workflow",
        path: "flows/Stage.md",
        sourceHash: STAGED_SHA1,
        content: STAGED,
      }),
      componentImport("Stage", {
        kind: "repository",
        path: "flows/Stage.md",
        content: STAGED,
      }),
      staged({ content: 7 }),
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
