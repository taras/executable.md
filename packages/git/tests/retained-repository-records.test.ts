/**
 * R1 and R2 — what a retained repository history has to say before an entry
 * resumes repository work, and every way it can fail to say it.
 *
 * The protocol is the whole defence here. Slice A installs nothing and selects
 * nothing: it reads the frozen snapshot core admitted and either describes the
 * work it holds or refuses the history. So these tests are the closed protocol
 * itself — one positive history that folds to the right state, then each
 * inconsistency on its own, because a reader that refused them all together
 * could still be refusing for one reason and missing the rest.
 *
 * Every fixture's fingerprint is computed from the request beside it, through
 * the module's own encoders, rather than written as a literal. A placeholder
 * string would make the positive cases pass while the check that holds a
 * request to its name was missing entirely.
 *
 * Nothing here is a live occurrence. The sites and owners are fixtures, and a
 * fixture that admits cleanly proves the sequence rules and nothing about
 * authenticity — R2's engine-authenticated identity is slice B's and slice D's
 * to prove, through actual canonical execution.
 */

import { FILES_WRITE_SUCCESS, fileWriteFailure, filesFailure } from "@executablemd/runtime";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import type { Operation, Result } from "effection";
import {
  RETAINED_REPOSITORY_COMPLETION,
  RETAINED_REPOSITORY_INTENT,
  parseRetainedRepositoryCompletion,
  parseRetainedRepositoryIntent,
  retainedFrontierJson,
  retainedRepositoryCompletionJson,
  retainedRepositoryIntentIdentity,
  retainedRepositoryIntentJson,
  retainedRepositoryOwner,
  detachedJson,
  retainedRepositoryRequestFingerprint,
} from "../src/retained-repository/records.ts";
import type {
  RetainedFrontier,
  RetainedRepositoryIntent,
  RetainedRepositoryOperation,
  RetainedRepositorySite,
} from "../src/retained-repository/records.ts";
import { admitRetainedRepositoryHistory } from "../src/retained-repository/admission.ts";
import type { RetainedRepositoryHistory } from "../src/retained-repository/admission.ts";

const OWNER = retainedRepositoryOwner({ executionId: "execution-1", entryKey: "0001" });
const OTHER = retainedRepositoryOwner({ executionId: "execution-1", entryKey: "0002" });

const COMMON = "/checkouts/project/.git";
const PRIMARY = "/checkouts/project";
const LINKED = "/checkouts/topic";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

/**
 * One checkout's state, with the shared `refs/heads/topic` at `topic`.
 *
 * The primary checkout and the linked worktree share one common directory and
 * one ref list, and each stands on its own branch — which is the shape the
 * shared-state folding rule is about.
 */
function frontier(checkout = PRIMARY, topic = A, main = A): RetainedFrontier {
  const primary = checkout === PRIMARY;
  return {
    checkout,
    administration: {
      common: COMMON,
      worktree: primary ? null : `${COMMON}/worktrees/topic`,
      role: primary ? "primary" : "linked",
    },
    objectFormat: "sha1",
    head: {
      kind: "symbolic",
      ref: primary ? "refs/heads/main" : "refs/heads/topic",
      oid: primary ? main : topic,
    },
    refs: [
      { name: "refs/heads/main", oid: main },
      { name: "refs/heads/topic", oid: topic },
    ],
    index: [],
    worktree: [],
  };
}

interface IntentFixture {
  readonly operation?: RetainedRepositoryOperation;
  readonly position?: number;
  readonly site?: RetainedRepositorySite;
  readonly owner?: string;
  readonly preState?: RetainedFrontier | null;
  readonly postState?: RetainedFrontier;
  readonly request?: Json;
  readonly lane?: { readonly common: string; readonly position: number };
}

/** One intent, named by the request beside it. */
function* intent(fixture: IntentFixture = {}): Operation<RetainedRepositoryIntent> {
  const position = fixture.position ?? 0;
  const preState = fixture.preState ?? frontier();
  const value = {
    version: 1 as const,
    owner: fixture.owner ?? OWNER,
    site: fixture.site ?? { source: "entry.md", occurrence: `occurrence-${position}` },
    operation: fixture.operation ?? "ambient",
    lane: fixture.lane ?? { common: COMMON, position },
    selection: { checkout: preState.checkout },
    request: fixture.request ?? { path: "notes.md" },
    prepared: { target: "notes.md" },
    preState,
    postState: fixture.postState ?? preState,
    evidence: { path: "notes.md" },
  };
  return {
    ...value,
    fingerprint: yield* retainedRepositoryRequestFingerprint(value),
  };
}

function event(type: string, value: Json): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type, name: "retained-repository" },
    result: { status: "ok", value },
  };
}

function intended(value: RetainedRepositoryIntent): DurableEvent {
  return event(RETAINED_REPOSITORY_INTENT, retainedRepositoryIntentJson(value));
}

interface CompletionFixture {
  readonly owner?: string;
  readonly site?: RetainedRepositorySite;
  readonly intent?: string;
  readonly fingerprint?: string;
  readonly frontier?: RetainedFrontier;
  readonly result?: Json;
}

function* completed(
  value: RetainedRepositoryIntent,
  fixture: CompletionFixture = {},
): Operation<DurableEvent> {
  return event(
    RETAINED_REPOSITORY_COMPLETION,
    retainedRepositoryCompletionJson({
      version: 1,
      owner: fixture.owner ?? OWNER,
      site: fixture.site ?? value.site,
      intent: fixture.intent ?? (yield* retainedRepositoryIntentIdentity(value)),
      fingerprint: fixture.fingerprint ?? value.fingerprint,
      result: fixture.result ?? value.evidence,
      frontier: fixture.frontier ?? value.postState,
    }),
  );
}

/**
 * The runtime's own failure data as the journal holds it.
 *
 * Parsed rather than cast: these records carry optional members, and what a
 * journal holds is whatever survives being written as JSON.
 */
function failureJson(data: unknown): Json {
  const value = detachedJson(data);
  if (value === undefined) {
    throw new Error("the runtime's failure data is not JSON");
  }
  return value;
}

/** The encoded record's members, so a test can add, drop or replace one. */
function fields(value: Json): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the encoder did not produce an object");
  }
  return { ...value };
}

/**
 * The state this intent starts from, for a fixture that only builds operations
 * which have one.
 */
function established(intent: RetainedRepositoryIntent): RetainedFrontier {
  if (intent.preState === null) {
    throw new Error("this fixture built an operation with no state to start from");
  }
  return intent.preState;
}

function accepted(result: Result<RetainedRepositoryHistory>): RetainedRepositoryHistory {
  if (!result.ok) {
    throw new Error(`expected an admitted history, found a refusal: ${result.error.message}`);
  }
  return result.value;
}

function reasonOf(result: Result<RetainedRepositoryHistory>): string {
  if (result.ok) {
    throw new Error("expected a refusal, found an admitted history");
  }
  const refusal = result.error;
  return "reason" in refusal && typeof refusal.reason === "string" ? refusal.reason : refusal.name;
}

function topicOf(state: RetainedFrontier): string | undefined {
  return state.refs.find((ref) => ref.name === "refs/heads/topic")?.oid;
}

/** The primary checkout and one linked worktree, with a commit on the linked branch. */
function* linkedHistory(): Operation<DurableEvent[]> {
  const primary = yield* intent({ operation: "ambient", position: 0 });
  const linked = yield* intent({
    operation: "worktree",
    position: 1,
    preState: frontier(LINKED),
  });
  const commit = yield* intent({
    operation: "commit",
    position: 2,
    preState: frontier(LINKED),
    postState: frontier(LINKED, B),
  });
  return [
    intended(primary),
    yield* completed(primary),
    intended(linked),
    yield* completed(linked),
    intended(commit),
    yield* completed(commit),
  ];
}

describe("retained repository records", () => {
  it("R1: folds a baseline, its completions and one pending intent", function* () {
    const baseline = yield* intent({ operation: "ambient", position: 0 });
    const commit = yield* intent({
      operation: "commit",
      position: 1,
      postState: frontier(PRIMARY, A, B),
    });
    const write = yield* intent({
      operation: "file-write",
      position: 2,
      preState: frontier(PRIMARY, A, B),
      postState: frontier(PRIMARY, A, C),
    });

    const history = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          intended(baseline),
          yield* completed(baseline),
          intended(commit),
          yield* completed(commit),
          intended(write),
        ],
        OWNER,
      ),
    );

    expect(history.completed.map((effect) => effect.intent.operation)).toEqual([
      "ambient",
      "commit",
    ]);
    expect(history.pending.map((effect) => effect.intent.operation)).toEqual(["file-write"]);

    expect(history.attachments.length).toBe(1);
    const attachment = history.attachments[0]!;
    expect(attachment.checkout).toBe(PRIMARY);
    // The state the accepted records establish, not the interrupted write's
    // prediction.
    expect(attachment.frontier.head.kind === "symbolic" && attachment.frontier.head.oid).toBe(B);
    // The pending write may have reached either side of its own transition, so
    // both stand beside the established state.
    expect(
      attachment.candidates.map((candidate) =>
        candidate.head.kind === "symbolic" ? candidate.head.oid : candidate.head.oid,
      ),
    ).toEqual([B, C]);
  });

  it("R1: reads nothing from another feature, another type or a failed effect", function* () {
    const baseline = yield* intent();
    const history = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          event("git_host_effect", { anything: true }),
          { type: "close", coroutineId: "root", result: { status: "ok" } },
          {
            type: "yield",
            coroutineId: "root",
            description: { type: RETAINED_REPOSITORY_INTENT, name: "retained-repository" },
            result: { status: "err", error: { message: "the append failed" } },
          },
          intended(baseline),
        ],
        OWNER,
      ),
    );
    expect(history.completed.length).toBe(0);
    expect(history.pending.length).toBe(1);
  });

  it("R1: accepted data is detached from the payload it was read out of", function* () {
    const payload = fields(retainedRepositoryIntentJson(yield* intent()));
    const history = accepted(
      yield* admitRetainedRepositoryHistory([event(RETAINED_REPOSITORY_INTENT, payload)], OWNER),
    );
    const before = history.pending[0]!.intent.request;

    const request = payload["request"];
    if (typeof request === "object" && request !== null && !Array.isArray(request)) {
      request["path"] = "substituted.md";
    }

    expect(history.pending[0]!.intent.request).toBe(before);
    expect(before).toEqual({ path: "notes.md" });
  });

  it("R1: a record round-trips through its journal encoding", function* () {
    const value = yield* intent();
    const read = parseRetainedRepositoryIntent(retainedRepositoryIntentJson(value));
    expect(read?.fingerprint).toBe(value.fingerprint);
    expect(read?.preState?.administration.role).toBe("primary");

    const identity = yield* retainedRepositoryIntentIdentity(value);
    const completion = yield* completed(value);
    const encoded = completion.type === "yield" ? completion.result : undefined;
    const record = parseRetainedRepositoryCompletion(
      encoded?.status === "ok" ? encoded.value : undefined,
    );
    expect(record?.intent).toBe(identity);
  });

  it("R2: the owner is the execution and the entry together", function* () {
    expect(OWNER).toBe('repl:v1:["execution-1","0001"]');
    expect(OWNER === OTHER).toBe(false);
    expect(retainedRepositoryOwner({ executionId: "execution-2", entryKey: "0001" })).not.toBe(
      OWNER,
    );
  });

  it("R2: identical text at two occurrences asks two questions", function* () {
    const request = {
      owner: OWNER,
      operation: "commit",
      selection: { checkout: PRIMARY },
      request: { message: "Record the note" },
    } as const;
    const first = yield* retainedRepositoryRequestFingerprint({
      ...request,
      site: { source: "entry.md", occurrence: "loop#0" },
    });
    const again = yield* retainedRepositoryRequestFingerprint({
      ...request,
      site: { source: "entry.md", occurrence: "loop#0" },
    });
    const second = yield* retainedRepositoryRequestFingerprint({
      ...request,
      site: { source: "entry.md", occurrence: "loop#1" },
    });
    const elsewhere = yield* retainedRepositoryRequestFingerprint({
      ...request,
      site: { source: "generated:1", occurrence: "loop#0" },
    });
    const otherEntry = yield* retainedRepositoryRequestFingerprint({
      ...request,
      owner: OTHER,
      site: { source: "entry.md", occurrence: "loop#0" },
    });

    expect(again).toBe(first);
    expect(second).not.toBe(first);
    expect(elsewhere).not.toBe(first);
    expect(otherEntry).not.toBe(first);
  });

  it("R1: an authored request changed without its fingerprint is refused", function* () {
    const baseline = yield* intent();
    const changed = fields(
      retainedRepositoryIntentJson({ ...baseline, request: { path: "other.md" } }),
    );
    const result = yield* admitRetainedRepositoryHistory(
      [event(RETAINED_REPOSITORY_INTENT, changed)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("request-fingerprint");
  });

  it("R1: a changed selection or operation is refused by the same name", function* () {
    const baseline = yield* intent();
    const selection = yield* admitRetainedRepositoryHistory(
      [
        event(
          RETAINED_REPOSITORY_INTENT,
          fields(retainedRepositoryIntentJson({ ...baseline, selection: { checkout: LINKED } })),
        ),
      ],
      OWNER,
    );
    expect(reasonOf(selection)).toBe("request-fingerprint");

    const operation = yield* admitRetainedRepositoryHistory(
      [
        event(
          RETAINED_REPOSITORY_INTENT,
          fields(retainedRepositoryIntentJson({ ...baseline, operation: "repository" })),
        ),
      ],
      OWNER,
    );
    expect(reasonOf(operation)).toBe("request-fingerprint");
  });

  it("R2: an intent belonging to another entry is refused", function* () {
    const result = yield* admitRetainedRepositoryHistory(
      [intended(yield* intent({ owner: OTHER }))],
      OWNER,
    );
    expect(reasonOf(result)).toBe("foreign-owner");
  });

  it("R2: a completion belonging to another entry is refused", function* () {
    const baseline = yield* intent();
    const result = yield* admitRetainedRepositoryHistory(
      [intended(baseline), yield* completed(baseline, { owner: OTHER })],
      OWNER,
    );
    expect(reasonOf(result)).toBe("foreign-owner");
  });

  it("R1: a later version is refused as itself, not as a broken record", function* () {
    const payload = fields(retainedRepositoryIntentJson(yield* intent()));
    payload["version"] = 2;
    const result = yield* admitRetainedRepositoryHistory(
      [event(RETAINED_REPOSITORY_INTENT, payload)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("unknown-version");
  });

  it("R1: an unknown member and a missing one are both refused", function* () {
    const baseline = retainedRepositoryIntentJson(yield* intent());
    const extra = yield* admitRetainedRepositoryHistory(
      [event(RETAINED_REPOSITORY_INTENT, { ...fields(baseline), lease: "held" })],
      OWNER,
    );
    expect(reasonOf(extra)).toBe("malformed-record");

    const withoutEvidence = fields(baseline);
    delete withoutEvidence["evidence"];
    const missing = yield* admitRetainedRepositoryHistory(
      [event(RETAINED_REPOSITORY_INTENT, withoutEvidence)],
      OWNER,
    );
    expect(reasonOf(missing)).toBe("malformed-record");
  });

  it("R1: a frontier carrying a volatile member describes no frontier", function* () {
    const payload = fields(retainedRepositoryIntentJson(yield* intent()));
    payload["preState"] = { ...fields(payload["preState"]!), reflogTime: 1 };
    const result = yield* admitRetainedRepositoryHistory(
      [event(RETAINED_REPOSITORY_INTENT, payload)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("malformed-record");
  });

  it("R1: a completion from another source or occurrence is refused", function* () {
    const baseline = yield* intent();

    const source = yield* admitRetainedRepositoryHistory(
      [
        intended(baseline),
        yield* completed(baseline, {
          site: { source: "other.md", occurrence: "occurrence-0" },
        }),
      ],
      OWNER,
    );
    expect(reasonOf(source)).toBe("site-substitution");

    const occurrence = yield* admitRetainedRepositoryHistory(
      [
        intended(baseline),
        yield* completed(baseline, {
          site: { source: "entry.md", occurrence: "occurrence-9" },
        }),
      ],
      OWNER,
    );
    expect(reasonOf(occurrence)).toBe("site-substitution");
  });

  it("R1: a completion carrying a different authored request is refused", function* () {
    const baseline = yield* intent();
    const result = yield* admitRetainedRepositoryHistory(
      [intended(baseline), yield* completed(baseline, { fingerprint: "another-request" })],
      OWNER,
    );
    expect(reasonOf(result)).toBe("request-substitution");
  });

  it("R1: a completion substituting an unrelated checkout is refused", function* () {
    const baseline = yield* intent();
    const result = yield* admitRetainedRepositoryHistory(
      [
        intended(baseline),
        yield* completed(baseline, {
          frontier: { ...frontier(), checkout: "/unselected/checkout" },
        }),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("frontier-substitution");
  });

  it("R1: a completion carrying a state its intent never froze is refused", function* () {
    const baseline = yield* intent({
      operation: "commit",
      position: 1,
      postState: frontier(PRIMARY, A, B),
    });
    const selection = yield* intent();
    const result = yield* admitRetainedRepositoryHistory(
      [
        intended(selection),
        yield* completed(selection),
        intended(baseline),
        // Neither the state it started from nor the one it predicted.
        yield* completed(baseline, { frontier: frontier(PRIMARY, A, C) }),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("frontier-substitution");
  });

  it("R1: a closed refusal keeps the state it started from", function* () {
    const selection = yield* intent();
    const refused = yield* intent({
      operation: "add",
      position: 1,
      postState: frontier(PRIMARY, A, B),
    });
    const history = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          intended(selection),
          yield* completed(selection),
          intended(refused),
          // One word from the vocabulary a Git operation refuses in, which is
          // the only part of such a refusal that is retained at all.
          yield* completed(refused, {
            result: { reason: "unmatched-pathspec" },
            frontier: established(refused),
          }),
        ],
        OWNER,
      ),
    );
    expect(history.completed.length).toBe(2);
    expect(history.pending.length).toBe(0);
    expect(
      history.attachments[0]!.frontier.head.kind === "symbolic" &&
        history.attachments[0]!.frontier.head.oid,
    ).toBe(A);
  });

  it("R1: a successful write cannot stand at the state it was meant to change", function* () {
    const selection = yield* intent();
    const write = yield* intent({
      operation: "file-write",
      position: 1,
      postState: {
        ...frontier(),
        worktree: [{ kind: "file", path: "notes.md", mode: "100644", bytes: "bmV3IHRleHQ=" }],
      },
    });
    const result = yield* admitRetainedRepositoryHistory(
      [
        intended(selection),
        yield* completed(selection),
        intended(write),
        // The result its intent froze, at the state the file had before it.
        yield* completed(write, { frontier: established(write) }),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("unproven-outcome");
  });

  it("R1: a refusal cannot stand at the state its intent predicted", function* () {
    const selection = yield* intent();
    const commit = yield* intent({
      operation: "commit",
      position: 1,
      postState: frontier(PRIMARY, A, B),
    });
    const result = yield* admitRetainedRepositoryHistory(
      [
        intended(selection),
        yield* completed(selection),
        intended(commit),
        yield* completed(commit, { result: { reason: "empty-index" } }),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("unproven-outcome");
  });

  it("R1: a result that is neither the frozen one nor a refusal is refused", function* () {
    const selection = yield* intent();
    const commit = yield* intent({
      operation: "commit",
      position: 1,
      postState: frontier(PRIMARY, A, B),
    });
    const results: readonly Json[] = [
      // Not a word this operation refuses in.
      { reason: "dirty-worktree" },
      // Not a refusal shape at all.
      { refused: true },
      "refused",
    ];
    for (const result of results) {
      const admitted = yield* admitRetainedRepositoryHistory(
        [
          intended(selection),
          yield* completed(selection),
          intended(commit),
          yield* completed(commit, { result, frontier: established(commit) }),
        ],
        OWNER,
      );
      expect(reasonOf(admitted)).toBe("unproven-outcome");
    }
  });

  it("R1: a different ordinary write success is not a refusal", function* () {
    const selection = yield* intent();
    const write = yield* intent({
      operation: "file-write",
      position: 1,
      request: { cwd: PRIMARY, path: "notes.md", content: "new text" },
      postState: {
        ...frontier(),
        worktree: [{ kind: "file", path: "notes.md", mode: "100644", bytes: "bmV3IHRleHQ=" }],
      },
    });
    const result = yield* admitRetainedRepositoryHistory(
      [
        intended(selection),
        yield* completed(selection),
        intended(write),
        // An ordinary success the runtime recognizes, and not the one this
        // intent froze: the write happened, under a different publication.
        yield* completed(write, {
          result: { type: FILES_WRITE_SUCCESS, publication: "transaction-staged" },
          frontier: established(write),
        }),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("unproven-outcome");
  });

  it("R1: a write refusal is retained only where the target was left alone", function* () {
    const selection = yield* intent();
    const write = yield* intent({
      operation: "file-write",
      position: 1,
      request: { cwd: PRIMARY, path: "notes.md", content: "new text" },
      postState: {
        ...frontier(),
        worktree: [{ kind: "file", path: "notes.md", mode: "100644", bytes: "bmV3IHRleHQ=" }],
      },
    });

    const unchanged = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          intended(selection),
          yield* completed(selection),
          intended(write),
          yield* completed(write, {
            result: failureJson(
              fileWriteFailure({ phase: "target", reason: "permission-denied" }).data,
            ),
            frontier: established(write),
          }),
        ],
        OWNER,
      ),
    );
    expect(unchanged.completed.length).toBe(2);

    // The runtime's word for not knowing what became of the target. It is a
    // well-formed failure and it is not proof that nothing changed.
    const uncertain = yield* admitRetainedRepositoryHistory(
      [
        intended(selection),
        yield* completed(selection),
        intended(write),
        yield* completed(write, {
          result: failureJson(fileWriteFailure({ phase: "commit", reason: "no-space" }).data),
          frontier: established(write),
        }),
      ],
      OWNER,
    );
    expect(reasonOf(uncertain)).toBe("unproven-outcome");
  });

  it("R1: a delete's refusal has to be a delete's failure", function* () {
    // A delete that really changes something: the file is there before and
    // gone after, so the unchanged end is only reachable by a refusal.
    const present: RetainedFrontier = {
      ...frontier(),
      worktree: [{ kind: "file", path: "notes.md", mode: "100644", bytes: "b2xk" }],
    };
    const selection = yield* intent({ preState: present });
    const remove = yield* intent({
      operation: "file-delete",
      position: 1,
      request: { cwd: PRIMARY, path: "notes.md" },
      preState: present,
      postState: frontier(),
    });
    const history = [intended(selection), yield* completed(selection), intended(remove)];

    const refused = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          ...history,
          yield* completed(remove, {
            result: failureJson(
              filesFailure({ operation: "delete", phase: "access", reason: "permission-denied" })
                .data,
            ),
            frontier: established(remove),
          }),
        ],
        OWNER,
      ),
    );
    expect(refused.completed.length).toBe(2);

    // One parser answers for every non-write Files operation, so a well-formed
    // failure of another one is not this operation's refusal.
    for (const operation of ["read", "ensure-directory", "glob"] as const) {
      const substituted = yield* admitRetainedRepositoryHistory(
        [
          ...history,
          yield* completed(remove, {
            result: failureJson(
              filesFailure({ operation, phase: "access", reason: "permission-denied" }).data,
            ),
            frontier: established(remove),
          }),
        ],
        OWNER,
      );
      expect(reasonOf(substituted)).toBe("unproven-outcome");
    }
  });

  it("R1: a directory ensure's refusal has to be an ensure's failure", function* () {
    const ensured: RetainedFrontier = {
      ...frontier(),
      worktree: [{ kind: "directory", path: "notes", mode: "040755" }],
    };
    const selection = yield* intent();
    const ensure = yield* intent({
      operation: "dir-ensure",
      position: 1,
      request: { cwd: PRIMARY, path: "notes" },
      postState: ensured,
    });
    const history = [intended(selection), yield* completed(selection), intended(ensure)];

    const refused = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          ...history,
          yield* completed(ensure, {
            result: failureJson(
              filesFailure({
                operation: "ensure-directory",
                phase: "target",
                reason: "not-directory",
              }).data,
            ),
            frontier: established(ensure),
          }),
        ],
        OWNER,
      ),
    );
    expect(refused.completed.length).toBe(2);

    const substituted = yield* admitRetainedRepositoryHistory(
      [
        ...history,
        yield* completed(ensure, {
          result: failureJson(
            filesFailure({ operation: "delete", phase: "target", reason: "missing" }).data,
          ),
          frontier: established(ensure),
        }),
      ],
      OWNER,
    );
    expect(reasonOf(substituted)).toBe("unproven-outcome");
  });

  it("R1: a delete refusal is its own operation's failure data", function* () {
    const selection = yield* intent();
    const remove = yield* intent({
      operation: "file-delete",
      position: 1,
      request: { cwd: PRIMARY, path: "notes.md" },
      postState: { ...frontier(), worktree: [] },
    });
    const history = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          intended(selection),
          yield* completed(selection),
          intended(remove),
          yield* completed(remove, {
            result: failureJson(
              filesFailure({ operation: "delete", phase: "target", reason: "missing" }).data,
            ),
            frontier: established(remove),
          }),
        ],
        OWNER,
      ),
    );
    expect(history.completed.length).toBe(2);
  });

  it("R1: coincident ends still need a result this operation can produce", function* () {
    const selection = yield* intent();
    const noop = yield* intent({ operation: "dir-ensure", position: 1 });

    const admitted = accepted(
      yield* admitRetainedRepositoryHistory(
        [intended(selection), yield* completed(selection), intended(noop), yield* completed(noop)],
        OWNER,
      ),
    );
    expect(admitted.completed.length).toBe(2);

    const invalid = yield* admitRetainedRepositoryHistory(
      [
        intended(selection),
        yield* completed(selection),
        intended(noop),
        yield* completed(noop, { result: { existing: true } }),
      ],
      OWNER,
    );
    expect(reasonOf(invalid)).toBe("unproven-outcome");
  });

  it("R1: an intent whose frozen state is in another lane is refused", function* () {
    const result = yield* admitRetainedRepositoryHistory(
      [intended(yield* intent({ lane: { common: "/elsewhere/.git", position: 0 } }))],
      OWNER,
    );
    expect(reasonOf(result)).toBe("lane-mismatch");
  });

  it("R1: an intent whose transition names two checkouts is refused", function* () {
    const result = yield* admitRetainedRepositoryHistory(
      [
        intended(
          yield* intent({
            operation: "worktree",
            preState: frontier(PRIMARY),
            postState: frontier(LINKED),
          }),
        ),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("lane-mismatch");
  });

  it("R1: a completion with no intent is refused", function* () {
    const baseline = yield* intent();
    const result = yield* admitRetainedRepositoryHistory(
      [yield* completed(baseline, { intent: "nothing-names-this" })],
      OWNER,
    );
    expect(reasonOf(result)).toBe("completion-without-intent");
  });

  it("R1: a completion standing before its own intent is refused", function* () {
    const baseline = yield* intent();
    const result = yield* admitRetainedRepositoryHistory(
      [yield* completed(baseline), intended(baseline)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("misordered-completion");
  });

  it("R1: a second completion for one intent is refused", function* () {
    const baseline = yield* intent();
    const result = yield* admitRetainedRepositoryHistory(
      [intended(baseline), yield* completed(baseline), yield* completed(baseline)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("duplicate-completion");
  });

  it("R1: a lane position that does not advance is refused", function* () {
    const baseline = yield* intent();
    const commit = yield* intent({
      operation: "commit",
      position: 0,
      site: { source: "entry.md", occurrence: "occurrence-2" },
      postState: frontier(PRIMARY, A, B),
    });
    const result = yield* admitRetainedRepositoryHistory(
      [intended(baseline), yield* completed(baseline), intended(commit)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("misordered-lane");
  });

  it("R1: a mutation before any baseline is refused", function* () {
    const result = yield* admitRetainedRepositoryHistory(
      [intended(yield* intent({ operation: "commit", postState: frontier(PRIMARY, A, B) }))],
      OWNER,
    );
    expect(reasonOf(result)).toBe("missing-baseline");
  });

  it("R1: a pre-state the accepted records did not establish is refused", function* () {
    const baseline = yield* intent();
    const commit = yield* intent({
      operation: "commit",
      position: 1,
      preState: frontier(PRIMARY, A, C),
      postState: frontier(PRIMARY, A, B),
    });
    const result = yield* admitRetainedRepositoryHistory(
      [intended(baseline), yield* completed(baseline), intended(commit)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("broken-frontier-chain");
  });

  it("R1: two unresolved mutations of one shared Git directory are refused", function* () {
    const baseline = yield* intent();
    const commit = yield* intent({
      operation: "commit",
      position: 1,
      postState: frontier(PRIMARY, A, B),
    });
    const result = yield* admitRetainedRepositoryHistory(
      [intended(baseline), intended(commit)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("competing-mutation");
  });

  it("R1: a linked worktree's commit moves the shared refs every checkout sees", function* () {
    const history = accepted(yield* admitRetainedRepositoryHistory(yield* linkedHistory(), OWNER));

    const primary = history.attachments.find((value) => value.checkout === PRIMARY);
    const linked = history.attachments.find((value) => value.checkout === LINKED);
    expect(topicOf(primary!.frontier)).toBe(B);
    expect(topicOf(linked!.frontier)).toBe(B);
    // The primary checkout still stands where it stood: only the ref list moved.
    expect(primary!.frontier.head.kind === "symbolic" && primary!.frontier.head.ref).toBe(
      "refs/heads/main",
    );
    expect(primary!.frontier.head.kind === "symbolic" && primary!.frontier.head.oid).toBe(A);
  });

  it("R1: the next primary mutation is admitted against the moved shared refs", function* () {
    const next = yield* intent({
      operation: "file-write",
      position: 3,
      preState: frontier(PRIMARY, B),
      postState: frontier(PRIMARY, B),
    });
    const history = accepted(
      yield* admitRetainedRepositoryHistory([...(yield* linkedHistory()), intended(next)], OWNER),
    );
    expect(history.pending.map((effect) => effect.intent.operation)).toEqual(["file-write"]);
  });

  it("R1: a pending sibling mutation's shared refs reach the primary's candidates", function* () {
    const events = yield* linkedHistory();
    // Everything but the linked commit's completion: that mutation is
    // unresolved, and it may already have moved the ref both checkouts share.
    const history = accepted(yield* admitRetainedRepositoryHistory(events.slice(0, -1), OWNER));
    expect(history.pending.map((effect) => effect.intent.operation)).toEqual(["commit"]);

    const primary = history.attachments.find((value) => value.checkout === PRIMARY)!;
    // The established state is still the completed one, and the prediction
    // stands beside it rather than replacing it.
    expect(topicOf(primary.frontier)).toBe(A);
    expect(primary.candidates.map(topicOf)).toEqual([A, B]);
    // Only the refs travel: the primary keeps its own HEAD in every candidate.
    expect(
      primary.candidates.every(
        (candidate) =>
          candidate.head.kind === "symbolic" && candidate.head.ref === "refs/heads/main",
      ),
    ).toBe(true);
  });

  it("R1: a pending mutation in another common directory reaches no candidate here", function* () {
    const baseline = yield* intent();
    const separate: RetainedFrontier = {
      ...frontier(PRIMARY, A),
      checkout: "/checkouts/other",
      administration: { common: "/checkouts/other/.git", worktree: null, role: "primary" },
    };
    const other = yield* intent({
      operation: "repository",
      position: 0,
      site: { source: "entry.md", occurrence: "occurrence-other" },
      lane: { common: "/checkouts/other/.git", position: 0 },
      preState: separate,
    });
    const elsewhere = yield* intent({
      operation: "commit",
      position: 1,
      site: { source: "entry.md", occurrence: "occurrence-elsewhere" },
      lane: { common: "/checkouts/other/.git", position: 1 },
      preState: separate,
      postState: { ...separate, refs: [{ name: "refs/heads/main", oid: B }] },
    });

    const history = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          intended(baseline),
          yield* completed(baseline),
          intended(other),
          yield* completed(other),
          intended(elsewhere),
        ],
        OWNER,
      ),
    );
    const primary = history.attachments.find((value) => value.checkout === PRIMARY)!;
    expect(primary.candidates.length).toBe(1);
    expect(topicOf(primary.candidates[0]!)).toBe(A);
  });

  it("R1: shared refs do not travel to a checkout in another common directory", function* () {
    const baseline = yield* intent();
    const elsewhere = frontier(PRIMARY, A);
    const separate: RetainedFrontier = {
      ...elsewhere,
      checkout: "/checkouts/other",
      administration: { common: "/checkouts/other/.git", worktree: null, role: "primary" },
    };
    const other = yield* intent({
      operation: "repository",
      position: 0,
      site: { source: "entry.md", occurrence: "occurrence-other" },
      lane: { common: "/checkouts/other/.git", position: 0 },
      preState: separate,
    });
    const commit = yield* intent({
      operation: "commit",
      position: 1,
      postState: frontier(PRIMARY, B),
    });

    const history = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          intended(baseline),
          yield* completed(baseline),
          intended(other),
          yield* completed(other),
          intended(commit),
          yield* completed(commit),
        ],
        OWNER,
      ),
    );
    expect(topicOf(history.attachments.find((value) => value.checkout === PRIMARY)!.frontier)).toBe(
      B,
    );
    expect(
      topicOf(history.attachments.find((value) => value.checkout === "/checkouts/other")!.frontier),
    ).toBe(A);
  });
});

/**
 * R1 — a creation records the destination it does not have yet.
 *
 * Everything else in this protocol freezes the state it expects to find. A
 * creation cannot: the checkout it is about to establish is not there. So its
 * pre-state is absence, and what makes that recoverable is the rest of what it
 * freezes — the trusted slot, the metadata that will identify the destination,
 * and, for a worktree, what adding one does to the refs its owner shares.
 *
 * Absence is one thing and not a spare value. These hold it to that: only a
 * creation may record it, only with the closed preparation beside it, and it
 * establishes nothing until a completion says the destination is there.
 */
describe("retained repository records: a destination that is not there yet", () => {
  const REPOSITORY_METADATA: Json = {
    kind: "repository",
    version: 1,
    name: "project",
    locator: "https://example.invalid/project.git",
    locatorFingerprint: "f".repeat(64),
    requestedBase: null,
    creationCommit: "a".repeat(40),
    primaryBranch: "refs/heads/main",
    objectFormat: "sha1",
    commonDirectory: `${PRIMARY}/.git`,
  };

  const WORKTREE_METADATA: Json = {
    kind: "worktree",
    version: 1,
    owner: COMMON,
    name: "review",
    requestedBranch: "topic",
    requestedBase: null,
    // The commit the owner's own post-state puts `refs/heads/topic` at: adding
    // this worktree is what moves that ref, and a creation whose destination
    // stood somewhere else would be describing a pair that cannot exist.
    creationCommit: B,
    objectFormat: "sha1",
  };

  /** A creation of a checkout that is not there, with its own preparation. */
  function* creation(
    fixture: IntentFixture & {
      readonly operation: "repository" | "worktree";
      readonly prepared?: Json;
    },
  ): Operation<RetainedRepositoryIntent> {
    // The request a creation's own component writes, which is part of what the
    // saved metadata has to agree with: a Worktree's names the branch it is
    // asking for.
    const built = yield* intent({
      request:
        fixture.operation === "repository"
          ? { name: "project", url: "https://example.invalid/project.git", base: null }
          : { name: "review", branch: "topic", base: null, owner: PRIMARY },
      ...fixture,
    });
    const prepared = fixture.prepared ?? {
      slot: "/managed/repositories/project",
      metadata: fixture.operation === "repository" ? REPOSITORY_METADATA : WORKTREE_METADATA,
      owner:
        fixture.operation === "repository"
          ? null
          : {
              preState: retainedFrontierJson(frontier()),
              postState: retainedFrontierJson(frontier(PRIMARY, B)),
            },
    };
    return { ...built, preState: null, prepared };
  }

  it("R1: a creation's absent destination is admitted and establishes nothing yet", function* () {
    const made = yield* creation({ operation: "repository", postState: frontier() });
    const history = accepted(yield* admitRetainedRepositoryHistory([intended(made)], OWNER));

    expect(history.pending.length).toBe(1);
    expect(history.pending[0]!.intent.preState).toBe(null);
    // Nothing is attached: a destination that is not there is not a checkout
    // to attach to, and an unresolved creation offers it no candidate either.
    expect(history.attachments).toEqual([]);
  });

  it("R1: a completed creation is what establishes the checkout", function* () {
    const made = yield* creation({ operation: "repository", postState: frontier() });
    const history = accepted(
      yield* admitRetainedRepositoryHistory([intended(made), yield* completed(made)], OWNER),
    );

    expect(history.completed.length).toBe(1);
    expect(history.attachments.map((value) => value.checkout)).toEqual([PRIMARY]);
    expect(history.attachments[0]!.frontier.checkout).toBe(PRIMARY);
  });

  it("R1: later mutations advance a created checkout and replay folds to the end", function* () {
    const made = yield* creation({ operation: "repository", postState: frontier() });
    const write = yield* intent({
      operation: "file-write",
      position: 1,
      preState: frontier(),
      postState: frontier(PRIMARY, A, B),
    });
    const history = accepted(
      yield* admitRetainedRepositoryHistory(
        [intended(made), yield* completed(made), intended(write), yield* completed(write)],
        OWNER,
      ),
    );

    // The creation supplied the baseline and the mutation advanced it, so what
    // attachment offers is the end of that sequence rather than the initial
    // snapshot.
    expect(history.attachments.length).toBe(1);
    const head = history.attachments[0]!.frontier.head;
    expect(head.kind === "symbolic" && head.oid).toBe(B);
  });

  it("R1: only a creation may record an absent destination", function* () {
    const write = yield* intent({ operation: "file-write", postState: frontier(PRIMARY, A, B) });
    const payload = fields(retainedRepositoryIntentJson(write));
    payload["preState"] = null;
    const result = yield* admitRetainedRepositoryHistory(
      [event(RETAINED_REPOSITORY_INTENT, payload)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("malformed-record");
  });

  it("R1: an absent destination without readable creation data is refused", function* () {
    const unreadable: readonly Json[] = [
      // Not the closed shape at all.
      { target: "notes.md" },
      // A repository cannot carry an owner, and a worktree must.
      {
        slot: "/managed/repositories/project",
        metadata: REPOSITORY_METADATA,
        owner: {
          preState: retainedFrontierJson(frontier()),
          postState: retainedFrontierJson(frontier()),
        },
      },
      // Metadata this version cannot read.
      { slot: "/managed/repositories/project", metadata: { kind: "repository" }, owner: null },
    ];
    for (const prepared of unreadable) {
      const made = yield* creation({
        operation: "repository",
        postState: frontier(),
        prepared,
      });
      const result = yield* admitRetainedRepositoryHistory([intended(made)], OWNER);
      expect(reasonOf(result)).toBe("malformed-record");
    }
  });

  it("R1: a worktree creation without its owner's two states is refused", function* () {
    const made = yield* creation({
      operation: "worktree",
      postState: frontier(LINKED),
      prepared: {
        slot: "/managed/worktrees/review",
        metadata: WORKTREE_METADATA,
        owner: null,
      },
    });
    const result = yield* admitRetainedRepositoryHistory([intended(made)], OWNER);
    expect(reasonOf(result)).toBe("malformed-record");
  });

  it("R1: creating a destination this history already established is refused", function* () {
    const selection = yield* intent();
    const again = yield* creation({
      operation: "repository",
      position: 1,
      postState: frontier(),
    });
    const result = yield* admitRetainedRepositoryHistory(
      [intended(selection), yield* completed(selection), intended(again)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("broken-frontier-chain");
  });

  it("R1: a worktree creation needs its owner already established, in that state", function* () {
    const made = yield* creation({
      operation: "worktree",
      postState: frontier(LINKED, B),
    });
    // No owner baseline at all.
    const missing = yield* admitRetainedRepositoryHistory([intended(made)], OWNER);
    expect(reasonOf(missing)).toBe("missing-baseline");

    // An owner this history established in a different state.
    const owner = yield* intent({ preState: frontier(PRIMARY, A, B) });
    const drifted = yield* admitRetainedRepositoryHistory(
      [
        intended(owner),
        yield* completed(owner),
        intended(
          yield* creation({ operation: "worktree", position: 1, postState: frontier(LINKED, B) }),
        ),
      ],
      OWNER,
    );
    expect(reasonOf(drifted)).toBe("broken-frontier-chain");
  });

  it("R1: a creation's completion may stand only where it predicted", function* () {
    const made = yield* creation({ operation: "repository", postState: frontier() });
    // There is no unchanged end to a creation: a completion anywhere but the
    // predicted destination is not this creation's.
    const result = yield* admitRetainedRepositoryHistory(
      [intended(made), yield* completed(made, { frontier: frontier(PRIMARY, A, B) })],
      OWNER,
    );
    expect(reasonOf(result)).toBe("frontier-substitution");
  });

  it("R1: a worktree creation's owner and destination must predict one ref list", function* () {
    const owner = yield* intent();
    // Everything about the owner's own checkout is preserved, and only the
    // shared refs are put back the way they were — an owner that predicts it
    // gains nothing, beside a destination checked out on a branch somebody has
    // to have created.
    const made = yield* creation({
      operation: "worktree",
      position: 1,
      postState: frontier(LINKED, B),
      prepared: {
        slot: "/managed/worktrees/review",
        metadata: WORKTREE_METADATA,
        owner: {
          preState: retainedFrontierJson(frontier()),
          postState: retainedFrontierJson(frontier()),
        },
      },
    });
    const result = yield* admitRetainedRepositoryHistory(
      [intended(owner), yield* completed(owner), intended(made)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("malformed-record");
  });

  it("R1: a worktree creation's two halves must agree on the object format", function* () {
    const owner = yield* intent();
    // The shared refs agree and the commit is the destination's own, and the
    // owner is described as a repository of another object format — which is
    // not a repository this worktree could be a checkout of.
    const made = yield* creation({
      operation: "worktree",
      position: 1,
      postState: frontier(LINKED, B),
      prepared: {
        slot: "/managed/worktrees/review",
        metadata: WORKTREE_METADATA,
        owner: {
          // Both of the owner's ends, so the transition between them is a ref
          // advance like any other and what disagrees is the owner against the
          // destination.
          preState: {
            ...(retainedFrontierJson(frontier()) as Record<string, Json>),
            objectFormat: "sha256",
          },
          postState: {
            ...(retainedFrontierJson(frontier(PRIMARY, B)) as Record<string, Json>),
            objectFormat: "sha256",
          },
        },
      },
    });
    const result = yield* admitRetainedRepositoryHistory(
      [intended(owner), yield* completed(owner), intended(made)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("malformed-record");
  });

  it("R1: a worktree creation's saved branch is the one its request named", function* () {
    const owner = yield* intent();
    // Everything else agrees: the owner's two states, the shared refs, the
    // commit, the administration. Only the branch the metadata saved is not
    // the branch the document asked for — and the branch the metadata saved is
    // the one that would be created.
    const made = yield* creation({
      operation: "worktree",
      position: 1,
      postState: frontier(LINKED, B),
      prepared: {
        slot: "/managed/worktrees/review",
        metadata: { ...WORKTREE_METADATA, requestedBranch: "another-branch" },
        owner: {
          preState: retainedFrontierJson(frontier()),
          postState: retainedFrontierJson(frontier(PRIMARY, B)),
        },
      },
    });
    const result = yield* admitRetainedRepositoryHistory(
      [intended(owner), yield* completed(owner), intended(made)],
      OWNER,
    );
    expect(reasonOf(result)).toBe("malformed-record");
  });

  it("R1: a worktree creation whose branch agrees everywhere is admitted", function* () {
    const owner = yield* intent();
    const made = yield* creation({
      operation: "worktree",
      position: 1,
      postState: frontier(LINKED, B),
    });
    const history = accepted(
      yield* admitRetainedRepositoryHistory(
        [intended(owner), yield* completed(owner), intended(made)],
        OWNER,
      ),
    );
    expect(history.pending.length).toBe(1);
    expect(history.pending[0]!.intent.operation).toBe("worktree");
  });

  it("R1: an unresolved worktree creation offers its owner's two ends", function* () {
    const owner = yield* intent();
    const made = yield* creation({
      operation: "worktree",
      position: 1,
      postState: frontier(LINKED, B),
    });
    const history = accepted(
      yield* admitRetainedRepositoryHistory(
        [intended(owner), yield* completed(owner), intended(made)],
        OWNER,
      ),
    );

    const attachment = history.attachments.find((value) => value.checkout === PRIMARY)!;
    // The owner's established state, and the state the pending creation says it
    // will leave the shared refs in.
    expect(attachment.candidates.map(topicOf)).toEqual([A, B]);
    // The destination itself is offered nothing, because it is not there.
    expect(history.attachments.some((value) => value.checkout === LINKED)).toBe(false);
  });
});
