/**
 * Tier OW — reconciling an external Git-host effect under a stated owner.
 *
 * The shared engine's other entrypoint derives its identity from a workflow run
 * and the engine's expansion. This one is told who owns the history and which
 * invocation inside it is asking, which is what lets a REPL entry retain
 * external work the way a workflow run does without being one.
 *
 * What each case measures is the order: whose identity reached the provider,
 * how many times a phase ran, when the attempt's own resources closed, and what
 * the journal holds afterwards. Nothing here reaches a Git host, and nothing
 * here is GitHub.
 *
 * These cases carry the provider-neutral half of the delivery-4 matrix: E2's
 * provider-free completed replay, E4's decisions, E5's identity separation,
 * E6's refusal of a completion the caller cannot account for, E7's persistence
 * fence, and E8's joined teardown before publication.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, ensure, Ok, scoped, spawn, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { collect, getExpansion, inlineSource, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { GIT_HOST_EFFECT } from "../src/git-host/effect.ts";
import { reconcileOwnedGitHostEffect } from "@executablemd/git/api";
import type { OwnedGitHostLive } from "../src/git-host/effect.ts";
import {
  GitHostConflictError,
  GitHostProviderError,
  GitHostUnavailableError,
} from "../src/git-host/errors.ts";
import { gitHostRequestFingerprint } from "../src/git-host/records.ts";
import type { GitHostEffectRequest, GitHostReconciliationRecord } from "../src/git-host/records.ts";
// The public contracts a provider is written against arrive on the subpath that
// publishes them, exactly as any other consumer reaches them.
import type {
  CompleteGitHostEffectRequest,
  GitHostCompletion,
  GitHostObservation,
  GitHostProvider,
} from "@executablemd/git/api";

const OWNER = '["executablemd.repl.issue-owner",1,"execution-7","entry-2"]';
const SITE = "site-9f2c";

const SOURCE = "<Effect />\n";

const PUSH: GitHostEffectRequest = Object.freeze({
  kind: "git-push",
  inputs: { remote: "origin", branch: "review/push", commit: "9fceb02" },
  naturalKey: { ref: "refs/heads/review/push" },
});

const ABSENT: GitHostObservation = Object.freeze({
  state: "absent",
  preState: { remoteCommit: null },
});
const CONFLICT: GitHostObservation = Object.freeze({
  state: "conflict",
  preState: { remoteCommit: "0000001" },
});
const AMBIGUOUS: GitHostObservation = Object.freeze({
  state: "ambiguous",
  preState: { remoteCommit: null },
});
const COMPATIBLE: GitHostObservation = Object.freeze({
  state: "compatible",
  preState: { remoteCommit: "9fceb02" },
  observations: { remoteCommit: "9fceb02" },
  result: { commit: "9fceb02" },
});
const PERFORMED: GitHostCompletion = Object.freeze({
  observations: { remoteCommit: "9fceb02" },
  result: { commit: "9fceb02" },
});

type Observe = (request: CompleteGitHostEffectRequest) => Operation<Result<GitHostObservation>>;
type Perform = (
  request: CompleteGitHostEffectRequest,
  observation: GitHostObservation,
) => Operation<Result<GitHostCompletion>>;

interface Recorded {
  readonly provider: GitHostProvider;
  readonly observed: CompleteGitHostEffectRequest[];
  readonly performed: CompleteGitHostEffectRequest[];
  readonly evidence: GitHostObservation[];
}

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

function answering<T>(value: Result<T>): () => Operation<Result<T>> {
  // deno-lint-ignore require-yield
  return function* (): Operation<Result<T>> {
    return value;
  };
}

/** What one owned attempt did, as the trusted body saw it. */
interface Attempt {
  readonly records: GitHostReconciliationRecord[];
  readonly failures: unknown[];
  readonly validated: GitHostReconciliationRecord[];
  /** How many times the live provider was constructed, replay included. */
  constructions: number;
}

function attempt(): Attempt {
  return { records: [], failures: [], validated: [], constructions: 0 };
}

interface OwnedOptions {
  readonly stream: DurableStream;
  readonly owner?: string;
  readonly site?: string;
  readonly request?: GitHostEffectRequest;
  readonly provider?: GitHostProvider;
  /** Reached with the complete record, before the coordinator publishes it. */
  readonly validate?: (record: GitHostReconciliationRecord) => void;
  /** Acquired inside the attempt's own scope, around the whole reconciliation. */
  readonly resource?: () => Operation<void>;
  readonly seen?: Attempt;
  /** Invocations the one `<Effect />` makes, which is one by default. */
  readonly calls?: number;
}

/**
 * One document execution whose element reconciles an owned effect.
 *
 * No workflow run is installed, and that is a property under test rather than a
 * shortcut: this entrypoint's identity is the one its caller states, so an
 * execution that is not a workflow run reconciles external work all the same.
 */
function* runOwned(options: OwnedOptions): Operation<Attempt> {
  const seen = options.seen ?? attempt();
  const owner = options.owner ?? OWNER;
  const site = options.site ?? SITE;
  const request = options.request ?? PUSH;
  const calls = options.calls ?? 1;

  yield* scoped(function* () {
    yield* registerComponents([
      {
        name: "Effect",
        origin: "tier-ow",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          // Read so a site derived from the engine stays available to a case
          // that wants one; the identity this entrypoint uses is the stated
          // pair and nothing else.
          yield* getExpansion();
          for (let index = 0; index < calls; index += 1) {
            try {
              seen.records.push(
                yield* reconcileOwnedGitHostEffect({ owner, site, request }, live(options, seen)),
              );
            } catch (error) {
              seen.failures.push(error);
              throw error;
            }
          }
          return "";
        },
      },
    ]);
    try {
      yield* collect(
        yield* executeInstalled({ ...inlineSource(SOURCE), stream: options.stream }, []),
      );
    } catch {
      // The component recorded the exact failure; a document that fails is one
      // of the outcomes under test rather than an error in the harness.
    }
  });
  return seen;
}

/**
 * The private trusted half one case supplies.
 *
 * `provider()` is where a live attempt's resources are opened, so a case that
 * states one acquires it here — inside the attempt's own scope, where the
 * engine joins its teardown before publication.
 */
function live(options: OwnedOptions, seen: Attempt): OwnedGitHostLive {
  return {
    *provider(): Operation<GitHostProvider> {
      seen.constructions += 1;
      if (options.resource !== undefined) {
        yield* options.resource();
      }
      const provider = options.provider;
      if (provider === undefined) {
        throw new Error("the attempt constructed a provider where none may be constructed");
      }
      return provider;
    },
    validate(record: GitHostReconciliationRecord): void {
      seen.validated.push(record);
      options.validate?.(record);
    },
  };
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

/** The names the journal holds for this effect's type, in append order. */
function names(events: DurableEvent[]): string[] {
  return gitHostYields(events).map((event) =>
    event.type === "yield" ? event.description.name : "",
  );
}

/** A provider that fails the case if any phase reaches it. */
function forbiddenProvider(): GitHostProvider {
  return recordingProvider(
    // deno-lint-ignore require-yield
    function* (): Operation<Result<GitHostObservation>> {
      throw new Error("the Git host was observed where no observation may happen");
    },
  ).provider;
}

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

describe("Tier OW — owner-specified external Git-host reconciliation", () => {
  it("OW1: reconciles under exactly the stated owner and site, with no workflow run", function* () {
    const stream = new InMemoryStream();
    const host = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));

    const seen = yield* runOwned({ stream, provider: host.provider });

    expect(seen.failures).toEqual([]);
    expect(host.observed).toHaveLength(1);
    expect(host.performed).toHaveLength(1);
    // The pair the caller stated, carried in the field spellings the record
    // already had. Nothing was derived from a run this execution is not.
    const identity = { runId: OWNER, expansionId: SITE };
    expect(host.observed[0]?.identity).toEqual(identity);
    expect(host.performed[0]?.identity).toEqual(identity);
    expect(host.evidence).toEqual([ABSENT]);

    expect(recordOf(seen)).toEqual({
      request: { identity, kind: PUSH.kind, inputs: PUSH.inputs, naturalKey: PUSH.naturalKey },
      preState: ABSENT.preState,
      observations: PERFORMED.observations,
      decision: "performed",
      result: PERFORMED.result,
    });
    // The complete record reached the caller's own reading before it was
    // published, and the journal holds exactly what was validated.
    expect(seen.validated).toEqual([recordOf(seen)]);
    const yields = gitHostYields(stream.snapshot());
    expect(yields).toHaveLength(1);
    expect(yields[0]).toEqual(
      expect.objectContaining({ result: { status: "ok", value: recordOf(seen) } }),
    );
    expect(names(stream.snapshot())).toEqual([
      yield* gitHostRequestFingerprint({
        identity,
        kind: PUSH.kind,
        inputs: PUSH.inputs,
        naturalKey: PUSH.naturalKey,
      }),
    ]);
  });

  it("OW2: another owner, another site and a second occurrence are separate work", function* () {
    const identity = (owner: string, site: string) => ({ runId: owner, expansionId: site });
    const complete = (owner: string, site: string): CompleteGitHostEffectRequest => ({
      identity: identity(owner, site),
      kind: PUSH.kind,
      inputs: PUSH.inputs,
      naturalKey: PUSH.naturalKey,
    });

    const mine = yield* gitHostRequestFingerprint(complete(OWNER, SITE));
    const elsewhere = yield* gitHostRequestFingerprint(complete(OWNER, "site-other"));
    const somebody = yield* gitHostRequestFingerprint(complete("another-owner", SITE));
    expect(new Set([mine, elsewhere, somebody]).size).toBe(3);

    // Two invocations of one element, with equal inputs at one owner and site.
    // They are two occurrences at two positions, which is allowed: telling them
    // apart is the engine's positional matching, and nothing deduplicates by
    // name.
    const stream = new InMemoryStream();
    const host = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    const seen = yield* runOwned({ stream, provider: host.provider, calls: 2 });

    expect(seen.failures).toEqual([]);
    expect(seen.records).toHaveLength(2);
    expect(host.observed).toHaveLength(2);
    expect(host.performed).toHaveLength(2);
    expect(names(stream.snapshot())).toEqual([mine, mine]);
  });

  it("OW3: a completed replay constructs no provider, validates nothing and appends nothing", function* () {
    const stream = new InMemoryStream();
    const host = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    const first = yield* runOwned({ stream, provider: host.provider });
    expect(first.constructions).toBe(1);

    const replayed = new InMemoryStream(partial(stream.snapshot()));
    // Every append this execution makes, so "nothing was appended for the
    // effect" is measured rather than inferred: the root's own close is still
    // written, which is what makes `appendCount` the wrong question.
    const appended: string[] = [];
    replayed.onAppend = (event) => {
      appended.push(event.type === "yield" ? event.description.type : event.type);
    };
    const second = yield* runOwned({ stream: replayed, provider: forbiddenProvider() });

    expect(second.failures).toEqual([]);
    expect(recordOf(second)).toEqual(recordOf(first));
    // Neither half of the live attempt is reached: no provider is constructed,
    // so no credential, transport or resource of any kind is either, and the
    // caller's validation is not re-run over a record it already accepted.
    expect(second.constructions).toBe(0);
    expect(second.validated).toEqual([]);
    expect(host.observed).toHaveLength(1);
    expect(host.performed).toHaveLength(1);
    expect(appended).not.toContain(GIT_HOST_EFFECT);
    expect(gitHostYields(replayed.snapshot())).toHaveLength(1);
  });

  it("OW4: a completion the caller cannot account for is fatal and publishes nothing", function* () {
    const stream = new InMemoryStream();
    const host = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    const refusal = new Error("this completion names a push this invocation did not describe");

    const seen = yield* runOwned({
      stream,
      provider: host.provider,
      validate: () => {
        throw refusal;
      },
    });

    expect(seen.records).toEqual([]);
    // The caller's own sentence survives: a validation refusal is this
    // attempt's own non-outcome rather than an anonymous boundary failure.
    expect(seen.failures).toEqual([refusal]);
    expect(host.performed).toHaveLength(1);
    // Validated before publication, so a completion this reading refuses is
    // never acknowledged — however far the remote work got.
    expect(gitHostYields(stream.snapshot())).toEqual([]);
  });

  it("OW5: conflict, ambiguity and unavailability publish as themselves and replay provider-free", function* () {
    const cases: readonly { readonly observation: GitHostObservation; readonly name: string }[] = [
      { observation: CONFLICT, name: "GitHostConflictError" },
      { observation: AMBIGUOUS, name: "GitHostAmbiguousError" },
    ];
    for (const { observation, name } of cases) {
      const stream = new InMemoryStream();
      const host = recordingProvider(answering(Ok(observation)));
      const seen = yield* runOwned({ stream, provider: host.provider });

      expect(seen.records).toEqual([]);
      expect(host.performed).toEqual([]);
      // A decision the Git host made is this effect's failed result, and the
      // caller's validation is not asked about a record there is none of.
      expect(seen.validated).toEqual([]);
      expect(gitHostYields(stream.snapshot())).toHaveLength(1);
      expect(gitHostYields(stream.snapshot())[0]).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            status: "err",
            error: expect.objectContaining({ name }),
          }),
        }),
      );

      const replayed = new InMemoryStream(partial(stream.snapshot()));
      const second = yield* runOwned({ stream: replayed, provider: forbiddenProvider() });
      expect(second.constructions).toBe(0);
      expect(gitHostYields(replayed.snapshot())).toHaveLength(1);
    }

    // Unavailability is the provider's own answer rather than an observation.
    const stream = new InMemoryStream();
    const host = recordingProvider(answering(Err(new GitHostUnavailableError())));
    const seen = yield* runOwned({ stream, provider: host.provider });
    expect(seen.failures[0]).toBeInstanceOf(GitHostUnavailableError);
    expect(gitHostYields(stream.snapshot())).toHaveLength(1);

    const replayed = new InMemoryStream(partial(stream.snapshot()));
    const second = yield* runOwned({ stream: replayed, provider: forbiddenProvider() });
    expect(second.failures[0]).toBeInstanceOf(GitHostUnavailableError);
    expect(second.constructions).toBe(0);
  });

  it("OW6: attempt resources survive both phases, and a held cleanup holds publication", function* () {
    const stream = new InMemoryStream();
    const order: string[] = [];
    stream.onAppend = (event) => {
      if (event.type === "yield" && event.description.type === GIT_HOST_EFFECT) {
        order.push("appended");
      }
    };
    const host = recordingProvider(
      // deno-lint-ignore require-yield
      function* (): Operation<Result<GitHostObservation>> {
        order.push(`observe:${order.includes("closed") ? "closed" : "open"}`);
        return Ok(ABSENT);
      },
      // deno-lint-ignore require-yield
      function* (): Operation<Result<GitHostCompletion>> {
        order.push(`perform:${order.includes("closed") ? "closed" : "open"}`);
        return Ok(PERFORMED);
      },
    );

    // Two explicit signals and no elapsed time anywhere: the attempt says when
    // its teardown has begun, and this row says when it may finish.
    const began = withResolvers<void>();
    const release = withResolvers<void>();
    // Armed before anything waits on it, so an assertion that fails below
    // cannot leave the attempt stranded in a cleanup nobody will release.
    yield* ensure(() => release.resolve());

    const seen = attempt();
    let completed = false;
    const caller = yield* spawn(function* (): Operation<void> {
      yield* runOwned({
        stream,
        seen,
        provider: host.provider,
        *resource(): Operation<void> {
          order.push("opened");
          yield* ensure(function* (): Operation<void> {
            began.resolve();
            yield* release.operation;
            order.push("closed");
          });
        },
        validate: () => {
          order.push(`validate:${order.includes("closed") ? "closed" : "open"}`);
        },
      });
      completed = true;
    });

    yield* began.operation;

    // Held here, after the whole reconciliation and before its teardown has
    // finished. Nothing has been published and the caller has not come back:
    // acknowledgement is downstream of cleanup rather than racing it, so a
    // reader of this journal can never see a completion whose resources were
    // still closing.
    expect(gitHostYields(stream.snapshot())).toEqual([]);
    expect(order).toEqual(["opened", "observe:open", "perform:open", "validate:open"]);
    expect(completed).toBe(false);
    expect(seen.records).toEqual([]);

    release.resolve();
    yield* caller;

    expect(completed).toBe(true);
    expect(seen.failures).toEqual([]);
    expect(seen.records).toHaveLength(1);
    // One resource, opened once around a whole reconciliation: what observe
    // opened is still open when perform runs, and the validation that decides
    // whether anything may be published runs while it is too. Teardown is
    // joined before the append, and the caller is answered only after it.
    expect(order).toEqual([
      "opened",
      "observe:open",
      "perform:open",
      "validate:open",
      "closed",
      "appended",
    ]);
  });

  it("OW7: a cleanup failure publishes neither a success nor an authored refusal", function* () {
    const broken = new Error("the attempt's own scratch directory could not be removed");

    // A successful reconciliation whose teardown then fails.
    const succeeded = new InMemoryStream();
    const host = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));
    const success = yield* runOwned({
      stream: succeeded,
      provider: host.provider,
      *resource(): Operation<void> {
        yield* ensure(function* () {
          throw broken;
        });
      },
    });

    expect(success.records).toEqual([]);
    expect(host.performed).toHaveLength(1);
    // The outcome object survived unwinding, and surviving is not enough: the
    // attempt is no longer holding what it authored, so nothing is published.
    expect(gitHostYields(succeeded.snapshot())).toEqual([]);

    // And an ordinary conflict the worker authored, on the same terms.
    const refused = new InMemoryStream();
    const conflicted = recordingProvider(answering(Ok(CONFLICT)));
    const second = yield* runOwned({
      stream: refused,
      provider: conflicted.provider,
      *resource(): Operation<void> {
        yield* ensure(function* () {
          throw broken;
        });
      },
    });

    expect(second.records).toEqual([]);
    expect(second.failures[0]).not.toBeInstanceOf(GitHostConflictError);
    expect(gitHostYields(refused.snapshot())).toEqual([]);
  });

  it("OW8: a refused append is the first failure, and nothing is published after it", function* () {
    const backing = new InMemoryStream();
    const host = recordingProvider(answering(Ok(ABSENT)), answering(Ok(PERFORMED)));

    const seen = yield* runOwned({
      stream: refusingGitHostAppends(backing),
      provider: host.provider,
    });

    expect(seen.records).toEqual([]);
    expect(seen.failures).toHaveLength(1);
    // The remote work happened and the journal refused it, which is the window
    // this boundary is honest about: no record, and nothing compensating.
    expect(host.performed).toHaveLength(1);
    expect(gitHostYields(backing.snapshot())).toEqual([]);
  });

  it("OW9: the stated identity and request are read once, before anything suspends", function* () {
    const stream = new InMemoryStream();
    const host = recordingProvider(answering(Ok(COMPATIBLE)));

    // A request object the caller keeps and edits while the attempt runs. What
    // was reconciled is the reading taken before the first suspension.
    const mutable: { kind: string; inputs: Json; naturalKey: Json } = {
      kind: PUSH.kind,
      inputs: { remote: "origin", branch: "review/push", commit: "9fceb02" },
      naturalKey: { ref: "refs/heads/review/push" },
    };
    const seen = yield* runOwned({
      stream,
      request: mutable,
      provider: host.provider,
      validate: () => {
        mutable.kind = "git-pull-request";
        mutable.inputs = { remote: "elsewhere" };
      },
    });

    expect(seen.failures).toEqual([]);
    expect(recordOf(seen).request.kind).toBe(PUSH.kind);
    expect(recordOf(seen).request.inputs).toEqual({
      remote: "origin",
      branch: "review/push",
      commit: "9fceb02",
    });

    // And an identity member that names no history refuses before any of it.
    const empty = new InMemoryStream();
    const refused = yield* runOwned({
      stream: empty,
      owner: "",
      provider: forbiddenProvider(),
    });
    expect(refused.failures).toHaveLength(1);
    expect(refused.constructions).toBe(0);
    expect(gitHostYields(empty.snapshot())).toEqual([]);
  });

  it("OW10: an unauthored throw inside the attempt withholds what it raised", function* () {
    const stream = new InMemoryStream();
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const host = recordingProvider(
      // deno-lint-ignore require-yield
      function* (): Operation<Result<GitHostObservation>> {
        throw new Error(`the transport failed with ${secret}`);
      },
    );

    const seen = yield* runOwned({ stream, provider: host.provider });

    expect(seen.failures).toHaveLength(1);
    expect(seen.failures[0]).toBeInstanceOf(GitHostProviderError);
    expect(JSON.stringify(seen.failures[0])).not.toContain(secret);
    expect(`${seen.failures[0]}`).not.toContain(secret);
    expect(gitHostYields(stream.snapshot())).toEqual([]);
  });

  it("OW11: a provider the attempt cannot construct publishes nothing", function* () {
    const stream = new InMemoryStream();
    const unavailable = new Error("this host lends no transport for that locator");

    const seen = yield* runOwned({
      stream,
      provider: forbiddenProvider(),
      *resource(): Operation<void> {
        // Construction is where a live attempt opens what it needs, and a
        // failure there is infrastructure: no phase runs, so the Git host is
        // never asked and no outcome exists to publish.
        yield* ensure(function* () {});
        throw unavailable;
      },
    });

    expect(seen.records).toEqual([]);
    expect(seen.failures).toHaveLength(1);
    expect(gitHostYields(stream.snapshot())).toEqual([]);
  });
});
