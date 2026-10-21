/**
 * Tier RP — what a REPL entry's saved publication request says, and what a
 * history holding one is allowed to look like.
 *
 * Two boundaries, both provider-neutral and both pure. The **codec** decides
 * what a saved request is: the shape, the closed origin grammar, and the facts
 * three readings of one place have to agree about. The **admission** decides
 * whether a whole history may be continued: integrity, this entry's ownership,
 * and the pairing of each request with the outcome that answers it.
 *
 * Nothing here opens a checkout, resolves a path or contacts anything, because
 * neither boundary may: a continuation whose managed worktree was deleted while
 * the person was away answers from what it already wrote down.
 *
 * These cases carry E6 of the delivery-4 matrix, and the request half of E3's
 * trailing-request history.
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
} from "@executablemd/git";
import { locatorFingerprint } from "@executablemd/git/deno";
import type { RepositoryIdentity } from "@executablemd/git";
import { GIT_HOST_EFFECT } from "@executablemd/git";
import { gitHostReconciliationRecordJson, gitHostRequestFingerprint } from "@executablemd/git";
import {
  admitReplPushHistory,
  replPushEffectRequest,
  replPushOutcomeName,
  replPushPlacesHeld,
  ReplPushHistoryError,
  type ReplPushPlacement,
} from "../src/repl/repositories/push-admission.ts";
import {
  parseReplPushRequestRecord,
  replPushRequestJson,
  replPushRequestName,
  REPL_REPOSITORY_PUSH_REQUEST,
  sameReplPushPlace,
  type ReplPushPlace,
  type ReplPushRequestRecord,
} from "../src/repl/repositories/push-records.ts";
import {
  replPlacementFingerprint,
  replPlacementRecordJson,
  replPlacementRecordName,
  REPL_REPOSITORY_PLACEMENT,
  type ReplPlacement,
} from "../src/repl/repositories/placement-records.ts";

const OWNER = '["executablemd.repl.issue-owner",1,"execution-4","entry-1"]';
const SITE = "expansion-5a7";

const ORIGIN = "/srv/remotes/project.git";
const CHECKOUT = "/home/dev/.xmd/repositories/project/checkout";
const COMMON = "/home/dev/.xmd/repositories/project/checkout/.git";
const BRANCH = "review/push";
const COMMIT = "9fceb02d8c5a1b4e7f03a6d9c2b8e5174a0f3b6d";
const OTHER_COMMIT = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

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

const INPUTS: GitPushInputs = Object.freeze({
  repository: IDENTITY,
  remote: PUSH_REMOTE,
  branch: BRANCH,
  destinationRef: destinationRefFor(BRANCH),
  sourceCommit: COMMIT,
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

/** One saved request, with whatever this case wants to be different about it. */
function request(
  overrides: {
    readonly owner?: string;
    readonly site?: string;
    readonly requested?: ReplPushPlace;
    readonly received?: ReplPushPlace;
    readonly resolved?: {
      readonly checkoutRoot?: string;
      readonly commonDirectory?: string;
      readonly origin?: string;
      readonly inputs?: GitPushInputs;
    };
  } = {},
): Json {
  return replPushRequestJson({
    owner: overrides.owner ?? OWNER,
    site: overrides.site ?? SITE,
    requested: overrides.requested ?? PLACE,
    received: overrides.received ?? PLACE,
    resolved: {
      checkoutRoot: overrides.resolved?.checkoutRoot ?? CHECKOUT,
      commonDirectory: overrides.resolved?.commonDirectory ?? COMMON,
      origin: overrides.resolved?.origin ?? ORIGIN,
      inputs: overrides.resolved?.inputs ?? INPUTS,
    },
  });
}

function parsed(payload: Json): ReplPushRequestRecord {
  const record = parseReplPushRequestRecord(payload);
  if (record === undefined) {
    throw new Error("the saved request this case builds does not parse");
  }
  return record;
}

/** The journal event one published request is held by. */
function* requestEvent(
  payload: Json,
  options: { readonly coroutineId?: string; readonly name?: string } = {},
): Operation<DurableEvent> {
  const record = parseReplPushRequestRecord(payload);
  const name =
    options.name ?? (record === undefined ? "unreadable" : yield* replPushRequestName(record));
  return {
    type: "yield",
    coroutineId: options.coroutineId ?? "root",
    description: { type: REPL_REPOSITORY_PUSH_REQUEST, name },
    result: { status: "ok", value: payload },
  };
}

/** The successful Git-host outcome one saved request's publication produces. */
function* outcomeEvent(
  record: ReplPushRequestRecord,
  options: {
    readonly coroutineId?: string;
    readonly name?: string;
    readonly inputs?: GitPushInputs;
    readonly decision?: "performed" | "adopted";
    readonly observed?: string;
  } = {},
): Operation<DurableEvent> {
  const inputs = options.inputs ?? record.resolved.inputs;
  const decision = options.decision ?? "performed";
  const observed = options.observed ?? inputs.sourceCommit;
  const complete = {
    identity: { runId: record.owner, expansionId: record.site },
    ...replPushEffectRequest(inputs),
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
        request: {
          identity: complete.identity,
          kind: complete.kind,
          inputs: complete.inputs,
          naturalKey: complete.naturalKey,
        },
        preState: gitPushPreStateJson(
          decision === "performed" ? { remoteCommit: null } : { remoteCommit: observed },
        ),
        observations: gitPushObservationsJson({ remoteCommit: observed }),
        decision,
        result: gitPushResultJson({
          repository: inputs.repository,
          remote: inputs.remote,
          branch: inputs.branch,
          destinationRef: inputs.destinationRef,
          refspec: refspecFor(inputs.sourceCommit, inputs.destinationRef),
          sourceCommit: inputs.sourceCommit,
          observedRemoteCommit: observed,
        }),
      }),
    },
  };
}

/** The failed Git-host outcome a refused publication leaves. */
function* refusedEvent(
  record: ReplPushRequestRecord,
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
      name: options.journaled ?? (yield* replPushOutcomeName(record)),
    },
    result: { status: "err", error: serializeError(failure) },
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

describe("Tier RP — a REPL entry's saved publication request", () => {
  it("RP1: holds the question, the received reading and what routing resolved", function* () {
    const record = parsed(request());

    expect(record.owner).toBe(OWNER);
    expect(record.site).toBe(SITE);
    expect(record.requested).toEqual(PLACE);
    expect(record.received).toEqual(PLACE);
    expect(record.resolved.inputs).toEqual(INPUTS);
    expect(record.resolved.origin).toBe(ORIGIN);
    // Equal readings still occupy both fields, so a record always says which
    // of the two it is talking about.
    expect(sameReplPushPlace(record.requested, record.received)).toBe(true);

    // Nothing else is retained, and the member sets say so exactly: no opaque
    // selection identifier, no source object, no token, no Git output, no HEAD
    // inventory and no flag claiming anything was published.
    const payload = request() as Record<string, Json>;
    expect(Object.keys(payload).sort()).toEqual([
      "owner",
      "received",
      "requested",
      "resolved",
      "site",
      "version",
    ]);
    for (const reading of ["requested", "received"]) {
      expect(Object.keys(payload[reading] as Record<string, Json>).sort()).toEqual([
        "commonDirectory",
        "repository",
        "selectionCheckout",
        "workingDirectory",
      ]);
    }
    expect(Object.keys(payload["resolved"] as Record<string, Json>).sort()).toEqual([
      "checkoutRoot",
      "commonDirectory",
      "inputs",
      "origin",
    ]);
    // The provider mints an opaque identifier per selection, and no part of it
    // reaches the record: it names nothing once the entry ends.
    expect(JSON.stringify(payload)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });

  it("RP2: the name covers the question alone, and every member of it", function* () {
    const base = parsed(request());
    const mine = yield* replPushRequestName(base);

    const elsewhere = yield* replPushRequestName(parsed(request({ site: "expansion-other" })));
    const somebody = yield* replPushRequestName(parsed(request({ owner: "another-owner" })));
    const moved = yield* replPushRequestName(
      parsed(
        request({
          requested: { ...PLACE, workingDirectory: `${CHECKOUT}/notes` },
        }),
      ),
    );
    expect(new Set([mine, elsewhere, somebody, moved]).size).toBe(4);

    // The answer takes no part in it. A replay looks for the question it is
    // asking now, and the question is all it knows before it finds the record.
    const answered = yield* replPushRequestName(
      parsed(request({ resolved: { inputs: { ...INPUTS, sourceCommit: OTHER_COMMIT } } })),
    );
    expect(answered).toBe(mine);
  });

  it("RP3: refuses an unknown version, a hostile value and a missing member", function* () {
    expect(parseReplPushRequestRecord(undefined)).toBe(undefined);
    expect(parseReplPushRequestRecord(null)).toBe(undefined);
    expect(parseReplPushRequestRecord("a saved request")).toBe(undefined);
    expect(parseReplPushRequestRecord([request()])).toBe(undefined);

    const payload = request() as Record<string, Json>;
    expect(parseReplPushRequestRecord({ ...payload, version: 2 })).toBe(undefined);
    expect(parseReplPushRequestRecord({ ...payload, version: "1" })).toBe(undefined);
    expect(parseReplPushRequestRecord({ ...payload, owner: "" })).toBe(undefined);
    expect(parseReplPushRequestRecord({ ...payload, site: 7 })).toBe(undefined);
    expect(parseReplPushRequestRecord({ ...payload, extra: true })).toBe(undefined);
    const { resolved: _dropped, ...without } = payload;
    expect(parseReplPushRequestRecord(without)).toBe(undefined);

    // A member whose read throws is a value that describes nothing.
    const hostile = { ...payload };
    Object.defineProperty(hostile, "requested", {
      enumerable: true,
      get() {
        throw new Error("this value refuses to be read");
      },
    });
    expect(parseReplPushRequestRecord(hostile)).toBe(undefined);
  });

  it("RP4: refuses an origin this host would not hand to Git", function* () {
    // Each of these is a locator the closed grammar refuses, so a saved request
    // carrying one is not one this host can act on. Whether an *admitted* origin
    // is the one the identity was fingerprinted from needs the provider's own
    // digest, so the provider asks it of every record it reads back: P8 in
    // packages/git/tests/retained-repository-push.test.ts is that row.
    for (const origin of [
      "ext::sh -c 'id'",
      "-upload-pack=payload",
      "https://token@example.invalid/project.git",
      "https://example.invalid/project.git?access_token=secret",
      "relative/path.git",
      "",
    ]) {
      const fingerprinted: GitPushInputs = {
        ...INPUTS,
        repository: { ...IDENTITY, locatorFingerprint: locatorFingerprint(origin) },
      };
      expect(
        parseReplPushRequestRecord(
          request({
            requested: { ...PLACE, repository: fingerprinted.repository },
            received: { ...PLACE, repository: fingerprinted.repository },
            resolved: { origin, inputs: fingerprinted },
          }),
        ),
      ).toBe(undefined);
    }
  });

  it("RP5: refuses inputs that do not belong to the Repository the dispatch received", function* () {
    const elsewhere: RepositoryIdentity = { ...IDENTITY, name: "other" };
    expect(
      parseReplPushRequestRecord(
        request({ resolved: { inputs: { ...INPUTS, repository: elsewhere } } }),
      ),
    ).toBe(undefined);

    // The shared Push parser owns the rest: the remote is the literal label,
    // the destination is the branch's own ref, and the commit is an object id
    // in this repository's format.
    for (const inputs of [
      { ...INPUTS, remote: "upstream" },
      { ...INPUTS, destinationRef: "refs/heads/elsewhere" },
      { ...INPUTS, destinationRef: BRANCH },
      { ...INPUTS, sourceCommit: "HEAD" },
      { ...INPUTS, sourceCommit: COMMIT.toUpperCase() },
      { ...INPUTS, sourceCommit: COMMIT.slice(0, 39) },
    ]) {
      expect(parseReplPushRequestRecord(request({ resolved: { inputs } }))).toBe(undefined);
    }
  });

  it("RP6: both object-id formats round-trip", function* () {
    const sha256 = "a".repeat(64);
    const identity: RepositoryIdentity = {
      ...IDENTITY,
      objectFormat: "sha256",
      creationCommit: sha256,
    };
    const inputs: GitPushInputs = { ...INPUTS, repository: identity, sourceCommit: sha256 };
    const place: ReplPushPlace = { ...PLACE, repository: identity };
    const record = parsed(request({ requested: place, received: place, resolved: { inputs } }));
    expect(record.resolved.inputs.sourceCommit).toBe(sha256);
    expect(record.resolved.inputs.repository.objectFormat).toBe("sha256");
    // And a sha1-width commit is not an id in a sha256 repository.
    expect(
      parseReplPushRequestRecord(
        request({
          requested: place,
          received: place,
          resolved: { inputs: { ...inputs, sourceCommit: COMMIT } },
        }),
      ),
    ).toBe(undefined);
  });

  it("RP7: a saved place has to be one a placement before it described", function* () {
    const record = parsed(request());
    expect(replPushPlacesHeld(record, HELD)).toBe(true);
    expect(replPushPlacesHeld(record, [])).toBe(false);
    // Each of the three readings is checked, so a record agreeing about two of
    // them and naming somewhere else in the third does not pass.
    expect(
      replPushPlacesHeld(record, [
        { identity: IDENTITY, checkoutRoot: `${CHECKOUT}-copy`, commonDirectory: COMMON },
      ]),
    ).toBe(false);
    expect(
      replPushPlacesHeld(record, [
        {
          identity: { ...IDENTITY, name: "other" },
          checkoutRoot: CHECKOUT,
          commonDirectory: COMMON,
        },
      ]),
    ).toBe(false);
    expect(
      replPushPlacesHeld(
        parsed(request({ resolved: { checkoutRoot: `${CHECKOUT}/nested` } })),
        HELD,
      ),
    ).toBe(false);
  });
});

describe("Tier RP — admitting a history that published", () => {
  it("RP8: admits a request answered by its own outcome, and one still unanswered", function* () {
    const payload = request();
    const record = parsed(payload);
    const published = [
      yield* placementEvent(),
      yield* requestEvent(payload),
      yield* outcomeEvent(record),
    ];
    expect(yield* refusalOf(published)).toBe(undefined);

    // The state this feature exists for: the request was acknowledged and the
    // host's answer never arrived. It is history, not damage.
    expect(yield* refusalOf(published.slice(0, 2))).toBe(undefined);

    // An adopted completion is the same history with another decision.
    expect(
      yield* refusalOf([
        yield* placementEvent(),
        yield* requestEvent(payload),
        yield* outcomeEvent(record, { decision: "adopted" }),
      ]),
    ).toBe(undefined);
  });

  it("RP9: refuses a request that is misnamed, foreign or unplaced", function* () {
    const payload = request();
    const record = parsed(payload);

    const misnamed = yield* refusalOf([
      yield* placementEvent(),
      yield* requestEvent(payload, { name: "a name its own question does not produce" }),
    ]);
    expect(misnamed?.reason).toBe("request-fingerprint");

    const foreign = request({ owner: "another-owner" });
    const borrowed = yield* refusalOf([yield* placementEvent(), yield* requestEvent(foreign)]);
    expect(borrowed?.reason).toBe("foreign-owner");

    const unplaced = yield* refusalOf([yield* requestEvent(payload)]);
    expect(unplaced?.reason).toBe("unknown-placement");

    const malformed = yield* refusalOf([
      yield* placementEvent(),
      {
        type: "yield",
        coroutineId: "root",
        description: { type: REPL_REPOSITORY_PUSH_REQUEST, name: "whatever" },
        result: { status: "ok", value: { version: 1, owner: OWNER } },
      },
    ]);
    expect(malformed?.reason).toBe("malformed-record");

    const stated = yield* refusalOf([
      yield* placementEvent(),
      {
        type: "yield",
        coroutineId: "root",
        description: { type: REPL_REPOSITORY_PUSH_REQUEST, name: "whatever" },
        result: { status: "ok", value: { ...(payload as Record<string, Json>), version: 4 } },
      },
    ]);
    expect(stated?.reason).toBe("unknown-version");

    // A request publication has no failure side of its own.
    const failed = yield* refusalOf([
      yield* placementEvent(),
      {
        type: "yield",
        coroutineId: "root",
        description: { type: REPL_REPOSITORY_PUSH_REQUEST, name: "whatever" },
        result: { status: "err", error: serializeError(new Error("refused")) },
      },
    ]);
    expect(failed?.reason).toBe("malformed-record");

    // And `record` is the reading every one of those was built against.
    expect(record.owner).toBe(OWNER);
  });

  it("RP10: refuses an orphan outcome, a duplicate pairing and a receipt it cannot read", function* () {
    const payload = request();
    const record = parsed(payload);

    const orphan = yield* refusalOf([yield* placementEvent(), yield* outcomeEvent(record)]);
    expect(orphan?.reason).toBe("orphan-outcome");

    const twice = yield* refusalOf([
      yield* placementEvent(),
      yield* requestEvent(payload),
      yield* outcomeEvent(record),
      yield* outcomeEvent(record),
    ]);
    expect(twice?.reason).toBe("duplicate-outcome");

    const misnamed = yield* refusalOf([
      yield* placementEvent(),
      yield* requestEvent(payload),
      yield* outcomeEvent(record, { name: "a name the request does not produce" }),
    ]);
    expect(misnamed?.reason).toBe("request-fingerprint");

    const unreadable = yield* refusalOf([
      yield* placementEvent(),
      yield* requestEvent(payload),
      {
        type: "yield",
        coroutineId: "root",
        description: { type: GIT_HOST_EFFECT, name: yield* replPushOutcomeName(record) },
        result: { status: "ok", value: { published: true } },
      },
    ]);
    expect(unreadable?.reason).toBe("malformed-receipt");
  });

  it("RP11: refuses an outcome describing another push, or one this host cannot name", function* () {
    const payload = request();
    const record = parsed(payload);

    // Named by this request, and describing another commit. The name is the
    // request's own, so only reading the receipt catches it.
    const elsewhere = yield* refusalOf([
      yield* placementEvent(),
      yield* requestEvent(payload),
      yield* outcomeEvent(record, {
        inputs: { ...INPUTS, sourceCommit: OTHER_COMMIT },
        name: yield* replPushOutcomeName(record),
      }),
    ]);
    expect(elsewhere?.reason).toBe("malformed-receipt");

    // A decision its own pre-state does not support.
    const unsupported = yield* refusalOf([
      yield* placementEvent(),
      yield* requestEvent(payload),
      yield* outcomeEvent(record, { decision: "adopted", observed: OTHER_COMMIT }),
    ]);
    expect(unsupported?.reason).toBe("malformed-receipt");

    // A refusal under a condition this host has a word for, and one under a
    // condition it does not.
    for (const name of [
      "GitHostConflictError",
      "GitHostAmbiguousError",
      "GitHostUnavailableError",
    ]) {
      expect(
        yield* refusalOf([
          yield* placementEvent(),
          yield* requestEvent(payload),
          yield* refusedEvent(record, name),
        ]),
      ).toBe(undefined);
    }
    const invented = yield* refusalOf([
      yield* placementEvent(),
      yield* requestEvent(payload),
      yield* refusedEvent(record, "GitHostSomethingElseError"),
    ]);
    expect(invented?.reason).toBe("malformed-receipt");
  });

  it("RP12: coroutines pair independently, and equal requests are separate occurrences", function* () {
    const payload = request();
    const record = parsed(payload);
    const other = request({ site: "expansion-second" });
    const second = parsed(other);

    // Two branches, interleaved. Neither outcome answers the other's request.
    expect(
      yield* refusalOf([
        yield* placementEvent(),
        yield* requestEvent(payload, { coroutineId: "root.0" }),
        yield* requestEvent(other, { coroutineId: "root.1" }),
        yield* outcomeEvent(second, { coroutineId: "root.1" }),
        yield* outcomeEvent(record, { coroutineId: "root.0" }),
      ]),
    ).toBe(undefined);

    // An outcome in a coroutine whose request lives in another is an orphan.
    const crossed = yield* refusalOf([
      yield* placementEvent(),
      yield* requestEvent(payload, { coroutineId: "root.0" }),
      yield* outcomeEvent(record, { coroutineId: "root.1" }),
    ]);
    expect(crossed?.reason).toBe("orphan-outcome");

    // Two equal requests at two positions, each answered. Nothing is matched by
    // searching for a name, and nothing is deduplicated.
    expect(
      yield* refusalOf([
        yield* placementEvent(),
        yield* requestEvent(payload),
        yield* outcomeEvent(record),
        yield* requestEvent(payload),
        yield* outcomeEvent(record),
      ]),
    ).toBe(undefined);
  });

  it("RP13: passes over records of other features and other external protocols", function* () {
    const payload = request();
    const record = parsed(payload);
    const complete = {
      identity: { runId: OWNER, expansionId: SITE },
      kind: "git-pull-request",
      inputs: { title: "Ready" },
      naturalKey: { ref: destinationRefFor(BRANCH) },
    };

    expect(
      yield* refusalOf([
        yield* placementEvent(),
        // Another feature's durable type, which this reader does not own.
        {
          type: "yield",
          coroutineId: "root",
          description: { type: "repl_repository_local", name: "a file write" },
          result: { status: "ok", value: { version: 1 } },
        },
        // Another external protocol's successful record, which names its kind.
        {
          type: "yield",
          coroutineId: "root",
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
              preState: { pullRequest: null },
              observations: { pullRequest: 7 },
              decision: "performed",
              result: { number: 7 },
            }),
          },
        },
        yield* requestEvent(payload),
        yield* outcomeEvent(record),
      ]),
    ).toBe(undefined);

    // A Push outcome reconciled under another owner is refused rather than
    // passed over: an entry's own segment is where its own work is.
    const borrowed = yield* refusalOf([
      yield* placementEvent(),
      yield* requestEvent(payload),
      {
        type: "yield",
        coroutineId: "root",
        description: {
          type: GIT_HOST_EFFECT,
          name: yield* gitHostRequestFingerprint({
            identity: { runId: "another-owner", expansionId: SITE },
            ...replPushEffectRequest(INPUTS),
          }),
        },
        result: {
          status: "ok",
          value: gitHostReconciliationRecordJson({
            request: {
              identity: { runId: "another-owner", expansionId: SITE },
              ...replPushEffectRequest(INPUTS),
            },
            preState: gitPushPreStateJson({ remoteCommit: null }),
            observations: gitPushObservationsJson({ remoteCommit: COMMIT }),
            decision: "performed",
            result: gitPushResultJson({
              repository: INPUTS.repository,
              remote: INPUTS.remote,
              branch: INPUTS.branch,
              destinationRef: INPUTS.destinationRef,
              refspec: refspecFor(COMMIT, INPUTS.destinationRef),
              sourceCommit: COMMIT,
              observedRemoteCommit: COMMIT,
            }),
          }),
        },
      },
    ]);
    expect(borrowed?.reason).toBe("foreign-owner");
  });
});
