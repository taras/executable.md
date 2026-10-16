/**
 * What a REPL entry's records say, and which histories this host will continue.
 *
 * Portable on purpose: these are the provider-neutral halves of the feature —
 * the name, the request digest and the admission — so they are held to the same
 * rules under every runtime the CLI starts on. A record format that
 * only parsed where the adapter runs would be a format a Node session could
 * write and never read back.
 *
 * Nothing here touches a filesystem or runs Git. The question is what the bytes
 * mean and which of them this host refuses to act on.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation, Result } from "effection";
import { Err, Ok } from "effection";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { fileWriteSuccess, filesFailure, fileWriteFailure } from "@executablemd/runtime";
import {
  parseReplLocalRecord,
  parseReplSelectionRecord,
  replLocalFingerprint,
  replLocalRecordJson,
  replLocalRecordName,
  replSelectionFingerprint,
  replSelectionRecordJson,
  replSelectionRecordName,
  REPL_REPOSITORY_LOCAL,
  REPL_REPOSITORY_SELECTION,
  REPL_REPOSITORY_VERSION,
  retainableRefusal,
} from "../src/retained-repository/records.ts";
import type {
  ReplLocalOperation,
  ReplLocalRequest,
  ReplLocalValue,
} from "../src/retained-repository/records.ts";
import {
  admitReplRepositoryHistory,
  ReplRepositoryHistoryError,
} from "../src/retained-repository/admission.ts";
import {
  parseReplPlacementRecord,
  REPL_REPOSITORY_PLACEMENT,
  ReplPlacementRefusal,
  replPlacementFingerprint,
  replPlacementRecordJson,
  replPlacementRecordName,
} from "../src/retained-repository/placement-records.ts";
import type {
  ReplPlacement,
  ReplPlacementRequest,
} from "../src/retained-repository/placement-records.ts";
import type { RepositoryIdentity } from "../src/composition/selection.ts";
import {
  parseReplGitRecord,
  replGitFingerprint,
  replGitRecordJson,
  replGitRecordName,
  ReplGitRefusal,
  replGitRefusalOf,
  REPL_REPOSITORY_GIT,
} from "../src/retained-repository/git-records.ts";
import type { ReplGitRequest, ReplGitValue } from "../src/retained-repository/git-records.ts";
// From the root rather than from the source module: these result types are what
// the package publishes, and reaching them by relative path would bypass the
// export map the partition test holds every consumer to.
import type { GitAddResult, GitCommitResult, GitSwitchResult } from "@executablemd/git";

const WRITE: ReplLocalRequest = { cwd: "/work", path: "note.md", content: "first" };

const IDENTITY: RepositoryIdentity = Object.freeze({
  name: "project",
  locatorFingerprint: "a".repeat(64),
  requestedBase: null,
  creationCommit: "b".repeat(40),
  primaryBranch: "main",
  objectFormat: "sha1",
});

const REPOSITORY_REQUEST: ReplPlacementRequest = Object.freeze({
  kind: "repository",
  name: "project",
  locatorFingerprint: "a".repeat(64),
  base: null,
});

const PLACEMENT: ReplPlacement = Object.freeze({
  kind: "repository",
  managedRoot: "/managed",
  checkoutRoot: "/managed/repositories/slot/checkout",
  commonDirectory: "/managed/repositories/slot/checkout/.git",
  identity: IDENTITY,
  displayName: "project",
  ownerCheckout: "/managed/repositories/slot/checkout",
});

/** The payload one journaled event carries, as an object this suite can edit. */
function payloadOf(event: DurableEvent): Record<string, unknown> {
  if (event.type !== "yield" || event.result.status !== "ok") {
    throw new Error("the event carries no payload");
  }
  return { ...Object(event.result.value) };
}

/** One journaled placement, named the way the host names it. */
function* placementEvent(
  request: ReplPlacementRequest = REPOSITORY_REQUEST,
  outcome: Result<ReplPlacement> = Ok(PLACEMENT),
  name?: string,
): Operation<DurableEvent> {
  const fingerprint = yield* replPlacementFingerprint(request);
  return {
    type: "yield",
    coroutineId: "root",
    description: {
      type: REPL_REPOSITORY_PLACEMENT,
      name: name ?? replPlacementRecordName({ kind: request.kind, fingerprint }),
    },
    result: {
      status: "ok",
      value: replPlacementRecordJson({ fingerprint, request, outcome }),
    },
  };
}

/** The publication a recorded write's success names, where it is one. */
function receipt(outcome: Result<ReplLocalValue> | undefined): string | undefined {
  if (outcome === undefined || !outcome.ok) {
    return undefined;
  }
  const value = outcome.value;
  return value === undefined || typeof value === "string" ? undefined : value.publication;
}

/** One journaled local result, named the way the host names it. */
function* localEvent(
  operation: ReplLocalOperation,
  request: ReplLocalRequest,
  outcome = Ok(operation === "file-write" ? fileWriteSuccess("host-committed") : undefined),
  name?: string,
): Operation<DurableEvent> {
  const fingerprint = yield* replLocalFingerprint({ operation, request });
  return {
    type: "yield",
    coroutineId: "root",
    description: {
      type: REPL_REPOSITORY_LOCAL,
      name: name ?? replLocalRecordName({ operation, fingerprint }),
    },
    result: {
      status: "ok",
      value: replLocalRecordJson({ operation, fingerprint, request, outcome }),
    },
  };
}

/** The refusal admitting this history produced, or nothing when it admitted. */
function* refusalOf(
  events: readonly DurableEvent[],
): Operation<ReplRepositoryHistoryError | undefined> {
  try {
    yield* admitReplRepositoryHistory(events);
    return undefined;
  } catch (error) {
    if (error instanceof ReplRepositoryHistoryError) {
      return error;
    }
    throw error;
  }
}

describe("what one entry's records say", () => {
  it("names an operation by its complete authored request", function* () {
    const write = yield* replLocalFingerprint({
      operation: "file-write",
      request: WRITE,
    });
    const other = yield* replLocalFingerprint({
      operation: "file-write",
      request: { ...WRITE, content: "second" },
    });
    const elsewhere = yield* replLocalFingerprint({
      operation: "file-write",
      request: { ...WRITE, path: "other.md" },
    });
    const deleted = yield* replLocalFingerprint({
      operation: "file-delete",
      request: { cwd: WRITE.cwd, path: WRITE.path },
    });

    // The content, the path and the kind are all identity.
    expect(new Set([write, other, elsewhere, deleted]).size).toBe(4);
    // And the same request twice is the same name, which is what makes two
    // equal writes one name at two ordered positions.
    expect(yield* replLocalFingerprint({ operation: "file-write", request: WRITE })).toBe(write);
  });

  it("reads back a read's text, and refuses a payload that is not one", function* () {
    const request = { cwd: "/work", path: "note.md" };
    const fingerprint = yield* replLocalFingerprint({ operation: "file-read", request });
    const payload = replLocalRecordJson({
      operation: "file-read",
      fingerprint,
      request,
      outcome: Ok("first\n"),
    });

    const record = parseReplLocalRecord(payload);
    // The exact text, which is what a continuation binds. Not a receipt: a read
    // answers with what it read.
    expect(record?.outcome.ok === true ? record.outcome.value : undefined).toBe("first\n");
    // A read's request carries no content, so one that does describes an
    // operation this host does not perform.
    expect(
      parseReplLocalRecord({ ...Object(payload), request: { ...request, content: "first\n" } }),
    ).toBe(undefined);
    // And a success that is not text is not a read this version wrote: the
    // absence a delete answers with, and a write's receipt, are both refused
    // here exactly as a read's text is refused in their place.
    expect(parseReplLocalRecord({ ...Object(payload), success: null })).toBe(undefined);
    expect(
      parseReplLocalRecord({
        ...Object(payload),
        success: { type: "executablemd.files.write-success", publication: "host-committed" },
      }),
    ).toBe(undefined);

    // A read's refusal is the ordinary one it was.
    const refused = parseReplLocalRecord(
      replLocalRecordJson({
        operation: "file-read",
        fingerprint,
        request,
        outcome: Err(filesFailure({ operation: "read", phase: "access", reason: "missing" })),
      }),
    );
    expect(refused?.outcome.ok).toBe(false);
    const data =
      refused?.outcome.ok === false ? Reflect.get(refused.outcome.error, "data") : undefined;
    expect(Reflect.get(Object(data), "operation")).toBe("read");
    expect(Reflect.get(Object(data), "reason")).toBe("missing");
  });

  it("reads back a write success, a void success and a refusal", function* () {
    const fingerprint = yield* replLocalFingerprint({
      operation: "file-write",
      request: WRITE,
    });

    const written = parseReplLocalRecord(
      replLocalRecordJson({
        operation: "file-write",
        fingerprint,
        request: WRITE,
        outcome: Ok(fileWriteSuccess("transaction-staged")),
      }),
    );
    expect(written?.outcome.ok).toBe(true);
    expect(receipt(written?.outcome)).toBe("transaction-staged");

    const removed = parseReplLocalRecord(
      replLocalRecordJson({
        operation: "file-delete",
        fingerprint,
        request: { cwd: WRITE.cwd, path: WRITE.path },
        outcome: Ok(undefined),
      }),
    );
    // Nothing at all, which is what a delete answers with. No receipt is
    // manufactured for it.
    expect(removed?.outcome.ok).toBe(true);
    expect(removed?.outcome.ok === true && removed.outcome.value).toBe(undefined);

    const refused = parseReplLocalRecord(
      replLocalRecordJson({
        operation: "file-write",
        fingerprint,
        request: WRITE,
        outcome: Err(fileWriteFailure({ phase: "commit", reason: "no-space" })),
      }),
    );
    expect(refused?.outcome.ok).toBe(false);
    // Rebuilt as a conforming failure, phase and target included.
    const data =
      refused?.outcome.ok === false ? Reflect.get(refused.outcome.error, "data") : undefined;
    expect(Reflect.get(Object(data), "phase")).toBe("commit");
    expect(Reflect.get(Object(data), "reason")).toBe("no-space");
  });

  it("refuses a payload carrying anything this version did not write", function* () {
    const fingerprint = yield* replLocalFingerprint({
      operation: "file-write",
      request: WRITE,
    });
    const valid = replLocalRecordJson({
      operation: "file-write",
      fingerprint,
      request: WRITE,
      outcome: Ok(fileWriteSuccess("host-committed")),
    });
    expect(parseReplLocalRecord(valid)).not.toBe(undefined);

    // An extra member is a record this host did not write, so what the rest of
    // it means is unknown.
    expect(parseReplLocalRecord({ ...Object(valid), extra: 1 })).toBe(undefined);
    // A write with no content, and a delete carrying some, each describe an
    // operation this host does not perform.
    expect(
      parseReplLocalRecord({ ...Object(valid), request: { cwd: "/work", path: "note.md" } }),
    ).toBe(undefined);
    expect(
      parseReplLocalRecord({
        ...Object(valid),
        operation: "file-delete",
        success: null,
      }),
    ).toBe(undefined);
    // And a write whose success is the absence a delete answers with.
    expect(parseReplLocalRecord({ ...Object(valid), success: null })).toBe(undefined);
  });

  it("says which refusals the record format can carry", function* () {
    expect(
      retainableRefusal(filesFailure({ operation: "delete", phase: "access", reason: "missing" })),
    ).toBe(true);
    expect(retainableRefusal(fileWriteFailure({ phase: "lexical", reason: "empty-path" }))).toBe(
      true,
    );
    // Anything else is a broken provider contract rather than an outcome.
    expect(retainableRefusal(new Error("something went wrong"))).toBe(false);
  });

  it("reads back saved routing, and its absence", function* () {
    const fingerprint = yield* replSelectionFingerprint({ cwd: "/work" });
    const found = parseReplSelectionRecord(
      replSelectionRecordJson({
        cwd: "/work",
        checkout: { checkoutRoot: "/work", commonDirectory: "/work/.git" },
      }),
    );
    expect(found?.checkout).toEqual({ checkoutRoot: "/work", commonDirectory: "/work/.git" });

    const absent = parseReplSelectionRecord(
      replSelectionRecordJson({ cwd: "/elsewhere", checkout: undefined }),
    );
    // Absence is a value this host remembers, not a failure it retries.
    expect(absent?.checkout).toBe(null);
    expect(replSelectionRecordName({ fingerprint }).length > 0).toBe(true);
  });
});

describe("what one entry's placement records say", () => {
  it("names a selection by its kind and its complete normalized request", function* () {
    const repository = yield* replPlacementFingerprint(REPOSITORY_REQUEST);
    const renamed = yield* replPlacementFingerprint({ ...REPOSITORY_REQUEST, name: "other" });
    const based = yield* replPlacementFingerprint({ ...REPOSITORY_REQUEST, base: "main" });
    const worktree = yield* replPlacementFingerprint({
      kind: "worktree",
      name: "project",
      branch: "main",
      base: null,
      owner: IDENTITY,
      commonDirectory: "/managed/repositories/slot/checkout/.git",
      ownerCheckout: "/managed/repositories/slot/checkout",
    });
    const ambient = yield* replPlacementFingerprint({ kind: "ambient-owner", cwd: "/work" });

    // Every fact in the request is identity, and the kind is too.
    expect(new Set([repository, renamed, based, worktree, ambient]).size).toBe(5);
    // And the same request twice is the same name, which is what makes two
    // equal selections one name at two ordered positions.
    expect(yield* replPlacementFingerprint(REPOSITORY_REQUEST)).toBe(repository);
    expect(
      replPlacementRecordName({ kind: "repository", fingerprint: repository }) ===
        replPlacementRecordName({ kind: "worktree", fingerprint: repository }),
    ).toBe(false);
  });

  it("reads back the routing a successful selection recorded", function* () {
    const fingerprint = yield* replPlacementFingerprint(REPOSITORY_REQUEST);
    const payload = replPlacementRecordJson({
      fingerprint,
      request: REPOSITORY_REQUEST,
      outcome: Ok(PLACEMENT),
    });

    const record = parseReplPlacementRecord(payload);
    expect(record?.kind).toBe("repository");
    expect(record?.outcome.ok === true ? record.outcome.value.checkoutRoot : undefined).toBe(
      PLACEMENT.checkoutRoot,
    );
    expect(record?.outcome.ok === true ? record.outcome.value.identity.name : undefined).toBe(
      "project",
    );
    // A payload carrying anything this version did not write describes
    // something other than a selection this host made.
    expect(parseReplPlacementRecord({ ...Object(payload), extra: 1 })).toBe(undefined);
    expect(parseReplPlacementRecord({ ...Object(payload), version: 2 })).toBe(undefined);
    expect(parseReplPlacementRecord({ ...Object(payload), kind: "elsewhere" })).toBe(undefined);
  });

  it("requires a managed root of exactly the kinds a managed root places", function* () {
    const ambient: ReplPlacementRequest = { kind: "ambient-owner", cwd: "/work" };
    const fingerprint = yield* replPlacementFingerprint(ambient);
    const owner = replPlacementRecordJson({
      fingerprint,
      request: ambient,
      outcome: Ok({ ...PLACEMENT, kind: "ambient-owner", managedRoot: undefined }),
    });

    // An ambient owner is the checkout the person was already in, so nothing
    // placed it.
    expect(parseReplPlacementRecord(owner)?.kind).toBe("ambient-owner");
    const placed = Object(owner);
    expect(
      parseReplPlacementRecord({
        ...placed,
        placement: { ...Object(placed["placement"]), managedRoot: "/managed" },
      }),
    ).toBe(undefined);

    // And a repository selection without one disagrees with its own kind.
    const repository = Object(
      replPlacementRecordJson({
        fingerprint: yield* replPlacementFingerprint(REPOSITORY_REQUEST),
        request: REPOSITORY_REQUEST,
        outcome: Ok(PLACEMENT),
      }),
    );
    expect(
      parseReplPlacementRecord({
        ...repository,
        placement: { ...Object(repository["placement"]), managedRoot: null },
      }),
    ).toBe(undefined);
  });

  it("reads an ambient absence as null alone, and refuses anything else", function* () {
    const ambient: ReplPlacementRequest = { kind: "ambient-owner", cwd: "/work" };
    const fingerprint = yield* replPlacementFingerprint(ambient);
    const payload = Object(
      replPlacementRecordJson({
        fingerprint,
        request: ambient,
        outcome: Ok({ ...PLACEMENT, kind: "ambient-owner", managedRoot: undefined }),
      }),
    );
    const placement = Object(payload["placement"]);

    // The control: absence is written as null, and reads back as absence.
    expect(placement["managedRoot"]).toBe(null);
    expect(parseReplPlacementRecord(payload)?.kind).toBe("ambient-owner");

    // A value that is present and is not a managed root is a record this
    // version did not write, not a record that carried no root. Reading the two
    // as one answer would let a malformed ambient placement bind a path.
    for (const stated of [42, "", true, {}, [], 0]) {
      expect(
        parseReplPlacementRecord({ ...payload, placement: { ...placement, managedRoot: stated } }),
      ).toBe(undefined);
    }
  });

  it("carries only a refusal word its own vocabulary names", function* () {
    const fingerprint = yield* replPlacementFingerprint(REPOSITORY_REQUEST);
    const refused = Object(
      replPlacementRecordJson({
        fingerprint,
        request: REPOSITORY_REQUEST,
        outcome: Err(
          new ReplPlacementRefusal({
            vocabulary: "managed",
            reason: "incompatible-reuse",
            sentence: "the managed checkout was created from a different url.",
          }),
        ),
      }),
    );

    const record = parseReplPlacementRecord(refused);
    expect(record?.outcome.ok).toBe(false);
    expect(record?.outcome.ok === false ? record.outcome.error.message : undefined).toContain(
      "different url",
    );

    // A word outside the closed set is not a refusal this build may rebuild,
    // and neither is a vocabulary it does not speak. `in-use` is deliberately
    // absent: contention is decided before the recorded selection begins.
    for (const refusal of [
      { vocabulary: "managed", reason: "in-use", sentence: "busy" },
      { vocabulary: "managed", reason: "invented", sentence: "busy" },
      { vocabulary: "elsewhere", reason: "incompatible-reuse", sentence: "busy" },
      { vocabulary: "worktree", reason: "no-repository-context", sentence: "busy" },
      { vocabulary: "managed", reason: "incompatible-reuse", sentence: "" },
    ]) {
      expect(parseReplPlacementRecord({ ...refused, refusal })).toBe(undefined);
    }
  });
});

describe("which histories one entry will continue", () => {
  it("admits its own records, including repeated equal names", function* () {
    const once = yield* localEvent("file-write", WRITE);
    const twice = yield* localEvent("file-write", WRITE);
    expect(once.type === "yield" && twice.type === "yield").toBe(true);
    // The same name at two ordered positions, which is what one entry writing
    // the same file twice produces — and what two entries writing the same file
    // produce as well. Nothing in a name says which entry wrote it, because
    // which history an entry may replay is its own segment's range rather than
    // a label inside the record.
    expect(once.type === "yield" ? once.description.name : "").toBe(
      twice.type === "yield" ? twice.description.name : "",
    );
    expect(yield* refusalOf([once, twice])).toBe(undefined);
  });

  it("passes over records of other features and other types", function* () {
    const foreign: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: "exec", name: "echo" },
      result: { status: "ok", value: null },
    };
    expect(
      yield* refusalOf([
        foreign,
        yield* localEvent("dir-ensure", {
          cwd: "/work",
          path: "drafts",
        }),
      ]),
    ).toBe(undefined);
  });

  it("refuses a record whose request no longer produces its name", function* () {
    const event = yield* localEvent("file-write", WRITE);
    // The request is changed after the work was saved, which is the one way a
    // saved result could answer a question nobody asked.
    const tampered: DurableEvent = {
      ...event,
      result: {
        status: "ok",
        value: {
          ...Object(saved(event)),
          request: { cwd: "/work", path: "note.md", content: "somebody else's" },
        },
      },
    };
    const refusal = yield* refusalOf([tampered]);
    expect(refusal?.reason).toBe("request-fingerprint");
  });

  it("refuses a record journaled under a name it does not produce", function* () {
    const event = yield* localEvent("file-write", WRITE, undefined, "something-else");
    const refusal = yield* refusalOf([event]);
    expect(refusal?.reason).toBe("request-fingerprint");
  });

  it("refuses a record of this type it cannot read", function* () {
    const malformed: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: REPL_REPOSITORY_LOCAL, name: "whatever" },
      result: {
        status: "ok",
        value: { version: REPL_REPOSITORY_VERSION, operation: "file-write" },
      },
    };
    const refusal = yield* refusalOf([malformed]);
    expect(refusal?.reason).toBe("malformed-record");
  });

  it("refuses a record stating a version this host does not implement", function* () {
    const later: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: REPL_REPOSITORY_SELECTION, name: "whatever" },
      result: { status: "ok", value: { version: REPL_REPOSITORY_VERSION + 1, cwd: "/work" } },
    };
    const refusal = yield* refusalOf([later]);
    expect(refusal?.reason).toBe("unknown-version");
    // A later version is told apart from a broken record, so the person is
    // told which of the two they have.
    expect(refusal?.message).toContain(`version ${REPL_REPOSITORY_VERSION + 1}`);
  });

  it("admits a placement record, including repeated equal names", function* () {
    const first = yield* placementEvent();
    const second = yield* placementEvent();
    expect(first.type === "yield" && second.type === "yield").toBe(true);
    expect(yield* refusalOf([first, second])).toBe(undefined);
  });

  it("refuses a placement record it cannot read", function* () {
    const event = yield* placementEvent();
    const broken: DurableEvent = {
      ...event,
      result: { status: "ok", value: { version: REPL_REPOSITORY_VERSION, kind: "repository" } },
    };
    expect((yield* refusalOf([broken]))?.reason).toBe("malformed-record");
  });

  it("refuses a placement record stating a version this host does not implement", function* () {
    const event = yield* placementEvent();
    const stated: DurableEvent = {
      ...event,
      result: {
        status: "ok",
        value: { ...payloadOf(event), version: 2 },
      },
    };
    expect((yield* refusalOf([stated]))?.reason).toBe("unknown-version");
  });

  it("refuses a placement whose request no longer produces its fingerprint", function* () {
    const event = yield* placementEvent();
    const changed: DurableEvent = {
      ...event,
      result: {
        status: "ok",
        value: {
          ...payloadOf(event),
          request: { name: "elsewhere", locatorFingerprint: "a".repeat(64), base: null },
        },
      },
    };
    expect((yield* refusalOf([changed]))?.reason).toBe("request-fingerprint");
  });

  it("refuses a placement journaled under a name it does not produce", function* () {
    const event = yield* placementEvent(REPOSITORY_REQUEST, Ok(PLACEMENT), "another name");
    expect((yield* refusalOf([event]))?.reason).toBe("request-fingerprint");
  });

  it("refuses an ambient placement whose managed root is not one", function* () {
    const ambient: ReplPlacementRequest = { kind: "ambient-owner", cwd: "/work" };
    const event = yield* placementEvent(
      ambient,
      Ok({
        ...PLACEMENT,
        kind: "ambient-owner",
        managedRoot: undefined,
      }),
    );
    // The valid-null control is admitted.
    expect(yield* refusalOf([event])).toBe(undefined);

    const placement = Object(payloadOf(event)["placement"]);
    const malformed: DurableEvent = {
      ...event,
      result: {
        status: "ok",
        value: { ...payloadOf(event), placement: { ...placement, managedRoot: 42 } },
      },
    };
    expect((yield* refusalOf([malformed]))?.reason).toBe("malformed-record");
  });

  it("admits an empty history", function* () {
    const events: readonly DurableEvent[] = [];
    expect(yield* refusalOf(events)).toBe(undefined);
    // The positive control: this admission can refuse, so admitting nothing is
    // an answer rather than a scan that never looked.
    const refusal = yield* refusalOf([
      yield* localEvent("file-write", WRITE, undefined, "not-its-own-name"),
    ]);
    expect(refusal?.reason).toBe("request-fingerprint");
  });
});

/** The payload one journaled event carries, for a fixture that edits it. */
function saved(event: DurableEvent): Json {
  if (event.type !== "yield" || event.result.status !== "ok") {
    throw new Error("the fixture event carries no payload");
  }
  return event.result.value ?? null;
}

const GIT_PLACE = {
  repository: IDENTITY,
  selectionCheckout: "/work/checkout",
  commonDirectory: "/work/checkout/.git",
  workingDirectory: "/work/checkout",
} as const;

/**
 * The checkout a native result names: an absolute host path.
 *
 * Which is the whole difference from the Workflow parsers beside these. A
 * Workspace-relative path is what a workflow run retains, and an ordinary
 * checkout is a directory on somebody's own filesystem.
 */
const GIT_CHECKOUT = Object.freeze({
  repositoryName: "project",
  worktreeName: null,
  checkoutPath: "/work/checkout",
});

const AT_REST = Object.freeze({
  branch: "main",
  commit: "c".repeat(40),
  headTree: "d".repeat(40),
  indexTree: "d".repeat(40),
});

const ADD_REQUEST: ReplGitRequest = Object.freeze({
  operation: "add",
  ...GIT_PLACE,
  paths: Object.freeze(["note.md", "note.md"]),
});

const ADD_RESULT: GitAddResult = Object.freeze({
  checkout: GIT_CHECKOUT,
  paths: Object.freeze(["note.md", "note.md"]),
  before: AT_REST,
  // Staging moves the index and nothing else.
  after: Object.freeze({ ...AT_REST, indexTree: "e".repeat(40) }),
});

const SWITCH_REQUEST: ReplGitRequest = Object.freeze({
  operation: "switch",
  ...GIT_PLACE,
  branch: "experiment",
  base: null,
});

const SWITCH_RESULT: GitSwitchResult = Object.freeze({
  checkout: GIT_CHECKOUT,
  requestedBranch: "experiment",
  resolvedBranch: "experiment",
  requestedBase: null,
  // Created, so it ends at the commit it was created from and on another branch.
  resolvedBase: "c".repeat(40),
  before: AT_REST,
  after: Object.freeze({ ...AT_REST, branch: "experiment" }),
});

const STAGED = Object.freeze({ ...AT_REST, indexTree: "e".repeat(40) });

const COMMIT_REQUEST: ReplGitRequest = Object.freeze({
  operation: "commit",
  ...GIT_PLACE,
  messageSource: "prop",
  messageDigest: "f".repeat(64),
  messageLength: 18,
});

const COMMIT_RESULT: GitCommitResult = Object.freeze({
  checkout: GIT_CHECKOUT,
  messageSource: "prop",
  messageDigest: "f".repeat(64),
  messageLength: 18,
  parent: "c".repeat(40),
  tree: "e".repeat(40),
  commit: "1".repeat(40),
  committedAt: 1_700_000_000,
  before: STAGED,
  after: Object.freeze({
    branch: "main",
    commit: "1".repeat(40),
    headTree: "e".repeat(40),
    indexTree: "e".repeat(40),
  }),
});

/** The payload one local Git record is journaled with. */
function gitPayload(
  request: ReplGitRequest,
  outcome: Result<ReplGitValue>,
): Operation<{ payload: Json; fingerprint: string }> {
  return (function* () {
    const fingerprint = yield* replGitFingerprint(request);
    return { payload: replGitRecordJson({ fingerprint, request, outcome }), fingerprint };
  })();
}

/** One journaled local Git operation, named the way the host names it. */
function* gitEvent(
  request: ReplGitRequest,
  outcome: Result<ReplGitValue>,
  name?: string,
): Operation<DurableEvent> {
  const { payload, fingerprint } = yield* gitPayload(request, outcome);
  return {
    type: "yield",
    coroutineId: "root",
    description: {
      type: REPL_REPOSITORY_GIT,
      name: name ?? replGitRecordName({ operation: request.operation, fingerprint }),
    },
    result: { status: "ok", value: payload },
  };
}

/** The saved value one record's outcome carries, for editing it member by member. */
function savedValue(payload: Json): Record<string, unknown> {
  const outcome = Object(Object(payload)["outcome"]);
  return { ...Object(outcome["value"]) };
}

/** That payload again, with this value in place of the one it carried. */
function withValue(payload: Json, value: unknown): unknown {
  return { ...Object(payload), outcome: { ok: true, value } };
}

describe("what one entry's local Git records say", () => {
  it("names an operation by its complete request", function* () {
    const add = yield* replGitFingerprint(ADD_REQUEST);
    const elsewhere = yield* replGitFingerprint({
      ...ADD_REQUEST,
      workingDirectory: "/work/checkout/inside",
    });
    const other = yield* replGitFingerprint({ ...ADD_REQUEST, paths: ["other.md"] });
    const ordered = yield* replGitFingerprint({ ...ADD_REQUEST, paths: ["note.md"] });
    const switched = yield* replGitFingerprint(SWITCH_REQUEST);
    const committed = yield* replGitFingerprint(COMMIT_REQUEST);

    // The directory, the pathspecs, their repetitions and the operation are all
    // identity.
    expect(new Set([add, elsewhere, other, ordered, switched, committed]).size).toBe(6);
    // And the same request twice is the same name, which is what makes two
    // equal Adds one name at two ordered positions.
    expect(yield* replGitFingerprint(ADD_REQUEST)).toBe(add);
    // The name carries the operation beside the digest, so two operations can
    // never share one.
    expect(replGitRecordName({ operation: "add", fingerprint: add })).not.toBe(
      replGitRecordName({ operation: "switch", fingerprint: add }),
    );
  });

  it("reads back each operation's own result, and refuses another's", function* () {
    for (const [request, result] of [
      [ADD_REQUEST, ADD_RESULT],
      [SWITCH_REQUEST, SWITCH_RESULT],
      [COMMIT_REQUEST, COMMIT_RESULT],
    ] as const) {
      const { payload } = yield* gitPayload(request, Ok(result));
      const record = parseReplGitRecord(payload);
      expect(record?.operation).toBe(request.operation);
      expect(record?.outcome.ok === true ? record.outcome.value : undefined).toEqual(result);
    }

    // A result of another operation standing where this one belongs is not an
    // outcome of it, whatever else it is.
    const { payload } = yield* gitPayload(ADD_REQUEST, Ok(ADD_RESULT));
    expect(parseReplGitRecord(withValue(payload, { ...SWITCH_RESULT }))).toBe(undefined);
  });

  it("refuses a result carrying a wrong, extra or missing member", function* () {
    const { payload } = yield* gitPayload(ADD_REQUEST, Ok(ADD_RESULT));
    // The positive control: the record this host wrote parses.
    expect(parseReplGitRecord(payload)).not.toBe(undefined);

    const value = savedValue(payload);
    expect(parseReplGitRecord(withValue(payload, { ...value, extra: 1 }))).toBe(undefined);
    const { paths: _dropped, ...missing } = value;
    expect(parseReplGitRecord(withValue(payload, missing))).toBe(undefined);
    expect(parseReplGitRecord(withValue(payload, { ...value, paths: "note.md" }))).toBe(undefined);
    expect(parseReplGitRecord(withValue(payload, { ...value, paths: [] }))).toBe(undefined);
    // A host checkout path is read as the string it is; nothing else is one.
    expect(
      parseReplGitRecord(
        withValue(payload, { ...value, checkout: { ...GIT_CHECKOUT, checkoutPath: 42 } }),
      ),
    ).toBe(undefined);
    // And the repository a result names has to be the one the request
    // authenticated.
    expect(
      parseReplGitRecord(
        withValue(payload, {
          ...value,
          checkout: { ...GIT_CHECKOUT, repositoryName: "another" },
        }),
      ),
    ).toBe(undefined);
    // A whole record missing one of its five wire members is not one either.
    const { outcome: _outcome, ...envelope } = Object(payload);
    expect(parseReplGitRecord(envelope)).toBe(undefined);
    expect(parseReplGitRecord({ ...Object(payload), surprise: true })).toBe(undefined);
  });

  it("refuses an object id of the wrong width for the request's format", function* () {
    const { payload } = yield* gitPayload(COMMIT_REQUEST, Ok(COMMIT_RESULT));
    const value = savedValue(payload);
    // A sha1 repository names its objects in forty hex characters. A sixty-four
    // character id is a real digest and still not one of this repository's.
    expect(parseReplGitRecord(withValue(payload, { ...value, commit: "1".repeat(64) }))).toBe(
      undefined,
    );
    expect(parseReplGitRecord(withValue(payload, { ...value, commit: "1".repeat(39) }))).toBe(
      undefined,
    );
    expect(parseReplGitRecord(withValue(payload, { ...value, commit: "Z".repeat(40) }))).toBe(
      undefined,
    );
    // A time and a byte length are whole and never negative.
    expect(parseReplGitRecord(withValue(payload, { ...value, committedAt: -1 }))).toBe(undefined);
    expect(parseReplGitRecord(withValue(payload, { ...value, messageLength: 1.5 }))).toBe(
      undefined,
    );
  });

  it("refuses a transition the operation does not make", function* () {
    const add = yield* gitPayload(ADD_REQUEST, Ok(ADD_RESULT));
    const moved = savedValue(add.payload);
    // Staging moves the index. A result whose commit or HEAD tree moved
    // across it describes something `git add` does not do.
    expect(
      parseReplGitRecord(
        withValue(add.payload, {
          ...moved,
          after: { ...ADD_RESULT.after, commit: "9".repeat(40) },
        }),
      ),
    ).toBe(undefined);

    const commit = yield* gitPayload(COMMIT_REQUEST, Ok(COMMIT_RESULT));
    const graph = savedValue(commit.payload);
    // A commit continues the commit the checkout was on, and holds the tree the
    // index described.
    expect(
      parseReplGitRecord(withValue(commit.payload, { ...graph, parent: "9".repeat(40) })),
    ).toBe(undefined);
    expect(parseReplGitRecord(withValue(commit.payload, { ...graph, tree: "9".repeat(40) }))).toBe(
      undefined,
    );
    // Committing an index that already matched HEAD is the condition this
    // operation refuses rather than one it records.
    expect(
      parseReplGitRecord(
        withValue(commit.payload, {
          ...graph,
          before: { ...STAGED, indexTree: STAGED.headTree },
        }),
      ),
    ).toBe(undefined);

    const switched = yield* gitPayload(SWITCH_REQUEST, Ok(SWITCH_RESULT));
    const branch = savedValue(switched.payload);
    // A created branch ends at the commit it was created from and cannot be the
    // branch the checkout was already on.
    expect(
      parseReplGitRecord(
        withValue(switched.payload, {
          ...branch,
          after: { ...SWITCH_RESULT.after, commit: "9".repeat(40) },
        }),
      ),
    ).toBe(undefined);
    // And switching to the branch a checkout is already on moves nothing.
    expect(
      parseReplGitRecord(
        withValue(switched.payload, {
          ...branch,
          resolvedBase: null,
          after: { ...AT_REST, indexTree: "9".repeat(40) },
        }),
      ),
    ).toBe(undefined);
  });

  it("refuses a result whose arguments are not the ones the request asked for", function* () {
    const add = yield* gitPayload(ADD_REQUEST, Ok(ADD_RESULT));
    // Order and repetitions are part of what was asked for, because each of
    // them changes what Git stages.
    expect(
      parseReplGitRecord(
        withValue(add.payload, { ...savedValue(add.payload), paths: ["note.md"] }),
      ),
    ).toBe(undefined);

    const switched = yield* gitPayload(SWITCH_REQUEST, Ok(SWITCH_RESULT));
    const branch = savedValue(switched.payload);
    expect(
      parseReplGitRecord(
        withValue(switched.payload, {
          ...branch,
          requestedBranch: "other",
          resolvedBranch: "other",
          after: { ...SWITCH_RESULT.after, branch: "other" },
        }),
      ),
    ).toBe(undefined);
    expect(
      parseReplGitRecord(withValue(switched.payload, { ...branch, requestedBase: "main" })),
    ).toBe(undefined);

    const commit = yield* gitPayload(COMMIT_REQUEST, Ok(COMMIT_RESULT));
    const evidence = savedValue(commit.payload);
    expect(
      parseReplGitRecord(withValue(commit.payload, { ...evidence, messageDigest: "a".repeat(64) })),
    ).toBe(undefined);
    expect(
      parseReplGitRecord(withValue(commit.payload, { ...evidence, messageSource: "children" })),
    ).toBe(undefined);
    expect(parseReplGitRecord(withValue(commit.payload, { ...evidence, messageLength: 19 }))).toBe(
      undefined,
    );
  });

  it("carries any supplied Switch base exactly, the empty string included", function* () {
    const supplied: ReplGitRequest = Object.freeze({ ...SWITCH_REQUEST, base: "" });
    const result: GitSwitchResult = Object.freeze({ ...SWITCH_RESULT, requestedBase: "" });
    const { payload } = yield* gitPayload(supplied, Ok(result));

    // Round trips as the bytes it was given. A base is a value the caller
    // supplied rather than a fact this host derived, the ordinary performer
    // consults one only to create a branch, and an acknowledged success has to
    // be readable — so the empty string is carried rather than refused.
    const record = parseReplGitRecord(payload);
    expect(record?.request.operation === "switch" ? record.request.base : undefined).toBe("");
    expect(
      record?.outcome.ok === true && "requestedBase" in record.outcome.value
        ? record.outcome.value.requestedBase
        : undefined,
    ).toBe("");
    // And it names a different operation from the same request with no base,
    // so the two cannot be confused for one another.
    expect(yield* replGitFingerprint(supplied)).not.toBe(yield* replGitFingerprint(SWITCH_REQUEST));

    // Request and result still have to agree about it.
    const value = savedValue(payload);
    expect(parseReplGitRecord(withValue(payload, { ...value, requestedBase: null }))).toBe(
      undefined,
    );

    // Everything that is neither a string nor null is still a record this
    // version did not write — on both sides.
    for (const wrong of [42, {}, [], true]) {
      expect(
        parseReplGitRecord({
          ...Object(payload),
          request: { ...Object(Object(payload)["request"]), base: wrong },
        }),
      ).toBe(undefined);
      expect(parseReplGitRecord(withValue(payload, { ...value, requestedBase: wrong }))).toBe(
        undefined,
      );
    }
    // An absent member is absent, not an absent base.
    const { base: _dropped, ...missing } = Object(Object(payload)["request"]);
    expect(parseReplGitRecord({ ...Object(payload), request: missing })).toBe(undefined);

    // The branch stays a non-empty name: it is what the operation is of.
    expect(
      parseReplGitRecord({
        ...Object(payload),
        request: { ...Object(Object(payload)["request"]), branch: "" },
      }),
    ).toBe(undefined);

    // And the commit a created branch started at is still an object id, which
    // the empty string is not.
    expect(parseReplGitRecord(withValue(payload, { ...value, resolvedBase: "" }))).toBe(undefined);
  });

  it("reads back a refusal, and refuses a word outside the closed set", function* () {
    const { payload } = yield* gitPayload(
      ADD_REQUEST,
      Err(new ReplGitRefusal({ vocabulary: "native-git", reason: "ignored-pathspec" })),
    );
    const record = parseReplGitRecord(payload);
    expect(record?.outcome.ok).toBe(false);
    const carried =
      record?.outcome.ok === false ? replGitRefusalOf(record.outcome.error) : undefined;
    // The route stays the route it was. An ignored path native Git reported is
    // not the Workflow formatter's condition, which claims the staging was
    // discarded.
    expect(carried).toEqual({ vocabulary: "native-git", reason: "ignored-pathspec" });

    const refused = { ...Object(payload) };
    for (const error of [
      { vocabulary: "native-git", reason: "empty-index" },
      { vocabulary: "composition-git", reason: "ignored-pathspec" },
      { vocabulary: "somewhere-else", reason: "ignored-pathspec" },
      { vocabulary: "native-git", reason: "something new" },
      { vocabulary: "native-git" },
      { vocabulary: "native-git", reason: "ignored-pathspec", sentence: "git said so" },
    ]) {
      expect(parseReplGitRecord({ ...refused, outcome: { ok: false, error } })).toBe(undefined);
    }
    // A settlement that states neither side, and one that states the wrong
    // one, are both records this host did not write.
    expect(parseReplGitRecord({ ...refused, outcome: { ok: true, error: {} } })).toBe(undefined);
    expect(
      parseReplGitRecord({
        ...refused,
        outcome: { ok: false, error: { vocabulary: "native-git", reason: "ignored-pathspec" } },
      }),
    ).not.toBe(undefined);

    // Each route's own word, for the two the other vocabularies own.
    const empty = yield* gitPayload(
      COMMIT_REQUEST,
      Err(new ReplGitRefusal({ vocabulary: "composition-git", reason: "empty-index" })),
    );
    expect(parseReplGitRecord(empty.payload)?.outcome.ok).toBe(false);
    const unresolved = yield* gitPayload(
      COMMIT_REQUEST,
      Err(new ReplGitRefusal({ vocabulary: "ordinary-identity", reason: "unresolved-identity" })),
    );
    expect(parseReplGitRecord(unresolved.payload)?.outcome.ok).toBe(false);
  });
});

describe("which local Git histories one entry will continue", () => {
  it("admits its own records, including repeated equal names", function* () {
    const first = yield* gitEvent(ADD_REQUEST, Ok(ADD_RESULT));
    const second = yield* gitEvent(ADD_REQUEST, Ok(ADD_RESULT));
    const refused = yield* gitEvent(
      SWITCH_REQUEST,
      Err(new ReplGitRefusal({ vocabulary: "native-git", reason: "overwrites-local-changes" })),
    );
    expect(yield* refusalOf([first, second, refused])).toBe(undefined);
  });

  it("refuses a local Git record it cannot read", function* () {
    const event = yield* gitEvent(ADD_REQUEST, Ok(ADD_RESULT));
    const broken: DurableEvent = {
      ...event,
      result: { status: "ok", value: { version: REPL_REPOSITORY_VERSION, operation: "add" } },
    };
    expect((yield* refusalOf([broken]))?.reason).toBe("malformed-record");
  });

  it("refuses a local Git record stating a version this host does not implement", function* () {
    const event = yield* gitEvent(ADD_REQUEST, Ok(ADD_RESULT));
    const stated: DurableEvent = {
      ...event,
      result: { status: "ok", value: { ...payloadOf(event), version: 2 } },
    };
    expect((yield* refusalOf([stated]))?.reason).toBe("unknown-version");
  });

  it("refuses a local Git record whose request no longer names it", function* () {
    const event = yield* gitEvent(ADD_REQUEST, Ok(ADD_RESULT));
    const changed: DurableEvent = {
      ...event,
      result: {
        status: "ok",
        value: {
          ...payloadOf(event),
          request: {
            repository: { ...IDENTITY },
            selectionCheckout: "/work/checkout",
            commonDirectory: "/work/checkout/.git",
            workingDirectory: "/somewhere/else",
            paths: ["note.md", "note.md"],
          },
        },
      },
    };
    expect((yield* refusalOf([changed]))?.reason).toBe("request-fingerprint");

    const misnamed = yield* gitEvent(ADD_REQUEST, Ok(ADD_RESULT), "another name");
    expect((yield* refusalOf([misnamed]))?.reason).toBe("request-fingerprint");
  });

  it("refuses a failed protocol envelope for a local Git record", function* () {
    const event = yield* gitEvent(ADD_REQUEST, Ok(ADD_RESULT));
    const failed: DurableEvent = {
      ...event,
      result: { status: "err", error: { name: "Error", message: "something went wrong" } },
    };
    // This operation's own refusals live inside its successful payload, so a
    // failed envelope under this type is not a record this host ever wrote.
    expect((yield* refusalOf([failed]))?.reason).toBe("malformed-record");
  });

  it("admits a history holding only the older record types", function* () {
    const file = yield* localEvent("file-write", WRITE);
    const placement = yield* placementEvent();
    expect(yield* refusalOf([file, placement])).toBe(undefined);
    // Together with a local Git record, which is what an entry that did both
    // leaves behind.
    expect(
      yield* refusalOf([file, placement, yield* gitEvent(COMMIT_REQUEST, Ok(COMMIT_RESULT))]),
    ).toBe(undefined);
  });
});
