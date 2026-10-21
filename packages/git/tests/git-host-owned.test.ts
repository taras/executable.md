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
import {
  Err,
  ensure,
  Ok,
  race,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import { exists, writeTextFile } from "@effectionx/fs";
import { chmod, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome, RepositoryHost } from "../src/deno/composition/host.ts";
import { UNAUTHENTICATED } from "../src/deno/composition/authentication.ts";
import type { GitAuthenticationSession } from "../src/deno/composition/authentication.ts";
import { repositoryOperationsOver } from "../src/deno/repository-operations.ts";
import {
  GIT_PUSH,
  gitPushInputsJson,
  gitPushNaturalKeyJson,
} from "../src/composition/git-push-records.ts";
import type { GitPushInputs } from "../src/composition/git-push-records.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { useHostCheckout } from "./support/run-composition.ts";
import { REMOTE } from "./support/run-composition-tier.ts";
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
  /**
   * The provider this attempt constructs, when a case builds a real one.
   *
   * Reached in the same place and the same scope as `provider` above, so a case
   * that constructs the actual native provider is exercising the construction
   * the engine joins rather than a copy of it.
   */
  readonly construct?: () => Operation<GitHostProvider>;
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
      if (options.construct !== undefined) {
        return yield* options.construct();
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

/** Let every ready task run, so "reached its wait" is about turns. */
function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
}

/**
 * A promise a case releases by hand.
 *
 * What makes these cuts deterministic rather than a race: an acquisition is
 * started, the halt is delivered while it is demonstrably still pending, and
 * only then is it allowed to deliver.
 */
function gate(): { readonly released: Promise<void>; release(): void } {
  let open = (): void => {};
  const released = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { released, release: () => open() };
}

/** A script that reports it ran and then waits, holding its pipes open. */
function* waitingScript(path: string, marker: string): Operation<void> {
  yield* writeTextFile(path, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nsleep 120\n`);
  yield* until(chmod(path, 0o755));
}

/** Wait until this path is there, or say what never appeared. */
function* appears(path: string): Operation<void> {
  const deadline = Date.now() + 30_000;
  while (!(yield* exists(path))) {
    if (Date.now() > deadline) {
      throw new Error(`${path} never appeared`);
    }
    yield* sleep(25);
  }
}

/** What a watched `git` child reported about its own lifetime. */
interface WatchedChildren {
  readonly spawned: Operation<void>;
  readonly observe: NonNullable<GitInvocation["observe"]>;
  observed(): number;
  closed(): boolean;
  alive(): boolean;
}

/** Watch the real children one invocation spawns. */
function watchChildren(): WatchedChildren {
  const pids: number[] = [];
  let count = 0;
  let closes = 0;
  const first = withResolvers<void>();
  return {
    spawned: first.operation,
    observe(child): void {
      count += 1;
      if (child.pid !== undefined) {
        pids.push(child.pid);
      }
      child.on("close", () => {
        closes += 1;
      });
      first.resolve();
    },
    observed: () => count,
    closed: () => count > 0 && closes === count,
    alive: () =>
      pids.some((pid) => {
        try {
          // Signal 0 asks the operating system whether the process is there.
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
  };
}

/**
 * The request the real Push provider admits, from one publication's inputs.
 *
 * The suite's own `PUSH` constant is a generic effect request: the real
 * provider re-admits what it is handed and refuses anything that is not its
 * own, so a case driving the actual provider has to state the real thing.
 */
function pushRequest(branch: string, commit: string): GitHostEffectRequest {
  const inputs = pushInputs(branch, commit);
  return Object.freeze({
    kind: GIT_PUSH,
    inputs: gitPushInputsJson(inputs),
    naturalKey: gitPushNaturalKeyJson({
      repository: inputs.repository,
      remote: inputs.remote,
      destinationRef: inputs.destinationRef,
    }),
  });
}

/** One publication's inputs against a real bare remote. */
function pushInputs(branch: string, commit: string): GitPushInputs {
  return Object.freeze({
    repository: {
      name: "project",
      locatorFingerprint: "a".repeat(64),
      requestedBase: null,
      creationCommit: commit,
      primaryBranch: "main",
      objectFormat: "sha1" as const,
    },
    remote: "origin",
    branch,
    destinationRef: `refs/heads/${branch}`,
    sourceCommit: commit,
  });
}

/**
 * What a cancelled attempt does to the resources its own provider acquired.
 *
 * These four windows live inside `pushProvider`: the scratch repository it
 * opens over the checkout's object database, and the credential session it
 * opens for the destination. Neither is reachable from above — the published
 * handle answers with two phases and nothing else, which is the whole point of
 * that boundary — so each case builds the *same* handle this package's public
 * factory builds, over a host whose leaves it can hold, and reconciles through
 * the real engine so the teardown it watches is the one publication waits for.
 *
 * The generic attempt-resource controls above (OW6, OW7) prove that a held
 * cleanup holds publication and that a failing cleanup publishes nothing. They
 * say nothing about which resource, when it was asked for, or whether a
 * delivery that arrived after cancellation began was released — which is what
 * these four are.
 */
describe("Tier OW — what a cancelled owned attempt's own native resources do", () => {
  it("OW12: waits for a pending scratch delivery, then removes what arrived", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const checkout = yield* useHostCheckout(remote.locator);
    const head = checkout.run("rev-parse", "HEAD").trim();
    const common = checkout.run("rev-parse", "--path-format=absolute", "--git-common-dir").trim();

    const made: string[] = [];
    const asked = withResolvers<void>();
    const held = gate();
    // Armed before anything waits on it, so an assertion that fails below
    // cannot leave the attempt stranded in a delivery nobody releases.
    yield* ensure(() => held.release());
    const create = (prefix: string): Promise<string> => {
      asked.resolve();
      return held.released
        .then(() => mkdtemp(prefix))
        .then((directory) => {
          made.push(directory);
          return directory;
        });
    };
    const host = denoRepositoryHost({ directories: { create } });

    const stream = new InMemoryStream();
    const seen = attempt();
    let returned = false;
    yield* scoped(function* (): Operation<void> {
      const running = yield* spawn(() =>
        runOwned({
          stream,
          seen,
          request: pushRequest("ow12", head),
          *construct(): Operation<GitHostProvider> {
            const operations = yield* repositoryOperationsOver(host);
            return yield* operations.pushProvider(common, remote.locator, pushInputs("ow12", head));
          },
        }),
      );
      yield* asked.operation;
      // The window: the provider asked for its scratch space and has not been
      // handed one, so nothing has been observed and nothing published.
      expect(made).toEqual([]);
      expect(gitHostYields(stream.snapshot())).toEqual([]);

      const halting = yield* spawn(function* (): Operation<void> {
        yield* running.halt();
        returned = true;
      });
      yield* settled();
      // Teardown is waiting for the acquisition it armed its release before:
      // nothing delivered, and the halt has not come back.
      expect(returned).toBe(false);
      expect(made).toEqual([]);

      held.release();
      yield* halting;
    });

    // It waited for the delivery and removed exactly what arrived.
    expect(returned).toBe(true);
    expect(made).toHaveLength(1);
    expect(yield* exists(made[0] ?? "")).toBe(false);
    // And nothing was published for the publication it never finished.
    expect(gitHostYields(stream.snapshot())).toEqual([]);
    expect(seen.records).toEqual([]);
  });

  it("OW13: removes a scratch space the attempt had already received", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const checkout = yield* useHostCheckout(remote.locator);
    const head = checkout.run("rev-parse", "HEAD").trim();
    const common = checkout.run("rev-parse", "--path-format=absolute", "--git-common-dir").trim();

    const delivered: string[] = [];
    const built = withResolvers<void>();
    const create = (prefix: string): Promise<string> =>
      mkdtemp(prefix).then((directory) => {
        delivered.push(directory);
        return directory;
      });
    const host = denoRepositoryHost({ directories: { create } });

    const stream = new InMemoryStream();
    const seen = attempt();
    yield* scoped(function* (): Operation<void> {
      const running = yield* spawn(() =>
        runOwned({
          stream,
          seen,
          request: pushRequest("ow13", head),
          *construct(): Operation<GitHostProvider> {
            const operations = yield* repositoryOperationsOver(host);
            const provider = yield* operations.pushProvider(
              common,
              remote.locator,
              pushInputs("ow13", head),
            );
            // The other half of OW12's distinction: the scratch space has been
            // delivered and the provider exists, and the cut lands here —
            // before anything is observed, so what the halt releases is a
            // resource the attempt already held rather than one it was owed.
            built.resolve();
            yield* suspend();
            return provider;
          },
        }),
      );
      yield* built.operation;
      // The positive control: a scratch space really was delivered, and it is
      // on disk at the moment of the cut.
      expect(delivered).toHaveLength(1);
      expect(yield* exists(delivered[0] ?? "")).toBe(true);
      yield* running.halt();
    });

    // Gone with the attempt, and nothing invented for the publication.
    expect(yield* exists(delivered[0] ?? "")).toBe(false);
    expect(gitHostYields(stream.snapshot())).toEqual([]);
    expect(seen.records).toEqual([]);
  });

  it("OW14: releases a credential session delivered after cancellation began", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const checkout = yield* useHostCheckout(remote.locator);
    const head = checkout.run("rev-parse", "HEAD").trim();
    const common = checkout.run("rev-parse", "--path-format=absolute", "--git-common-dir").trim();

    const opened: string[] = [];
    const held = withResolvers<GitAuthenticationSession>();
    const reached = withResolvers<void>();
    const cleaning = withResolvers<void>();
    const session = { delivered: false, released: false };
    yield* ensure(() => held.resolve(UNAUTHENTICATED));

    const inner = denoRepositoryHost();
    const host: RepositoryHost = {
      ...inner,
      useAuthentication(locator: string): Operation<GitAuthenticationSession> {
        opened.push(locator);
        return resource<GitAuthenticationSession>(function* (provide) {
          // Registered before the pending acquisition is announced, because the
          // halt below is started off that announcement: an `ensure` yielded
          // afterwards registers nothing on a scope already unwinding, and the
          // cancellation would reach an acquisition with no cleanup on it. It
          // suspends, so it is an `ensure` and not a `finally` — a `finally`
          // that yields takes the frame out of return-mode mid-teardown.
          yield* ensure(function* (): Operation<void> {
            cleaning.resolve();
            // The same delivery the cancelled acquisition was owed. A settled
            // resolver answers every later read, so what this attempt was owed
            // arrives here instead of at the initializer the halt unwound.
            yield* held.operation;
            session.released = true;
          });
          reached.resolve();
          yield* provide(yield* held.operation);
        });
      },
    };

    const stream = new InMemoryStream();
    const seen = attempt();
    let returned = false;
    yield* scoped(function* (): Operation<void> {
      const running = yield* spawn(() =>
        runOwned({
          stream,
          seen,
          request: pushRequest("ow14", head),
          *construct(): Operation<GitHostProvider> {
            const operations = yield* repositoryOperationsOver(host);
            return yield* operations.pushProvider(common, remote.locator, pushInputs("ow14", head));
          },
        }),
      );
      // Raced against the attempt finishing, so an attempt that never asked
      // for a credential is a diagnosis here rather than a hang.
      yield* race([
        reached.operation,
        (function* (): Operation<never> {
          yield* running;
          throw new Error(
            `the attempt settled without opening a session: ${seen.failures
              .map((one) => String(one))
              .join(" | ")}`,
          );
        })(),
      ]);
      const halting = yield* spawn(function* (): Operation<void> {
        yield* running.halt();
        returned = true;
      });
      try {
        // Ordered by acknowledgement and nothing else: until the cleanup says
        // it started, nothing proves the cancellation reached the acquisition
        // this delivery is owed to.
        yield* cleaning.operation;
        expect(session.delivered).toBe(false);
        expect(session.released).toBe(false);
        expect(returned).toBe(false);
      } finally {
        // External arrival, from this case rather than from the acquisition the
        // halt unwound. In a `finally` with no yield in it, so an assertion
        // that failed above leaves the joined cleanup nothing to wait for.
        session.delivered = true;
        held.resolve(UNAUTHENTICATED);
      }
      yield* halting;
    });

    // The session was opened for the exact destination this publication names,
    // the delivery it was still owed arrived after its own cleanup had started,
    // that cleanup released it, and only then did the halt return.
    expect(new Set(opened)).toEqual(new Set([remote.locator]));
    expect(session.delivered).toBe(true);
    expect(session.released).toBe(true);
    expect(returned).toBe(true);
    expect(gitHostYields(stream.snapshot())).toEqual([]);
    expect(seen.records).toEqual([]);
  });

  it("OW15: joins the running child its own observation spawned", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const checkout = yield* useHostCheckout(remote.locator);
    const head = checkout.run("rev-parse", "HEAD").trim();
    const common = checkout.run("rev-parse", "--path-format=absolute", "--git-common-dir").trim();

    const home = yield* useTempDirectory("xmd-owned-child-");
    const marker = join(home, "upload-pack-ran");
    const script = join(home, "slow-upload-pack");
    yield* waitingScript(script, marker);
    const watched = watchChildren();

    // The first remote contact a publication makes is an exact observation of
    // the destination. Against a local remote that spawns an upload-pack, and a
    // program that reports it ran and then waits is a child holding the pipes
    // this process inherited.
    const inner = denoRepositoryHost();
    const host: RepositoryHost = {
      ...inner,
      *git(invocation: GitInvocation): Operation<GitOutcome> {
        if (invocation.args.includes("ls-remote")) {
          return yield* inner.git({
            ...invocation,
            args: [
              "ls-remote",
              `--upload-pack=${script}`,
              ...invocation.args.slice(invocation.args.indexOf("ls-remote") + 1),
            ],
            observe: watched.observe,
          });
        }
        return yield* inner.git(invocation);
      },
    };

    const stream = new InMemoryStream();
    const seen = attempt();
    yield* scoped(function* (): Operation<void> {
      const running = yield* spawn(() =>
        runOwned({
          stream,
          seen,
          request: pushRequest("ow15", head),
          *construct(): Operation<GitHostProvider> {
            const operations = yield* repositoryOperationsOver(host);
            return yield* operations.pushProvider(common, remote.locator, pushInputs("ow15", head));
          },
        }),
      );
      yield* watched.spawned;
      // Not merely spawned: inside its own transport, with a descendant of its
      // own waiting. Halting before that would interrupt a command which had
      // done nothing, which is the hole this row closes.
      yield* appears(marker);
      // The guard against a vacuous row: a child that had already ended would
      // make everything below true without anything being interrupted.
      expect(watched.closed()).toBe(false);
      yield* running.halt();
    });

    // The child this attempt's own observation started closed before the
    // attempt settled, and no outcome was invented for it.
    expect(watched.observed() > 0).toBe(true);
    expect(watched.closed()).toBe(true);
    expect(watched.alive()).toBe(false);
    expect(gitHostYields(stream.snapshot())).toEqual([]);
    expect(seen.records).toEqual([]);
  });
});
