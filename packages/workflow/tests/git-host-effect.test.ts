/**
 * Tier GH — one shared reconciliation for every external Git-host effect.
 *
 * A Git host holds state no SQLite transaction here can enclose, so the only
 * thing standing between an interrupted push and a duplicated one is the order
 * this engine works in: observe, then decide, then perform at most once. Every
 * test below measures that order rather than the answer it produced — what the
 * provider was asked, how many times, and what the journal holds afterwards.
 *
 * Nothing here reaches a real Git host, and nothing here is GitHub. The kinds
 * are the three #218 names downstream issues will use, run through the same
 * engine and the same provider interface, which is the point: a kind-specific
 * state machine appearing in this layer is what GH13 exists to red.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, Err, Ok, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import {
  DivergenceError,
  InMemoryStream,
  serializeDurableEvent,
} from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { createApi } from "@effectionx/context-api";
import {
  collect,
  content,
  getExpansion,
  inlineSource,
  registerComponents,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { retainedWorkflowInstallation } from "../src/run.ts";
import type { WorkflowRun } from "../src/run.ts";
import {
  GIT_HOST_EFFECT,
  reconcileGitHostEffect,
  withGitHostProvider,
} from "../src/git-host/effect.ts";
import { GIT_HOST_API } from "../src/git-host/api.ts";
import type {
  GitHostApi,
  GitHostCall,
  GitHostProvider,
  GitHostRoutingRequest,
} from "../src/git-host/api.ts";
import {
  GitHostAmbiguousError,
  GitHostConflictError,
  GitHostProtocolError,
  GitHostProviderError,
  GitHostUnavailableError,
} from "../src/git-host/errors.ts";
import {
  gitHostRequestFingerprint,
  parseGitHostReconciliationRecord,
} from "../src/git-host/records.ts";
import type {
  CompleteGitHostEffectRequest,
  GitHostCompletion,
  GitHostEffectRequest,
  GitHostObservation,
  GitHostReconciliationRecord,
} from "../src/git-host/records.ts";

const RUN: WorkflowRun = Object.freeze({
  runId: "run-297-git-host",
  base: "main",
  pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
});

const SOURCE = "<Effect />\n";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A synthetic Git-host token, format-realistic and assembled here. */
const CREDENTIAL = ["ghp", "_", ALPHABET.slice(0, 36)].join("");

/** Words only a forged failure carries, so finding them anywhere is a leak. */
const FORGED_MARKER = "forged-by-routing-middleware";

const PUSH: GitHostEffectRequest = Object.freeze({
  kind: "git-push",
  inputs: { remote: "origin", branch: "release-1.4", commit: "9fceb02" },
  naturalKey: { ref: "refs/heads/release-1.4" },
});

const ABSENT: GitHostObservation = Object.freeze({
  state: "absent",
  preState: { ref: null },
});
const CONFLICT: GitHostObservation = Object.freeze({
  state: "conflict",
  preState: { ref: "refs/heads/release-1.4", commit: "0000001" },
});
const AMBIGUOUS: GitHostObservation = Object.freeze({
  state: "ambiguous",
  preState: { ref: "unreadable" },
});
const COMPATIBLE: GitHostObservation = Object.freeze({
  state: "compatible",
  preState: { ref: "refs/heads/release-1.4", commit: "9fceb02" },
  observations: { ref: "refs/heads/release-1.4", commit: "9fceb02" },
  result: { ref: "refs/heads/release-1.4", commit: "9fceb02", updated: false },
});
const PERFORMED: GitHostCompletion = Object.freeze({
  observations: { ref: "refs/heads/release-1.4", commit: "9fceb02" },
  result: { ref: "refs/heads/release-1.4", commit: "9fceb02", updated: true },
});

/**
 * The one Git-host surface, addressed by its stable name from outside.
 *
 * Independently constructed, exactly as a repository component or a second
 * loaded copy would construct it: sharing the name is how composition works,
 * and is deliberately not how authority works.
 */
const GitHostWitness = createApi<GitHostApi>(GIT_HOST_API, {
  // deno-lint-ignore require-yield
  *route(): Operation<unknown> {
    throw new Error("the witness handler did not delegate");
  },
});

/** What a compatible answer looks like when middleware writes it. */
const FORGED_COMPATIBLE: GitHostObservation = Object.freeze({
  state: "compatible",
  preState: { by: "middleware-forgery" },
  observations: { by: "middleware-forgery" },
  result: { by: "middleware-forgery" },
});

/** The routing request a call carries, whichever member holds it. */
function routingOf(call: GitHostCall): GitHostRoutingRequest {
  return call.intent === "route" ? call : call.routing;
}

/** Everything a public handler can construct from what it was handed. */
function forgedCalls(call: GitHostCall): GitHostCall[] {
  const routing = routingOf(call);
  const copied: GitHostRoutingRequest = Object.freeze({
    intent: "route",
    phase: routing.phase,
    request: routing.request,
  });
  return [
    { intent: "inspect", routing },
    { intent: "answer", routing, answer: Ok(FORGED_COMPATIBLE) },
    { intent: "inspect", routing: copied },
    { intent: "answer", routing: copied, answer: Ok(FORGED_COMPATIBLE) },
  ];
}

interface Attempt {
  readonly records: GitHostReconciliationRecord[];
  readonly failures: unknown[];
  readonly expansions: string[];
}

function attempt(): Attempt {
  return { records: [], failures: [], expansions: [] };
}

interface Recorded {
  readonly provider: GitHostProvider;
  readonly observed: CompleteGitHostEffectRequest[];
  readonly performed: CompleteGitHostEffectRequest[];
  readonly evidence: GitHostObservation[];
}

type Observe = (request: CompleteGitHostEffectRequest) => Operation<Result<GitHostObservation>>;
type Perform = (
  request: CompleteGitHostEffectRequest,
  observation: GitHostObservation,
) => Operation<Result<GitHostCompletion>>;

/**
 * A provider that counts what it was asked, and fails the test when it is asked
 * to perform without a perform of its own.
 */
function recordingProvider(observe: Observe, perform?: Perform): Recorded {
  const observed: CompleteGitHostEffectRequest[] = [];
  const performed: CompleteGitHostEffectRequest[] = [];
  const evidence: GitHostObservation[] = [];
  return {
    observed,
    performed,
    evidence,
    provider: {
      *observe(request): Operation<Result<GitHostObservation>> {
        observed.push(request);
        return yield* observe(request);
      },
      *perform(request, observation): Operation<Result<GitHostCompletion>> {
        performed.push(request);
        evidence.push(observation);
        if (perform === undefined) {
          throw new Error("the engine performed where nothing may be performed");
        }
        return yield* perform(request, observation);
      },
    },
  };
}

/** A provider that fails the test if any phase reaches it. */
function forbiddenProvider(): Recorded {
  return recordingProvider(
    // deno-lint-ignore require-yield
    function* (): Operation<Result<GitHostObservation>> {
      throw new Error("the Git host was observed where no observation may happen");
    },
  );
}

function answering<T>(value: Result<T>): () => Operation<Result<T>> {
  // deno-lint-ignore require-yield
  return function* (): Operation<Result<T>> {
    return value;
  };
}

function useEffectComponent(request: GitHostEffectRequest, seen: Attempt): Operation<void> {
  return registerComponents([
    {
      name: "Effect",
      origin: "tier-fe",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        seen.expansions.push((yield* getExpansion()).id);
        try {
          seen.records.push(yield* reconcileGitHostEffect(request));
        } catch (error) {
          seen.failures.push(error);
          throw error;
        }
        return "";
      },
    },
  ]);
}

interface RunOptions {
  readonly stream: DurableStream;
  readonly request?: GitHostEffectRequest;
  readonly provider?: GitHostProvider;
  readonly seen?: Attempt;
  readonly around?: (operation: Operation<unknown>) => Operation<unknown>;
}

/**
 * One document execution of `<Effect />`, under one retained run.
 *
 * The run is retained rather than allocated so that every execution in a test
 * carries the same external identity, which is what the reconciliation is keyed
 * on. The document's failure is captured rather than raised: what each test
 * measures is the provider traffic and the journal, and both outlive the
 * failure.
 */
function* runDocument(options: RunOptions): Operation<Attempt> {
  const seen = options.seen ?? attempt();
  yield* scoped(function* () {
    yield* useEffectComponent(options.request ?? PUSH, seen);
    const execution: Operation<unknown> = collectDocument(options.stream);
    const around = options.around ?? ((operation: Operation<unknown>) => operation);
    const routed =
      options.provider === undefined
        ? around(execution)
        : withGitHostProvider(options.provider, around(execution));
    try {
      yield* routed;
    } catch {
      // The component already recorded the exact failure; a document that fails
      // is one of the outcomes under test rather than an error in the harness.
    }
  });
  return seen;
}

function collectDocument(stream: DurableStream): Operation<unknown> {
  return collectSource(SOURCE, stream);
}

function* collectSource(source: string, stream: DurableStream): Operation<unknown> {
  return yield* collect(
    yield* executeInstalled({ ...inlineSource(source), stream }, [
      retainedWorkflowInstallation(RUN),
    ]),
  );
}

function gitHostYields(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === GIT_HOST_EFFECT,
  );
}

/** The history a run leaves behind when it was interrupted before its root closed. */
function partial(events: DurableEvent[]): DurableEvent[] {
  return events.filter((event) => !(event.type === "close" && event.coroutineId === "root"));
}

function recordOf(seen: Attempt): GitHostReconciliationRecord {
  const record = seen.records[0];
  if (record === undefined) {
    throw new Error("the effect produced no reconciliation record");
  }
  return record;
}

function identityOf(seen: Attempt): { runId: string; expansionId: string } {
  const expansionId = seen.expansions[0];
  if (expansionId === undefined) {
    throw new Error("the effect never expanded");
  }
  return { runId: RUN.runId, expansionId };
}

describe("Tier GH — shared external Git-host effect reconciliation", () => {
  it("GH1: proven absence performs once, under identity only the host can name", function* () {
    const stream = new InMemoryStream();
    const host = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    // The document supplies an identity of its own. It is not a member of a
    // request, so it is not read, and the provider still sees the run and the
    // expansion the engine derived.
    const forged = {
      ...PUSH,
      identity: { runId: "forged-run", expansionId: "forged-expansion" },
    };

    const seen = yield* runDocument({ stream, provider: host.provider, request: forged });

    expect(seen.failures).toEqual([]);
    expect(host.observed).toHaveLength(1);
    expect(host.performed).toHaveLength(1);
    expect(host.observed[0]?.identity).toEqual(identityOf(seen));
    expect(host.performed[0]?.identity).toEqual(identityOf(seen));
    expect(host.observed[0]?.kind).toBe("git-push");
    // Perform is reached from the proven absence, and receives it as evidence.
    expect(host.evidence).toEqual([ABSENT]);

    expect(recordOf(seen)).toEqual({
      request: {
        identity: identityOf(seen),
        kind: PUSH.kind,
        inputs: PUSH.inputs,
        naturalKey: PUSH.naturalKey,
      },
      preState: ABSENT.preState,
      observations: PERFORMED.observations,
      decision: "performed",
      result: PERFORMED.result,
    });

    const yields = gitHostYields(stream.snapshot());
    expect(yields).toHaveLength(1);
    expect(yields[0]).toEqual(
      expect.objectContaining({
        result: { status: "ok", value: recordOf(seen) },
      }),
    );
  });

  it("GH2: a proven compatible completion is adopted and performs nothing", function* () {
    const stream = new InMemoryStream();
    const host = recordingProvider(answering(Ok(COMPATIBLE)));

    const seen = yield* runDocument({ stream, provider: host.provider });

    expect(seen.failures).toEqual([]);
    expect(host.observed).toHaveLength(1);
    expect(host.performed).toEqual([]);
    expect(recordOf(seen)).toEqual({
      request: {
        identity: identityOf(seen),
        kind: PUSH.kind,
        inputs: PUSH.inputs,
        naturalKey: PUSH.naturalKey,
      },
      preState: COMPATIBLE.preState,
      observations: COMPATIBLE.observations,
      decision: "adopted",
      result: COMPATIBLE.result,
    });
    expect(gitHostYields(stream.snapshot())).toHaveLength(1);
  });

  it("GH3: a recorded decision replays without a provider at all", function* () {
    for (const observation of [ABSENT, COMPATIBLE]) {
      const stream = new InMemoryStream();
      const host = recordingProvider(answering(Ok(observation)), answering(Ok(PERFORMED)));
      const first = yield* runDocument({ stream, provider: host.provider });
      expect(first.failures).toEqual([]);

      const replayed = new InMemoryStream(partial(stream.snapshot()));
      // No provider is installed at all, so any phase that reached the boundary
      // would fail rather than answer.
      const second = yield* runDocument({ stream: replayed });

      expect(second.failures).toEqual([]);
      expect(recordOf(second)).toEqual(recordOf(first));
      expect(host.observed).toHaveLength(1);
      expect(host.performed).toHaveLength(observation === ABSENT ? 1 : 0);
      expect(gitHostYields(replayed.snapshot())).toHaveLength(1);
    }
  });

  it("GH4: a remote success whose result was never published is adopted, not repeated", function* () {
    const remote: { mutations: number; state: Json | undefined } = {
      mutations: 0,
      state: undefined,
    };
    const host = recordingProvider(
      // deno-lint-ignore require-yield
      function* (): Operation<Result<GitHostObservation>> {
        if (remote.state === undefined) {
          return Ok(ABSENT);
        }
        return Ok({
          state: "compatible",
          preState: remote.state,
          observations: remote.state,
          result: remote.state,
        });
      },
      // deno-lint-ignore require-yield
      function* (): Operation<Result<GitHostCompletion>> {
        remote.mutations += 1;
        remote.state = { ref: "refs/heads/release-1.4", commit: "9fceb02" };
        return Ok({ observations: remote.state, result: remote.state });
      },
    );

    // The remote accepts the mutation and the journal refuses to record it.
    const backing = new InMemoryStream();
    const interrupted = yield* runDocument({
      stream: refusingGitHostAppends(backing),
      provider: host.provider,
    });

    expect(interrupted.records).toEqual([]);
    expect(remote.mutations).toBe(1);
    expect(gitHostYields(backing.snapshot())).toEqual([]);

    // A new execution of the same run, same expansion and same request, with no
    // history of the effect at all.
    const resumed = new InMemoryStream();
    const second = yield* runDocument({ stream: resumed, provider: host.provider });

    expect(second.failures).toEqual([]);
    expect(remote.mutations).toBe(1);
    expect(host.observed).toHaveLength(2);
    expect(host.performed).toHaveLength(1);
    expect(recordOf(second).decision).toBe("adopted");
    expect(recordOf(second).result).toEqual({
      ref: "refs/heads/release-1.4",
      commit: "9fceb02",
    });
    expect(gitHostYields(resumed.snapshot())).toHaveLength(1);
  });

  it("GH5: conflict refuses, mutates nothing, and replays as itself", function* () {
    const stream = new InMemoryStream();
    const host = recordingProvider(answering(Ok(CONFLICT)));

    const seen = yield* runDocument({ stream, provider: host.provider });

    expect(seen.records).toEqual([]);
    expect(seen.failures[0]).toBeInstanceOf(GitHostConflictError);
    expect(host.performed).toEqual([]);
    const yields = gitHostYields(stream.snapshot());
    expect(yields).toHaveLength(1);
    expect(yields[0]).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          status: "err",
          error: expect.objectContaining({ name: "GitHostConflictError" }),
        }),
      }),
    );

    const replayed = new InMemoryStream(partial(stream.snapshot()));
    const second = yield* runDocument({ stream: replayed, provider: forbiddenProvider().provider });

    expect(second.failures[0]).toBeInstanceOf(GitHostConflictError);
    expect(gitHostYields(replayed.snapshot())).toHaveLength(1);
  });

  it("GH6: permanent ambiguity refuses distinctly and replays provider-free", function* () {
    const stream = new InMemoryStream();
    const host = recordingProvider(answering(Ok(AMBIGUOUS)));

    const seen = yield* runDocument({ stream, provider: host.provider });

    expect(seen.failures[0]).toBeInstanceOf(GitHostAmbiguousError);
    expect(seen.failures[0]).not.toBeInstanceOf(GitHostConflictError);
    expect(host.performed).toEqual([]);

    const replayed = new InMemoryStream(partial(stream.snapshot()));
    const second = yield* runDocument({ stream: replayed, provider: forbiddenProvider().provider });

    expect(second.failures[0]).toBeInstanceOf(GitHostAmbiguousError);
    expect(gitHostYields(replayed.snapshot())).toHaveLength(1);
  });

  it("GH7: temporary unavailability is its own failure, retried by nobody here", function* () {
    const rows = [
      {
        name: "observation",
        host: () => recordingProvider(answering(Err(new GitHostUnavailableError()))),
        performs: 0,
      },
      {
        name: "perform",
        host: () =>
          recordingProvider(answering(Ok(ABSENT)), answering(Err(new GitHostUnavailableError()))),
        performs: 1,
      },
    ];

    for (const row of rows) {
      const stream = new InMemoryStream();
      const host = row.host();
      const seen = yield* runDocument({ stream, provider: host.provider });

      expect(seen.failures[0]).toBeInstanceOf(GitHostUnavailableError);
      expect(seen.failures[0]).not.toBeInstanceOf(GitHostConflictError);
      expect(seen.failures[0]).not.toBeInstanceOf(GitHostAmbiguousError);
      expect(seen.records).toEqual([]);
      // One observation and no hidden second attempt at either phase.
      expect(host.observed).toHaveLength(1);
      expect(host.performed).toHaveLength(row.performs);
    }

    // Cancellation is Effection control flow, not a forge condition.
    const stream = new InMemoryStream();
    const entered = withResolvers<void>();
    const host = recordingProvider(function* (): Operation<Result<GitHostObservation>> {
      entered.resolve();
      yield* suspend();
      return Ok(ABSENT);
    });
    const seen = attempt();

    yield* scoped(function* () {
      const task = yield* spawn(() => runDocument({ stream, provider: host.provider, seen }));
      yield* entered.operation;
      yield* task.halt();
    });

    expect(host.observed).toHaveLength(1);
    expect(host.performed).toEqual([]);
    expect(seen.failures).toEqual([]);
    expect(seen.records).toEqual([]);
    expect(gitHostYields(stream.snapshot())).toEqual([]);
  });

  it("GH8: a changed request cannot consume a retained completion", function* () {
    const stream = new InMemoryStream();
    const host = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    const first = yield* runDocument({ stream, provider: host.provider });
    expect(first.failures).toEqual([]);

    const changed: GitHostEffectRequest = {
      ...PUSH,
      naturalKey: { ref: "refs/heads/release-1.5" },
    };
    const mismatched = new InMemoryStream(partial(stream.snapshot()));
    const refused = yield* runDocument({
      stream: mismatched,
      request: changed,
      provider: forbiddenProvider().provider,
    });

    expect(refused.failures[0]).toBeInstanceOf(DivergenceError);
    expect(refused.records).toEqual([]);
    expect(gitHostYields(mismatched.snapshot())).toHaveLength(1);

    // The positive control: the unchanged request still replays its record.
    const unchanged = new InMemoryStream(partial(stream.snapshot()));
    const replayed = yield* runDocument({
      stream: unchanged,
      provider: forbiddenProvider().provider,
    });
    expect(recordOf(replayed)).toEqual(recordOf(first));
  });

  it("GH9: routing may inspect or refuse, and can complete nothing", function* () {
    // Every one of these is a public handler doing the most it can do with what
    // the one surface hands it. None of them can answer a phase, because the
    // only route to this invocation's terminal is a continuation held by the
    // selected provider's handler alone.
    const routings = [
      {
        name: "short circuit",
        // deno-lint-ignore require-yield
        route: function* (): Operation<unknown> {
          return undefined;
        },
      },
      {
        name: "forged return",
        // deno-lint-ignore require-yield
        route: function* (): Operation<unknown> {
          return { intent: "answer", answer: Ok(COMPATIBLE) };
        },
      },
      {
        name: "substituted request",
        *route([call]: [GitHostCall], next: (call: GitHostCall) => Operation<unknown>) {
          return yield* next({ ...Object(call) });
        },
      },
      {
        name: "look-alike private message",
        *route([call]: [GitHostCall], next: (call: GitHostCall) => Operation<unknown>) {
          return yield* next({
            intent: "answer",
            routing: routingOf(call),
            answer: Ok(COMPATIBLE),
          });
        },
      },
      {
        name: "pre-answer forged failure",
        // deno-lint-ignore require-yield
        route: function* (): Operation<unknown> {
          const forged = new GitHostConflictError();
          forged.message = `${forged.message} ${FORGED_MARKER}`;
          throw forged;
        },
      },
    ];

    for (const routing of routings) {
      const stream = new InMemoryStream();
      const host = forbiddenProvider();
      const seen = yield* runDocument({
        stream,
        provider: host.provider,
        around: (operation) =>
          scoped(function* () {
            yield* GitHostWitness.around({ route: routing.route });
            return yield* operation;
          }),
      });

      expect(seen.records).toEqual([]);
      expect(seen.failures[0]).toBeInstanceOf(GitHostProviderError);
      expect(seen.failures[0]).not.toBeInstanceOf(GitHostConflictError);
      expect(host.observed).toEqual([]);
      expect(gitHostYields(stream.snapshot())).toEqual([]);
      expect(String(seen.failures[0])).not.toContain(FORGED_MARKER);
      expect(stream.snapshot().map(serializeDurableEvent).join("")).not.toContain(FORGED_MARKER);
    }

    // A request replayed after its own routing finished finds the invocation
    // spent. The replay reaches no provider and produces no second answer.
    const reused = new InMemoryStream();
    const reusedHost = recordingProvider(answering(Ok(COMPATIBLE)));
    const reuseRefusals: unknown[] = [];
    const reusedRun = yield* runDocument({
      stream: reused,
      provider: reusedHost.provider,
      around: (operation) =>
        scoped(function* () {
          yield* GitHostWitness.around({
            *route([call], next): Operation<unknown> {
              const answered = yield* next(call);
              try {
                yield* next(call);
              } catch (error) {
                reuseRefusals.push(error);
              }
              return answered;
            },
          });
          return yield* operation;
        }),
    });

    expect(reuseRefusals[0]).toBeInstanceOf(GitHostProviderError);
    expect(reusedHost.observed).toHaveLength(1);
    expect(recordOf(reusedRun).decision).toBe("adopted");
    expect(gitHostYields(reused.snapshot())).toHaveLength(1);

    // A throw after the real provider's accepted answer cannot take it away.
    const completed = new InMemoryStream();
    const completedHost = recordingProvider(answering(Ok(COMPATIBLE)));
    const completedRun = yield* runDocument({
      stream: completed,
      provider: completedHost.provider,
      around: (operation) =>
        scoped(function* () {
          yield* GitHostWitness.around({
            *route([call], next): Operation<unknown> {
              yield* next(call);
              throw new Error("post-answer routing failure");
            },
          });
          return yield* operation;
        }),
    });

    expect(completedRun.failures).toEqual([]);
    expect(recordOf(completedRun).decision).toBe("adopted");
    expect(completedHost.observed).toHaveLength(1);
    expect(gitHostYields(completed.snapshot())).toHaveLength(1);
  });

  it("GH10: combined middleware at both priorities still authors nothing", function* () {
    // The structural attack the previous two-surface design lost to. There, a
    // handler on the selection surface captured the credential, a handler on
    // the coordination surface captured the invocation capability, and the two
    // together answered a phase the provider was never asked about.
    //
    // Here a repository component wraps every exposed Git-host hook at both
    // supported priorities, keeps every request, return and continuation it can
    // observe, and tries each of them. The selected provider answers with a
    // distinguishable result, and that is the only thing the run may retain.
    const stream = new InMemoryStream();
    const seen = attempt();
    const observed: CompleteGitHostEffectRequest[] = [];
    const performed: CompleteGitHostEffectRequest[] = [];
    const captured: unknown[] = [];
    const returns: { at: string; value: unknown }[] = [];
    const refused: unknown[] = [];

    const AUTHORIZED: GitHostObservation = Object.freeze({
      state: "compatible",
      preState: { by: "authorized-provider" },
      observations: { by: "authorized-provider" },
      result: { by: "authorized-provider" },
    });

    const provider: GitHostProvider = {
      // deno-lint-ignore require-yield
      *observe(request): Operation<Result<GitHostObservation>> {
        observed.push(request);
        return Ok(AUTHORIZED);
      },
      // deno-lint-ignore require-yield
      *perform(request): Operation<Result<GitHostCompletion>> {
        performed.push(request);
        return Ok({ observations: null, result: { by: "middleware-forgery" } });
      },
    };

    function* attackAt(at: "max" | "min"): Operation<void> {
      yield* GitHostWitness.around(
        {
          *route([call], next): Operation<unknown> {
            if (call.intent !== "route") {
              // Something this component itself sent inward. Pass it along and
              // let the boundary answer it.
              return yield* next(call);
            }
            captured.push(call);
            // Everything a handler can build out of what it was handed.
            for (const attempted of forgedCalls(call)) {
              try {
                refused.push(yield* next(attempted));
              } catch (error) {
                refused.push(error);
              }
            }
            returns.push({ at, value: yield* next(call) });
            // And one more forged answer, now that a real one exists.
            try {
              refused.push(
                yield* next({ intent: "answer", routing: call, answer: Ok(FORGED_COMPATIBLE) }),
              );
            } catch (error) {
              refused.push(error);
            }
            return { intent: "answer", answer: Ok(FORGED_COMPATIBLE) };
          },
        },
        { at },
      );
    }

    yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Attack",
          origin: "tier-gh",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            yield* attackAt("max");
            yield* attackAt("min");
            return yield* content();
          },
        },
      ]);
      yield* useEffectComponent(PUSH, seen);
      yield* withGitHostProvider(
        provider,
        collectSource("<Attack>\n\n<Effect />\n\n</Attack>\n", stream),
      );
    });

    // The provider was asked exactly once, and never asked to mutate.
    expect(observed).toHaveLength(1);
    expect(performed).toEqual([]);

    // One adopted Yield, holding only what the provider said.
    const yields = gitHostYields(stream.snapshot());
    expect(yields).toHaveLength(1);
    expect(recordOf(seen).decision).toBe("adopted");
    expect(recordOf(seen).result).toEqual({ by: "authorized-provider" });
    const persisted = stream.snapshot().map(serializeDurableEvent).join("");
    expect(persisted).toContain("authorized-provider");
    expect(persisted).not.toContain("middleware-forgery");
    expect(JSON.stringify(recordOf(seen))).not.toContain("middleware-forgery");

    // Both handlers ran, saw only the routing request, and were answered
    // nothing. Every private message either of them tried was refused.
    expect(captured).toHaveLength(2);
    expect(returns.map((entry) => entry.at).sort()).toEqual(["max", "min"]);
    expect(returns.find((entry) => entry.at === "min")?.value).toBe(undefined);
    expect(refused.length).toBeGreaterThanOrEqual(8);
    expect(refused.every((value) => value instanceof GitHostProviderError)).toBe(true);

    // And nothing public was ever a credential, a capability, an answer method
    // or a private continuation.
    for (const value of captured) {
      const call = Object(value);
      expect(Object.keys(call).sort()).toEqual(["intent", "phase", "request"]);
      expect(Object.values(call).some((member) => typeof member === "function")).toBe(false);
      expect(Object.isFrozen(call)).toBe(true);
    }
  });

  it("GH11: a provider answer this boundary cannot read is refused, not journaled", function* () {
    const hostile = new Proxy(
      { state: "absent", preState: null },
      {
        get(): never {
          throw new Error("the hostile answer refuses to be read");
        },
      },
    );
    const malformed = [
      { name: "missing member", value: { state: "absent" } },
      {
        name: "extra raw payload",
        value: {
          state: "absent",
          preState: null,
          payload: `{"token":"${CREDENTIAL}"}`,
        },
      },
      { name: "hostile", value: hostile },
    ];

    for (const answer of malformed) {
      const stream = new InMemoryStream();
      const host = recordingProvider(
        // deno-lint-ignore require-yield
        function* (): Operation<Result<GitHostObservation>> {
          return Ok(answer.value as unknown as GitHostObservation);
        },
      );
      const seen = yield* runDocument({ stream, provider: host.provider });

      expect(seen.failures[0]).toBeInstanceOf(GitHostProtocolError);
      expect(String(seen.failures[0])).not.toContain(CREDENTIAL);
      expect(seen.records).toEqual([]);
      expect(host.performed).toEqual([]);
      expect(gitHostYields(stream.snapshot())).toEqual([]);
      expect(stream.snapshot().map(serializeDurableEvent).join("")).not.toContain(CREDENTIAL);
    }

    // Positive controls: each valid variant is accepted by the same parser.
    for (const observation of [ABSENT, COMPATIBLE, CONFLICT, AMBIGUOUS]) {
      const stream = new InMemoryStream();
      const host = recordingProvider(answering(Ok(observation)), answering(Ok(PERFORMED)));
      const seen = yield* runDocument({ stream, provider: host.provider });
      expect(seen.failures[0]).not.toBeInstanceOf(GitHostProtocolError);
      expect(gitHostYields(stream.snapshot())).toHaveLength(1);
    }

    // A completion carrying a raw payload is refused on the same terms, after a
    // real mutation: the answer is what is refused, never the mutation's record.
    const stream = new InMemoryStream();
    const host = recordingProvider(
      answering(Ok(ABSENT)),
      // deno-lint-ignore require-yield
      function* (): Operation<Result<GitHostCompletion>> {
        return Ok({
          observations: PERFORMED.observations,
          result: PERFORMED.result,
          raw: CREDENTIAL,
        } as unknown as GitHostCompletion);
      },
    );
    const seen = yield* runDocument({ stream, provider: host.provider });
    expect(seen.failures[0]).toBeInstanceOf(GitHostProtocolError);
    expect(gitHostYields(stream.snapshot())).toEqual([]);
    expect(stream.snapshot().map(serializeDurableEvent).join("")).not.toContain(CREDENTIAL);
  });

  it("GH12: the journal's own secret gate is the only security boundary here", function* () {
    const stream = new InMemoryStream();
    const clean = recordingProvider(
      // The credential never leaves the closure: the provider authenticates with
      // it and answers with normalized data.
      // deno-lint-ignore require-yield
      function* (): Operation<Result<GitHostObservation>> {
        expect(CREDENTIAL).toHaveLength(40);
        return Ok(COMPATIBLE);
      },
    );
    const seen = yield* runDocument({ stream, provider: clean.provider });

    expect(seen.failures).toEqual([]);
    expect(stream.snapshot().map(serializeDurableEvent).join("")).not.toContain(CREDENTIAL);

    // A normalized result that does carry one is rejected by the real
    // pre-persistence gate, and no alternate record holds it.
    const leaking = new InMemoryStream();
    const host = recordingProvider(
      answering(
        Ok({
          state: "compatible",
          preState: null,
          observations: null,
          result: { token: CREDENTIAL },
        }),
      ),
    );
    const leaked = yield* runDocument({ stream: leaking, provider: host.provider });

    expect(leaked.records).toEqual([]);
    expect(leaked.failures).toHaveLength(1);
    expect(gitHostYields(leaking.snapshot())).toEqual([]);
    expect(leaking.snapshot().map(serializeDurableEvent).join("")).not.toContain(CREDENTIAL);
  });

  it("GH13: every downstream kind runs through this one engine", function* () {
    const kinds: GitHostEffectRequest[] = [
      PUSH,
      {
        kind: "pull-request",
        inputs: { head: "release-1.4", base: "main", title: "Release 1.4" },
        naturalKey: { head: "release-1.4", base: "main" },
      },
      {
        kind: "issue",
        inputs: { title: "Release 1.4 checklist", body: "" },
        naturalKey: { title: "Release 1.4 checklist" },
      },
    ];

    for (const request of kinds) {
      const stream = new InMemoryStream();
      const host = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
      const seen = yield* runDocument({ stream, provider: host.provider, request });

      expect(seen.failures).toEqual([]);
      expect(recordOf(seen).decision).toBe("performed");
      expect(recordOf(seen).request.kind).toBe(request.kind);
      expect(recordOf(seen).request.naturalKey).toEqual(request.naturalKey);
      expect(host.observed).toHaveLength(1);
      expect(host.performed).toHaveLength(1);
      expect(gitHostYields(stream.snapshot())).toHaveLength(1);
      // Every kind is named by its own durable identity.
      const description = gitHostYields(stream.snapshot())[0];
      expect(description?.type === "yield" ? description.description.name : "").toMatch(
        /^[0-9a-f]{64}$/,
      );
    }

    // A plain Git server hosts branches and nothing else. It says so from
    // observe, before any remote work, and the boundary neither performs nor
    // records anything — nor repeats the sentence the provider chose.
    const pushOnly = (request: CompleteGitHostEffectRequest): Result<GitHostObservation> => {
      if (request.kind === "git-push") {
        return Ok(ABSENT);
      }
      const refusal = new GitHostProviderError("this server hosts no pull requests");
      refusal.message = `${refusal.message} ${FORGED_MARKER}`;
      return Err(refusal);
    };

    const supported = new InMemoryStream();
    const supportedHost = recordingProvider(
      // deno-lint-ignore require-yield
      function* (request): Operation<Result<GitHostObservation>> {
        return pushOnly(request);
      },
      answering(Ok(PERFORMED)),
    );
    const pushed = yield* runDocument({ stream: supported, provider: supportedHost.provider });
    expect(pushed.failures).toEqual([]);
    expect(recordOf(pushed).decision).toBe("performed");

    const unsupported = new InMemoryStream();
    const unsupportedHost = recordingProvider(
      // deno-lint-ignore require-yield
      function* (request): Operation<Result<GitHostObservation>> {
        return pushOnly(request);
      },
      answering(Ok(PERFORMED)),
    );
    const refusedRun = yield* runDocument({
      stream: unsupported,
      provider: unsupportedHost.provider,
      request: kinds[1],
    });

    expect(refusedRun.records).toEqual([]);
    expect(refusedRun.failures[0]).toBeInstanceOf(GitHostProviderError);
    expect(unsupportedHost.observed).toHaveLength(1);
    expect(unsupportedHost.performed).toEqual([]);
    expect(gitHostYields(unsupported.snapshot())).toEqual([]);
    expect(String(refusedRun.failures[0])).toContain("does not support this effect kind");
    expect(String(refusedRun.failures[0])).not.toContain(FORGED_MARKER);
    expect(unsupported.snapshot().map(serializeDurableEvent).join("")).not.toContain(FORGED_MARKER);
  });

  it("GH14: a counterfeit context cannot choose a Git-host identity", function* () {
    // A fork's journal holds records its source wrote, so the effect at a
    // retained position is named by the identity that record holds. What must
    // never choose it is a binding: `DurableContext` is a public stable name,
    // and a stateful replacement can forge one replay-index answer and delegate
    // the rest.
    const inheritedRunId = "run-297-git-host-source";
    const seedStream = new InMemoryStream();
    const seedHost = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    const seeded = yield* runDocument({ stream: seedStream, provider: seedHost.provider });
    expect(seeded.failures).toEqual([]);

    // The same history as a *source* run's, truncated so the run continues into
    // the component rather than reusing a recorded terminal result.
    const inherited = yield* inheritedHistory(partial(seedStream.snapshot()), inheritedRunId);

    // Uncounterfeited: a completed inherited record replays provider-free,
    // under the identity it was written with rather than this run's.
    const replayStream = new InMemoryStream(inherited);
    const replayed = yield* runDocument({ stream: replayStream });

    expect(replayed.failures).toEqual([]);
    expect(recordOf(replayed).request.identity.runId).toBe(inheritedRunId);
    // Nothing was asked and no second Git-host event exists.
    expect(gitHostYields(replayStream.snapshot())).toHaveLength(1);
    expect(replayStream.snapshot().slice(0, inherited.length)).toEqual(inherited);

    // Counterfeited, on both paths. The replacement may break replay — that is
    // its own business — but it can never put its run anywhere: not into what
    // the provider is asked, not into what the effect produced, and not into
    // what either journal holds.
    const forged = yield* counterfeitRecord();

    const forgedReplayStream = new InMemoryStream(inherited);
    const forgedReplay = yield* counterfeitedRun({ stream: forgedReplayStream, forged });

    const liveStream = new InMemoryStream();
    const liveHost = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    const live = yield* counterfeitedRun({
      stream: liveStream,
      provider: liveHost.provider,
      forged,
    });

    for (const request of [...liveHost.observed, ...liveHost.performed]) {
      expect(request.identity.runId).toBe(RUN.runId);
    }
    for (const attempt of [forgedReplay, live]) {
      expect(attempt.records.map((record) => record.request.identity.runId)).not.toContain(
        COUNTERFEIT_RUN,
      );
    }
    for (const stream of [forgedReplayStream, liveStream]) {
      expect(stream.snapshot().map(serializeDurableEvent).join("")).not.toContain(COUNTERFEIT_RUN);
    }
  });

  it("GH15: an inherited identity answers one retained call, never the live one after it", function* () {
    // `reconcileGitHostEffect()` is a public surface, so one expansion may reach
    // it twice. A fork whose inherited prefix ends after the first of those
    // calls must not lend the source's identity to the second: that call is
    // live, and a live call is the fork's own.
    const sourceRunId = "run-297-git-host-source";
    const second: GitHostEffectRequest = {
      kind: "git-push",
      inputs: { remote: "origin", branch: "release-1.5", commit: "0e1d2c3" },
      naturalKey: { remote: "origin", destinationRef: "refs/heads/release-1.5" },
    };

    // A source run that made both calls in one expansion.
    const seedStream = new InMemoryStream();
    const seedHost = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    const seeded = yield* twiceRun({ stream: seedStream, provider: seedHost.provider, second });
    expect(seeded.failures).toEqual([]);
    expect(seeded.records).toHaveLength(2);
    expect(gitHostYields(seedStream.snapshot())).toHaveLength(2);

    // What a fork inherits: the prefix ending after the *first* record, written
    // under the source's identity. The second call has nothing retained.
    const rewritten = yield* inheritedHistory(partial(seedStream.snapshot()), sourceRunId);
    const upTo = rewritten.findIndex(
      (event) => event.type === "yield" && event.description.type === GIT_HOST_EFFECT,
    );
    const inherited = rewritten.slice(0, upTo + 1);
    expect(gitHostYields(inherited)).toHaveLength(1);

    const stream = new InMemoryStream(inherited);
    const host = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    const forked = yield* twiceRun({ stream, provider: host.provider, second });

    expect(forked.failures).toEqual([]);
    expect(forked.records).toHaveLength(2);

    // The first call replays the inherited record, provider-free, under the
    // identity it was written with.
    expect(forked.records[0]?.request.identity.runId).toBe(sourceRunId);

    // The second is live: the provider is asked exactly once, under the run
    // executing now, and that is the identity the journal receives.
    expect(host.observed).toHaveLength(1);
    expect(host.performed).toHaveLength(1);
    expect(host.observed[0]?.identity.runId).toBe(RUN.runId);
    expect(host.performed[0]?.identity.runId).toBe(RUN.runId);
    expect(host.observed[0]?.naturalKey).toEqual(second.naturalKey);
    expect(forked.records[1]?.request.identity.runId).toBe(RUN.runId);

    // Two Git-host events: the one inherited, and the one this run appended.
    const yields = gitHostYields(stream.snapshot());
    expect(yields).toHaveLength(2);
    expect(stream.snapshot().slice(0, inherited.length)).toEqual(inherited);
    const appended = yields[1];
    const record =
      appended?.type === "yield" && appended.result.status === "ok"
        ? parseGitHostReconciliationRecord(appended.result.value)
        : undefined;
    expect(record?.request.identity.runId).toBe(RUN.runId);
  });
});

/**
 * One execution whose single expansion asks for two Git-host effects.
 *
 * Both calls are the same public surface from the same element, which is what
 * makes an identity held per expansion too broad to be safe.
 */
function* twiceRun(options: {
  readonly stream: DurableStream;
  readonly provider: GitHostProvider;
  readonly second: GitHostEffectRequest;
}): Operation<Attempt> {
  const seen = attempt();
  yield* scoped(function* () {
    yield* registerComponents([
      {
        name: "Effect",
        origin: "tier-gh",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          seen.expansions.push((yield* getExpansion()).id);
          for (const request of [PUSH, options.second]) {
            try {
              seen.records.push(yield* reconcileGitHostEffect(request));
            } catch (error) {
              seen.failures.push(error);
            }
          }
          return "";
        },
      },
    ]);
    try {
      yield* withGitHostProvider(options.provider, collectSource(SOURCE, options.stream));
    } catch {
      // A document that fails is one of the outcomes under test.
    }
  });
  return seen;
}

/** A run id only a counterfeit could put anywhere. */
const COUNTERFEIT_RUN = "counterfeit-run";

/**
 * One execution whose own component rebinds the durable machinery's context and
 * then asks for a Git-host effect.
 *
 * `DurableContext` is a public stable name — `"@effection/durable"` — so a
 * separately constructed descriptor addresses the very context the engine runs
 * on, and a component is where a repository component or a loaded copy would
 * install one. The replacement is *stateful* and armed immediately before the
 * effect: it forges one completed Git-host entry for the next `peekYield()` and
 * delegates every later peek to the genuine index, so anything consulting the
 * replay index for an identity at that moment sees a retained record while
 * durable execution sees the real position.
 *
 * Nothing it does may change which identity the effect uses.
 */
function* counterfeitedRun(options: {
  readonly stream: DurableStream;
  readonly provider?: GitHostProvider;
  readonly forged: DurableEvent;
}): Operation<Attempt> {
  const seen = attempt();
  const { forged } = options;
  const entry =
    forged.type === "yield"
      ? { description: forged.description, result: forged.result }
      : undefined;

  yield* scoped(function* () {
    yield* registerComponents([
      {
        name: "Effect",
        origin: "tier-gh",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          const durable = createContext<Record<string, unknown>>("@effection/durable");
          const genuine = yield* durable.expect();
          const index = genuine["replayIndex"] as { peekYield(coroutineId: string): unknown };
          let armed = true;
          yield* durable.set({
            ...genuine,
            replayIndex: Object.create(index, {
              peekYield: {
                value(coroutineId: string): unknown {
                  if (armed) {
                    armed = false;
                    return entry;
                  }
                  return index.peekYield(coroutineId);
                },
              },
            }),
          });

          seen.expansions.push((yield* getExpansion()).id);
          try {
            seen.records.push(yield* reconcileGitHostEffect(PUSH));
          } catch (error) {
            seen.failures.push(error);
          }
          return "";
        },
      },
    ]);
    const execution = collectSource(SOURCE, options.stream);
    try {
      yield* options.provider === undefined
        ? execution
        : withGitHostProvider(options.provider, execution);
    } catch {
      // A document that fails is one of the outcomes under test.
    }
  });
  return seen;
}

/** A completed Git-host record naming a run nothing here is. */
function* counterfeitRecord(): Operation<DurableEvent> {
  const request: CompleteGitHostEffectRequest = {
    identity: { runId: COUNTERFEIT_RUN, expansionId: "expansion-1" },
    kind: PUSH.kind,
    inputs: PUSH.inputs,
    naturalKey: PUSH.naturalKey,
  };
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: GIT_HOST_EFFECT, name: yield* gitHostRequestFingerprint(request) },
    result: {
      status: "ok",
      value: {
        request,
        preState: null,
        observations: null,
        decision: "performed",
        result: null,
      } as unknown as Json,
    },
  };
}

/**
 * One run's history as another run's, so it can be inherited.
 *
 * Only the Git-host record moves: its retained identity becomes the source's,
 * and the durable operation is renamed to the digest that identity produces —
 * which is exactly what the source itself wrote, and what a fork copies
 * verbatim.
 */
function* inheritedHistory(
  events: readonly DurableEvent[],
  runId: string,
): Operation<DurableEvent[]> {
  const rewritten: DurableEvent[] = [];
  for (const event of events) {
    const record =
      event.type === "yield" &&
      event.description.type === GIT_HOST_EFFECT &&
      event.result.status === "ok"
        ? parseGitHostReconciliationRecord(event.result.value)
        : undefined;
    if (event.type !== "yield" || record === undefined) {
      rewritten.push(event);
      continue;
    }
    const request = { ...record.request, identity: { ...record.request.identity, runId } };
    rewritten.push({
      ...event,
      description: { ...event.description, name: yield* gitHostRequestFingerprint(request) },
      result: { status: "ok", value: { ...record, request } as unknown as Json },
    });
  }
  return rewritten;
}

/** A journal that refuses exactly the Git-host effect's own publication. */
function refusingGitHostAppends(inner: InMemoryStream): DurableStream {
  return {
    readAll: () => inner.readAll(),
    *append(event: DurableEvent): Operation<void> {
      if (event.type === "yield" && event.description.type === GIT_HOST_EFFECT) {
        throw new Error("the journal backend refused this append");
      }
      yield* inner.append(event);
    },
  };
}
