/**
 * R1 and R2 — what a REPL entry's history has to say before it continues
 * repository work, and every way it can fail to say it.
 *
 * The protocol is small now, and so is its defence. A record says what one
 * operation was asked for and what it produced; admission reads every record of
 * this feature's own types, holds each to this entry's owner and to the name its
 * own request produces, and answers with what it holds. There is no state to
 * fold, no frontier to compare and no lane to order — the REPL's execution model
 * accepts that a recorded result and the live environment can disagree.
 *
 * So these tests are the closed protocol itself: one positive history that
 * reads back whole, then each inconsistency on its own, because a reader that
 * refused them all together could still be refusing for one reason and missing
 * the rest.
 *
 * Every fixture's fingerprint is computed from the request beside it, through
 * the module's own encoder, rather than written as a literal. A placeholder
 * string would make the positive cases pass while the check that holds a
 * request to its name was missing entirely.
 *
 * Nothing here is a live occurrence. The sites and owners are fixtures, and a
 * fixture that admits cleanly proves the reading rules and nothing about
 * authenticity — R2's engine-authenticated identity is proven through actual
 * canonical execution elsewhere.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import type { Operation, Result } from "effection";
import { fileWriteFailure, filesFailure } from "@executablemd/runtime";
import {
  detachedJson,
  parseReplRepositoryRequest,
  parseReplRepositoryResult,
  replRepositoryRecordName,
  replRepositoryRequestJson,
  replRepositoryResultJson,
  REPL_REPOSITORY_REQUEST,
  REPL_REPOSITORY_RESULT,
  REPL_REPOSITORY_VERSION,
  retainedFileResult,
  retainedRepositoryOutcome,
  retainedRepositoryOwner,
  retainedRepositoryRefusal,
  retainedRepositoryRequestFingerprint,
} from "../src/retained-repository/records.ts";
import type {
  ReplRepositoryRequest,
  ReplRepositoryResult,
  RetainedRepositoryOperation,
  RetainedRepositorySite,
} from "../src/retained-repository/records.ts";
import { admitRetainedRepositoryHistory } from "../src/retained-repository/admission.ts";
import type { RetainedRepositoryHistory } from "../src/retained-repository/admission.ts";

const OWNER = retainedRepositoryOwner({ executionId: "execution-1", entryKey: "0001" });
const OTHER = retainedRepositoryOwner({ executionId: "execution-1", entryKey: "0002" });
const SOURCE = "entry.md";
const CHECKOUT = "/checkouts/project";

/** One site, named by the occurrence a claimant would have minted. */
function site(occurrence: string, source = SOURCE): RetainedRepositorySite {
  return Object.freeze({ source, occurrence });
}

interface ResultFixture {
  readonly owner?: string;
  readonly site?: RetainedRepositorySite;
  readonly operation?: RetainedRepositoryOperation;
  readonly request?: Json;
  readonly result?: Json;
  /** A fingerprint other than the one this request produces. */
  readonly fingerprint?: string;
}

/** One recorded result, fingerprinted through the module's own encoder. */
function* result(fixture: ResultFixture = {}): Operation<ReplRepositoryResult> {
  const owner = fixture.owner ?? OWNER;
  const where = fixture.site ?? site("write-1");
  const operation = fixture.operation ?? "file-write";
  const request = fixture.request ?? { cwd: CHECKOUT, path: "notes.md", content: "the note\n" };
  const fingerprint =
    fixture.fingerprint ??
    (yield* retainedRepositoryRequestFingerprint({
      owner,
      site: where,
      operation,
      selection: null,
      request,
    }));
  return Object.freeze({
    version: REPL_REPOSITORY_VERSION,
    owner,
    site: where,
    operation,
    fingerprint,
    request,
    result: fixture.result ?? { type: "file-write", publication: "host-committed" },
  });
}

/** One resolved external request, fingerprinted the same way. */
function* resolved(fixture: ResultFixture = {}): Operation<ReplRepositoryRequest> {
  const owner = fixture.owner ?? OWNER;
  const where = fixture.site ?? site("push-1");
  const operation = fixture.operation ?? "push";
  const request = fixture.request ?? { cwd: CHECKOUT };
  const fingerprint =
    fixture.fingerprint ??
    (yield* retainedRepositoryRequestFingerprint({
      owner,
      site: where,
      operation,
      selection: null,
      request,
    }));
  return Object.freeze({
    version: REPL_REPOSITORY_VERSION,
    owner,
    site: where,
    operation,
    fingerprint,
    request,
    resolved: fixture.result ?? { branch: "main", commit: "a".repeat(40) },
  });
}

/** One journal event of a given durable type, named as the host names it. */
function event(type: string, name: string, value: Json): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type, name },
    result: { status: "ok", value },
  } as DurableEvent;
}

/** This result as the journal holds it, under the name the host gives it. */
function recorded(value: ReplRepositoryResult, name?: string): DurableEvent {
  return event(
    REPL_REPOSITORY_RESULT,
    name ??
      replRepositoryRecordName({
        phase: "result",
        owner: value.owner,
        fingerprint: value.fingerprint,
        operation: value.operation,
      }),
    replRepositoryResultJson(value),
  );
}

/** This request as the journal holds it, under the name the host gives it. */
function requested(value: ReplRepositoryRequest, name?: string): DurableEvent {
  return event(
    REPL_REPOSITORY_REQUEST,
    name ??
      replRepositoryRecordName({
        phase: "request",
        owner: value.owner,
        fingerprint: value.fingerprint,
        operation: value.operation,
      }),
    replRepositoryRequestJson(value),
  );
}

/** The members of a record's encoding, for a test that replaces one. */
function fields(value: Json): Record<string, Json> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("a record encodes to an object");
  }
  return { ...value };
}

function accepted(read: Result<RetainedRepositoryHistory>): RetainedRepositoryHistory {
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

function reasonOf(read: Result<RetainedRepositoryHistory>): string {
  if (read.ok) {
    throw new Error("this history was accepted, and it must be refused");
  }
  return Reflect.get(read.error, "reason") as string;
}

/**
 * One error payload as plain journal data, which is how a record holds it.
 *
 * Read through the same parser the records themselves are read with, so a
 * fixture cannot hand these rows a value a journal could not carry.
 */
function json(data: unknown): Json {
  const read = detachedJson(data);
  if (read === undefined) {
    throw new Error("this fixture's payload is not something a journal can hold");
  }
  return read;
}

describe("REPL repository records", () => {
  it("R1: reads back every result and request this entry retained", function* () {
    const write = yield* result();
    const push = yield* resolved();
    const read = accepted(
      yield* admitRetainedRepositoryHistory([recorded(write), requested(push)], OWNER),
    );

    expect(read.owner).toBe(OWNER);
    expect(read.results.map((held) => held.operation)).toEqual(["file-write"]);
    expect(read.requests.map((held) => held.operation)).toEqual(["push"]);
    // What the record says it was asked for, and what it produced. No state.
    expect(read.results[0]?.request).toEqual(write.request);
    expect(read.results[0]?.result).toEqual(write.result);
    expect(read.requests[0]?.resolved).toEqual(push.resolved);
  });

  it("R1: reads nothing from another feature, another type or a failed effect", function* () {
    const write = yield* result();
    const read = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          event("some_other_effect", "elsewhere", { anything: true }),
          {
            type: "close",
            coroutineId: "root",
            result: { status: "ok", value: null },
          } as unknown as DurableEvent,
          {
            type: "yield",
            coroutineId: "root",
            description: { type: REPL_REPOSITORY_RESULT, name: "failed" },
            result: { status: "err", error: { name: "Error", message: "no" } },
          } as unknown as DurableEvent,
          recorded(write),
        ],
        OWNER,
      ),
    );
    expect(read.results).toHaveLength(1);
  });

  it("R1: accepted data is detached from the payload it was read out of", function* () {
    const write = yield* result();
    const payload = fields(replRepositoryResultJson(write));
    const read = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          event(
            REPL_REPOSITORY_RESULT,
            replRepositoryRecordName({
              phase: "result",
              owner: write.owner,
              fingerprint: write.fingerprint,
              operation: write.operation,
            }),
            payload as unknown as Json,
          ),
        ],
        OWNER,
      ),
    );
    // Mutating what the journal handed over cannot change what was admitted.
    payload["owner"] = OTHER;
    expect(read.results[0]?.owner).toBe(OWNER);
  });

  it("R1: a record round-trips through its journal encoding", function* () {
    const write = yield* result();
    expect(parseReplRepositoryResult(replRepositoryResultJson(write))).toEqual(write);
    const push = yield* resolved();
    expect(parseReplRepositoryRequest(replRepositoryRequestJson(push))).toEqual(push);
  });

  it("R2: the owner is the execution and the entry together", function* () {
    expect(OWNER).toBe('repl:v1:["execution-1","0001"]');
    expect(OTHER).not.toBe(OWNER);
  });

  it("R2: identical text at two occurrences asks two questions", function* () {
    const first = yield* result({ site: site("write-1") });
    const second = yield* result({ site: site("write-2") });
    // The same request, written twice in one document, is two operations: the
    // occurrence is part of what names each one.
    expect(second.fingerprint).not.toBe(first.fingerprint);
    const read = accepted(
      yield* admitRetainedRepositoryHistory([recorded(first), recorded(second)], OWNER),
    );
    expect(read.results).toHaveLength(2);
  });

  it("R2: the same request in another source is another question", function* () {
    const here = yield* result({ site: site("write-1") });
    const elsewhere = yield* result({ site: site("write-1", "<eval>") });
    expect(elsewhere.fingerprint).not.toBe(here.fingerprint);
  });

  it("R1: an authored request changed without its fingerprint is refused", function* () {
    const write = yield* result();
    const changed = { ...write, request: { ...fields(write.request), path: "elsewhere.md" } };
    expect(
      reasonOf(
        yield* admitRetainedRepositoryHistory(
          [
            recorded(
              changed as ReplRepositoryResult,
              replRepositoryRecordName({
                phase: "result",
                owner: write.owner,
                fingerprint: write.fingerprint,
                operation: write.operation,
              }),
            ),
          ],
          OWNER,
        ),
      ),
    ).toBe("request-fingerprint");
  });

  it("R1: a record journaled under another operation's name is refused", function* () {
    const write = yield* result();
    const misnamed = replRepositoryRecordName({
      phase: "result",
      owner: write.owner,
      fingerprint: write.fingerprint,
      operation: "commit",
    });
    expect(
      reasonOf(yield* admitRetainedRepositoryHistory([recorded(write, misnamed)], OWNER)),
    ).toBe("request-fingerprint");
  });

  it("R2: a result belonging to another entry is refused", function* () {
    const write = yield* result({ owner: OTHER });
    expect(reasonOf(yield* admitRetainedRepositoryHistory([recorded(write)], OWNER))).toBe(
      "foreign-owner",
    );
  });

  it("R2: a resolved request belonging to another entry is refused", function* () {
    const push = yield* resolved({ owner: OTHER });
    expect(reasonOf(yield* admitRetainedRepositoryHistory([requested(push)], OWNER))).toBe(
      "foreign-owner",
    );
  });

  it("R1: two records of one operation are refused rather than chosen between", function* () {
    const write = yield* result();
    expect(
      reasonOf(yield* admitRetainedRepositoryHistory([recorded(write), recorded(write)], OWNER)),
    ).toBe("duplicate-record");
  });

  it("R1: a later version is refused as itself, not as a broken record", function* () {
    const write = yield* result();
    const payload = fields(replRepositoryResultJson(write));
    payload["version"] = REPL_REPOSITORY_VERSION + 1;
    expect(
      reasonOf(
        yield* admitRetainedRepositoryHistory(
          [event(REPL_REPOSITORY_RESULT, "any", payload as unknown as Json)],
          OWNER,
        ),
      ),
    ).toBe("unknown-version");
  });

  it("R1: an unknown member and a missing one are both refused", function* () {
    const write = yield* result();
    const extra = fields(replRepositoryResultJson(write));
    extra["mood"] = "cheerful";
    expect(
      reasonOf(
        yield* admitRetainedRepositoryHistory(
          [event(REPL_REPOSITORY_RESULT, "any", extra as unknown as Json)],
          OWNER,
        ),
      ),
    ).toBe("malformed-record");

    const missing = fields(replRepositoryResultJson(write));
    delete missing["result"];
    expect(
      reasonOf(
        yield* admitRetainedRepositoryHistory(
          [event(REPL_REPOSITORY_RESULT, "any", missing as unknown as Json)],
          OWNER,
        ),
      ),
    ).toBe("malformed-record");
  });

  it("R1: a resolved request missing its resolution is refused", function* () {
    const push = yield* resolved();
    const missing = fields(replRepositoryRequestJson(push));
    delete missing["resolved"];
    expect(
      reasonOf(
        yield* admitRetainedRepositoryHistory(
          [event(REPL_REPOSITORY_REQUEST, "any", missing as unknown as Json)],
          OWNER,
        ),
      ),
    ).toBe("malformed-record");
  });

  it("R1: the experimental snapshot protocol's records are refused, not migrated", function* () {
    const write = yield* result();
    for (const type of ["retained_repository_intent", "retained_repository_completion"]) {
      expect(
        reasonOf(
          yield* admitRetainedRepositoryHistory(
            [event(type, "whatever that protocol called it", { version: 1 }), recorded(write)],
            OWNER,
          ),
        ),
      ).toBe("superseded-protocol");
    }
  });

  it("R1: a history with no repository records at all is admitted as empty", function* () {
    const read = accepted(
      yield* admitRetainedRepositoryHistory(
        [event("import_component", "File", { kind: "registered" })],
        OWNER,
      ),
    );
    expect(read.results).toEqual([]);
    expect(read.requests).toEqual([]);
  });

  it("R1: a value carrying a function or a cycle describes no record", function* () {
    const cyclic: Record<string, unknown> = { version: 1 };
    cyclic["self"] = cyclic;
    expect(detachedJson(cyclic)).toBeUndefined();
    expect(parseReplRepositoryResult(cyclic)).toBeUndefined();
    expect(parseReplRepositoryResult({ version: 1, owner: OWNER, apply: () => true })).toBe(
      undefined,
    );
  });

  /**
   * The two branches a saved file outcome has, and everything that is neither.
   *
   * The reader these rows exercise is the one a continuation asks before it
   * acts on a record: failing to be this operation's refusal is not being its
   * success, so a value from another operation — or no operation at all — has
   * to read as neither rather than falling through to one of them.
   */
  const FILE_OUTCOMES = [
    {
      operation: "file-write" as const,
      refusal: json(fileWriteFailure({ phase: "target", reason: "read-only" }).data),
    },
    {
      operation: "file-delete" as const,
      refusal: json(
        filesFailure({ operation: "delete", phase: "target", reason: "read-only" }).data,
      ),
    },
    {
      operation: "dir-ensure" as const,
      refusal: json(
        filesFailure({ operation: "ensure-directory", phase: "target", reason: "read-only" }).data,
      ),
    },
  ];

  // A well-formed Files failure belonging to none of the three, and a failure
  // too malformed for any parser to read.
  const ANOTHER_OPERATION = json(
    filesFailure({ operation: "read", phase: "target", reason: "read-only" }).data,
  );
  const MALFORMED: Json = { type: "executablemd.runtime.files-error/v1", operation: "delete" };

  for (const { operation, refusal } of FILE_OUTCOMES) {
    it(`R5: only ${operation}'s own result or refusal reads as an outcome`, function* () {
      // The two it can produce.
      expect(retainedRepositoryOutcome(operation, retainedFileResult(operation))).toBe(true);
      expect(retainedRepositoryOutcome(operation, refusal)).toBe(true);
      // The refusal still reads as the refusal it is, which is what makes the
      // row above about the success branch rather than about both at once.
      expect(retainedRepositoryRefusal(operation, refusal)).toBe(true);
      expect(retainedRepositoryRefusal(operation, retainedFileResult(operation))).toBe(false);

      // And everything that is neither: another operation's failure, one no
      // parser can read, another file operation's success, and a value from
      // somewhere else entirely.
      expect(retainedRepositoryOutcome(operation, ANOTHER_OPERATION)).toBe(false);
      expect(retainedRepositoryOutcome(operation, MALFORMED)).toBe(false);
      expect(retainedRepositoryOutcome(operation, null)).toBe(false);
      for (const other of FILE_OUTCOMES) {
        if (other.operation !== operation) {
          expect(retainedRepositoryOutcome(operation, retainedFileResult(other.operation))).toBe(
            false,
          );
          expect(retainedRepositoryOutcome(operation, other.refusal)).toBe(false);
        }
      }
    });
  }

  it("R5: a file write's result is its whole encoding, not part of it", function* () {
    // Compared as the value it is, so a result missing the member that says
    // what became of the file — or carrying one this host never wrote — is not
    // the result this operation produces.
    expect(retainedRepositoryOutcome("file-write", { type: "file-write" })).toBe(false);
    expect(
      retainedRepositoryOutcome("file-write", {
        type: "file-write",
        publication: "host-committed",
        checkout: "/somewhere",
      }),
    ).toBe(false);
  });

  it("R5: an operation with no fixed result keeps the one it saved", function* () {
    // A commit keeps its SHA and a selection its placement, so there is no
    // fixed word to hold them to and the reader that owns those members is the
    // one that parses them. Nothing here may start refusing them.
    expect(retainedRepositoryOutcome("commit", { commit: "a".repeat(40) })).toBe(true);
    expect(retainedRepositoryOutcome("ambient", { type: "ambient", checkout: "/anywhere" })).toBe(
      true,
    );
    expect(retainedRepositoryOutcome("add", ANOTHER_OPERATION)).toBe(true);
  });
});
