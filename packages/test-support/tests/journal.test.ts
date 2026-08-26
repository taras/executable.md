/**
 * What the shared journal reader says about an array of durable events.
 *
 * Hand-written events and parser spies, because what is under test is the
 * projection itself: no database is opened here, and no effect-specific parser
 * is imported. The retained payloads carry a sentinel standing in for a
 * credential, so a diagnostic that echoed one would be visible.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import {
  effectSequence,
  readRetainedRecords,
  readRetainedValues,
  selectYields,
} from "@executablemd/test-support/journal";
import type { RetainedRecordParser } from "@executablemd/test-support/journal";
import type { Close, DurableEvent, Json, Yield } from "@executablemd/durable-streams";

const SENTINEL = "retained-credential-sentinel";

function settled(type: string, value: Json): Yield {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type, name: type },
    result: { status: "ok", value },
  };
}

function unsettled(type: string): Yield {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type, name: type },
    result: { status: "ok" },
  };
}

function failed(type: string, message: string): Yield {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type, name: type },
    result: { status: "err", error: { name: "GitHostConflictError", message } },
  };
}

function cancelled(type: string): Yield {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type, name: type },
    result: { status: "cancelled" },
  };
}

function closed(coroutineId: string): Close {
  return { type: "close", coroutineId, result: { status: "ok" } };
}

interface Reconciliation {
  readonly kind: string;
  readonly decision: string;
}

/** A parser that owns its record type, and counts what it was asked to read. */
function reconciliations(): {
  parse: RetainedRecordParser<Reconciliation>;
  seen: unknown[];
} {
  const seen: unknown[] = [];
  return {
    seen,
    parse: (value: unknown): Reconciliation | undefined => {
      seen.push(value);
      if (typeof value !== "object" || value === null) {
        return undefined;
      }
      const kind = Reflect.get(value, "kind");
      const decision = Reflect.get(value, "decision");
      if (typeof kind !== "string" || typeof decision !== "string") {
        return undefined;
      }
      return { kind, decision };
    },
  };
}

describe("test-support journal reader", () => {
  /** JR1 */
  // deno-lint-ignore require-yield
  it("selects the named effect types in order, numbered from zero", function* () {
    const first = settled("workspace_repository", { record: { name: "project" } });
    const second = settled("workspace_worktree", { record: { name: "implementation" } });
    const third = settled("workspace_repository", { record: { name: "second" } });
    const events: DurableEvent[] = [
      closed("root.0"),
      first,
      settled("workspace_file", { record: { path: "which.txt" } }),
      closed("root.1"),
      second,
      closed("root.2"),
      third,
    ];

    expect(selectYields(events, ["workspace_repository", "workspace_worktree"])).toEqual([
      { position: 0, effect: "workspace_repository", event: first },
      { position: 1, effect: "workspace_worktree", event: second },
      { position: 2, effect: "workspace_repository", event: third },
    ]);
    expect(selectYields(events, [])).toEqual([]);
  });

  /** JR2 */
  // deno-lint-ignore require-yield
  it("drops the four bookkeeping types and numbers what is left after them", function* () {
    const events: DurableEvent[] = [
      settled("workflow_run", null),
      settled("import_component", null),
      settled("workspace_repository", null),
      settled("loop", null),
      settled("workspace_worktree", null),
      settled("loop_iteration", null),
      // Similarly named, and not what this repository calls bookkeeping.
      settled("loop_control", null),
      closed("root"),
      settled("workspace_git_commit", null),
    ];

    expect(effectSequence(events)).toEqual([
      "0 workspace_repository",
      "1 workspace_worktree",
      "2 loop_control",
      "3 workspace_git_commit",
    ]);
  });

  /** JR3 */
  // deno-lint-ignore require-yield
  it("parses a direct result value through the parser that owns it", function* () {
    const { parse, seen } = reconciliations();
    const events: DurableEvent[] = [
      settled("git_host_effect", { kind: "git-push", decision: "performed" }),
      settled("git_host_effect", { kind: "pull-request", decision: "adopted" }),
    ];

    const outcomes = readRetainedValues(events, "git_host_effect", parse);

    expect(outcomes).toEqual([
      {
        position: 0,
        effect: "git_host_effect",
        status: "ok",
        record: { kind: "git-push", decision: "performed" },
      },
      {
        position: 1,
        effect: "git_host_effect",
        status: "ok",
        record: { kind: "pull-request", decision: "adopted" },
      },
    ]);
    expect(seen).toHaveLength(2);
    const [first] = outcomes;
    if (first?.status !== "ok") {
      throw new Error("the first Git-host effect did not settle ok");
    }
    // The record is typed, so this reads a member rather than a `Reflect.get`.
    expect(first.record.kind).toBe("git-push");
  });

  /** JR4 */
  // deno-lint-ignore require-yield
  it("parses a nested result record through the parser that owns it", function* () {
    const { parse } = reconciliations();
    const events: DurableEvent[] = [
      settled("workspace_repository", {
        record: { kind: "repository", decision: "/repositories/project" },
      }),
    ];

    expect(readRetainedRecords(events, "workspace_repository", parse)).toEqual([
      {
        position: 0,
        effect: "workspace_repository",
        status: "ok",
        record: { kind: "repository", decision: "/repositories/project" },
      },
    ]);
  });

  /** JR5 */
  // deno-lint-ignore require-yield
  it("keeps failed and cancelled outcomes in place without parsing them", function* () {
    const { parse, seen } = reconciliations();
    const events: DurableEvent[] = [
      failed("git_host_effect", "the destination moved"),
      settled("git_host_effect", { kind: "git-push", decision: "performed" }),
      cancelled("git_host_effect"),
    ];

    expect(readRetainedValues(events, "git_host_effect", parse)).toEqual([
      {
        position: 0,
        effect: "git_host_effect",
        status: "err",
        error: { name: "GitHostConflictError", message: "the destination moved" },
      },
      {
        position: 1,
        effect: "git_host_effect",
        status: "ok",
        record: { kind: "git-push", decision: "performed" },
      },
      { position: 2, effect: "git_host_effect", status: "cancelled" },
    ]);
    expect(seen).toEqual([{ kind: "git-push", decision: "performed" }]);
  });

  /** JR6 */
  // deno-lint-ignore require-yield
  it("refuses a success whose direct value is absent, naming only where it is", function* () {
    const { parse } = reconciliations();
    const events: DurableEvent[] = [
      settled("git_host_effect", { kind: "git-push", decision: "performed", token: SENTINEL }),
      unsettled("git_host_effect"),
    ];

    const message = refusal(() => readRetainedValues(events, "git_host_effect", parse));

    expect(message).toBe(
      "the value retained at 1 git_host_effect is not a record its parser reads",
    );
    expect(message).not.toContain(SENTINEL);
  });

  /** JR6 */
  // deno-lint-ignore require-yield
  it("refuses a success whose nested record is absent, echoing no payload", function* () {
    const { parse } = reconciliations();
    const events: DurableEvent[] = [settled("workspace_repository", { token: SENTINEL })];

    const message = refusal(() => readRetainedRecords(events, "workspace_repository", parse));

    expect(message).toBe(
      "the value retained at 0 workspace_repository is not a record its parser reads",
    );
    expect(message).not.toContain(SENTINEL);
  });

  /** JR6 */
  // deno-lint-ignore require-yield
  it("refuses a success its parser will not read, echoing no payload", function* () {
    const { parse } = reconciliations();
    const events: DurableEvent[] = [
      settled("git_host_effect", { decision: "performed", token: SENTINEL }),
    ];

    const message = refusal(() => readRetainedValues(events, "git_host_effect", parse));

    expect(message).toBe(
      "the value retained at 0 git_host_effect is not a record its parser reads",
    );
    expect(message).not.toContain(SENTINEL);
  });

  /** JR7 */
  it("declares the durable-stream dependency this subpath reads, and no workflow", function* () {
    const manifest: unknown = JSON.parse(
      yield* readTextFile(new URL("../package.json", import.meta.url)),
    );
    const dependencies = Object(Reflect.get(Object(manifest), "dependencies"));
    const exports = Object(Reflect.get(Object(manifest), "exports"));

    expect(Reflect.get(exports, "./journal")).toBe("./journal.ts");
    expect(Reflect.get(dependencies, "@executablemd/durable-streams")).toBe("workspace:*");
    expect(Object.keys(dependencies)).not.toContain("@executablemd/workflow");
  });
});

/**
 * What the reader refused with, and a failure when it refused nothing.
 *
 * A reader that returned instead of throwing would leave every assertion below
 * unreached, which is a pass that proves nothing.
 */
function refusal(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    return String(Reflect.get(Object(error), "message"));
  }
  throw new Error("the reader returned instead of refusing");
}
