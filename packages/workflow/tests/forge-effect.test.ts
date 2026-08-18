/**
 * Tier FE — one shared reconciliation for every external forge effect.
 *
 * A forge holds state no SQLite transaction here can enclose, so the only thing
 * standing between an interrupted push and a duplicated one is the order this
 * engine works in: observe, then decide, then perform at most once. Every test
 * below measures that order rather than the answer it produced — what the
 * provider was asked, how many times, and what the journal holds afterwards.
 *
 * Nothing here reaches a real forge, and nothing here is GitHub. The kinds are
 * the three #218 names downstream issues will use, run through the same engine
 * and the same provider interface, which is the point: a kind-specific state
 * machine appearing in this layer is what FE12 exists to red.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, Ok, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import {
  DivergenceError,
  InMemoryStream,
  serializeDurableEvent,
} from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { createApi } from "@effectionx/context-api";
import { collect, getExpansion, inlineSource, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { retainedWorkflowInstallation } from "../src/run.ts";
import type { WorkflowRun } from "../src/run.ts";
import { FORGE_EFFECT, reconcileForgeEffect, withForgeProvider } from "../src/forge/effect.ts";
import type { ForgeProvider } from "../src/forge/api.ts";
import {
  ForgeAmbiguousError,
  ForgeConflictError,
  ForgeProtocolError,
  ForgeProviderError,
  ForgeUnavailableError,
} from "../src/forge/errors.ts";
import type {
  CompleteForgeEffectRequest,
  ForgeCompletion,
  ForgeEffectRequest,
  ForgeObservation,
  ForgeReconciliationRecord,
} from "../src/forge/records.ts";

const RUN: WorkflowRun = Object.freeze({
  runId: "run-297-forge",
  base: "main",
  pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
});

const SOURCE = "<Effect />\n";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A synthetic forge token, format-realistic and assembled here. */
const CREDENTIAL = ["ghp", "_", ALPHABET.slice(0, 36)].join("");

/** Words only a forged failure carries, so finding them anywhere is a leak. */
const FORGED_MARKER = "forged-by-routing-middleware";

const PUSH: ForgeEffectRequest = Object.freeze({
  kind: "git-push",
  inputs: { remote: "origin", branch: "release-1.4", commit: "9fceb02" },
  naturalKey: { ref: "refs/heads/release-1.4" },
});

const ABSENT: ForgeObservation = Object.freeze({
  state: "absent",
  preState: { ref: null },
});
const CONFLICT: ForgeObservation = Object.freeze({
  state: "conflict",
  preState: { ref: "refs/heads/release-1.4", commit: "0000001" },
});
const AMBIGUOUS: ForgeObservation = Object.freeze({
  state: "ambiguous",
  preState: { ref: "unreadable" },
});
const COMPATIBLE: ForgeObservation = Object.freeze({
  state: "compatible",
  preState: { ref: "refs/heads/release-1.4", commit: "9fceb02" },
  observations: { ref: "refs/heads/release-1.4", commit: "9fceb02" },
  result: { ref: "refs/heads/release-1.4", commit: "9fceb02", updated: false },
});
const PERFORMED: ForgeCompletion = Object.freeze({
  observations: { ref: "refs/heads/release-1.4", commit: "9fceb02" },
  result: { ref: "refs/heads/release-1.4", commit: "9fceb02", updated: true },
});

/** The private invocation Api, addressed by its stable name from outside. */
const ForgeInvocationCollision = createApi<{ coordinate(request: unknown): Operation<unknown> }>(
  "executablemd.workflow.forge.invocation",
  {
    // deno-lint-ignore require-yield
    *coordinate(): Operation<unknown> {
      throw new Error("the collision handler did not delegate");
    },
  },
);

interface Attempt {
  readonly records: ForgeReconciliationRecord[];
  readonly failures: unknown[];
  readonly expansions: string[];
}

function attempt(): Attempt {
  return { records: [], failures: [], expansions: [] };
}

interface Recorded {
  readonly provider: ForgeProvider;
  readonly observed: CompleteForgeEffectRequest[];
  readonly performed: CompleteForgeEffectRequest[];
  readonly evidence: ForgeObservation[];
}

type Observe = (request: CompleteForgeEffectRequest) => Operation<Result<ForgeObservation>>;
type Perform = (
  request: CompleteForgeEffectRequest,
  observation: ForgeObservation,
) => Operation<Result<ForgeCompletion>>;

/**
 * A provider that counts what it was asked, and fails the test when it is asked
 * to perform without a perform of its own.
 */
function recordingProvider(observe: Observe, perform?: Perform): Recorded {
  const observed: CompleteForgeEffectRequest[] = [];
  const performed: CompleteForgeEffectRequest[] = [];
  const evidence: ForgeObservation[] = [];
  return {
    observed,
    performed,
    evidence,
    provider: {
      *observe(request): Operation<Result<ForgeObservation>> {
        observed.push(request);
        return yield* observe(request);
      },
      *perform(request, observation): Operation<Result<ForgeCompletion>> {
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
    function* (): Operation<Result<ForgeObservation>> {
      throw new Error("the forge was observed where no observation may happen");
    },
  );
}

function answering<T>(value: Result<T>): () => Operation<Result<T>> {
  // deno-lint-ignore require-yield
  return function* (): Operation<Result<T>> {
    return value;
  };
}

function useEffectComponent(request: ForgeEffectRequest, seen: Attempt): Operation<void> {
  return registerComponents([
    {
      name: "Effect",
      origin: "tier-fe",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        seen.expansions.push((yield* getExpansion()).id);
        try {
          seen.records.push(yield* reconcileForgeEffect(request));
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
  readonly request?: ForgeEffectRequest;
  readonly provider?: ForgeProvider;
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
        : withForgeProvider(options.provider, around(execution));
    try {
      yield* routed;
    } catch {
      // The component already recorded the exact failure; a document that fails
      // is one of the outcomes under test rather than an error in the harness.
    }
  });
  return seen;
}

function* collectDocument(stream: DurableStream): Operation<unknown> {
  return yield* collect(
    yield* executeInstalled({ ...inlineSource(SOURCE), stream }, [
      retainedWorkflowInstallation(RUN),
    ]),
  );
}

function forgeYields(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === FORGE_EFFECT,
  );
}

/** The history a run leaves behind when it was interrupted before its root closed. */
function partial(events: DurableEvent[]): DurableEvent[] {
  return events.filter((event) => !(event.type === "close" && event.coroutineId === "root"));
}

function recordOf(seen: Attempt): ForgeReconciliationRecord {
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

describe("Tier FE — shared external forge-effect reconciliation", () => {
  it("FE1: proven absence performs once, under identity only the host can name", function* () {
    const stream = new InMemoryStream();
    const forge = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    // The document supplies an identity of its own. It is not a member of a
    // request, so it is not read, and the provider still sees the run and the
    // expansion the engine derived.
    const forged = {
      ...PUSH,
      identity: { runId: "forged-run", expansionId: "forged-expansion" },
    };

    const seen = yield* runDocument({ stream, provider: forge.provider, request: forged });

    expect(seen.failures).toEqual([]);
    expect(forge.observed).toHaveLength(1);
    expect(forge.performed).toHaveLength(1);
    expect(forge.observed[0]?.identity).toEqual(identityOf(seen));
    expect(forge.performed[0]?.identity).toEqual(identityOf(seen));
    expect(forge.observed[0]?.kind).toBe("git-push");
    // Perform is reached from the proven absence, and receives it as evidence.
    expect(forge.evidence).toEqual([ABSENT]);

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

    const yields = forgeYields(stream.snapshot());
    expect(yields).toHaveLength(1);
    expect(yields[0]).toEqual(
      expect.objectContaining({
        result: { status: "ok", value: recordOf(seen) },
      }),
    );
  });

  it("FE2: a proven compatible completion is adopted and performs nothing", function* () {
    const stream = new InMemoryStream();
    const forge = recordingProvider(answering(Ok(COMPATIBLE)));

    const seen = yield* runDocument({ stream, provider: forge.provider });

    expect(seen.failures).toEqual([]);
    expect(forge.observed).toHaveLength(1);
    expect(forge.performed).toEqual([]);
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
    expect(forgeYields(stream.snapshot())).toHaveLength(1);
  });

  it("FE3: a recorded decision replays without a provider at all", function* () {
    for (const observation of [ABSENT, COMPATIBLE]) {
      const stream = new InMemoryStream();
      const forge = recordingProvider(answering(Ok(observation)), answering(Ok(PERFORMED)));
      const first = yield* runDocument({ stream, provider: forge.provider });
      expect(first.failures).toEqual([]);

      const replayed = new InMemoryStream(partial(stream.snapshot()));
      // No provider is installed at all, so any phase that reached the boundary
      // would fail rather than answer.
      const second = yield* runDocument({ stream: replayed });

      expect(second.failures).toEqual([]);
      expect(recordOf(second)).toEqual(recordOf(first));
      expect(forge.observed).toHaveLength(1);
      expect(forge.performed).toHaveLength(observation === ABSENT ? 1 : 0);
      expect(forgeYields(replayed.snapshot())).toHaveLength(1);
    }
  });

  it("FE4: a remote success whose result was never published is adopted, not repeated", function* () {
    const remote: { mutations: number; state: Json | undefined } = {
      mutations: 0,
      state: undefined,
    };
    const forge = recordingProvider(
      // deno-lint-ignore require-yield
      function* (): Operation<Result<ForgeObservation>> {
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
      function* (): Operation<Result<ForgeCompletion>> {
        remote.mutations += 1;
        remote.state = { ref: "refs/heads/release-1.4", commit: "9fceb02" };
        return Ok({ observations: remote.state, result: remote.state });
      },
    );

    // The remote accepts the mutation and the journal refuses to record it.
    const backing = new InMemoryStream();
    const interrupted = yield* runDocument({
      stream: refusingForgeAppends(backing),
      provider: forge.provider,
    });

    expect(interrupted.records).toEqual([]);
    expect(remote.mutations).toBe(1);
    expect(forgeYields(backing.snapshot())).toEqual([]);

    // A new execution of the same run, same expansion and same request, with no
    // history of the effect at all.
    const resumed = new InMemoryStream();
    const second = yield* runDocument({ stream: resumed, provider: forge.provider });

    expect(second.failures).toEqual([]);
    expect(remote.mutations).toBe(1);
    expect(forge.observed).toHaveLength(2);
    expect(forge.performed).toHaveLength(1);
    expect(recordOf(second).decision).toBe("adopted");
    expect(recordOf(second).result).toEqual({
      ref: "refs/heads/release-1.4",
      commit: "9fceb02",
    });
    expect(forgeYields(resumed.snapshot())).toHaveLength(1);
  });

  it("FE5: conflict refuses, mutates nothing, and replays as itself", function* () {
    const stream = new InMemoryStream();
    const forge = recordingProvider(answering(Ok(CONFLICT)));

    const seen = yield* runDocument({ stream, provider: forge.provider });

    expect(seen.records).toEqual([]);
    expect(seen.failures[0]).toBeInstanceOf(ForgeConflictError);
    expect(forge.performed).toEqual([]);
    const yields = forgeYields(stream.snapshot());
    expect(yields).toHaveLength(1);
    expect(yields[0]).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          status: "err",
          error: expect.objectContaining({ name: "ForgeConflictError" }),
        }),
      }),
    );

    const replayed = new InMemoryStream(partial(stream.snapshot()));
    const second = yield* runDocument({ stream: replayed, provider: forbiddenProvider().provider });

    expect(second.failures[0]).toBeInstanceOf(ForgeConflictError);
    expect(forgeYields(replayed.snapshot())).toHaveLength(1);
  });

  it("FE6: permanent ambiguity refuses distinctly and replays provider-free", function* () {
    const stream = new InMemoryStream();
    const forge = recordingProvider(answering(Ok(AMBIGUOUS)));

    const seen = yield* runDocument({ stream, provider: forge.provider });

    expect(seen.failures[0]).toBeInstanceOf(ForgeAmbiguousError);
    expect(seen.failures[0]).not.toBeInstanceOf(ForgeConflictError);
    expect(forge.performed).toEqual([]);

    const replayed = new InMemoryStream(partial(stream.snapshot()));
    const second = yield* runDocument({ stream: replayed, provider: forbiddenProvider().provider });

    expect(second.failures[0]).toBeInstanceOf(ForgeAmbiguousError);
    expect(forgeYields(replayed.snapshot())).toHaveLength(1);
  });

  it("FE7: temporary unavailability is its own failure, retried by nobody here", function* () {
    const rows = [
      {
        name: "observation",
        forge: () => recordingProvider(answering(Err(new ForgeUnavailableError()))),
        performs: 0,
      },
      {
        name: "perform",
        forge: () =>
          recordingProvider(answering(Ok(ABSENT)), answering(Err(new ForgeUnavailableError()))),
        performs: 1,
      },
    ];

    for (const row of rows) {
      const stream = new InMemoryStream();
      const forge = row.forge();
      const seen = yield* runDocument({ stream, provider: forge.provider });

      expect(seen.failures[0]).toBeInstanceOf(ForgeUnavailableError);
      expect(seen.failures[0]).not.toBeInstanceOf(ForgeConflictError);
      expect(seen.failures[0]).not.toBeInstanceOf(ForgeAmbiguousError);
      expect(seen.records).toEqual([]);
      // One observation and no hidden second attempt at either phase.
      expect(forge.observed).toHaveLength(1);
      expect(forge.performed).toHaveLength(row.performs);
    }

    // Cancellation is Effection control flow, not a forge condition.
    const stream = new InMemoryStream();
    const entered = withResolvers<void>();
    const forge = recordingProvider(function* (): Operation<Result<ForgeObservation>> {
      entered.resolve();
      yield* suspend();
      return Ok(ABSENT);
    });
    const seen = attempt();

    yield* scoped(function* () {
      const task = yield* spawn(() => runDocument({ stream, provider: forge.provider, seen }));
      yield* entered.operation;
      yield* task.halt();
    });

    expect(forge.observed).toHaveLength(1);
    expect(forge.performed).toEqual([]);
    expect(seen.failures).toEqual([]);
    expect(seen.records).toEqual([]);
    expect(forgeYields(stream.snapshot())).toEqual([]);
  });

  it("FE8: a changed request cannot consume a retained completion", function* () {
    const stream = new InMemoryStream();
    const forge = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    const first = yield* runDocument({ stream, provider: forge.provider });
    expect(first.failures).toEqual([]);

    const changed: ForgeEffectRequest = {
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
    expect(forgeYields(mismatched.snapshot())).toHaveLength(1);

    // The positive control: the unchanged request still replays its record.
    const unchanged = new InMemoryStream(partial(stream.snapshot()));
    const replayed = yield* runDocument({
      stream: unchanged,
      provider: forbiddenProvider().provider,
    });
    expect(recordOf(replayed)).toEqual(recordOf(first));
  });

  it("FE9: contextual routing selects a provider and completes nothing", function* () {
    const cases = [
      {
        name: "short-circuit",
        // deno-lint-ignore require-yield
        around: function* (): Operation<unknown> {
          return undefined;
        },
      },
      {
        name: "forged answer",
        // deno-lint-ignore require-yield
        around: function* (): Operation<unknown> {
          return { type: "answered", result: Ok(COMPATIBLE) };
        },
      },
    ];

    for (const routing of cases) {
      const stream = new InMemoryStream();
      const forge = forbiddenProvider();
      const seen = yield* runDocument({
        stream,
        provider: forge.provider,
        around: (operation) =>
          scoped(function* () {
            yield* ForgeInvocationCollision.around({
              coordinate: routing.around,
            });
            return yield* operation;
          }),
      });

      expect(seen.records).toEqual([]);
      expect(seen.failures[0]).toBeInstanceOf(ForgeProviderError);
      expect(forge.observed).toEqual([]);
      expect(forgeYields(stream.snapshot())).toEqual([]);
    }

    // Routing that throws a closed forge failure of its own is still routing.
    // Nothing was accepted through the capability, so there is no forge outcome
    // for the journal to hold — and the middleware's own words are not the
    // run's history.
    const authored = new InMemoryStream();
    const authoredForge = forbiddenProvider();
    const authoredRun = yield* runDocument({
      stream: authored,
      provider: authoredForge.provider,
      around: (operation) =>
        scoped(function* () {
          yield* ForgeInvocationCollision.around({
            // deno-lint-ignore require-yield
            *coordinate(): Operation<unknown> {
              const forged = new ForgeConflictError();
              forged.message = `${forged.message} ${FORGED_MARKER}`;
              throw forged;
            },
          });
          return yield* operation;
        }),
    });

    expect(authoredForge.observed).toEqual([]);
    expect(authoredRun.records).toEqual([]);
    expect(authoredRun.failures[0]).toBeInstanceOf(ForgeProviderError);
    expect(authoredRun.failures[0]).not.toBeInstanceOf(ForgeConflictError);
    expect(forgeYields(authored.snapshot())).toEqual([]);
    expect(String(authoredRun.failures[0])).not.toContain(FORGED_MARKER);
    expect(authored.snapshot().map(serializeDurableEvent).join("")).not.toContain(FORGED_MARKER);

    // A substituted selection carries no credential this scope minted.
    const substituted = new InMemoryStream();
    const substitutedForge = forbiddenProvider();
    const substitutedRun = yield* runDocument({
      stream: substituted,
      provider: substitutedForge.provider,
      around: (operation) =>
        scoped(function* () {
          yield* ForgeInvocationCollision.around({
            *coordinate([request], next): Operation<unknown> {
              return yield* next({
                ...Object(request),
                route: Object.freeze({}),
              });
            },
          });
          return yield* operation;
        }),
    });

    expect(substitutedRun.failures[0]).toBeInstanceOf(ForgeProviderError);
    expect(substitutedForge.observed).toEqual([]);
    expect(forgeYields(substituted.snapshot())).toEqual([]);

    // A request replayed after its own coordination finished finds its route
    // consumed. The reuse reaches no provider and produces no second answer;
    // what the run publishes is the one authoritative answer already recorded.
    const reused = new InMemoryStream();
    const reusedForge = recordingProvider(answering(Ok(COMPATIBLE)));
    const reuseRefusals: unknown[] = [];
    const reusedRun = yield* runDocument({
      stream: reused,
      provider: reusedForge.provider,
      around: (operation) =>
        scoped(function* () {
          yield* ForgeInvocationCollision.around({
            *coordinate([request], next): Operation<unknown> {
              const answered = yield* next(request);
              try {
                yield* next(request);
              } catch (error) {
                reuseRefusals.push(error);
              }
              return answered;
            },
          });
          return yield* operation;
        }),
    });

    expect(reuseRefusals[0]).toBeInstanceOf(ForgeProviderError);
    expect(reusedForge.observed).toHaveLength(1);
    expect(recordOf(reusedRun).decision).toBe("adopted");
    expect(forgeYields(reused.snapshot())).toHaveLength(1);

    // A throw after a real provider answered cannot take that answer away.
    const completed = new InMemoryStream();
    const completedForge = recordingProvider(answering(Ok(COMPATIBLE)));
    const completedRun = yield* runDocument({
      stream: completed,
      provider: completedForge.provider,
      around: (operation) =>
        scoped(function* () {
          yield* ForgeInvocationCollision.around({
            *coordinate([request], next): Operation<unknown> {
              yield* next(request);
              throw new Error("post-completion routing failure");
            },
          });
          return yield* operation;
        }),
    });

    expect(completedRun.failures).toEqual([]);
    expect(recordOf(completedRun).decision).toBe("adopted");
    expect(completedForge.observed).toHaveLength(1);
    expect(forgeYields(completed.snapshot())).toHaveLength(1);
  });

  it("FE10: a provider answer this boundary cannot read is refused, not journaled", function* () {
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
      const forge = recordingProvider(
        // deno-lint-ignore require-yield
        function* (): Operation<Result<ForgeObservation>> {
          return Ok(answer.value as unknown as ForgeObservation);
        },
      );
      const seen = yield* runDocument({ stream, provider: forge.provider });

      expect(seen.failures[0]).toBeInstanceOf(ForgeProtocolError);
      expect(String(seen.failures[0])).not.toContain(CREDENTIAL);
      expect(seen.records).toEqual([]);
      expect(forge.performed).toEqual([]);
      expect(forgeYields(stream.snapshot())).toEqual([]);
      expect(stream.snapshot().map(serializeDurableEvent).join("")).not.toContain(CREDENTIAL);
    }

    // Positive controls: each valid variant is accepted by the same parser.
    for (const observation of [ABSENT, COMPATIBLE, CONFLICT, AMBIGUOUS]) {
      const stream = new InMemoryStream();
      const forge = recordingProvider(answering(Ok(observation)), answering(Ok(PERFORMED)));
      const seen = yield* runDocument({ stream, provider: forge.provider });
      expect(seen.failures[0]).not.toBeInstanceOf(ForgeProtocolError);
      expect(forgeYields(stream.snapshot())).toHaveLength(1);
    }

    // A completion carrying a raw payload is refused on the same terms, after a
    // real mutation: the answer is what is refused, never the mutation's record.
    const stream = new InMemoryStream();
    const forge = recordingProvider(
      answering(Ok(ABSENT)),
      // deno-lint-ignore require-yield
      function* (): Operation<Result<ForgeCompletion>> {
        return Ok({
          observations: PERFORMED.observations,
          result: PERFORMED.result,
          raw: CREDENTIAL,
        } as unknown as ForgeCompletion);
      },
    );
    const seen = yield* runDocument({ stream, provider: forge.provider });
    expect(seen.failures[0]).toBeInstanceOf(ForgeProtocolError);
    expect(forgeYields(stream.snapshot())).toEqual([]);
    expect(stream.snapshot().map(serializeDurableEvent).join("")).not.toContain(CREDENTIAL);
  });

  it("FE11: the journal's own secret gate is the only security boundary here", function* () {
    const stream = new InMemoryStream();
    const clean = recordingProvider(
      // The credential never leaves the closure: the provider authenticates with
      // it and answers with normalized data.
      // deno-lint-ignore require-yield
      function* (): Operation<Result<ForgeObservation>> {
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
    const forge = recordingProvider(
      answering(
        Ok({
          state: "compatible",
          preState: null,
          observations: null,
          result: { token: CREDENTIAL },
        }),
      ),
    );
    const leaked = yield* runDocument({ stream: leaking, provider: forge.provider });

    expect(leaked.records).toEqual([]);
    expect(leaked.failures).toHaveLength(1);
    expect(forgeYields(leaking.snapshot())).toEqual([]);
    expect(leaking.snapshot().map(serializeDurableEvent).join("")).not.toContain(CREDENTIAL);
  });

  it("FE12: every downstream kind runs through this one engine", function* () {
    const kinds: ForgeEffectRequest[] = [
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
      const forge = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
      const seen = yield* runDocument({ stream, provider: forge.provider, request });

      expect(seen.failures).toEqual([]);
      expect(recordOf(seen).decision).toBe("performed");
      expect(recordOf(seen).request.kind).toBe(request.kind);
      expect(recordOf(seen).request.naturalKey).toEqual(request.naturalKey);
      expect(forge.observed).toHaveLength(1);
      expect(forge.performed).toHaveLength(1);
      expect(forgeYields(stream.snapshot())).toHaveLength(1);
      // Every kind is named by its own durable identity.
      const description = forgeYields(stream.snapshot())[0];
      expect(description?.type === "yield" ? description.description.name : "").toMatch(
        /^[0-9a-f]{64}$/,
      );
    }
  });
});

/** A journal that refuses exactly the forge effect's own publication. */
function refusingForgeAppends(inner: InMemoryStream): DurableStream {
  return {
    readAll: () => inner.readAll(),
    *append(event: DurableEvent): Operation<void> {
      if (event.type === "yield" && event.description.type === FORGE_EFFECT) {
        throw new Error("the journal backend refused this append");
      }
      yield* inner.append(event);
    },
  };
}
