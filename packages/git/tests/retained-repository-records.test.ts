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
  readonly preState?: RetainedFrontier;
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
    expect(read?.preState.administration.role).toBe("primary");

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
            frontier: refused.preState,
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
        yield* completed(write, { frontier: write.preState }),
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
          yield* completed(commit, { result, frontier: commit.preState }),
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
          frontier: write.preState,
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
            frontier: write.preState,
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
          frontier: write.preState,
        }),
      ],
      OWNER,
    );
    expect(reasonOf(uncertain)).toBe("unproven-outcome");
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
            frontier: remove.preState,
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
