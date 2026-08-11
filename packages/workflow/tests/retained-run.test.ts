/**
 * Tier RR — installing a run that already exists.
 *
 * `workflowInstallation({ base })` lets the first live execution decide what the run is:
 * it allocates an identifier and resolves the base through Git. A workflow host
 * has already done both by the time a document runs — storage answered with the
 * run id, and the definition was established from a commit it pinned — so
 * nothing is left to decide, and a journal that records a different run is not
 * this run's journal.
 *
 * Every test here replaces `Git` with a provider that fails when it is
 * consulted, so "the retained installation asks Git nothing" is asserted rather
 * than assumed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { type Api, createApi } from "@effectionx/context-api";
import { InMemoryStream, ReplayGuard, StaleInputError } from "@executablemd/durable-streams";
import type {
  DurableEvent,
  DurableStream,
  Json,
  Result,
  Yield,
} from "@executablemd/durable-streams";
import {
  collect,
  DocumentOutput,
  execute,
  Execution,
  inlineSource,
  registerComponents,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionRequest } from "@executablemd/core";
import { Git } from "../src/git.ts";
import { getWorkflowRun, retainedWorkflowInstallation } from "../src/run.ts";
import type { WorkflowRun } from "../src/run.ts";

const COMMIT = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const OTHER_COMMIT = "1111111111111111111111111111111111111111";

const RETAINED: WorkflowRun = Object.freeze({
  runId: "release-1.4",
  base: "main",
  pinnedCommit: COMMIT,
});

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
      origin: "tier-rr",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        seen.push(yield* getWorkflowRun());
        return "";
      },
    },
  ]);
}

interface Attempt {
  readonly seen: WorkflowRun[];
  readonly emitted: string[];
  readonly thrown: unknown;
}

/**
 * Run `<Probe />` under a retained installation, watching everything a refusal
 * has to prevent.
 *
 * `seen` is non-empty only if the document expanded; `emitted` is non-empty only
 * if a recorded result reached a consumer. `install` is where a test puts the
 * policy it wants to prove cannot widen the boundary — installed *outside* the
 * workflow installation, which is the position a suppressing handler wants.
 */
function runRetained(
  run: WorkflowRun,
  stream: DurableStream,
  install: Operation<void> = ok(),
  after: Operation<void> = ok(),
): Operation<Attempt> {
  return scoped(function* () {
    const seen: WorkflowRun[] = [];
    const emitted: string[] = [];
    yield* useForbiddenGit();
    yield* useProbe(seen);
    yield* install;
    const workflow = retainedWorkflowInstallation(run);
    yield* after;
    yield* DocumentOutput.around({
      *output([text], next) {
        emitted.push(text);
        yield* next(text);
      },
    });
    try {
      yield* collect(
        yield* executeInstalled({ ...inlineSource("<Probe />\n"), stream }, [workflow]),
      );
      return { seen, emitted, thrown: undefined };
    } catch (error) {
      return { seen, emitted, thrown: error };
    }
  });
}

// deno-lint-ignore require-yield
function* ok(): Operation<void> {}

/**
 * A `ReplayGuard` that answers one phase without delegating.
 *
 * This is what composable policy is allowed to do, and the whole reason durable
 * identity may not live behind it.
 */
function useSuppressingGuard(phase: "check" | "admit" | "decide"): Operation<void> {
  return ReplayGuard.around({
    *check([event], next) {
      if (phase !== "check") {
        yield* next(event);
      }
    },
    *admit([history], next) {
      if (phase !== "admit") {
        yield* next(history);
      }
    },
    decide([event], next) {
      return phase === "decide" ? { outcome: "replay" } : next(event);
    },
  });
}

/**
 * The same suppression, through a descriptor this test built for itself.
 *
 * A contextual Api composes by stable name across loaded copies, so a second
 * copy of `durable-streams` is exactly this: the same name, a handler nothing
 * here imported.
 */
function useForeignGuard(): Operation<void> {
  const foreign: Api<{
    check(event: unknown): Operation<void>;
    admit(history: unknown): Operation<void>;
    decide(event: unknown): { outcome: "replay" };
  }> = createApi("DurableEffection.ReplayGuard", {
    // deno-lint-ignore require-yield
    *check(_event: unknown): Operation<void> {},
    // deno-lint-ignore require-yield
    *admit(_history: unknown): Operation<void> {},
    decide(_event: unknown): { outcome: "replay" } {
      return { outcome: "replay" };
    },
  });
  return foreign.around({
    // deno-lint-ignore require-yield
    *check() {},
    // deno-lint-ignore require-yield
    *admit() {},
    decide() {
      return { outcome: "replay" };
    },
  });
}

function workflowEvents(stream: InMemoryStream): DurableEvent[] {
  return stream
    .snapshot()
    .filter((event) => event.type === "yield" && event.description.type === "workflow_run");
}

function recordedRun(stream: InMemoryStream): Json | undefined {
  const event = workflowEvents(stream)[0];
  if (event === undefined || event.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  return event.result.value;
}

/** The journal without the root's close, which is what makes the next run replay. */
function partial(stream: InMemoryStream): InMemoryStream {
  return new InMemoryStream(
    stream.snapshot().filter((event) => !(event.type === "close" && event.coroutineId === "root")),
  );
}

/** An `Execution` handler that hands the durable run a journal of its choosing. */
function useStreamHijack(raw: DurableStream): Operation<void> {
  return Execution.around(
    {
      *execute([request], next) {
        yield* next(request.withOptions({ ...request.options, stream: raw }));
      },
    },
    { at: "min" },
  );
}

/** The same, through a descriptor of the Api's stable name built in this suite. */
function useForeignStreamHijack(raw: DurableStream): Operation<void> {
  const foreign: Api<{
    execute(request: ExecutionRequest): Operation<void>;
  }> = createApi("Execution", {
    // deno-lint-ignore require-yield
    *execute(_request: ExecutionRequest): Operation<void> {},
  });
  return foreign.around(
    {
      *execute([request], next) {
        yield* next(request.withOptions({ ...request.options, stream: raw }));
      },
    },
    { at: "min" },
  );
}

/**
 * A journal that answers differently every time it is read.
 *
 * The run id shifts on the second read of the recorded value, which is what a
 * backend handing out live objects can do. Admission and replay must therefore
 * be reading one retained snapshot rather than each taking their own look —
 * otherwise a history admitted as one run is replayed as another.
 */
function shiftingJournal(events: readonly DurableEvent[], reads: string[]): DurableStream {
  const appended: DurableEvent[] = [];
  const shift = (event: DurableEvent): DurableEvent => {
    if (event.type !== "yield" || event.description.type !== "workflow_run") {
      return event;
    }
    return {
      ...event,
      get result(): Result {
        const runId = reads.length === 0 ? "release-1.4" : "release-1.5";
        reads.push(runId);
        return { status: "ok", value: { runId, base: "main", pinnedCommit: COMMIT } };
      },
    };
  };
  return {
    // deno-lint-ignore require-yield
    *readAll(): Operation<DurableEvent[]> {
      return [...events.map(shift), ...appended];
    },
    // deno-lint-ignore require-yield
    *append(event: DurableEvent): Operation<void> {
      appended.push(event);
    },
  };
}

/**
 * A journal handing back exactly these events, accessors and all.
 *
 * `InMemoryStream` clones what it is given, which is the right thing for it and
 * the wrong thing here: a value that refuses to be read cannot survive being
 * copied. These events reach the execution as written.
 */
interface WatchedJournal {
  readonly journal: DurableStream;
  /** What a refused run managed to append, which must stay empty. */
  readonly appended: DurableEvent[];
}

function unreadableJournal(events: readonly DurableEvent[]): WatchedJournal {
  const appended: DurableEvent[] = [];
  return {
    appended,
    journal: {
      // deno-lint-ignore require-yield
      *readAll(): Operation<DurableEvent[]> {
        return [...events, ...appended];
      },
      // deno-lint-ignore require-yield
      *append(event: DurableEvent): Operation<void> {
        appended.push(event);
      },
    },
  };
}

/**
 * The whole error, not only its sentence.
 *
 * `StaleInputError` retains what it is handed, so a refusal is inspected as an
 * object: anything reachable on it is something a log or a rendered document
 * could carry.
 */
function wholeError(thrown: unknown): string {
  return JSON.stringify(thrown, (_key, value) =>
    value instanceof Error ? { ...value, message: value.message, name: value.name } : value,
  );
}

/**
 * The completed journal, with what it records about the run replaced.
 *
 * A completed journal is where the run record matters most and is read least: it
 * answers with the recorded root result without expanding anything, so whatever
 * these cases leave behind is the whole of the evidence that the result is this
 * run's.
 */
function completedWith(
  stream: InMemoryStream,
  change: (event: Yield) => DurableEvent[],
): InMemoryStream {
  return new InMemoryStream(
    stream
      .snapshot()
      .flatMap((event) =>
        event.type === "yield" && event.description.type === "workflow_run"
          ? change(event)
          : [event],
      ),
  );
}

describe("Tier RR — retained workflow runs", () => {
  it("RR1: records exactly the retained run, without allocating or resolving", function* () {
    const stream = new InMemoryStream();
    const attempt = yield* runRetained(RETAINED, stream);

    expect(attempt.thrown).toBeUndefined();
    expect(attempt.seen).toEqual([RETAINED]);
    expect(recordedRun(stream)).toEqual({
      runId: "release-1.4",
      base: "main",
      pinnedCommit: COMMIT,
    });
    expect(workflowEvents(stream)).toHaveLength(1);
  });

  it("RR2: restores the retained run from a truncated journal without recording again", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const resumed = partial(first);
    const attempt = yield* runRetained(RETAINED, resumed);

    expect(attempt.thrown).toBeUndefined();
    expect(attempt.seen).toEqual([RETAINED]);
    expect(workflowEvents(resumed)).toHaveLength(1);
  });

  it("RR3: restores the retained run from a completed journal", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const replayed = new InMemoryStream(first.snapshot());
    const attempt = yield* runRetained(RETAINED, replayed);

    expect(attempt.thrown).toBeUndefined();
    expect(workflowEvents(replayed)).toHaveLength(1);
  });

  it("RR4: refuses a journal recording a different run id", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const attempt = yield* runRetained({ ...RETAINED, runId: "release-1.5" }, partial(first));

    expect(attempt.thrown).toBeInstanceOf(StaleInputError);
    const message = attempt.thrown instanceof Error ? attempt.thrown.message : "";
    expect(message).toContain("runId");
    // The differing values are named nowhere: a run id is caller-selected text.
    expect(message).not.toContain("release-1.4");
    expect(message).not.toContain("release-1.5");
    expect(attempt.seen).toEqual([]);
  });

  it("RR5: refuses a journal recording a different base or pinned commit", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const base = yield* runRetained({ ...RETAINED, base: "release/1.4" }, partial(first));
    expect(base.thrown).toBeInstanceOf(StaleInputError);
    expect(base.thrown instanceof Error ? base.thrown.message : "").toContain("base");

    const pinned = yield* runRetained({ ...RETAINED, pinnedCommit: OTHER_COMMIT }, partial(first));
    expect(pinned.thrown).toBeInstanceOf(StaleInputError);
    expect(pinned.thrown instanceof Error ? pinned.thrown.message : "").toContain("pinnedCommit");
  });

  it("RR6: refuses a record that does not describe a workflow run at all", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const damaged = new InMemoryStream(
      partial(first)
        .snapshot()
        .map((event) =>
          event.type === "yield" && event.description.type === "workflow_run"
            ? { ...event, result: { status: "ok", value: { runId: 7 } } }
            : event,
        ),
    );

    const attempt = yield* runRetained(RETAINED, damaged);
    expect(attempt.thrown).toBeInstanceOf(StaleInputError);
  });

  // RR8: what a completed journal has to hold. `check` can only object to an
  // event a journal contains, so a journal recording a terminal result and no
  // readable run for it leaves nothing to object to — and the recorded result
  // would answer for history that never identified this run.
  it("RR8: refuses a completed journal that does not record exactly one run", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const cases: Array<{ says: string; stream: InMemoryStream }> = [
      { says: "no successful workflow run", stream: completedWith(first, () => []) },
      {
        says: "no successful workflow run",
        stream: completedWith(first, (event) => [
          { ...event, result: { status: "err", error: { message: "recorded failure" } } },
        ]),
      },
      {
        says: "2 workflow run entries",
        stream: completedWith(first, (event) => [event, event]),
      },
    ];

    for (const refused of cases) {
      const before = refused.stream.snapshot().length;
      const attempt = yield* runRetained(RETAINED, refused.stream);

      expect(attempt.thrown).toBeInstanceOf(StaleInputError);
      expect(attempt.thrown instanceof Error ? attempt.thrown.message : "").toContain(refused.says);
      // Refused before the recorded root result was handed back, and before
      // anything expanded.
      expect(attempt.seen).toEqual([]);
      expect(refused.stream.snapshot().length).toEqual(before);
    }
  });

  it("RR9: refuses a completed journal recording another run, or an unreadable one", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);
    const completed = () => new InMemoryStream(first.snapshot());

    const foreign = yield* runRetained({ ...RETAINED, runId: "release-1.5" }, completed());
    expect(foreign.thrown).toBeInstanceOf(StaleInputError);
    expect(foreign.thrown instanceof Error ? foreign.thrown.message : "").toContain("runId");

    const damaged = yield* runRetained(
      RETAINED,
      completedWith(first, (event) => [
        { ...event, result: { status: "ok", value: { runId: 7 } } },
      ]),
    );
    expect(damaged.thrown).toBeInstanceOf(StaleInputError);
    expect(damaged.seen).toEqual([]);
  });

  // RR10: the reproduction the architecture review ran. Under a guard that
  // answers without delegating, run-a's completed journal used to hand its
  // recorded root result back to run-b. Identity is not policy, so it does not.
  it("RR10: refuses another run's completed journal beneath a suppressing guard", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    for (const phase of ["check", "admit", "decide"] as const) {
      const completed = new InMemoryStream(first.snapshot());
      const before = completed.snapshot().length;

      const attempt = yield* runRetained(
        { ...RETAINED, runId: "release-1.5" },
        completed,
        useSuppressingGuard(phase),
      );

      expect(attempt.thrown).toBeInstanceOf(StaleInputError);
      expect(attempt.thrown instanceof Error ? attempt.thrown.message : "").toContain("runId");
      expect(attempt.seen).toEqual([]);
      expect(attempt.emitted).toEqual([]);
      expect(completed.snapshot().length).toEqual(before);
    }
  });

  it("RR11: refuses it beneath a same-named guard this suite built itself", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const completed = new InMemoryStream(first.snapshot());
    const before = completed.snapshot().length;

    const attempt = yield* runRetained(
      { ...RETAINED, runId: "release-1.5" },
      completed,
      useForeignGuard(),
    );

    expect(attempt.thrown).toBeInstanceOf(StaleInputError);
    expect(attempt.seen).toEqual([]);
    expect(attempt.emitted).toEqual([]);
    expect(completed.snapshot().length).toEqual(before);
  });

  it("RR12: a valid completed journal still replays beneath a suppressing guard", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    for (const phase of ["check", "admit", "decide"] as const) {
      const completed = new InMemoryStream(first.snapshot());
      const attempt = yield* runRetained(RETAINED, completed, useSuppressingGuard(phase));

      expect(attempt.thrown).toBeUndefined();
      // Zero live execution: the recorded result answered.
      expect(attempt.seen).toEqual([]);
      expect(workflowEvents(completed)).toHaveLength(1);
    }
  });

  // RR13: the guard surface still works as policy. It observes what admission
  // let through, and it may still refuse — it simply cannot widen.
  it("RR13: a public guard still observes admitted history and may reject it", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const observed: string[] = [];
    const watched = yield* runRetained(
      RETAINED,
      new InMemoryStream(first.snapshot()),
      ReplayGuard.around({
        *check([event], next) {
          observed.push(event.description.type);
          yield* next(event);
        },
      }),
    );
    expect(watched.thrown).toBeUndefined();
    expect(observed).toContain("workflow_run");

    const rejected = yield* runRetained(
      RETAINED,
      new InMemoryStream(first.snapshot()),
      ReplayGuard.around({
        // deno-lint-ignore require-yield
        *check([event]) {
          if (event.description.type === "workflow_run") {
            throw new Error("this guard says no");
          }
        },
      }),
    );
    expect(rejected.thrown).toBeInstanceOf(Error);
    expect(rejected.emitted).toEqual([]);
  });

  // RR14: the record has to be the canonical one. A same-typed Yield under
  // another name, or under a child coroutine, establishes nothing — otherwise
  // removing the genuine record and adding one of these would authorize reuse.
  it("RR14: refuses a record that is not the root coroutine's canonical one", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const counterfeits: Array<{ says: string; change: (event: Yield) => DurableEvent[] }> = [
      {
        says: "wrong name",
        change: (event) => [
          { ...event, description: { ...event.description, name: "workflow_run_v2" } },
        ],
      },
      {
        says: "child coroutine",
        change: (event) => [{ ...event, coroutineId: "root.0" }],
      },
      {
        says: "extra member",
        change: (event) => [
          {
            ...event,
            result: {
              status: "ok",
              value: { ...RETAINED, executor: "someone-else" },
            },
          },
        ],
      },
    ];

    for (const counterfeit of counterfeits) {
      const damaged = completedWith(first, counterfeit.change);
      const before = damaged.snapshot().length;
      const attempt = yield* runRetained(RETAINED, damaged);

      expect(attempt.thrown).toBeInstanceOf(StaleInputError);
      expect(attempt.seen).toEqual([]);
      expect(attempt.emitted).toEqual([]);
      expect(damaged.snapshot().length).toEqual(before);
      // Nothing the journal held is quoted back.
      expect(String(attempt.thrown)).not.toContain("someone-else");
      expect(String(attempt.thrown)).not.toContain("workflow_run_v2");
    }
  });

  // RR15: a truncated journal is held to the same rule. A recorded
  // establishment failure is not a licence to establish the run again.
  it("RR15: refuses a truncated journal whose run record failed", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const failed = new InMemoryStream(
      partial(first)
        .snapshot()
        .map((event) =>
          event.type === "yield" && event.description.type === "workflow_run"
            ? { ...event, result: { status: "err", error: { message: "planted-establishment" } } }
            : event,
        ),
    );
    const before = failed.snapshot().length;

    const attempt = yield* runRetained(RETAINED, failed);

    expect(attempt.thrown).toBeInstanceOf(StaleInputError);
    expect(attempt.seen).toEqual([]);
    expect(attempt.emitted).toEqual([]);
    expect(failed.snapshot().length).toEqual(before);
    // The recorded failure text is not replayed as this run's diagnostic.
    expect(String(attempt.thrown)).not.toContain("planted-establishment");
  });

  // RR16: nothing about the run reaches the error object, only the message.
  it("RR16: a refusal retains no run id, base, pinned commit or planted member", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const attempt = yield* runRetained(
      { ...RETAINED, runId: "release-1.5" },
      new InMemoryStream(first.snapshot()),
    );

    expect(attempt.thrown).toBeInstanceOf(StaleInputError);
    // The whole error, not only its sentence: `StaleInputError` keeps what it
    // is handed, so the description it retains is inspected too.
    const whole = wholeError(attempt.thrown);
    for (const secret of ["release-1.4", "release-1.5", COMMIT, "main"]) {
      expect(whole).not.toContain(secret);
    }
    expect(whole).toContain("runId");
  });

  // RR17: the second bypass the architecture review found. `Execution` is
  // composable too — a handler registered at the same position can rebuild the
  // options a later one produced, stream included — so an installation that
  // wrapped the stream itself was still held to registration order. Nothing is
  // wrapped now: core reads the requirement and applies it to the journal it
  // built, after every handler has had its turn.
  it("RR17: refuses another run's journal however Execution middleware is ordered", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);
    const other = { ...RETAINED, runId: "release-1.5" };

    const hijacks: Array<{ says: string; install: (raw: DurableStream) => Operation<void> }> = [
      { says: "the package's own descriptor", install: useStreamHijack },
      { says: "a descriptor built here", install: useForeignStreamHijack },
    ];

    for (const hijack of hijacks) {
      // Registered before the workflow installation, and registered after it.
      // One of these was the order that used to succeed.
      for (const order of ["before", "after"] as const) {
        const raw = new InMemoryStream(first.snapshot());
        const handler = hijack.install(raw);
        const attempt = yield* runRetained(
          other,
          new InMemoryStream(first.snapshot()),
          order === "before" ? handler : ok(),
          order === "after" ? handler : ok(),
        );

        expect(attempt.thrown).toBeInstanceOf(StaleInputError);
        expect(attempt.thrown instanceof Error ? attempt.thrown.message : "").toContain("runId");
        expect(attempt.seen).toEqual([]);
        expect(attempt.emitted).toEqual([]);
        expect(raw.snapshot().length).toEqual(first.snapshot().length);
      }
    }
  });

  // RR18: admission and replay read one history, not two. The journal below
  // answers differently on a second read; what makes that harmless is that the
  // history is retained once, before anything is decided, and every phase is
  // handed those same objects.
  it("RR18: identity, guard observation and replay consume one retained snapshot", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const reads: string[] = [];
    const observed: Json[] = [];
    const attempt = yield* runRetained(
      RETAINED,
      shiftingJournal(first.snapshot(), reads),
      ReplayGuard.around({
        *check([event], next) {
          if (event.description.type === "workflow_run" && event.result.status === "ok") {
            observed.push(event.result.value ?? null);
          }
          yield* next(event);
        },
      }),
    );

    // The backend was asked once and never again, which is what makes the
    // shift unreachable: the history is retained before anything is decided.
    expect(reads).toEqual(["release-1.4"]);
    // Admission agreed with that settlement, so nothing was refused...
    expect(attempt.thrown).toBeUndefined();
    // ...and the guard was handed the same settled value, not a second look.
    expect(observed).toEqual([{ runId: "release-1.4", base: "main", pinnedCommit: COMMIT }]);
    expect(attempt.seen).toEqual([]);
  });

  // RR19: an event that refuses to be read is a history this run cannot
  // describe, not one to step past on the way to a record that does read.
  it("RR19: refuses a history holding an event that will not read", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const refusing: DurableEvent = {
      get type(): never {
        throw new Error("planted-unreadable-discriminator");
      },
    } as unknown as DurableEvent;

    const watched = unreadableJournal([refusing, ...first.snapshot()]);
    const attempt = yield* runRetained(RETAINED, watched.journal);

    expect(attempt.thrown).toBeInstanceOf(Error);
    expect(attempt.seen).toEqual([]);
    expect(attempt.emitted).toEqual([]);
    expect(String(attempt.thrown)).not.toContain("planted-unreadable-discriminator");
  });

  // RR20: nothing a journal holds gets to raise its own exception. Each value
  // below refuses a different way — enumeration, descriptors, a getter, and
  // classification of a revoked proxy — and every one of them has to arrive as
  // the same fixed refusal, carrying none of its own text.
  it("RR20: a hostile recorded value becomes the fixed refusal and leaks nothing", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const hostile: Array<{ says: string; value: () => unknown }> = [
      {
        says: "ownKeys refuses",
        value: () =>
          new Proxy(
            { ...RETAINED },
            {
              ownKeys() {
                throw new Error("PLANTED-OWNKEYS");
              },
            },
          ),
      },
      {
        says: "getOwnPropertyDescriptor refuses",
        value: () =>
          new Proxy(
            { ...RETAINED },
            {
              getOwnPropertyDescriptor() {
                throw new Error("PLANTED-DESCRIPTOR");
              },
            },
          ),
      },
      {
        says: "a getter refuses",
        value: () => ({
          base: "main",
          pinnedCommit: COMMIT,
          get runId(): never {
            throw new Error("PLANTED-GETTER");
          },
        }),
      },
      {
        says: "classification refuses",
        value: () => {
          const revoked = Proxy.revocable({ ...RETAINED }, {});
          revoked.revoke();
          return revoked.proxy;
        },
      },
    ];

    for (const planted of hostile) {
      const watched = unreadableJournal(
        first
          .snapshot()
          .map((event) =>
            event.type === "yield" && event.description.type === "workflow_run"
              ? { ...event, result: { status: "ok", value: planted.value() as Json } }
              : event,
          ),
      );

      const attempt = yield* runRetained(RETAINED, watched.journal);

      expect(attempt.thrown).toBeInstanceOf(StaleInputError);
      // No terminal result reused, no document code, no output, no append.
      expect(attempt.seen).toEqual([]);
      expect(attempt.emitted).toEqual([]);
      expect(watched.appended).toEqual([]);
      // The whole error object, not only its sentence.
      const whole = wholeError(attempt.thrown);
      for (const secret of [
        "PLANTED-OWNKEYS",
        "PLANTED-DESCRIPTOR",
        "PLANTED-GETTER",
        "release-1.4",
        COMMIT,
      ]) {
        expect(whole).not.toContain(secret);
      }
    }
  });

  // RR21: the record is written once, before the root import, so a second entry
  // under the canonical identity describes a second run — however either of them
  // ended. A failure beside a success is two runs, not one run with a stumble.
  it("RR21: refuses a duplicate canonical record in every settlement combination", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);
    const failure = (event: Yield): DurableEvent => ({
      ...event,
      result: { status: "err", error: { message: "planted-second-establishment" } },
    });

    const combinations: Array<{
      says: string;
      change: (event: Yield) => DurableEvent[];
    }> = [
      { says: "successful + successful", change: (event) => [event, event] },
      { says: "successful + failed", change: (event) => [event, failure(event)] },
      { says: "failed + successful", change: (event) => [failure(event), event] },
      { says: "failed + failed", change: (event) => [failure(event), failure(event)] },
    ];

    for (const combination of combinations) {
      const journal = completedWith(first, combination.change);
      const before = journal.snapshot().length;
      const attempt = yield* runRetained(RETAINED, journal);

      expect(attempt.thrown).toBeInstanceOf(StaleInputError);
      expect(attempt.thrown instanceof Error ? attempt.thrown.message : "").toContain("2");
      expect(attempt.seen).toEqual([]);
      expect(attempt.emitted).toEqual([]);
      expect(journal.snapshot().length).toEqual(before);
      expect(wholeError(attempt.thrown)).not.toContain("planted-second-establishment");
    }
  });

  // RR22: the same totality on the other side of the boundary. A host hands the
  // retained run over directly, so its members are read here rather than out of
  // a journal — and a member that refuses is a value identifying no run, which
  // is a sentence rather than the host's own exception.
  it("RR22: refuses a retained run whose members refuse to be read", function* () {
    const hostile = {
      base: "main",
      pinnedCommit: COMMIT,
      get runId(): never {
        throw new Error("PLANTED-INSTALL-GETTER");
      },
    };

    const thrown = yield* scoped(function* () {
      try {
        const workflow = retainedWorkflowInstallation(hostile as unknown as WorkflowRun);
        return undefined;
      } catch (error) {
        return error;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("identifies no workflow run");
    expect(wholeError(thrown)).not.toContain("PLANTED-INSTALL-GETTER");
  });

  // RR23: a workflow definition may name an exact document target (#431). That
  // is definition data — what the run is a run *of* — and never part of what
  // identifies the run. A journal recording it inside the run value describes
  // something this version cannot account for.
  it("RR23: a definition target is not part of run identity", function* () {
    const first = new InMemoryStream();
    yield* runRetained(RETAINED, first);

    const withTarget = completedWith(first, (event) => [
      {
        ...event,
        result: {
          status: "ok",
          value: { ...RETAINED, targetPath: "Release/Publish" },
        },
      },
    ]);
    const before = withTarget.snapshot().length;
    const attempt = yield* runRetained(RETAINED, withTarget);

    expect(attempt.thrown).toBeInstanceOf(StaleInputError);
    expect(attempt.seen).toEqual([]);
    expect(attempt.emitted).toEqual([]);
    expect(withTarget.snapshot().length).toEqual(before);
    // The target is not quoted back either.
    expect(wholeError(attempt.thrown)).not.toContain("Release/Publish");
  });

  it("RR7: refuses to install a run that identifies nothing", function* () {
    const empty = yield* scoped(function* () {
      try {
        const workflow = retainedWorkflowInstallation({
          runId: "",
          base: "main",
          pinnedCommit: COMMIT,
        });
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(empty).toBeInstanceOf(Error);

    const unpinned = yield* scoped(function* () {
      try {
        const workflow = retainedWorkflowInstallation({
          runId: "r",
          base: "main",
          pinnedCommit: "",
        });
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(unpinned).toBeInstanceOf(Error);
  });
});
