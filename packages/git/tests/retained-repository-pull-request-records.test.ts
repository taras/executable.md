/**
 * Tier RPR — what a REPL entry's saved pull-request request says, what a
 * history holding one beside its publications is allowed to look like, and
 * whose retained evidence reads are whose.
 *
 * Three boundaries, all provider-neutral and all pure. The **codec** decides
 * what a saved request is: the shape, the closed origin grammar, and the facts
 * the three readings of one question have to agree about. The **coordinated
 * admission** decides whether a whole history may be continued now that two
 * external protocols settle through one durable type — which is the part that
 * could not be answered by either protocol alone. The **read admission**
 * decides whose retained collection a record describes, which a name that
 * deliberately omits the owner cannot say.
 *
 * Nothing here opens a checkout, resolves a path or contacts anything, because
 * none of these boundaries may: a continuation whose managed worktree was
 * deleted while the person was away answers from what it already wrote down.
 *
 * These cases carry V6 of the delivery-5 matrix, the ordering consequence V2
 * states, and the request half of V3's trailing-request history.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok } from "effection";
import type { Operation } from "effection";
import { serializeError } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import {
  destinationRefFor,
  gitPushObservationsJson,
  gitPushPreStateJson,
  gitPushResultJson,
  PUSH_REMOTE,
  refspecFor,
  type GitPushInputs,
} from "../src/composition/git-push-records.ts";
import { locatorFingerprint } from "../src/deno/composition/locator.ts";
import {
  createReplPublicationMemory,
  type RankedReplPublication,
  type ReplPublicationMemory,
} from "../src/retained-repository/publication-evidence.ts";
import { PullRequestAdmissionError } from "../src/composition/errors.ts";
import type { RepositoryIdentity } from "../src/composition/selection.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect-type.ts";
import {
  gitHostReconciliationRecordJson,
  gitHostRequestFingerprint,
} from "../src/git-host/records.ts";
import type { PullRequestInput } from "@executablemd/git/api";
import {
  pullRequestInputsJson,
  pullRequestNaturalKey,
  pullRequestNaturalKeyJson,
  pullRequestResultJson,
  pullRequestSnapshotJson,
  type PullRequestInputs,
  type PullRequestSnapshot,
} from "../src/composition/pull-request-records.ts";
import {
  admitReplPushHistory,
  replPullRequestOutcomeName,
  replPushEffectRequest,
  replPushOutcomeName,
  ReplPushHistoryError,
  type ReplPushPlacement,
} from "../src/retained-repository/push-admission.ts";
import {
  parseReplPullRequestRequestRecord,
  replPullRequestRequestJson,
  replPullRequestRequestName,
  REPL_REPOSITORY_PULL_REQUEST_REQUEST,
  sameReplPullRequestAsk,
  type ReplPullRequestAsk,
  type ReplPullRequestRequestRecord,
} from "../src/retained-repository/pull-request-records.ts";
import {
  replPushRequestJson,
  replPushRequestName,
  REPL_REPOSITORY_PUSH_REQUEST,
  type ReplPushPlace,
  type ReplPushRequestRecord,
} from "../src/retained-repository/push-records.ts";
import { parseReplPushRequestRecord } from "../src/retained-repository/push-records.ts";
import {
  admitReplPullRequestReadRequest,
  admitReplPullRequestReadResult,
  ReplPullRequestReadHistoryError,
} from "../src/retained-repository/pull-request-read-admission.ts";
import {
  pullRequestReadRequestJson,
  readRequest,
} from "../src/composition/pull-request-read-records.ts";
import {
  replPlacementFingerprint,
  replPlacementRecordJson,
  replPlacementRecordName,
  REPL_REPOSITORY_PLACEMENT,
  type ReplPlacement,
} from "../src/retained-repository/placement-records.ts";

const OWNER = '["executablemd.repl.issue-owner",1,"execution-5","entry-1"]';
const OTHER_OWNER = '["executablemd.repl.issue-owner",1,"execution-5","entry-2"]';
const SITE = "expansion-9c1";
const PUSH_SITE = "expansion-4b2";

const ORIGIN = "/srv/remotes/project.git";
const CHECKOUT = "/home/dev/.xmd/repositories/project/checkout";
const COMMON = "/home/dev/.xmd/repositories/project/checkout/.git";
const BRANCH = "review/notes";
const HEAD = "9fceb02d8c5a1b4e7f03a6d9c2b8e5174a0f3b6d";
const MOVED_HEAD = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const BASE_SHA = "beefcafe00000000000000000000000000000001";
const URL = "https://github.com/octo/project/pull/7";

const IDENTITY: RepositoryIdentity = Object.freeze({
  name: "project",
  locatorFingerprint: locatorFingerprint(ORIGIN),
  requestedBase: null,
  creationCommit: "c0ffee00000000000000000000000000deadbeef",
  primaryBranch: "main",
  objectFormat: "sha1",
});

const PLACE: ReplPushPlace = Object.freeze({
  repository: IDENTITY,
  selectionCheckout: CHECKOUT,
  commonDirectory: COMMON,
  workingDirectory: CHECKOUT,
});

const AUTHORED: PullRequestInput = Object.freeze({
  number: null,
  title: "Prepare notes",
  body: "Ready for review.",
  draft: false,
  base: "main",
});

const ASK: ReplPullRequestAsk = Object.freeze({ pullRequest: AUTHORED, place: PLACE });

const INPUTS: PullRequestInputs = Object.freeze({
  repository: IDENTITY,
  number: null,
  title: AUTHORED.title,
  body: AUTHORED.body,
  draft: AUTHORED.draft,
  headBranch: BRANCH,
  headSha: HEAD,
  baseBranch: AUTHORED.base,
});

const PUSH_INPUTS: GitPushInputs = Object.freeze({
  repository: IDENTITY,
  remote: PUSH_REMOTE,
  branch: BRANCH,
  destinationRef: destinationRefFor(BRANCH),
  sourceCommit: HEAD,
});

const HELD: readonly ReplPushPlacement[] = [
  { identity: IDENTITY, checkoutRoot: CHECKOUT, commonDirectory: COMMON },
];

const PLACEMENT: ReplPlacement = Object.freeze({
  kind: "repository",
  managedRoot: "/home/dev/.xmd/repositories",
  checkoutRoot: CHECKOUT,
  commonDirectory: COMMON,
  identity: IDENTITY,
  displayName: "project",
  ownerCheckout: CHECKOUT,
});

const SNAPSHOT: PullRequestSnapshot = Object.freeze({
  providerId: "PR_kwDO",
  number: 7,
  url: URL,
  state: "open",
  title: AUTHORED.title,
  body: AUTHORED.body,
  draft: AUTHORED.draft,
  headBranch: BRANCH,
  headSha: HEAD,
  baseBranch: AUTHORED.base,
  baseSha: BASE_SHA,
});

/** One saved pull-request request, with whatever a case wants different. */
function request(
  overrides: {
    readonly owner?: string;
    readonly site?: string;
    readonly requested?: ReplPullRequestAsk;
    readonly received?: ReplPullRequestAsk;
    readonly resolved?: {
      readonly checkoutRoot?: string;
      readonly commonDirectory?: string;
      readonly origin?: string;
      readonly inputs?: PullRequestInputs;
    };
  } = {},
): Json {
  return replPullRequestRequestJson({
    owner: overrides.owner ?? OWNER,
    site: overrides.site ?? SITE,
    requested: overrides.requested ?? ASK,
    received: overrides.received ?? ASK,
    resolved: {
      checkoutRoot: overrides.resolved?.checkoutRoot ?? CHECKOUT,
      commonDirectory: overrides.resolved?.commonDirectory ?? COMMON,
      origin: overrides.resolved?.origin ?? ORIGIN,
      inputs: overrides.resolved?.inputs ?? INPUTS,
    },
  });
}

function parsed(payload: Json): ReplPullRequestRequestRecord {
  const record = parseReplPullRequestRequestRecord(payload);
  if (record === undefined) {
    throw new Error("the saved pull-request request this case builds does not parse");
  }
  return record;
}

/** The journal event one written pull-request request is held by. */
function* requestEvent(
  payload: Json,
  options: { readonly coroutineId?: string; readonly name?: string } = {},
): Operation<DurableEvent> {
  const record = parseReplPullRequestRequestRecord(payload);
  const name =
    options.name ??
    (record === undefined ? "unreadable" : yield* replPullRequestRequestName(record));
  return {
    type: "yield",
    coroutineId: options.coroutineId ?? "root",
    description: { type: REPL_REPOSITORY_PULL_REQUEST_REQUEST, name },
    result: { status: "ok", value: payload },
  };
}

/** One saved publication request, as the pull request's authority rests on it. */
function* pushRequestEvent(
  options: {
    readonly coroutineId?: string;
    readonly site?: string;
    readonly inputs?: GitPushInputs;
  } = {},
): Operation<{ readonly event: DurableEvent; readonly record: ReplPushRequestRecord }> {
  const payload = replPushRequestJson({
    owner: OWNER,
    site: options.site ?? PUSH_SITE,
    requested: PLACE,
    received: PLACE,
    resolved: {
      checkoutRoot: CHECKOUT,
      commonDirectory: COMMON,
      origin: ORIGIN,
      inputs: options.inputs ?? PUSH_INPUTS,
    },
  });
  const record = parseReplPushRequestRecord(payload);
  if (record === undefined) {
    throw new Error("the saved publication request this case builds does not parse");
  }
  return {
    record,
    event: {
      type: "yield",
      coroutineId: options.coroutineId ?? "root",
      description: {
        type: REPL_REPOSITORY_PUSH_REQUEST,
        name: yield* replPushRequestName(record),
      },
      result: { status: "ok", value: payload },
    },
  };
}

/** The successful publication outcome one saved publication request produces. */
function* pushOutcomeEvent(
  record: ReplPushRequestRecord,
  options: { readonly coroutineId?: string } = {},
): Operation<DurableEvent> {
  const inputs = record.resolved.inputs;
  const complete = {
    identity: { runId: record.owner, expansionId: record.site },
    ...replPushEffectRequest(inputs),
  };
  return {
    type: "yield",
    coroutineId: options.coroutineId ?? "root",
    description: {
      type: GIT_HOST_EFFECT,
      name: yield* gitHostRequestFingerprint(complete),
    },
    result: {
      status: "ok",
      value: gitHostReconciliationRecordJson({
        request: {
          identity: complete.identity,
          kind: complete.kind,
          inputs: complete.inputs,
          naturalKey: complete.naturalKey,
        },
        preState: gitPushPreStateJson({ remoteCommit: null }),
        observations: gitPushObservationsJson({ remoteCommit: inputs.sourceCommit }),
        decision: "performed",
        result: gitPushResultJson({
          repository: inputs.repository,
          remote: inputs.remote,
          branch: inputs.branch,
          destinationRef: inputs.destinationRef,
          refspec: refspecFor(inputs.sourceCommit, inputs.destinationRef),
          sourceCommit: inputs.sourceCommit,
          observedRemoteCommit: inputs.sourceCommit,
        }),
      }),
    },
  };
}

/** The successful upsert outcome one saved pull-request request produces. */
function* pullRequestOutcomeEvent(
  record: ReplPullRequestRequestRecord,
  options: {
    readonly coroutineId?: string;
    readonly name?: string;
    readonly inputs?: PullRequestInputs;
    readonly kind?: string;
    readonly naturalKey?: Json;
    readonly snapshot?: PullRequestSnapshot;
    readonly runId?: string;
    readonly expansionId?: string;
  } = {},
): Operation<DurableEvent> {
  const inputs = options.inputs ?? record.resolved.inputs;
  const snapshot = options.snapshot ?? SNAPSHOT;
  const identity = {
    runId: options.runId ?? record.owner,
    expansionId: options.expansionId ?? record.site,
  };
  const complete = {
    identity,
    kind: options.kind ?? "pull-request",
    inputs: pullRequestInputsJson(inputs),
    naturalKey: options.naturalKey ?? pullRequestNaturalKeyJson(pullRequestNaturalKey(inputs)),
  };
  return {
    type: "yield",
    coroutineId: options.coroutineId ?? "root",
    description: {
      type: GIT_HOST_EFFECT,
      name: options.name ?? (yield* gitHostRequestFingerprint(complete)),
    },
    result: {
      status: "ok",
      value: gitHostReconciliationRecordJson({
        request: complete,
        preState: { pullRequest: null },
        observations: { pullRequest: pullRequestSnapshotJson(snapshot) },
        decision: "performed",
        result: pullRequestResultJson({
          repository: inputs.repository,
          providerId: snapshot.providerId,
          number: snapshot.number,
          url: snapshot.url,
          state: "open",
          headSha: snapshot.headSha,
          baseSha: snapshot.baseSha,
        }),
      }),
    },
  };
}

/** The failed Git-host outcome a refused upsert leaves. */
function* refusedEvent(
  name: string,
  journaled: string,
  options: { readonly coroutineId?: string } = {},
): Operation<DurableEvent> {
  const failure = new Error("refused");
  failure.name = name;
  return {
    type: "yield",
    coroutineId: options.coroutineId ?? "root",
    description: { type: GIT_HOST_EFFECT, name: journaled },
    result: { status: "err", error: serializeError(failure) },
  };
}

/** The placement record a selection of this checkout leaves behind. */
function* placementEvent(): Operation<DurableEvent> {
  const selection = {
    kind: "repository" as const,
    name: PLACEMENT.displayName,
    locatorFingerprint: PLACEMENT.identity.locatorFingerprint,
    base: null,
  };
  const fingerprint = yield* replPlacementFingerprint(selection);
  return {
    type: "yield",
    coroutineId: "root",
    description: {
      type: REPL_REPOSITORY_PLACEMENT,
      name: replPlacementRecordName({ kind: "repository", fingerprint }),
    },
    result: {
      status: "ok",
      value: replPlacementRecordJson({ fingerprint, request: selection, outcome: Ok(PLACEMENT) }),
    },
  };
}

/** One history that published this head and then opened its pull request. */
function* published(
  options: { readonly inputs?: GitPushInputs } = {},
): Operation<readonly DurableEvent[]> {
  const push = yield* pushRequestEvent(options);
  return [yield* placementEvent(), push.event, yield* pushOutcomeEvent(push.record)];
}

/** What admitting this history refused, or `undefined` when it admitted it. */
function* refusalOf(events: readonly DurableEvent[]): Operation<ReplPushHistoryError | undefined> {
  try {
    yield* admitReplPushHistory(OWNER, events);
    return undefined;
  } catch (error) {
    if (error instanceof ReplPushHistoryError) {
      return error;
    }
    throw error;
  }
}

describe("Tier RPR — a REPL entry's saved pull-request request", () => {
  it("RPR1: holds the question, the received reading and what routing resolved", function* () {
    const record = parsed(request());
    expect(record.version).toBe(1);
    expect(record.owner).toBe(OWNER);
    expect(record.site).toBe(SITE);
    expect(record.requested.pullRequest).toEqual(AUTHORED);
    expect(record.requested.place.workingDirectory).toBe(CHECKOUT);
    expect(record.resolved.origin).toBe(ORIGIN);
    // The answer pins what the question could not say: the branch this head is
    // on, the commit it was at, and the base it is going to.
    expect(record.resolved.inputs.headBranch).toBe(BRANCH);
    expect(record.resolved.inputs.headSha).toBe(HEAD);
    expect(record.resolved.inputs.baseBranch).toBe("main");
  });

  it("RPR2: the name covers the question alone, and every member of it", function* () {
    const base = yield* replPullRequestRequestName({ owner: OWNER, site: SITE, requested: ASK });

    // The answer takes no part in it: a request resolved against another head
    // is the same question and keeps the same name, which is what lets a
    // continuation find it after HEAD has moved.
    expect(
      yield* replPullRequestRequestName({
        owner: OWNER,
        site: SITE,
        requested: ASK,
      }),
    ).toBe(base);

    for (const differing of [
      { owner: OTHER_OWNER, site: SITE, requested: ASK },
      { owner: OWNER, site: "expansion-other", requested: ASK },
      {
        owner: OWNER,
        site: SITE,
        requested: { ...ASK, pullRequest: { ...AUTHORED, title: "Other" } },
      },
      {
        owner: OWNER,
        site: SITE,
        requested: { ...ASK, pullRequest: { ...AUTHORED, body: "Other body" } },
      },
      {
        owner: OWNER,
        site: SITE,
        requested: { ...ASK, pullRequest: { ...AUTHORED, draft: true } },
      },
      {
        owner: OWNER,
        site: SITE,
        requested: { ...ASK, pullRequest: { ...AUTHORED, base: "release" } },
      },
      {
        owner: OWNER,
        site: SITE,
        requested: { ...ASK, pullRequest: { ...AUTHORED, number: 7 } },
      },
      {
        owner: OWNER,
        site: SITE,
        requested: { ...ASK, place: { ...PLACE, workingDirectory: `${CHECKOUT}/docs` } },
      },
    ]) {
      expect(yield* replPullRequestRequestName(differing)).not.toBe(base);
    }
  });

  it("RPR3: one name vector keeps the canonical-JSON digest, including odd text", function* () {
    // A null number, text outside ASCII and an unpaired surrogate are all
    // values a document can write and this record can carry. The vector pins
    // the algorithm rather than describing it: a change to the prefix, the
    // version, the member order or the digest moves it.
    const odd: ReplPullRequestAsk = {
      pullRequest: {
        number: null,
        title: "Préparer les notes \u{1F600}",
        body: "lone \ud800 surrogate",
        draft: true,
        base: "main",
      },
      place: PLACE,
    };
    const name = yield* replPullRequestRequestName({ owner: OWNER, site: SITE, requested: odd });
    expect(name).toMatch(/^[0-9a-f]{64}$/);
    // And it is not the publication request's name for the same place, because
    // the two prefixes differ: one record type cannot be mistaken for the other.
    const push = yield* replPushRequestName({ owner: OWNER, site: SITE, requested: PLACE });
    expect(name).not.toBe(push);
  });

  it("RPR4: refuses an unknown version, a hostile value and a missing member", function* () {
    expect(
      parseReplPullRequestRequestRecord({ ...(request() as object), version: 2 }),
    ).toBeUndefined();
    expect(parseReplPullRequestRequestRecord(undefined)).toBeUndefined();
    expect(parseReplPullRequestRequestRecord("a request")).toBeUndefined();

    const extra = { ...(request() as Record<string, Json>), surplus: true };
    expect(parseReplPullRequestRequestRecord(extra)).toBeUndefined();

    for (const member of ["version", "owner", "site", "requested", "received", "resolved"]) {
      const missing = { ...(request() as Record<string, Json>) };
      delete missing[member];
      expect(parseReplPullRequestRequestRecord(missing)).toBeUndefined();
    }

    // A getter that throws is the value's own refusal, and answering it with a
    // refusal is what keeps an untrusted value from carrying its text out.
    const hostile = {
      ...(request() as Record<string, Json>),
      get requested(): Json {
        throw new Error("hostile");
      },
    };
    expect(parseReplPullRequestRequestRecord(hostile)).toBeUndefined();
  });

  it("RPR5: refuses an origin this host would not hand to Git", function* () {
    expect(
      parseReplPullRequestRequestRecord(
        request({ resolved: { origin: "https://user:token@example.com/p.git" } }),
      ),
    ).toBeUndefined();
  });

  it("RPR6: refuses resolved inputs that do not answer the received question", function* () {
    // Each of the five authored fields has to survive resolution. A saved
    // request whose resolved title, body, draft, number or base is not the one
    // that was received describes a pull request the document never authored.
    for (const drifted of [
      { ...INPUTS, title: "Other" },
      { ...INPUTS, body: "Other body" },
      { ...INPUTS, draft: true },
      { ...INPUTS, number: 7 },
      { ...INPUTS, baseBranch: "release" },
    ]) {
      expect(
        parseReplPullRequestRequestRecord(request({ resolved: { inputs: drifted } })),
      ).toBeUndefined();
    }
  });

  it("RPR7: refuses inputs that do not belong to the Repository the dispatch received", function* () {
    const foreign: RepositoryIdentity = { ...IDENTITY, name: "other" };
    expect(
      parseReplPullRequestRequestRecord(
        request({ resolved: { inputs: { ...INPUTS, repository: foreign } } }),
      ),
    ).toBeUndefined();
  });

  it("RPR8: both object-id formats round-trip", function* () {
    const sha256 = "a".repeat(64);
    const identity: RepositoryIdentity = {
      ...IDENTITY,
      objectFormat: "sha256",
      creationCommit: "b".repeat(64),
    };
    const place: ReplPushPlace = { ...PLACE, repository: identity };
    const ask: ReplPullRequestAsk = { pullRequest: AUTHORED, place };
    const record = parsed(
      request({
        requested: ask,
        received: ask,
        resolved: { inputs: { ...INPUTS, repository: identity, headSha: sha256 } },
      }),
    );
    expect(record.resolved.inputs.headSha).toBe(sha256);
    expect(sameReplPullRequestAsk(record.requested, ask)).toBe(true);
  });
});

describe("Tier RPR — admitting a history that published and then opened", () => {
  it("RPR9: admits a pull request its own publication authorized, and one still pending", function* () {
    const prefix = yield* published();
    const payload = request();
    const record = parsed(payload);
    const complete = [
      ...prefix,
      yield* requestEvent(payload),
      yield* pullRequestOutcomeEvent(record),
    ];
    expect(yield* refusalOf(complete)).toBeUndefined();

    // A request with no outcome after it is the window this whole feature
    // exists for, so it is admitted rather than refused.
    expect(yield* refusalOf([...prefix, yield* requestEvent(payload)])).toBeUndefined();
  });

  it("RPR10: refuses a pull request no publication of this entry's authorized", function* () {
    const payload = request();
    // The placement is there, so the places are held; what is missing is the
    // publication itself.
    const unpublished = [yield* placementEvent(), yield* requestEvent(payload)];
    expect((yield* refusalOf(unpublished))?.reason).toBe("unauthorized-pull-request");

    // A publication of the same branch at another commit does not authorize
    // this head either, which is the conflicting category.
    const moved = yield* published({ inputs: { ...PUSH_INPUTS, sourceCommit: MOVED_HEAD } });
    expect((yield* refusalOf([...moved, yield* requestEvent(payload)]))?.reason).toBe(
      "unauthorized-pull-request",
    );
  });

  it("RPR11: the last relevant publication decides, not an earlier exact one", function* () {
    // A publishes this head, then B publishes the same branch at another
    // commit. The branch holds B, so a pull request naming this head is no
    // longer authorized even though an exact publication of it is in history.
    const first = yield* pushRequestEvent({ site: "expansion-a" });
    const second = yield* pushRequestEvent({
      site: "expansion-b",
      inputs: { ...PUSH_INPUTS, sourceCommit: MOVED_HEAD },
    });
    const superseded = [
      yield* placementEvent(),
      first.event,
      yield* pushOutcomeEvent(first.record),
      second.event,
      yield* pushOutcomeEvent(second.record),
      yield* requestEvent(request()),
    ];
    expect((yield* refusalOf(superseded))?.reason).toBe("unauthorized-pull-request");

    // The other way round, the later publication is the one that authorizes.
    const movedFirst = yield* pushRequestEvent({
      site: "expansion-a",
      inputs: { ...PUSH_INPUTS, sourceCommit: MOVED_HEAD },
    });
    const headSecond = yield* pushRequestEvent({ site: "expansion-b" });
    const current = [
      yield* placementEvent(),
      movedFirst.event,
      yield* pushOutcomeEvent(movedFirst.record),
      headSecond.event,
      yield* pushOutcomeEvent(headSecond.record),
      yield* requestEvent(request()),
    ];
    expect(yield* refusalOf(current)).toBeUndefined();
  });

  it("RPR12: refuses a request that is misnamed, foreign or unplaced", function* () {
    const prefix = yield* published();

    expect(
      (yield* refusalOf([...prefix, yield* requestEvent(request(), { name: "not-its-name" })]))
        ?.reason,
    ).toBe("request-fingerprint");

    expect(
      (yield* refusalOf([...prefix, yield* requestEvent(request({ owner: OTHER_OWNER }))]))?.reason,
    ).toBe("foreign-owner");

    // No placement before it, so the history does not say where the pull
    // request came from. The publication prefix is dropped with it, so the
    // placement question is the one that answers first.
    const push = yield* pushRequestEvent();
    expect((yield* refusalOf([push.event, yield* pushOutcomeEvent(push.record)]))?.reason).toBe(
      "unknown-placement",
    );
  });

  it("RPR13: refuses an unknown version before anything else about the record", function* () {
    const prefix = yield* published();
    const stated = { ...(request() as object), version: 2 };
    const event: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: REPL_REPOSITORY_PULL_REQUEST_REQUEST, name: "whatever" },
      result: { status: "ok", value: stated as Json },
    };
    expect((yield* refusalOf([...prefix, event]))?.reason).toBe("unknown-version");
  });

  it("RPR14: pairs one failed upsert with the request before it, by that request's own name", function* () {
    const prefix = yield* published();
    const payload = request();
    const record = parsed(payload);
    const expected = yield* replPullRequestOutcomeName(record);

    // The three words the shared protocol may refuse under. A failed envelope
    // names no kind, so what says this refusal is a pull request's and not a
    // publication's is the request standing before it and that request's own
    // expected worker name.
    for (const name of [
      "GitHostConflictError",
      "GitHostAmbiguousError",
      "GitHostUnavailableError",
    ]) {
      const history = [
        ...prefix,
        yield* requestEvent(payload),
        yield* refusedEvent(name, expected),
      ];
      expect(yield* refusalOf(history)).toBeUndefined();
    }

    // A word this host has no vocabulary for says nothing it can act on.
    const unknown = [
      ...prefix,
      yield* requestEvent(payload),
      yield* refusedEvent("SomethingElseError", expected),
    ];
    expect((yield* refusalOf(unknown))?.reason).toBe("malformed-receipt");

    // And a refusal journaled under the publication's name rather than the
    // pull request's does not answer the request before it. This is the case a
    // Push-only classifier got wrong: it would have checked this failure
    // against a publication name it never had.
    const push = yield* pushRequestEvent();
    const mispaired = [
      ...prefix,
      yield* requestEvent(payload),
      yield* refusedEvent("GitHostConflictError", yield* replPushOutcomeName(push.record)),
    ];
    expect((yield* refusalOf(mispaired))?.reason).toBe("request-fingerprint");
  });

  it("RPR15: refuses an orphan outcome, a duplicate pairing and a wrong-kind result", function* () {
    const prefix = yield* published();
    const payload = request();
    const record = parsed(payload);

    expect((yield* refusalOf([...prefix, yield* pullRequestOutcomeEvent(record)]))?.reason).toBe(
      "orphan-outcome",
    );

    const duplicated = [
      ...prefix,
      yield* requestEvent(payload),
      yield* pullRequestOutcomeEvent(record),
      yield* pullRequestOutcomeEvent(record),
    ];
    expect((yield* refusalOf(duplicated))?.reason).toBe("duplicate-outcome");

    // A successful outcome describing a publication where a pull request was
    // asked for. Its own name is right for what it says it is, so what refuses
    // it is the pairing: the request before it asked for something else.
    const wrongKind = [
      ...prefix,
      yield* requestEvent(payload),
      yield* pullRequestOutcomeEvent(record, {
        kind: "git-push",
        name: yield* replPullRequestOutcomeName(record),
      }),
    ];
    expect((yield* refusalOf(wrongKind))?.reason).toBe("malformed-receipt");
  });

  it("RPR16: refuses a foreign identity and a result that is not this request's", function* () {
    const prefix = yield* published();
    const payload = request();
    const record = parsed(payload);

    const foreignOwner = [
      ...prefix,
      yield* requestEvent(payload),
      yield* pullRequestOutcomeEvent(record, { runId: OTHER_OWNER }),
    ];
    expect((yield* refusalOf(foreignOwner))?.reason).toBe("foreign-owner");

    const foreignSite = [
      ...prefix,
      yield* requestEvent(payload),
      yield* pullRequestOutcomeEvent(record, {
        expansionId: "expansion-other",
        name: yield* replPullRequestOutcomeName(record),
      }),
    ];
    expect((yield* refusalOf(foreignSite))?.reason).toBe("foreign-owner");

    // A natural key that names another resource, with the name still the one
    // this request produces.
    const wrongKey = [
      ...prefix,
      yield* requestEvent(payload),
      yield* pullRequestOutcomeEvent(record, {
        naturalKey: pullRequestNaturalKeyJson({
          mode: "update",
          repository: IDENTITY,
          number: 99,
        }),
        name: yield* replPullRequestOutcomeName(record),
      }),
    ];
    expect((yield* refusalOf(wrongKey))?.reason).toBe("malformed-receipt");

    // A snapshot that finished at a different head than the request asked for.
    const wrongHead = [
      ...prefix,
      yield* requestEvent(payload),
      yield* pullRequestOutcomeEvent(record, {
        snapshot: { ...SNAPSHOT, headSha: MOVED_HEAD },
      }),
    ];
    expect((yield* refusalOf(wrongHead))?.reason).toBe("malformed-receipt");
  });

  it("RPR17: accepts mixed publication and pull-request work across two coroutines", function* () {
    // Two `<All>` branches, each publishing and then opening, interleaved in
    // the stream. Pairing is per coroutine, so neither branch's outcome answers
    // the other's request.
    const placement = yield* placementEvent();
    const leftPush = yield* pushRequestEvent({ coroutineId: "left" });
    const rightPush = yield* pushRequestEvent({
      coroutineId: "right",
      site: "expansion-right",
    });
    const leftPayload = request({ site: "expansion-left-pr" });
    const rightPayload = request({ site: "expansion-right-pr" });

    const interleaved = [
      placement,
      leftPush.event,
      rightPush.event,
      yield* pushOutcomeEvent(leftPush.record, { coroutineId: "left" }),
      yield* pushOutcomeEvent(rightPush.record, { coroutineId: "right" }),
      yield* requestEvent(leftPayload, { coroutineId: "left" }),
      yield* requestEvent(rightPayload, { coroutineId: "right" }),
      yield* pullRequestOutcomeEvent(parsed(rightPayload), { coroutineId: "right" }),
      // And the left branch's pull request is still pending, which is a valid
      // trailing request rather than damage.
    ];
    expect(yield* refusalOf(interleaved)).toBeUndefined();
  });

  it("RPR18: passes over records of other features and other external protocols", function* () {
    const prefix = yield* published();
    const unrelated: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: "some_other_feature", name: "whatever" },
      result: { status: "ok", value: { anything: true } },
    };
    expect(yield* refusalOf([...prefix, unrelated])).toBeUndefined();
  });

  it("RPR25: a pull request resolved in another authenticated checkout is refused", function* () {
    // Both requests name a placement this entry holds, which is the most this
    // feature's placement question can establish. What it cannot establish is
    // that the publication was of *this* checkout's branch: a worktree of the
    // same repository has its own `review/notes` holding its own commit.
    const push = yield* pushRequestEvent();
    const otherRoot = `${CHECKOUT}-other`;
    const selection = {
      kind: "worktree" as const,
      name: "other",
      branch: BRANCH,
      owner: IDENTITY,
      commonDirectory: COMMON,
      ownerCheckout: CHECKOUT,
      base: null,
    };
    const fingerprint = yield* replPlacementFingerprint(selection);
    const elsewhere: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: {
        type: REPL_REPOSITORY_PLACEMENT,
        name: replPlacementRecordName({ kind: "worktree", fingerprint }),
      },
      result: {
        status: "ok",
        value: replPlacementRecordJson({
          fingerprint,
          request: selection,
          outcome: Ok({ ...PLACEMENT, kind: "worktree", checkoutRoot: otherRoot }),
        }),
      },
    };

    const refusal = yield* refusalOf([
      yield* placementEvent(),
      elsewhere,
      push.event,
      yield* pushOutcomeEvent(push.record),
      yield* requestEvent(request({ resolved: { checkoutRoot: otherRoot } })),
    ]);
    expect(refusal?.reason).toBe("unauthorized-pull-request");

    // Resolved in the checkout that published it, the same history admits.
    expect(
      yield* refusalOf([
        yield* placementEvent(),
        elsewhere,
        push.event,
        yield* pushOutcomeEvent(push.record),
        yield* requestEvent(request()),
      ]),
    ).toBeUndefined();
  });
});

describe("Tier RPR — whose retained evidence read is whose", () => {
  const request5 = readRequest(URL, "reviews", undefined, OWNER, SITE);

  it("RPR19: admits this entry's own read, settled or failed", function* () {
    const admitted = admitReplPullRequestReadRequest(OWNER, pullRequestReadRequestJson(request5));
    expect(admitted.runId).toBe(OWNER);
    expect(admitted.url).toBe(URL);
    expect(admitted.kind).toBe("reviews");
    expect(admitted.provider).toBeNull();
  });

  it("RPR20: refuses a foreign owner, which the name alone cannot say", function* () {
    // The name omits the owner, so two entries reading the same URL at the same
    // position produce the same name. What tells them apart is `runId`, and
    // this is the case that proves the check is independent of the name.
    const foreign = readRequest(URL, "reviews", undefined, OTHER_OWNER, SITE);
    let refusal: ReplPullRequestReadHistoryError | undefined;
    try {
      admitReplPullRequestReadRequest(OWNER, pullRequestReadRequestJson(foreign));
    } catch (error) {
      refusal = error instanceof ReplPullRequestReadHistoryError ? error : undefined;
    }
    expect(refusal?.reason).toBe("foreign-owner");

    // Asked of a failed read's description too: a refusal retains no result,
    // and its description is the only thing that says who asked.
    let failedRefusal: ReplPullRequestReadHistoryError | undefined;
    try {
      admitReplPullRequestReadRequest(OWNER, pullRequestReadRequestJson(foreign));
    } catch (error) {
      failedRefusal = error instanceof ReplPullRequestReadHistoryError ? error : undefined;
    }
    expect(failedRefusal?.reason).toBe("foreign-owner");
  });

  it("RPR21: refuses a description this host cannot read", function* () {
    for (const value of [
      undefined,
      "a read",
      { ...pullRequestReadRequestJson(request5), surplus: true },
      { ...pullRequestReadRequestJson(request5), operation: "write" },
      { ...pullRequestReadRequestJson(request5), kind: "labels" },
    ]) {
      let refusal: ReplPullRequestReadHistoryError | undefined;
      try {
        admitReplPullRequestReadRequest(OWNER, value as Json);
      } catch (error) {
        refusal = error instanceof ReplPullRequestReadHistoryError ? error : undefined;
      }
      expect(refusal?.reason).toBe("malformed-record");
    }
  });

  it("RPR22: holds a settled read to the collection its own question asked for", function* () {
    const reviews = admitReplPullRequestReadResult(request5, { kind: "reviews", items: [] });
    expect(reviews.kind).toBe("reviews");

    // Another collection entirely, however well-formed.
    let refusal: ReplPullRequestReadHistoryError | undefined;
    try {
      admitReplPullRequestReadResult(request5, { kind: "comments", items: [] });
    } catch (error) {
      refusal = error instanceof ReplPullRequestReadHistoryError ? error : undefined;
    }
    expect(refusal?.reason).toBe("malformed-result");
  });

  it("RPR23: holds every check to the head the read recorded, empty or not", function* () {
    const checks = readRequest(URL, "checks", undefined, OWNER, SITE);
    const run = {
      kind: "check-run",
      id: "1",
      headSha: HEAD,
      name: "build",
      status: "completed",
      conclusion: "success",
      url: null,
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:01:00Z",
      title: null,
      summary: null,
      text: null,
    };

    // An empty collection still says which head was read, and that is admitted.
    expect(
      admitReplPullRequestReadResult(checks, { kind: "checks", headSha: HEAD, items: [] }).kind,
    ).toBe("checks");

    expect(
      admitReplPullRequestReadResult(checks, { kind: "checks", headSha: HEAD, items: [run] }).kind,
    ).toBe("checks");

    let refusal: ReplPullRequestReadHistoryError | undefined;
    try {
      admitReplPullRequestReadResult(checks, {
        kind: "checks",
        headSha: HEAD,
        items: [{ ...run, headSha: MOVED_HEAD }],
      });
    } catch (error) {
      refusal = error instanceof ReplPullRequestReadHistoryError ? error : undefined;
    }
    expect(refusal?.reason).toBe("malformed-result");
  });
});

/**
 * What a pull request may rest on, as the entry remembers it live.
 *
 * The admission above establishes the ordered facts; this is the memory that
 * decides which of them authorizes a pull request *now*. The two questions it
 * answers that nothing else can are reached-ness — a fact standing after the
 * position execution is at is not usable — and durable order, because replay
 * may revisit two concurrent children in either order.
 */
describe("Tier RPR — which publication a pull request may rest on", () => {
  /** One acknowledged publication, with whatever a case wants different. */
  function publication(overrides: Partial<RankedReplPublication> = {}): RankedReplPublication {
    return {
      site: PUSH_SITE,
      rank: 0,
      repository: IDENTITY,
      origin: ORIGIN,
      checkoutRoot: CHECKOUT,
      commonDirectory: COMMON,
      branch: BRANCH,
      destinationRef: destinationRefFor(BRANCH),
      sourceCommit: HEAD,
      ...overrides,
    };
  }

  /** What admitting this pull request refused, or `undefined`. */
  function refusedBy(
    memory: ReplPublicationMemory,
    inputs: PullRequestInputs = INPUTS,
  ): string | undefined {
    try {
      memory.admit(inputs, ORIGIN, { checkoutRoot: CHECKOUT, commonDirectory: COMMON });
      return undefined;
    } catch (error) {
      return error instanceof PullRequestAdmissionError ? error.reason : "unexpected";
    }
  }

  it("RPR26: a fact the snapshot holds authorizes nothing until execution reaches it", function* () {
    const memory = createReplPublicationMemory();
    memory.admitted([publication()]);
    // The publication is in this entry's history and this execution has not
    // arrived at it. A previous session getting further than this one is not
    // authority for work this one is doing now.
    expect(refusedBy(memory)).toBe("missing-push-evidence");

    memory.reach(publication());
    expect(refusedBy(memory)).toBeUndefined();
  });

  it("RPR27: restoring two publications in reverse keeps the order they were acknowledged in", function* () {
    const first = publication({ site: "expansion-a", rank: 0 });
    const second = publication({ site: "expansion-b", rank: 1, sourceCommit: MOVED_HEAD });
    const memory = createReplPublicationMemory();
    memory.admitted([first, second]);

    // Replay reaches the later publication first. The branch still holds what
    // was published to it last, so this head is superseded however this
    // execution happened to arrive.
    memory.reach(second);
    memory.reach(first);
    expect(refusedBy(memory)).toBe("conflicting-push-evidence");
    expect(refusedBy(memory, { ...INPUTS, headSha: MOVED_HEAD })).toBeUndefined();
  });

  it("RPR28: a publication from another of this entry's checkouts authorizes nothing", function* () {
    const memory = createReplPublicationMemory();
    const elsewhere = publication({ checkoutRoot: `${CHECKOUT}-other` });
    memory.admitted([elsewhere]);
    memory.reach(elsewhere);
    // Same repository, same origin, same branch, same commit — and a different
    // checkout, which is a different branch of that name.
    expect(refusedBy(memory)).toBe("missing-push-evidence");

    // A live publication from this checkout ranks after everything the
    // snapshot held, and is the one that authorizes.
    memory.reach(publication({ site: "expansion-live" }));
    expect(refusedBy(memory)).toBeUndefined();
  });
});
