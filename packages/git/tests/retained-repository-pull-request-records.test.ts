/**
 * Tier RPR — what a REPL entry's saved pull-request request says, and what a
 * history holding one beside a publication is allowed to look like.
 *
 * Two boundaries, both provider-neutral and both pure. The **codec** decides
 * what a saved request is: the closed shape, the closed origin grammar, and the
 * facts the received reading and the resolved inputs have to agree about. The
 * **admission** decides whether a whole history may be continued once two
 * external protocols interleave in it — a Push and a pull request, each paired
 * with the outcome that answers it.
 *
 * Nothing here opens a checkout, resolves a path or contacts anything, because
 * neither boundary may: a continuation whose managed worktree was deleted while
 * the person was away reconciles what it already wrote down.
 *
 * These cases carry the checkpoint-1 portion of B6. The runtime origin
 * readback, the complete saved-read question and envelope admission, and actual
 * registration before replay belong to checkpoint 2, so nothing here stands in
 * for them — and nothing here substitutes synthetic ordering for B2's native
 * two-publisher evidence.
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
import type { RepositoryIdentity } from "../src/composition/selection.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect-type.ts";
import {
  gitHostReconciliationRecordJson,
  gitHostRequestFingerprint,
} from "../src/git-host/records.ts";
import {
  pullRequestObservationsJson,
  pullRequestPreStateJson,
  pullRequestResultJson,
  type PullRequestInputs,
  type PullRequestSnapshot,
} from "../src/composition/pull-request-records.ts";
import {
  admitReplPushHistory,
  replPullRequestEffectRequest,
  replPullRequestOutcomeName,
  replPullRequestPlacesHeld,
  replPushEffectRequest,
  replPushOutcomeName,
  ReplPushHistoryError,
  walkReplRetainedPublications,
  type ReplPushPlacement,
} from "../src/retained-repository/push-admission.ts";
import {
  parseReplPullRequestRequestRecord,
  replPullRequestRequestJson,
  replPullRequestRequestName,
  REPL_REPOSITORY_PULL_REQUEST_REQUEST,
  sameReplPullRequestAsked,
  type ReplPullRequestAsked,
  type ReplPullRequestContent,
  type ReplPullRequestPlace,
  type ReplPullRequestRequestRecord,
} from "../src/retained-repository/pull-request-records.ts";
import {
  parseReplPushRequestRecord,
  replPushRequestJson,
  replPushRequestName,
  REPL_REPOSITORY_PUSH_REQUEST,
  type ReplPushPlace,
  type ReplPushRequestRecord,
} from "../src/retained-repository/push-records.ts";
import {
  replPlacementFingerprint,
  replPlacementRecordJson,
  replPlacementRecordName,
  REPL_REPOSITORY_PLACEMENT,
  type ReplPlacement,
} from "../src/retained-repository/placement-records.ts";

const OWNER = '["executablemd.repl.issue-owner",1,"execution-4","entry-1"]';
const SITE = "expansion-5a7";
const OTHER_SITE = "expansion-9b2";

const ORIGIN = "/srv/remotes/project.git";
const CHECKOUT = "/home/dev/.xmd/repositories/project/checkout";
const COMMON = "/home/dev/.xmd/repositories/project/checkout/.git";
const BRANCH = "review/push";
const COMMIT = "9fceb02d8c5a1b4e7f03a6d9c2b8e5174a0f3b6d";
const BASE_COMMIT = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

/** A sha256 object id, for the width the other format does not cover. */
const WIDE_COMMIT = "b".repeat(64);
const WIDE_BASE = "c".repeat(64);

const IDENTITY: RepositoryIdentity = Object.freeze({
  name: "project",
  locatorFingerprint: locatorFingerprint(ORIGIN),
  requestedBase: null,
  creationCommit: "c0ffee00000000000000000000000000deadbeef",
  primaryBranch: "main",
  objectFormat: "sha1",
});

const WIDE_IDENTITY: RepositoryIdentity = Object.freeze({
  ...IDENTITY,
  creationCommit: "a".repeat(64),
  objectFormat: "sha256",
});

const PLACE: ReplPullRequestPlace = Object.freeze({
  repository: IDENTITY,
  selectionCheckout: CHECKOUT,
  commonDirectory: COMMON,
  workingDirectory: CHECKOUT,
});

const CONTENT: ReplPullRequestContent = Object.freeze({
  number: null,
  title: "Prepare release",
  body: "Ready for review.",
  draft: false,
  base: "main",
});

const ASKED: ReplPullRequestAsked = Object.freeze({ place: PLACE, pullRequest: CONTENT });

const INPUTS: PullRequestInputs = Object.freeze({
  repository: IDENTITY,
  number: null,
  title: CONTENT.title,
  body: CONTENT.body,
  draft: CONTENT.draft,
  headBranch: BRANCH,
  headSha: COMMIT,
  baseBranch: CONTENT.base,
});

const PUSH_INPUTS: GitPushInputs = Object.freeze({
  repository: IDENTITY,
  remote: PUSH_REMOTE,
  branch: BRANCH,
  destinationRef: destinationRefFor(BRANCH),
  sourceCommit: COMMIT,
});

const PUSH_PLACE: ReplPushPlace = Object.freeze({
  repository: IDENTITY,
  selectionCheckout: CHECKOUT,
  commonDirectory: COMMON,
  workingDirectory: CHECKOUT,
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

/** One saved pull-request request, with whatever a case wants different. */
function request(
  overrides: {
    readonly owner?: string;
    readonly site?: string;
    readonly requested?: ReplPullRequestAsked;
    readonly received?: ReplPullRequestAsked;
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
    requested: overrides.requested ?? ASKED,
    received: overrides.received ?? ASKED,
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
    throw new Error("the saved request this case builds does not parse");
  }
  return record;
}

/** The journal event one published pull-request request is held by. */
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

/** One snapshot of the pull request an outcome finished at. */
function snapshot(inputs: PullRequestInputs, baseSha: string): PullRequestSnapshot {
  return {
    providerId: "PR_kwDO",
    number: inputs.number ?? 7,
    url: "https://github.com/octo/project/pull/7",
    state: "open",
    title: inputs.title,
    body: inputs.body,
    draft: inputs.draft,
    headBranch: inputs.headBranch,
    headSha: inputs.headSha,
    baseBranch: inputs.baseBranch,
    baseSha,
  };
}

/** The successful Git-host outcome one saved pull-request request produces. */
function* pullRequestOutcomeEvent(
  record: ReplPullRequestRequestRecord,
  options: {
    readonly coroutineId?: string;
    readonly name?: string;
    readonly inputs?: PullRequestInputs;
    readonly baseSha?: string;
  } = {},
): Operation<DurableEvent> {
  const inputs = options.inputs ?? record.resolved.inputs;
  const baseSha = options.baseSha ?? BASE_COMMIT;
  const complete = {
    identity: { runId: record.owner, expansionId: record.site },
    ...replPullRequestEffectRequest(inputs),
  };
  const observed = snapshot(inputs, baseSha);
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
        request: {
          identity: complete.identity,
          kind: complete.kind,
          inputs: complete.inputs,
          naturalKey: complete.naturalKey,
        },
        preState: pullRequestPreStateJson({ pullRequest: null }),
        observations: pullRequestObservationsJson({ pullRequest: observed }),
        decision: "performed",
        result: pullRequestResultJson({
          repository: inputs.repository,
          providerId: observed.providerId,
          number: observed.number,
          url: observed.url,
          state: "open",
          headSha: inputs.headSha,
          baseSha,
        }),
      }),
    },
  };
}

/** The failed Git-host outcome a refused pull request leaves. */
function* refusedPullRequestEvent(
  record: ReplPullRequestRequestRecord,
  name: string,
  options: { readonly coroutineId?: string; readonly journaled?: string } = {},
): Operation<DurableEvent> {
  const failure = new Error("refused");
  failure.name = name;
  return {
    type: "yield",
    coroutineId: options.coroutineId ?? "root",
    description: {
      type: GIT_HOST_EFFECT,
      name: options.journaled ?? (yield* replPullRequestOutcomeName(record)),
    },
    result: { status: "err", error: serializeError(failure) },
  };
}

/** One saved Push request, for the histories that interleave both protocols. */
function pushRequest(site: string = SITE): Json {
  return replPushRequestJson({
    owner: OWNER,
    site,
    requested: PUSH_PLACE,
    received: PUSH_PLACE,
    resolved: {
      checkoutRoot: CHECKOUT,
      commonDirectory: COMMON,
      origin: ORIGIN,
      inputs: PUSH_INPUTS,
    },
  });
}

function pushParsed(payload: Json): ReplPushRequestRecord {
  const record = parseReplPushRequestRecord(payload);
  if (record === undefined) {
    throw new Error("the saved Push request this case builds does not parse");
  }
  return record;
}

function* pushRequestEvent(
  payload: Json,
  options: { readonly coroutineId?: string } = {},
): Operation<DurableEvent> {
  const record = pushParsed(payload);
  return {
    type: "yield",
    coroutineId: options.coroutineId ?? "root",
    description: {
      type: REPL_REPOSITORY_PUSH_REQUEST,
      name: yield* replPushRequestName(record),
    },
    result: { status: "ok", value: payload },
  };
}

function* pushOutcomeEvent(
  record: ReplPushRequestRecord,
  options: { readonly coroutineId?: string; readonly inputs?: GitPushInputs } = {},
): Operation<DurableEvent> {
  const inputs = options.inputs ?? record.resolved.inputs;
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

/** The placement record a selection of this checkout leaves behind. */
function* placementEvent(placement: ReplPlacement = PLACEMENT): Operation<DurableEvent> {
  const selection = {
    kind: "repository" as const,
    name: placement.displayName,
    locatorFingerprint: placement.identity.locatorFingerprint,
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
      value: replPlacementRecordJson({
        fingerprint,
        request: selection,
        outcome: Ok(placement),
      }),
    },
  };
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

    // Both readings of the ask, whole: where it was authenticated and what the
    // document wrote. Equal readings are still written twice.
    expect(record.requested.place.selectionCheckout).toBe(CHECKOUT);
    expect(record.requested.place.commonDirectory).toBe(COMMON);
    expect(record.requested.place.workingDirectory).toBe(CHECKOUT);
    expect(record.requested.pullRequest).toEqual(CONTENT);
    expect(sameReplPullRequestAsked(record.requested, record.received)).toBe(true);

    // And the answer, including the head this attempt resolved.
    expect(record.resolved.checkoutRoot).toBe(CHECKOUT);
    expect(record.resolved.commonDirectory).toBe(COMMON);
    expect(record.resolved.origin).toBe(ORIGIN);
    expect(record.resolved.inputs.headBranch).toBe(BRANCH);
    expect(record.resolved.inputs.headSha).toBe(COMMIT);

    // No credential, endpoint, object source, selection token or publication
    // flag crosses this boundary.
    const text = JSON.stringify(request());
    for (const absent of ["token", "credential", "endpoint", "objectSource", "published"]) {
      expect(text.includes(absent)).toBe(false);
    }
  });

  it("RPR2: the name covers the question alone, and every member of it", function* () {
    const base = yield* replPullRequestRequestName({ owner: OWNER, site: SITE, requested: ASKED });

    // Equal questions at two positions are one name: telling them apart is the
    // durable engine's positional matching, not a search by name.
    expect(yield* replPullRequestRequestName({ owner: OWNER, site: SITE, requested: ASKED })).toBe(
      base,
    );

    // The owner and the site are part of it.
    expect(
      yield* replPullRequestRequestName({ owner: OWNER, site: OTHER_SITE, requested: ASKED }),
    ).not.toBe(base);
    expect(
      yield* replPullRequestRequestName({ owner: "another", site: SITE, requested: ASKED }),
    ).not.toBe(base);

    // Every member of the content is, because each of them changes what is
    // being asked for.
    for (const changed of [
      { ...CONTENT, number: 7 },
      { ...CONTENT, title: "Something else" },
      { ...CONTENT, body: "" },
      { ...CONTENT, draft: true },
      { ...CONTENT, base: "release" },
    ]) {
      expect(
        yield* replPullRequestRequestName({
          owner: OWNER,
          site: SITE,
          requested: { place: PLACE, pullRequest: changed },
        }),
      ).not.toBe(base);
    }

    // And so is every member of the place.
    expect(
      yield* replPullRequestRequestName({
        owner: OWNER,
        site: SITE,
        requested: { place: { ...PLACE, workingDirectory: `${CHECKOUT}/docs` }, pullRequest: CONTENT },
      }),
    ).not.toBe(base);

    // What routing answered takes no part in it: a name derived from the answer
    // would have to be recomputed against a checkout that has since moved.
    const moved = parsed(
      request({ resolved: { inputs: { ...INPUTS, headSha: WIDE_COMMIT.slice(0, 40) } } }),
    );
    expect(yield* replPullRequestRequestName(moved)).toBe(base);
  });

  it("RPR3: refuses an unknown version, a hostile value and a missing member", function* () {
    expect(parseReplPullRequestRequestRecord(undefined)).toBeUndefined();
    expect(parseReplPullRequestRequestRecord(null)).toBeUndefined();
    expect(parseReplPullRequestRequestRecord("a saved request")).toBeUndefined();

    const payload = request();
    expect(parseReplPullRequestRequestRecord({ ...Object(payload), version: 2 })).toBeUndefined();

    // One member more than the contract names, and one fewer.
    expect(
      parseReplPullRequestRequestRecord({ ...Object(payload), extra: "detail" }),
    ).toBeUndefined();
    const { resolved: _dropped, ...missing } = Object(payload);
    expect(parseReplPullRequestRequestRecord(missing)).toBeUndefined();

    // A value whose own reads refuse describes no saved request, and answering
    // that is what keeps its text from travelling out through an exception.
    const hostile = new Proxy(Object(payload), {
      get(): never {
        throw new Error("this value refuses to be read");
      },
    });
    expect(parseReplPullRequestRequestRecord(hostile)).toBeUndefined();
  });

  it("RPR4: refuses a number, a title or a body that is not what was asked for", function* () {
    const payload = Object(request());

    // Absence is `null`, and a number is a positive integer or nothing.
    for (const number of [0, -1, 1.5, "7", undefined]) {
      const content = { ...CONTENT, number } as unknown as ReplPullRequestContent;
      expect(
        parseReplPullRequestRequestRecord({
          ...payload,
          requested: { place: Object(payload).requested.place, pullRequest: content },
        }),
      ).toBeUndefined();
    }

    // An empty body is a body somebody wrote, and it round-trips verbatim.
    const empty = parsed(
      request({
        requested: { place: PLACE, pullRequest: { ...CONTENT, body: "" } },
        received: { place: PLACE, pullRequest: { ...CONTENT, body: "" } },
        resolved: { inputs: { ...INPUTS, body: "" } },
      }),
    );
    expect(empty.requested.pullRequest.body).toBe("");
    expect(empty.resolved.inputs.body).toBe("");

    // A body with its own whitespace crosses unchanged: an entry that reflowed
    // one would publish something nobody wrote.
    const verbatim = "  Two  spaces, a\ttab, and a trailing newline.\n";
    const kept = parsed(
      request({
        requested: { place: PLACE, pullRequest: { ...CONTENT, body: verbatim } },
        received: { place: PLACE, pullRequest: { ...CONTENT, body: verbatim } },
        resolved: { inputs: { ...INPUTS, body: verbatim } },
      }),
    );
    expect(kept.received.pullRequest.body).toBe(verbatim);
  });

  it("RPR5: refuses an origin this host would not hand to Git", function* () {
    for (const origin of [
      "https://token@github.com/octo/project.git",
      "https://github.com/octo/project.git?upload-pack=x",
      "",
      "   ",
    ]) {
      expect(parseReplPullRequestRequestRecord(request({ resolved: { origin } }))).toBeUndefined();
    }
  });

  it("RPR6: holds the received content and Repository to what was resolved", function* () {
    // Content the dispatch received but the inputs do not describe: a saved
    // request whose title, body, draft, number or destination disagrees with
    // what was resolved from it would reconcile something nobody asked for.
    for (const inputs of [
      { ...INPUTS, title: "Another title" },
      { ...INPUTS, body: "Another body" },
      { ...INPUTS, draft: true },
      { ...INPUTS, number: 7 },
      { ...INPUTS, baseBranch: "release" },
    ]) {
      expect(parseReplPullRequestRequestRecord(request({ resolved: { inputs } }))).toBeUndefined();
    }

    // And inputs belonging to another Repository than the one received.
    const elsewhere: RepositoryIdentity = { ...IDENTITY, name: "other" };
    expect(
      parseReplPullRequestRequestRecord(
        request({ resolved: { inputs: { ...INPUTS, repository: elsewhere } } }),
      ),
    ).toBeUndefined();
  });

  it("RPR7: both object-id formats round-trip", function* () {
    const wide: PullRequestInputs = {
      ...INPUTS,
      repository: WIDE_IDENTITY,
      headSha: WIDE_COMMIT,
    };
    const widePlace: ReplPullRequestPlace = { ...PLACE, repository: WIDE_IDENTITY };
    const asked: ReplPullRequestAsked = { place: widePlace, pullRequest: CONTENT };

    const record = parsed(
      request({ requested: asked, received: asked, resolved: { inputs: wide } }),
    );
    expect(record.resolved.inputs.headSha).toBe(WIDE_COMMIT);
    expect(record.resolved.inputs.repository.objectFormat).toBe("sha256");

    // And the narrow format still round-trips beside it.
    expect(parsed(request()).resolved.inputs.headSha).toBe(COMMIT);

    // A head of the wrong width for the format it declares is refused.
    expect(
      parseReplPullRequestRequestRecord(
        request({ resolved: { inputs: { ...wide, headSha: COMMIT } } }),
      ),
    ).toBeUndefined();
    expect(WIDE_BASE.length).toBe(64);
  });

  it("RPR8: a saved place has to be one a placement before it described", function* () {
    const record = parsed(request());
    expect(replPullRequestPlacesHeld(record, HELD)).toBe(true);

    // Another checkout entirely.
    expect(
      replPullRequestPlacesHeld(record, [
        { identity: IDENTITY, checkoutRoot: "/elsewhere", commonDirectory: "/elsewhere/.git" },
      ]),
    ).toBe(false);

    // The right roots under another Repository identity.
    expect(
      replPullRequestPlacesHeld(record, [
        {
          identity: { ...IDENTITY, name: "other" },
          checkoutRoot: CHECKOUT,
          commonDirectory: COMMON,
        },
      ]),
    ).toBe(false);

    // And a resolved checkout no placement covers, with the selection held.
    const resolvedElsewhere = parsed(
      request({ resolved: { checkoutRoot: "/elsewhere", commonDirectory: "/elsewhere/.git" } }),
    );
    expect(replPullRequestPlacesHeld(resolvedElsewhere, HELD)).toBe(false);
  });

  it("RPR9: admits a request answered by its own outcome, and one still unanswered", function* () {
    const payload = request();
    const record = parsed(payload);

    const answered: DurableEvent[] = [
      yield* placementEvent(),
      yield* requestEvent(payload),
      yield* pullRequestOutcomeEvent(record),
    ];
    expect(yield* refusalOf(answered)).toBeUndefined();

    // A trailing pending request is the state this protocol exists for.
    const pending: DurableEvent[] = [yield* placementEvent(), yield* requestEvent(payload)];
    expect(yield* refusalOf(pending)).toBeUndefined();

    // A definitive refusal is an answer too, under the three closed names.
    for (const name of [
      "GitHostConflictError",
      "GitHostAmbiguousError",
      "GitHostUnavailableError",
    ]) {
      const refused: DurableEvent[] = [
        yield* placementEvent(),
        yield* requestEvent(payload),
        yield* refusedPullRequestEvent(record, name),
      ];
      expect(yield* refusalOf(refused)).toBeUndefined();
    }

    // A condition this host has no word for is not one of them.
    const unknown: DurableEvent[] = [
      yield* placementEvent(),
      yield* requestEvent(payload),
      yield* refusedPullRequestEvent(record, "SomethingElseError"),
    ];
    expect((yield* refusalOf(unknown))?.reason).toBe("malformed-receipt");
  });

  it("RPR10: refuses a request that is misnamed, foreign or unplaced", function* () {
    const payload = request();

    const misnamed: DurableEvent[] = [
      yield* placementEvent(),
      yield* requestEvent(payload, { name: "not-the-name-its-question-produces" }),
    ];
    expect((yield* refusalOf(misnamed))?.reason).toBe("request-fingerprint");

    const foreign = request({ owner: "another-entry" });
    const borrowed: DurableEvent[] = [yield* placementEvent(), yield* requestEvent(foreign)];
    expect((yield* refusalOf(borrowed))?.reason).toBe("foreign-owner");

    // No placement before it described the checkout it names.
    const unplaced: DurableEvent[] = [yield* requestEvent(payload)];
    expect((yield* refusalOf(unplaced))?.reason).toBe("unknown-placement");

    // A version this host does not implement, and a payload it cannot read.
    const future: DurableEvent[] = [
      yield* placementEvent(),
      {
        type: "yield",
        coroutineId: "root",
        description: { type: REPL_REPOSITORY_PULL_REQUEST_REQUEST, name: "whatever" },
        result: { status: "ok", value: { ...Object(payload), version: 2 } },
      },
    ];
    expect((yield* refusalOf(future))?.reason).toBe("unknown-version");

    const unreadable: DurableEvent[] = [
      yield* placementEvent(),
      {
        type: "yield",
        coroutineId: "root",
        description: { type: REPL_REPOSITORY_PULL_REQUEST_REQUEST, name: "whatever" },
        result: { status: "ok", value: { version: 1 } },
      },
    ];
    expect((yield* refusalOf(unreadable))?.reason).toBe("malformed-record");
  });

  it("RPR11: refuses an orphan outcome, a duplicate pairing and a mismatched one", function* () {
    const payload = request();
    const record = parsed(payload);

    const orphan: DurableEvent[] = [
      yield* placementEvent(),
      yield* pullRequestOutcomeEvent(record),
    ];
    expect((yield* refusalOf(orphan))?.reason).toBe("orphan-outcome");

    const duplicate: DurableEvent[] = [
      yield* placementEvent(),
      yield* requestEvent(payload),
      yield* pullRequestOutcomeEvent(record),
      yield* pullRequestOutcomeEvent(record),
    ];
    expect((yield* refusalOf(duplicate))?.reason).toBe("duplicate-outcome");

    // An outcome describing a pull request other than the one asked for.
    const elsewhere: DurableEvent[] = [
      yield* placementEvent(),
      yield* requestEvent(payload),
      yield* pullRequestOutcomeEvent(record, {
        inputs: { ...INPUTS, title: "Another title" },
        name: yield* replPullRequestOutcomeName(record),
      }),
    ];
    expect((yield* refusalOf(elsewhere))?.reason).toBe("malformed-receipt");

    // And one journaled under a name its request does not produce.
    const misnamed: DurableEvent[] = [
      yield* placementEvent(),
      yield* requestEvent(payload),
      yield* pullRequestOutcomeEvent(record, { name: "not-the-expected-outcome-name" }),
    ];
    expect((yield* refusalOf(misnamed))?.reason).toBe("request-fingerprint");
  });

  it("RPR12: a failed envelope answers the request standing before it, not a Push", function* () {
    // The load-bearing case. A refusal retains no request of its own and names
    // no kind, so a reader that treated every failure as a publication would
    // consume this pull request's refusal as the Push's.
    const pushPayload = pushRequest();
    const pushRecord = pushParsed(pushPayload);
    const prPayload = request();
    const prRecord = parsed(prPayload);

    const mixed: DurableEvent[] = [
      yield* placementEvent(),
      yield* pushRequestEvent(pushPayload),
      yield* pushOutcomeEvent(pushRecord),
      yield* requestEvent(prPayload),
      yield* refusedPullRequestEvent(prRecord, "GitHostConflictError"),
    ];
    expect(yield* refusalOf(mixed)).toBeUndefined();

    // The same failure journaled under the *Push's* expected outcome name is
    // refused: it does not answer the request standing at this position.
    const asPush: DurableEvent[] = [
      yield* placementEvent(),
      yield* pushRequestEvent(pushPayload),
      yield* pushOutcomeEvent(pushRecord),
      yield* requestEvent(prPayload),
      yield* refusedPullRequestEvent(prRecord, "GitHostConflictError", {
        journaled: yield* replPushOutcomeName(pushRecord),
      }),
    ];
    expect((yield* refusalOf(asPush))?.reason).toBe("request-fingerprint");

    // And a successful answer of the other kind standing where this one was
    // asked for describes neither.
    const crossed: DurableEvent[] = [
      yield* placementEvent(),
      yield* requestEvent(prPayload),
      yield* pushOutcomeEvent(pushRecord),
    ];
    expect((yield* refusalOf(crossed))?.reason).toBe("malformed-receipt");
  });

  it("RPR13: both protocols interleave, and the walk exposes the publications", function* () {
    const pushPayload = pushRequest();
    const pushRecord = pushParsed(pushPayload);
    const prPayload = request();
    const prRecord = parsed(prPayload);

    const history: DurableEvent[] = [
      yield* placementEvent(),
      yield* pushRequestEvent(pushPayload),
      yield* pushOutcomeEvent(pushRecord),
      yield* requestEvent(prPayload),
      yield* pullRequestOutcomeEvent(prRecord),
    ];
    expect(yield* refusalOf(history)).toBeUndefined();

    // What the already-planned publication consumer reads: the acknowledged
    // successful Push pairs, in physical outcome order, with the provenance the
    // receipt alone does not carry.
    const walked = yield* walkReplRetainedPublications(OWNER, history);
    expect(walked.pushes).toHaveLength(1);
    expect(walked.pushes[0]?.request.resolved.checkoutRoot).toBe(CHECKOUT);
    expect(walked.pushes[0]?.request.resolved.commonDirectory).toBe(COMMON);
    expect(walked.pushes[0]?.request.resolved.inputs.sourceCommit).toBe(COMMIT);
    expect(walked.pushes[0]?.record.decision).toBe("performed");

    // A pull request is not a publication, and a refused Push is not one
    // either: neither appears among what grants publication authority.
    const refusedPush: DurableEvent[] = [
      yield* placementEvent(),
      yield* pushRequestEvent(pushPayload),
      {
        type: "yield",
        coroutineId: "root",
        description: {
          type: GIT_HOST_EFFECT,
          name: yield* replPushOutcomeName(pushRecord),
        },
        result: {
          status: "err",
          error: serializeError(Object.assign(new Error("refused"), { name: "GitHostConflictError" })),
        },
      },
      yield* requestEvent(prPayload),
      yield* pullRequestOutcomeEvent(prRecord),
    ];
    expect(yield* refusalOf(refusedPush)).toBeUndefined();
    expect((yield* walkReplRetainedPublications(OWNER, refusedPush)).pushes).toEqual([]);

    // A trailing pending Push grants none either.
    const pendingPush: DurableEvent[] = [
      yield* placementEvent(),
      yield* pushRequestEvent(pushPayload),
    ];
    expect((yield* walkReplRetainedPublications(OWNER, pendingPush)).pushes).toEqual([]);
  });

  it("RPR14: coroutines pair independently across both protocols", function* () {
    const pushPayload = pushRequest();
    const pushRecord = pushParsed(pushPayload);
    const prPayload = request({ site: OTHER_SITE });
    const prRecord = parsed(prPayload);

    // Two spawned branches, one publishing and one asking for a pull request.
    // Their outcomes interleave in the stream and neither answers the other's
    // request, because a position belongs to one coroutine.
    const interleaved: DurableEvent[] = [
      yield* placementEvent(),
      yield* pushRequestEvent(pushPayload, { coroutineId: "root.0" }),
      yield* requestEvent(prPayload, { coroutineId: "root.1" }),
      yield* pullRequestOutcomeEvent(prRecord, { coroutineId: "root.1" }),
      yield* pushOutcomeEvent(pushRecord, { coroutineId: "root.0" }),
    ];
    expect(yield* refusalOf(interleaved)).toBeUndefined();

    // An outcome in a coroutine that asked for nothing is still an orphan.
    const stray: DurableEvent[] = [
      yield* placementEvent(),
      yield* requestEvent(prPayload, { coroutineId: "root.1" }),
      yield* pullRequestOutcomeEvent(prRecord, { coroutineId: "root.2" }),
    ];
    expect((yield* refusalOf(stray))?.reason).toBe("orphan-outcome");
  });

  it("RPR15: passes over a well-formed success of a kind an entry does not retain", function* () {
    const prPayload = request();
    const prRecord = parsed(prPayload);

    // An Issue effect's own record belongs to a protocol this reader does not
    // own. It is passed over rather than consuming the pending request.
    const unrelated: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: GIT_HOST_EFFECT, name: "some-other-effect" },
      result: {
        status: "ok",
        value: gitHostReconciliationRecordJson({
          request: {
            identity: { runId: OWNER, expansionId: SITE },
            kind: "something-else",
            inputs: { nothing: true },
            naturalKey: { nothing: true },
          },
          preState: { nothing: null },
          observations: { nothing: true },
          decision: "performed",
          result: { nothing: true },
        }),
      },
    };

    const history: DurableEvent[] = [
      yield* placementEvent(),
      yield* requestEvent(prPayload),
      unrelated,
      yield* pullRequestOutcomeEvent(prRecord),
    ];
    expect(yield* refusalOf(history)).toBeUndefined();

    // An unreadable success still refuses: what it says about external work is
    // unknown, and passing over it would be assuming it was somebody else's.
    const damaged: DurableEvent[] = [
      yield* placementEvent(),
      yield* requestEvent(prPayload),
      {
        type: "yield",
        coroutineId: "root",
        description: { type: GIT_HOST_EFFECT, name: "whatever" },
        result: { status: "ok", value: { not: "a reconciliation record" } },
      },
    ];
    expect((yield* refusalOf(damaged))?.reason).toBe("malformed-receipt");
  });
});
