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
  Execution,
  getExpansion,
  inlineSource,
  registerComponents,
} from "@executablemd/core";
import { createApi } from "@effectionx/context-api";
import type { Api } from "@effectionx/context-api";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { Git } from "../src/git.ts";
import { getWorkflowRun, workflowInstallation } from "../src/run.ts";
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
      const workflow = workflowInstallation({ base: "main" });

      // Installing the middleware creates no workflow run.
      try {
        yield* getWorkflowRun();
      } catch (error) {
        before.push(error instanceof Error ? error.message : String(error));
      }

      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream: new InMemoryStream() }, [
          workflow,
        ]),
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
    expect(before[0]).toContain("workflowInstallation");
    expect(after[0]).toContain("workflowInstallation");
  });

  it("WR2: every read inside one execution answers with the same frozen value", function* () {
    const seen: WorkflowRun[] = [];

    yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* useProbe(seen);
      const workflow = workflowInstallation({ base: "main" });
      yield* collect(
        yield* executeInstalled(
          {
            ...inlineSource("<Probe />\n\n<Probe />\n"),
            stream: new InMemoryStream(),
          },
          [workflow],
        ),
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
        const workflow = workflowInstallation({ base });
        yield* collect(
          yield* executeInstalled(
            { ...inlineSource("<Probe />\n"), stream: new InMemoryStream() },
            [workflow],
          ),
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

  it("WR20: one installation value reused by two executions gives each its own run", function* () {
    // A host may hold one installation value and run more than one document
    // with it. Each of those is a separate execution, and the run one of them
    // records is not the other's — including while both are live.
    const shared = workflowInstallation({ base: "main" });
    const prepared = withResolvers<void>();
    const release = withResolvers<void>();
    const streamA = new InMemoryStream();
    const streamB = new InMemoryStream();
    const seenA: WorkflowRun[] = [];
    const seenB: WorkflowRun[] = [];

    const first = yield* spawn(() =>
      scoped(function* () {
        yield* useGit(COMMIT, []);
        yield* registerComponents([
          {
            name: "Hold",
            origin: "tier-wr",
            props: { type: "object", properties: {}, additionalProperties: false },
            *fn() {
              // Prepared, and holding here while the sibling runs end to end.
              prepared.resolve();
              yield* release.operation;
              seenA.push(yield* getWorkflowRun());
              seenA.push(yield* getWorkflowRun());
              return "";
            },
          },
        ]);
        return yield* collect(
          yield* executeInstalled({ ...inlineSource("<Hold />\n"), stream: streamA }, [shared]),
        );
      }),
    );

    yield* prepared.operation;

    yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* useProbe(seenB);
      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream: streamB }, [shared]),
      );
    });

    release.resolve();
    yield* first;

    const recordedA = recordedRun(streamA);
    const recordedB = recordedRun(streamB);
    expect(recordedA).toBeDefined();
    expect(recordedB).toBeDefined();
    const idA =
      recordedA !== null && typeof recordedA === "object" && "runId" in recordedA
        ? recordedA.runId
        : undefined;
    const idB =
      recordedB !== null && typeof recordedB === "object" && "runId" in recordedB
        ? recordedB.runId
        : undefined;
    // Two executions, two runs.
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toEqual(idB);

    // Each document read the run its own journal records — the sibling's
    // preparation and completion changed neither.
    expect(seenA[0]?.runId).toEqual(idA);
    expect(seenB[0]?.runId).toEqual(idB);
    // And every read inside one execution is the same frozen object.
    expect(seenA[0]).toBe(seenA[1]);

    // Nothing leaked into a later ordinary execution.
    let leaked: unknown;
    yield* scoped(function* () {
      yield* useForbiddenGit();
      yield* registerComponents([
        {
          name: "Probe",
          origin: "tier-wr",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            try {
              leaked = yield* getWorkflowRun();
            } catch {
              leaked = "refused";
            }
            return "";
          },
        },
      ]);
      yield* collect(
        yield* execute({ ...inlineSource("<Probe />\n"), stream: new InMemoryStream() }),
      );
    });
    expect(leaked).toEqual("refused");
  });

  it("WR4: a completed journal restores the run without consulting Git", function* () {
    const stream = new InMemoryStream();
    const live: WorkflowRun[] = [];
    const asked: string[] = [];

    yield* scoped(function* () {
      yield* useGit(COMMIT, asked);
      yield* useProbe(live);
      const workflow = workflowInstallation({ base: "main" });
      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]),
      );
    });
    expect(asked).toEqual(["main^{commit}"]);

    // The root Close is in the journal, so the document never expands again and
    // the only reader left is a middleware watching the replayed output.
    const replayed: WorkflowRun[] = [];
    yield* scoped(function* () {
      yield* useForbiddenGit();
      const workflow = workflowInstallation({ base: "main" });
      yield* DocumentOutput.around({
        *output([text], next) {
          replayed.push(yield* getWorkflowRun());
          yield* next(text);
        },
      });
      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]),
      );
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
      const workflow = workflowInstallation({ base: "main" });
      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]),
      );
    });

    const emitted: string[] = [];
    const result = yield* scoped(function* () {
      yield* useForbiddenGit();
      const workflow = workflowInstallation({ base: "release" });
      yield* DocumentOutput.around({
        *output([text], next) {
          emitted.push(text);
          yield* next(text);
        },
      });
      return yield* yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]);
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
      const workflow = workflowInstallation({ base: "main" });
      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]),
      );
    });

    // The branch moved between runs. The recorded commit is what stands.
    const restored: WorkflowRun[] = [];
    const asked: string[] = [];
    yield* scoped(function* () {
      yield* useGit(OTHER_COMMIT, asked);
      const workflow = workflowInstallation({ base: "main" });
      yield* DocumentOutput.around({
        *output([text], next) {
          restored.push(yield* getWorkflowRun());
          yield* next(text);
        },
      });
      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]),
      );
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
      const workflow = workflowInstallation({ base: "main" });
      return yield* yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]);
    });

    expect(result.ok).toBe(false);
    expect(expanded).toHaveLength(0);
    expect(recordedRun(stream)).toBeUndefined();
  });

  // WR18: a base that would not resolve is journaled as a failed effect, and
  // that history is this run's own — so a programmatic installation contributes
  // no refusal about it. Requiring a *successful* record here would refuse a
  // journal this run wrote, and retry Git on the way to doing so.
  //
  // What this does not assert is that the recorded Git failure is what the
  // caller sees. It is not, and it was not before this PR either: the journal
  // holds a root Close and no root import, which core's target admission refuses
  // on its own terms (verified against `main` at b324b97). That contradiction
  // between core's rule and workflow-spec §6 is recorded in §6 and is not this
  // PR's to settle.
  it("WR18: a recorded base-resolution failure is not refused as missing evidence", function* () {
    const stream = new InMemoryStream();

    const first = yield* scoped(function* () {
      yield* Git.around(
        {
          // deno-lint-ignore require-yield
          *revParse() {
            throw new Error("fatal: not a git repository");
          },
        },
        { at: "min" },
      );
      const workflow = workflowInstallation({ base: "main" });
      return yield* yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]);
    });
    expect(first.ok).toBe(false);
    expect(recordedRun(stream)).toBeUndefined();

    const before = stream.snapshot().length;
    const expanded: WorkflowRun[] = [];
    const replayed = yield* scoped(function* () {
      yield* useForbiddenGit();
      yield* useProbe(expanded);
      const workflow = workflowInstallation({ base: "main" });
      return yield* yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]);
    });

    expect(replayed.ok).toBe(false);
    const message = replayed.ok ? "" : replayed.error.message;
    // Nothing about workflow-run evidence: this installation had no objection.
    expect(message).not.toContain("workflow run");
    expect(message).not.toContain("identifies");
    // Git was never asked, the root never expanded, and nothing was appended.
    expect(expanded).toEqual([]);
    expect(stream.snapshot().length).toEqual(before);
  });

  it("WR19: a preparation that failed replays as the failure it was", function* () {
    const stream = new InMemoryStream();
    const expanded: WorkflowRun[] = [];

    const live = yield* scoped(function* () {
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
      return yield* yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [
        workflowInstallation({ base: "main" }),
      ]);
    });

    expect(live.ok).toBe(false);
    expect(expanded).toHaveLength(0);
    // Preparation failed before the root import, so the durable root records
    // the bound terminal core writes at that position (#433) — a history the
    // identical execution can read back rather than one it must refuse.
    const recorded = stream.snapshot();
    expect(recorded.some((event) => event.type === "close")).toBe(true);
    expect(
      recorded.some(
        (event) => event.type === "yield" && event.description.type === "import_component",
      ),
    ).toBe(false);

    const replay = new InMemoryStream(recorded);
    const asked: string[] = [];
    const order: string[] = [];
    const replayedExpansions: WorkflowRun[] = [];

    const replayed = yield* scoped(function* () {
      yield* useGit(COMMIT, asked);
      yield* useProbe(replayedExpansions);
      yield* Execution.around({
        *document([request], next) {
          order.push("policy");
          yield* next(request);
        },
      });
      return yield* yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream: replay }, [
        workflowInstallation({ base: "main" }),
      ]);
    });

    // The same failure, read back rather than re-decided.
    expect(replayed.ok).toBe(false);
    expect(String(replayed.ok ? "" : replayed.error)).not.toContain(
      "cannot be read by this version",
    );
    // Nothing ran: no Git, no preparation, no policy, no import, no append.
    expect(asked).toEqual([]);
    expect(order).toEqual([]);
    expect(replayedExpansions).toHaveLength(0);
    expect(replay.snapshot().length).toEqual(recorded.length);
  });

  it("WR8: a run survives a document that fails after it was recorded", function* () {
    const stream = new InMemoryStream();

    const result = yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      const workflow = workflowInstallation({ base: "main" });
      return yield* yield* executeInstalled(
        {
          // A value root that produces no <Return> fails after expansion begins.
          ...inlineSource("---\nreturns:\n  type: object\n---\n\nbody\n"),
          stream,
        },
        [workflow],
      );
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
  it("WR9: an execution without a workflow installation never invokes Git", function* () {
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
    expect(failures[0]).toContain("workflowInstallation");
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
      const workflow = workflowInstallation({ base: "main" });
      return yield* yield* executeInstalled({ ...inlineSource("# Hello\n"), stream }, [workflow]);
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
      const workflow = workflowInstallation({ base: "main" });
      yield* DocumentOutput.around({
        *output([text], next) {
          restored.push(yield* getWorkflowRun());
          yield* next(text);
        },
      });
      yield* collect(yield* executeInstalled({ ...inlineSource("# Hello\n"), stream }, [workflow]));
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
      const workflow = workflowInstallation({ base: "main" });
      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]),
      );
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
        const workflow = base === undefined ? undefined : workflowInstallation({ base });
        yield* collect(
          yield* executeInstalled(
            { ...inlineSource("<Probe />\n"), stream: new InMemoryStream() },
            workflow === undefined ? [] : [workflow],
          ),
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
      const workflow = workflowInstallation({ base: "main" });

      const execution = yield* spawn(function* () {
        yield* collect(
          yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]),
        );
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
    // The binding is the execution's own slot, and what it holds is the exact
    // frozen run. Retained-history admission and durable preparation both
    // decide the run from outside the scope that reads it, so a context set
    // from either would end with the operation that set it; the slot is what
    // gives them somewhere to put it that the document can still see.
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
      const workflow = workflowInstallation({ base: "main" });
      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream: new InMemoryStream() }, [
          workflow,
        ]),
      );
    });

    expect(own).toBeDefined();
    expect(observed).toBeDefined();
    const carried =
      observed !== null && typeof observed === "object" && "run" in observed
        ? observed.run
        : undefined;
    expect(carried).toBe(own);
  });

  /**
   * A descriptor of the Api's name whose `document` may return anything.
   *
   * The canonical surface types `Operation<void>`, so a handler cannot offer a
   * document result through it. Middleware from elsewhere is under no such
   * obligation — its types are its own — and this is what that looks like.
   */
  function loose(): Api<{ document(request: unknown): Operation<unknown> }> {
    return createApi("Execution", {
      // deno-lint-ignore require-yield
      *document(_request: unknown): Operation<unknown> {
        return undefined;
      },
    });
  }

  /**
   * Tier WM — what public middleware cannot do to a workflow run.
   *
   * The run is prepared by canonical core inside the durable root, after
   * retained-history admission and before any public `Execution.document`
   * policy. These are the ways a handler might try to get in front of that, and
   * what happens instead.
   */

  it("WM1: a non-delegating document handler cannot fabricate a successful run", function* () {
    const journal = new InMemoryStream();
    const seen: WorkflowRun[] = [];

    const result = yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* useProbe(seen);
      yield* loose().around({
        // deno-lint-ignore require-yield
        *document() {
          return { status: "ok", output: "FABRICATED", value: "FABRICATED" };
        },
      });
      return yield* yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream: journal }, [
        workflowInstallation({ base: "main" }),
      ]);
    });

    // The handler decided nothing. Core refused it.
    expect(result.ok).toBe(false);
    expect(seen).toEqual([]);
    // The run was prepared before that handler ever ran, so the journal holds
    // the canonical record — and then the failed terminal, never a success
    // carrying "FABRICATED".
    expect(recordedRun(journal)).toBeDefined();
    expect(JSON.stringify(journal.snapshot())).not.toContain("FABRICATED");
    const closes = journal.snapshot().filter((event) => event.type === "close");
    expect(closes.length).toEqual(1);
  });

  it("WM2: a substitute result after delegating replaces nothing", function* () {
    const journal = new InMemoryStream();
    const seen: WorkflowRun[] = [];

    const output = yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* useProbe(seen);
      yield* loose().around({
        *document([request], next) {
          yield* next(request);
          return { status: "ok", output: "SUBSTITUTE", value: "SUBSTITUTE" };
        },
      });
      return yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream: journal }, [
          workflowInstallation({ base: "main" }),
        ]),
      );
    });

    expect(String(output)).not.toContain("SUBSTITUTE");
    expect(seen.length).toEqual(1);
    expect(recordedRun(journal)).toBeDefined();
  });

  it("WM3: the run is prepared before any document policy observes it", function* () {
    const order: string[] = [];
    const journal = new InMemoryStream();

    yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* registerComponents([
        {
          name: "Probe",
          origin: "tier-wr",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            order.push(`expanded:${(yield* getWorkflowRun()).pinnedCommit === COMMIT}`);
            return "";
          },
        },
      ]);
      yield* Execution.around({
        *document([request], next) {
          // The record is already in the journal by the time policy runs.
          order.push(`policy:${workflowEvents(journal).length}`);
          yield* next(request);
        },
      });
      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream: journal }, [
          workflowInstallation({ base: "main" }),
        ]),
      );
    });

    expect(order).toEqual(["policy:1", "expanded:true"]);
  });

  it("WM4: an installation another loaded copy built composes when the host passes it", function* () {
    const seen: WorkflowRun[] = [];
    const journal = new InMemoryStream();

    // Built through this package's own constructor, then relayed to canonical
    // core as an opaque record of closures — which is exactly how a separately
    // loaded copy reaches core: it hands over functions, and nobody agrees on
    // a name or a type.
    const built = workflowInstallation({ base: "main" });
    const relayed: ExecutionInstallation = {
      admissions: built.admissions,
      prepare: built.prepare,
      install: built.install,
    };

    yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* useProbe(seen);
      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream: journal }, [relayed]),
      );
    });

    expect(seen.length).toEqual(1);
    expect(recordedRun(journal)).toBeDefined();
  });

  it("WM5: valid public observation still composes", function* () {
    const observed: string[] = [];
    const seen: WorkflowRun[] = [];
    const journal = new InMemoryStream();

    const output = yield* scoped(function* () {
      yield* useGit(COMMIT, []);
      yield* useProbe(seen);
      yield* Execution.around({
        *document([request], next) {
          observed.push("before");
          yield* next(request);
          observed.push("after");
        },
      });
      return yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream: journal }, [
          workflowInstallation({ base: "main" }),
        ]),
      );
    });

    expect(observed).toEqual(["before", "after"]);
    expect(seen.length).toEqual(1);
    expect(String(output).trim()).toEqual("");
    expect(recordedRun(journal)).toBeDefined();
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
          const workflow = workflowInstallation({ base: "slow" });
          yield* collect(
            yield* executeInstalled(
              { ...inlineSource("<Probe />\n"), stream: new InMemoryStream() },
              [workflow],
            ),
          );
        }),
      );
      yield* scoped(function* () {
        yield* useGit(OTHER_COMMIT, []);
        const workflow = workflowInstallation({ base: "fast" });
        yield* collect(
          yield* executeInstalled(
            { ...inlineSource("<Probe />\n"), stream: new InMemoryStream() },
            [workflow],
          ),
        );
      });
      yield* slow;
    });

    expect(seen.map((run) => run.base).sort()).toEqual(["fast", "slow"]);
  });
});
