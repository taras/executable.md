/**
 * Tier WR — workflow runs.
 *
 * A workflow run ties one run to a single pinned starting commit, recorded
 * durably before the root document is imported. What these measure is the
 * lifetime — where the run is readable and where it is not — and what replay
 * does and does not repeat.
 *
 * Nothing here reaches a real repository: `Git` is replaced in every test, and
 * several replace it with a provider that fails if it is invoked at all, so
 * "Git was not consulted" is asserted rather than assumed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import {
  collect,
  DocumentOutput,
  execute,
  getExpansion,
  inlineSource,
  registerComponents,
} from "@executablemd/core";
import { Git } from "../src/git.ts";
import { getWorkflowRun, useWorkflow } from "../src/run.ts";
import type { WorkflowRun } from "../src/run.ts";

const COMMIT = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const OTHER_COMMIT = "1111111111111111111111111111111111111111";

/** Resolve every revision to `commit`, and count the times Git was asked. */
function useGit(commit: string, asked: string[]): Operation<void> {
  return Git.around(
    {
      // deno-lint-ignore require-yield
      *revParse([revision]) {
        asked.push(revision);
        return commit;
      },
    },
    { at: "min" },
  );
}

/** A Git that fails the test if anything consults it. */
function useForbiddenGit(): Operation<void> {
  return Git.around(
    {
      // deno-lint-ignore require-yield
      *revParse([revision]) {
        throw new Error(`Git was consulted for "${revision}"`);
      },
    },
    { at: "min" },
  );
}

/** `<Probe />` — reports the run it was expanded under. */
function useProbe(seen: WorkflowRun[]): Operation<void> {
  return registerComponents([
    {
      name: "Probe",
      origin: "tier-wr",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        seen.push(yield* getWorkflowRun());
        return "";
      },
    },
  ]);
}

function workflowEvents(stream: InMemoryStream): DurableEvent[] {
  return stream
    .snapshot()
    .filter((event) => event.type === "yield" && event.description.type === "workflow_run");
}

/** The `workflow_run` value the journal holds, or undefined when it holds none. */
function recordedRun(stream: InMemoryStream): Json | undefined {
  const event = workflowEvents(stream)[0];
  if (event === undefined || event.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  return event.result.value;
}

describe("Tier WR — workflow runs", () => {
  it("WR1: is unreadable before the execution, readable inside it, unreadable after", function* () {
    const seen: WorkflowRun[] = [];
    const before: string[] = [];
    const after: string[] = [];

    yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* useProbe(seen);
      yield* useWorkflow({ base: "main" });

      // Installing the middleware creates no workflow run.
      try {
        yield* getWorkflowRun();
      } catch (error) {
        before.push(error instanceof Error ? error.message : String(error));
      }

      yield* collect(
        yield* execute({ ...inlineSource("<Probe />\n"), stream: new InMemoryStream() }),
      );

      // ...and the run does not outlive the execution that owns it, even though
      // the scope that installed the middleware is still alive.
      try {
        yield* getWorkflowRun();
      } catch (error) {
        after.push(error instanceof Error ? error.message : String(error));
      }
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ runId: expect.any(String), base: "main", pinnedCommit: COMMIT });
    expect(before[0]).toContain("useWorkflow");
    expect(after[0]).toContain("useWorkflow");
  });

  it("WR2: every read inside one execution answers with the same frozen value", function* () {
    const seen: WorkflowRun[] = [];

    yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* useProbe(seen);
      yield* useWorkflow({ base: "main" });
      yield* collect(
        yield* execute({
          ...inlineSource("<Probe />\n\n<Probe />\n"),
          stream: new InMemoryStream(),
        }),
      );
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("WR3: concurrent executions each read their own run", function* () {
    const first: WorkflowRun[] = [];
    const second: WorkflowRun[] = [];

    function run(into: WorkflowRun[], base: string, commit: string): Operation<void> {
      return scoped(function* () {
        yield* useGit(commit, []);
        yield* useProbe(into);
        yield* useWorkflow({ base });
        yield* collect(
          yield* execute({ ...inlineSource("<Probe />\n"), stream: new InMemoryStream() }),
        );
      });
    }

    yield* scoped(function* () {
      const a = yield* spawn(() => run(first, "main", COMMIT));
      const b = yield* spawn(() => run(second, "release", OTHER_COMMIT));
      yield* a;
      yield* b;
    });

    expect(first[0]?.base).toBe("main");
    expect(first[0]?.pinnedCommit).toBe(COMMIT);
    expect(second[0]?.base).toBe("release");
    expect(second[0]?.pinnedCommit).toBe(OTHER_COMMIT);
    expect(first[0]?.runId).not.toBe(second[0]?.runId);
  });

  it("WR4: a completed journal restores the run without consulting Git", function* () {
    const stream = new InMemoryStream();
    const live: WorkflowRun[] = [];
    const asked: string[] = [];

    yield* scoped(function* () {
      yield* useGit(COMMIT, asked);
      yield* useProbe(live);
      yield* useWorkflow({ base: "main" });
      yield* collect(yield* execute({ ...inlineSource("<Probe />\n"), stream }));
    });
    expect(asked).toEqual(["main^{commit}"]);

    // The root Close is in the journal, so the document never expands again and
    // the only reader left is a middleware watching the replayed output.
    const replayed: WorkflowRun[] = [];
    yield* scoped(function* () {
      yield* useForbiddenGit();
      yield* useWorkflow({ base: "main" });
      yield* DocumentOutput.around({
        *output([text], next) {
          replayed.push(yield* getWorkflowRun());
          yield* next(text);
        },
      });
      yield* collect(yield* execute({ ...inlineSource("<Probe />\n"), stream }));
    });

    expect(replayed).not.toHaveLength(0);
    expect(replayed[0]).toEqual(live[0]);
    // A replay preserves the field values, never JavaScript object identity.
    expect(replayed[0]).not.toBe(live[0]);
  });

  it("WR5: a completed journal refuses a different base before returning its result", function* () {
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* useProbe([]);
      yield* useWorkflow({ base: "main" });
      yield* collect(yield* execute({ ...inlineSource("<Probe />\n"), stream }));
    });

    const emitted: string[] = [];
    const result = yield* scoped(function* () {
      yield* useForbiddenGit();
      yield* useWorkflow({ base: "release" });
      yield* DocumentOutput.around({
        *output([text], next) {
          emitted.push(text);
          yield* next(text);
        },
      });
      return yield* yield* execute({ ...inlineSource("<Probe />\n"), stream });
    });

    expect(result.ok).toBe(false);
    const message = result.ok ? "" : result.error.message;
    expect(message).toContain("main");
    expect(message).toContain("release");
    // The recorded result never reaches the caller: the refusal lands first.
    expect(emitted).toHaveLength(0);
  });

  it("WR6: a moving base cannot change a recorded pinned commit", function* () {
    const stream = new InMemoryStream();
    const live: WorkflowRun[] = [];
    yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* useProbe(live);
      yield* useWorkflow({ base: "main" });
      yield* collect(yield* execute({ ...inlineSource("<Probe />\n"), stream }));
    });

    // The branch moved between runs. The recorded commit is what stands.
    const restored: WorkflowRun[] = [];
    const asked: string[] = [];
    yield* scoped(function* () {
      yield* useGit(OTHER_COMMIT, asked);
      yield* useWorkflow({ base: "main" });
      yield* DocumentOutput.around({
        *output([text], next) {
          restored.push(yield* getWorkflowRun());
          yield* next(text);
        },
      });
      yield* collect(yield* execute({ ...inlineSource("<Probe />\n"), stream }));
    });

    expect(asked).toHaveLength(0);
    expect(restored[0]?.pinnedCommit).toBe(COMMIT);
    expect(restored[0]?.runId).toBe(live[0]?.runId);
  });

  it("WR7: a failure to resolve the base records no run and expands no document", function* () {
    const stream = new InMemoryStream();
    const expanded: WorkflowRun[] = [];

    const result = yield* scoped(function* () {
      yield* Git.around(
        {
          // deno-lint-ignore require-yield
          *revParse() {
            throw new Error("fatal: not a git repository");
          },
        },
        { at: "min" },
      );
      yield* useProbe(expanded);
      yield* useWorkflow({ base: "main" });
      return yield* yield* execute({ ...inlineSource("<Probe />\n"), stream });
    });

    expect(result.ok).toBe(false);
    expect(expanded).toHaveLength(0);
    expect(recordedRun(stream)).toBeUndefined();
  });

  it("WR8: a run survives a document that fails after it was recorded", function* () {
    const stream = new InMemoryStream();

    const result = yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* useWorkflow({ base: "main" });
      return yield* yield* execute({
        // A value root that produces no <Return> fails after expansion begins.
        ...inlineSource("---\nreturns:\n  type: object\n---\n\nbody\n"),
        stream,
      });
    });

    expect(result.ok).toBe(false);
    expect(recordedRun(stream)).toEqual({
      runId: expect.any(String),
      base: "main",
      pinnedCommit: COMMIT,
    });
  });

  // Ordinary execution stays Git-independent: with no workflow middleware
  // installed, nothing reaches the process boundary looking for `git`.
  it("WR9: an execution without useWorkflow never invokes Git", function* () {
    const commands: string[][] = [];

    const output = yield* scoped(function* () {
      yield* API.Process.around(
        {
          // deno-lint-ignore require-yield
          *exec([options]) {
            commands.push(options.command);
            throw new Error(`the run executed ${options.command[0]}`);
          },
        },
        { at: "min" },
      );
      return yield* collect(
        yield* execute({ ...inlineSource("# Hello\n"), stream: new InMemoryStream() }),
      );
    });

    expect(String(output)).toContain("Hello");
    expect(commands).toHaveLength(0);
  });

  it("WR10: getWorkflowRun() throws inside an execution that installed no workflow", function* () {
    const failures: string[] = [];

    yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Probe",
          origin: "tier-wr",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            try {
              yield* getWorkflowRun();
            } catch (error) {
              failures.push(error instanceof Error ? error.message : String(error));
            }
            return "";
          },
        },
      ]);
      yield* collect(
        yield* execute({ ...inlineSource("<Probe />\n"), stream: new InMemoryStream() }),
      );
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("useWorkflow");
  });

  it("WR11: a journal holding something else under the workflow name is refused", function* () {
    const stream = new InMemoryStream();
    yield* stream.append({
      type: "yield",
      coroutineId: "root",
      description: { type: "workflow_run", name: "workflow_run", base: "main" },
      result: { status: "ok", value: { runId: 7, base: "main" } },
    });

    const result = yield* scoped(function* () {
      yield* useForbiddenGit();
      yield* useWorkflow({ base: "main" });
      return yield* yield* execute({ ...inlineSource("# Hello\n"), stream });
    });

    expect(result.ok).toBe(false);
    const message = result.ok ? "" : result.error.message;
    // The refusal describes the situation; it never quotes what the journal held.
    expect(message).not.toContain("7");
  });

  // WR4-WR6 build their journal with a live run first, so they cannot show that
  // replay is independent of the live path. These two seed the journal by hand:
  // nothing here has ever allocated an identifier or asked Git anything.
  it("WR13: a completed journal seeded by hand restores without any live run", function* () {
    const stream = new InMemoryStream();
    yield* stream.append({
      type: "yield",
      coroutineId: "root",
      description: { type: "workflow_run", name: "workflow_run", base: "main" },
      result: { status: "ok", value: { runId: "seeded-run", base: "main", pinnedCommit: COMMIT } },
    });
    // The root import a real completed run always records. A retained terminal
    // result is reused on the strength of the selection its root import
    // established, so a journal that carries one without the other describes a
    // run that never happened and is refused.
    yield* stream.append({
      type: "yield",
      coroutineId: "root",
      description: { type: "import_component", name: "__root__" },
      result: {
        status: "ok",
        value: { kind: "repository", path: "<eval>", content: "# Hello\n" },
      },
    });
    yield* stream.append({
      type: "close",
      coroutineId: "root",
      result: { status: "ok", value: { status: "ok", output: "# Hello\n", value: "# Hello\n" } },
    });

    const restored: WorkflowRun[] = [];
    yield* scoped(function* () {
      yield* useForbiddenGit();
      yield* useWorkflow({ base: "main" });
      yield* DocumentOutput.around({
        *output([text], next) {
          restored.push(yield* getWorkflowRun());
          yield* next(text);
        },
      });
      yield* collect(yield* execute({ ...inlineSource("# Hello\n"), stream }));
    });

    expect(restored[0]).toEqual({ runId: "seeded-run", base: "main", pinnedCommit: COMMIT });
  });

  it("WR14: a truncated journal seeded by hand restores, and the document runs on", function* () {
    const stream = new InMemoryStream();
    yield* stream.append({
      type: "yield",
      coroutineId: "root",
      description: { type: "workflow_run", name: "workflow_run", base: "main" },
      result: { status: "ok", value: { runId: "seeded-run", base: "main", pinnedCommit: COMMIT } },
    });

    const seen: WorkflowRun[] = [];
    yield* scoped(function* () {
      yield* useForbiddenGit();
      yield* useProbe(seen);
      yield* useWorkflow({ base: "main" });
      yield* collect(yield* execute({ ...inlineSource("<Probe />\n"), stream }));
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ runId: "seeded-run", base: "main", pinnedCommit: COMMIT });
    // The record was replayed, not written a second time.
    expect(workflowEvents(stream)).toHaveLength(1);
  });

  // The expansion identifier is derived from the document alone. A workflow run
  // pairs with it for workflow-wide identity; it never enters the derivation.
  it("WR15: expansion identifiers do not move with the workflow run", function* () {
    function* ids(base?: string): Operation<string[]> {
      const seen: string[] = [];
      yield* scoped(function* () {
        yield* useGit(base === "release" ? OTHER_COMMIT : COMMIT, []);
        yield* registerComponents([
          {
            name: "Probe",
            origin: "tier-wr",
            props: { type: "object", properties: {}, additionalProperties: false },
            *fn() {
              seen.push((yield* getExpansion()).id);
              return "";
            },
          },
        ]);
        if (base !== undefined) {
          yield* useWorkflow({ base });
        }
        yield* collect(
          yield* execute({ ...inlineSource("<Probe />\n"), stream: new InMemoryStream() }),
        );
      });
      return seen;
    }

    const withoutWorkflow = yield* ids();
    const firstRun = yield* ids("main");
    const secondRun = yield* ids("release");

    expect(withoutWorkflow).toHaveLength(1);
    expect(firstRun).toEqual(withoutWorkflow);
    expect(secondRun).toEqual(withoutWorkflow);
  });

  it("WR16: cancelling a document execution does not erase a recorded run", function* () {
    const stream = new InMemoryStream();
    // The component says when it has observed the recorded run, so the
    // cancellation lands after that point by construction rather than by
    // winning a race against a timer.
    const observed = withResolvers<void>();

    yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* registerComponents([
        {
          name: "Probe",
          origin: "tier-wr",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            yield* getWorkflowRun();
            observed.resolve();
            // Held open, so the execution is still running when it is cancelled.
            yield* suspend();
            return "";
          },
        },
      ]);
      yield* useWorkflow({ base: "main" });

      const execution = yield* spawn(function* () {
        yield* collect(yield* execute({ ...inlineSource("<Probe />\n"), stream }));
      });
      yield* observed.operation;
      yield* execution.halt();
    });

    expect(recordedRun(stream)).toEqual({
      runId: expect.any(String),
      base: "main",
      pinnedCommit: COMMIT,
    });
  });

  // `run.ts` makes the same loaded-copy claim core does: a second copy of this
  // package reads the run through its own descriptor of the same context name.
  it("WR17: a descriptor of the same name built elsewhere reads the run", function* () {
    let own: WorkflowRun | undefined;
    let observed: unknown;
    const elsewhere = createContext<unknown>("executablemd.workflow.run", undefined);

    yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* registerComponents([
        {
          name: "Probe",
          origin: "tier-wr",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            own = yield* getWorkflowRun();
            observed = yield* elsewhere.get();
            return "";
          },
        },
      ]);
      yield* useWorkflow({ base: "main" });
      yield* collect(
        yield* execute({ ...inlineSource("<Probe />\n"), stream: new InMemoryStream() }),
      );
    });

    expect(own).toBeDefined();
    expect(observed).toBe(own);
  });

  it("WR12: a slow Git does not stall a sibling execution", function* () {
    const seen: WorkflowRun[] = [];

    yield* scoped(function* () {
      yield* useProbe(seen);
      const slow = yield* spawn(() =>
        scoped(function* () {
          yield* Git.around(
            {
              *revParse() {
                yield* sleep(30);
                return COMMIT;
              },
            },
            { at: "min" },
          );
          yield* useWorkflow({ base: "slow" });
          yield* collect(
            yield* execute({ ...inlineSource("<Probe />\n"), stream: new InMemoryStream() }),
          );
        }),
      );
      yield* scoped(function* () {
        yield* useGit(OTHER_COMMIT, []);
        yield* useWorkflow({ base: "fast" });
        yield* collect(
          yield* execute({ ...inlineSource("<Probe />\n"), stream: new InMemoryStream() }),
        );
      });
      yield* slow;
    });

    expect(seen.map((run) => run.base).sort()).toEqual(["fast", "slow"]);
  });
});
