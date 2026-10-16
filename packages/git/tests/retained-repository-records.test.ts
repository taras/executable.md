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
