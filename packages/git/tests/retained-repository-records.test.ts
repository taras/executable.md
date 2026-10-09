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
 * Nothing here is a live occurrence. The sites and owners are fixtures, and a
 * fixture that admits cleanly proves the sequence rules and nothing about
 * authenticity — R2's engine-authenticated identity is slice B's and slice D's
 * to prove, through actual canonical execution.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import {
  RETAINED_REPOSITORY_COMPLETION,
  RETAINED_REPOSITORY_INTENT,
  parseRetainedRepositoryCompletion,
  parseRetainedRepositoryIntent,
  retainedRepositoryIntentIdentity,
  retainedRepositoryOwner,
  retainedRepositoryRequestFingerprint,
} from "../src/retained-repository/records.ts";
import type { RetainedRepositoryIntent } from "../src/retained-repository/records.ts";
import { admitRetainedRepositoryHistory } from "../src/retained-repository/admission.ts";
import type { RetainedRepositoryHistory } from "../src/retained-repository/admission.ts";
import type { Result } from "effection";

const OWNER = retainedRepositoryOwner({ executionId: "execution-1", entryKey: "0001" });
const OTHER = retainedRepositoryOwner({ executionId: "execution-1", entryKey: "0002" });

const COMMON = "/checkouts/project/.git";
const CHECKOUT = "project";

function frontier(overrides: Record<string, Json> = {}): Record<string, Json> {
  return {
    checkout: CHECKOUT,
    administration: { common: COMMON, worktree: null, role: "primary" },
    objectFormat: "sha1",
    head: { kind: "symbolic", ref: "refs/heads/main", oid: "a".repeat(40) },
    refs: [{ name: "refs/heads/main", oid: "a".repeat(40) }],
    index: [],
    worktree: [],
    ...overrides,
  };
}

/** The same checkout one commit later, as a completed mutation leaves it. */
function advanced(): Record<string, Json> {
  return frontier({
    head: { kind: "symbolic", ref: "refs/heads/main", oid: "b".repeat(40) },
    refs: [{ name: "refs/heads/main", oid: "b".repeat(40) }],
  });
}

function predicted(): Record<string, Json> {
  return frontier({
    head: { kind: "symbolic", ref: "refs/heads/main", oid: "c".repeat(40) },
    refs: [{ name: "refs/heads/main", oid: "c".repeat(40) }],
  });
}

function intent(overrides: Record<string, Json> = {}): Record<string, Json> {
  return {
    version: 1,
    owner: OWNER,
    site: { source: "entry.md", occurrence: "occurrence-1" },
    operation: "ambient",
    lane: { common: COMMON, position: 0 },
    selection: { checkout: CHECKOUT },
    request: { path: "notes.md" },
    fingerprint: "fingerprint-1",
    prepared: { resolved: "notes.md" },
    preState: frontier(),
    postState: frontier(),
    evidence: { kind: "selection" },
    ...overrides,
  };
}

function completion(identity: string, overrides: Record<string, Json> = {}): Record<string, Json> {
  return {
    version: 1,
    owner: OWNER,
    site: { source: "entry.md", occurrence: "occurrence-1" },
    intent: identity,
    fingerprint: "fingerprint-1",
    result: { selected: CHECKOUT },
    frontier: frontier(),
    ...overrides,
  };
}

function yielded(type: string, value: Json): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type, name: "retained-repository" },
    result: { status: "ok", value },
  };
}

/** The parsed intent a payload describes; the fixture is wrong if it describes none. */
function parsed(payload: Record<string, Json>): RetainedRepositoryIntent {
  const value = parseRetainedRepositoryIntent(payload);
  if (value === undefined) {
    throw new Error("the fixture payload does not describe an intent");
  }
  return value;
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

describe("retained repository records", () => {
  it("R1: folds a baseline, its completions and one pending intent", function* () {
    const baseline = intent();
    const baselineIdentity = yield* retainedRepositoryIntentIdentity(parsed(baseline));
    const commit = intent({
      operation: "commit",
      lane: { common: COMMON, position: 1 },
      site: { source: "entry.md", occurrence: "occurrence-2" },
      fingerprint: "fingerprint-2",
      preState: frontier(),
      postState: advanced(),
    });
    const commitIdentity = yield* retainedRepositoryIntentIdentity(parsed(commit));
    const write = intent({
      operation: "file-write",
      lane: { common: COMMON, position: 2 },
      site: { source: "entry.md", occurrence: "occurrence-3" },
      fingerprint: "fingerprint-3",
      preState: advanced(),
      postState: predicted(),
    });
    const writeIdentity = yield* retainedRepositoryIntentIdentity(parsed(write));

    const history = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          yielded(RETAINED_REPOSITORY_INTENT, baseline),
          yielded(RETAINED_REPOSITORY_COMPLETION, completion(baselineIdentity)),
          yielded(RETAINED_REPOSITORY_INTENT, commit),
          yielded(
            RETAINED_REPOSITORY_COMPLETION,
            completion(commitIdentity, {
              site: { source: "entry.md", occurrence: "occurrence-2" },
              fingerprint: "fingerprint-2",
              frontier: advanced(),
            }),
          ),
          yielded(RETAINED_REPOSITORY_INTENT, write),
        ],
        OWNER,
      ),
    );

    expect(history.completed.map((effect) => effect.intent.operation)).toEqual([
      "ambient",
      "commit",
    ]);
    expect(history.pending.map((effect) => effect.identity)).toEqual([writeIdentity]);
    expect(history.completed.map((effect) => effect.identity)).toEqual([
      baselineIdentity,
      commitIdentity,
    ]);

    expect(history.attachments.length).toBe(1);
    const attachment = history.attachments[0]!;
    expect(attachment.checkout).toBe(CHECKOUT);
    // The frontier the accepted records establish, not the interrupted write's
    // prediction.
    expect(attachment.frontier.head.kind === "symbolic" && attachment.frontier.head.oid).toBe(
      "b".repeat(40),
    );
    // The pending write may have reached either side of its own transition, so
    // both are admitted beside the established state.
    expect(
      attachment.candidates.map((candidate) =>
        candidate.head.kind === "symbolic" ? candidate.head.oid : candidate.head.oid,
      ),
    ).toEqual(["b".repeat(40), "c".repeat(40)]);
  });

  it("R1: reads nothing from another feature, another type or a failed effect", function* () {
    const baseline = intent();
    const history = accepted(
      yield* admitRetainedRepositoryHistory(
        [
          yielded("git_host_effect", { anything: true }),
          { type: "close", coroutineId: "root", result: { status: "ok" } },
          {
            type: "yield",
            coroutineId: "root",
            description: { type: RETAINED_REPOSITORY_INTENT, name: "retained-repository" },
            result: { status: "err", error: { message: "the append failed" } },
          },
          yielded(RETAINED_REPOSITORY_INTENT, baseline),
        ],
        OWNER,
      ),
    );
    expect(history.completed.length).toBe(0);
    expect(history.pending.length).toBe(1);
  });

  it("R1: accepted data is detached from the payload it was read out of", function* () {
    const payload = intent();
    const history = accepted(
      yield* admitRetainedRepositoryHistory([yielded(RETAINED_REPOSITORY_INTENT, payload)], OWNER),
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
    const payload = intent();
    const value = parseRetainedRepositoryIntent(payload);
    expect(value).toBeDefined();
    const identity = yield* retainedRepositoryIntentIdentity(parsed(payload));
    const record = parseRetainedRepositoryCompletion(completion(identity));
    expect(record).toBeDefined();
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
      selection: { checkout: CHECKOUT },
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

  it("R2: an intent belonging to another entry is refused", function* () {
    const result = yield* admitRetainedRepositoryHistory(
      [yielded(RETAINED_REPOSITORY_INTENT, intent({ owner: OTHER }))],
      OWNER,
    );
    expect(reasonOf(result)).toBe("foreign-owner");
  });

  it("R2: a completion belonging to another entry is refused", function* () {
    const baseline = intent();
    const identity = yield* retainedRepositoryIntentIdentity(parsed(baseline));
    const result = yield* admitRetainedRepositoryHistory(
      [
        yielded(RETAINED_REPOSITORY_INTENT, baseline),
        yielded(RETAINED_REPOSITORY_COMPLETION, completion(identity, { owner: OTHER })),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("foreign-owner");
  });

  it("R1: a later version is refused as itself, not as a broken record", function* () {
    const result = yield* admitRetainedRepositoryHistory(
      [yielded(RETAINED_REPOSITORY_INTENT, intent({ version: 2 }))],
      OWNER,
    );
    expect(reasonOf(result)).toBe("unknown-version");
  });

  it("R1: an unknown member and a missing one are both refused", function* () {
    const extra = yield* admitRetainedRepositoryHistory(
      [yielded(RETAINED_REPOSITORY_INTENT, { ...intent(), lease: "held" })],
      OWNER,
    );
    expect(reasonOf(extra)).toBe("malformed-record");

    const withoutEvidence: Record<string, Json> = { ...intent() };
    delete withoutEvidence["evidence"];
    const missing = yield* admitRetainedRepositoryHistory(
      [yielded(RETAINED_REPOSITORY_INTENT, withoutEvidence)],
      OWNER,
    );
    expect(reasonOf(missing)).toBe("malformed-record");
  });

  it("R1: a frontier carrying a volatile member describes no frontier", function* () {
    const result = yield* admitRetainedRepositoryHistory(
      [yielded(RETAINED_REPOSITORY_INTENT, intent({ preState: { ...frontier(), reflogTime: 1 } }))],
      OWNER,
    );
    expect(reasonOf(result)).toBe("malformed-record");
  });

  it("R1: a completion from another source or occurrence is refused", function* () {
    const baseline = intent();
    const identity = yield* retainedRepositoryIntentIdentity(parsed(baseline));

    const source = yield* admitRetainedRepositoryHistory(
      [
        yielded(RETAINED_REPOSITORY_INTENT, baseline),
        yielded(
          RETAINED_REPOSITORY_COMPLETION,
          completion(identity, { site: { source: "other.md", occurrence: "occurrence-1" } }),
        ),
      ],
      OWNER,
    );
    expect(reasonOf(source)).toBe("site-substitution");

    const occurrence = yield* admitRetainedRepositoryHistory(
      [
        yielded(RETAINED_REPOSITORY_INTENT, baseline),
        yielded(
          RETAINED_REPOSITORY_COMPLETION,
          completion(identity, { site: { source: "entry.md", occurrence: "occurrence-9" } }),
        ),
      ],
      OWNER,
    );
    expect(reasonOf(occurrence)).toBe("site-substitution");
  });

  it("R1: a completion carrying a different authored request is refused", function* () {
    const baseline = intent();
    const identity = yield* retainedRepositoryIntentIdentity(parsed(baseline));
    const result = yield* admitRetainedRepositoryHistory(
      [
        yielded(RETAINED_REPOSITORY_INTENT, baseline),
        yielded(RETAINED_REPOSITORY_COMPLETION, completion(identity, { fingerprint: "other" })),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("request-substitution");
  });

  it("R1: a completion with no intent is refused", function* () {
    const result = yield* admitRetainedRepositoryHistory(
      [yielded(RETAINED_REPOSITORY_COMPLETION, completion("nothing-names-this"))],
      OWNER,
    );
    expect(reasonOf(result)).toBe("completion-without-intent");
  });

  it("R1: a completion standing before its own intent is refused", function* () {
    const baseline = intent();
    const identity = yield* retainedRepositoryIntentIdentity(parsed(baseline));
    const result = yield* admitRetainedRepositoryHistory(
      [
        yielded(RETAINED_REPOSITORY_COMPLETION, completion(identity)),
        yielded(RETAINED_REPOSITORY_INTENT, baseline),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("misordered-completion");
  });

  it("R1: a second completion for one intent is refused", function* () {
    const baseline = intent();
    const identity = yield* retainedRepositoryIntentIdentity(parsed(baseline));
    const result = yield* admitRetainedRepositoryHistory(
      [
        yielded(RETAINED_REPOSITORY_INTENT, baseline),
        yielded(RETAINED_REPOSITORY_COMPLETION, completion(identity)),
        yielded(RETAINED_REPOSITORY_COMPLETION, completion(identity)),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("duplicate-completion");
  });

  it("R1: a lane position that does not advance is refused", function* () {
    const baseline = intent();
    const identity = yield* retainedRepositoryIntentIdentity(parsed(baseline));
    const result = yield* admitRetainedRepositoryHistory(
      [
        yielded(RETAINED_REPOSITORY_INTENT, baseline),
        yielded(RETAINED_REPOSITORY_COMPLETION, completion(identity)),
        yielded(
          RETAINED_REPOSITORY_INTENT,
          intent({
            operation: "commit",
            lane: { common: COMMON, position: 0 },
            site: { source: "entry.md", occurrence: "occurrence-2" },
            postState: advanced(),
          }),
        ),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("misordered-lane");
  });

  it("R1: a mutation before any baseline is refused", function* () {
    const result = yield* admitRetainedRepositoryHistory(
      [yielded(RETAINED_REPOSITORY_INTENT, intent({ operation: "commit", postState: advanced() }))],
      OWNER,
    );
    expect(reasonOf(result)).toBe("missing-baseline");
  });

  it("R1: a pre-state the accepted records did not establish is refused", function* () {
    const baseline = intent();
    const identity = yield* retainedRepositoryIntentIdentity(parsed(baseline));
    const result = yield* admitRetainedRepositoryHistory(
      [
        yielded(RETAINED_REPOSITORY_INTENT, baseline),
        yielded(RETAINED_REPOSITORY_COMPLETION, completion(identity)),
        yielded(
          RETAINED_REPOSITORY_INTENT,
          intent({
            operation: "commit",
            lane: { common: COMMON, position: 1 },
            site: { source: "entry.md", occurrence: "occurrence-2" },
            preState: predicted(),
            postState: advanced(),
          }),
        ),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("broken-frontier-chain");
  });

  it("R1: two unresolved mutations of one shared Git directory are refused", function* () {
    const baseline = intent();
    const result = yield* admitRetainedRepositoryHistory(
      [
        yielded(RETAINED_REPOSITORY_INTENT, baseline),
        yielded(
          RETAINED_REPOSITORY_INTENT,
          intent({
            operation: "commit",
            lane: { common: COMMON, position: 1 },
            site: { source: "entry.md", occurrence: "occurrence-2" },
            postState: advanced(),
          }),
        ),
      ],
      OWNER,
    );
    expect(reasonOf(result)).toBe("competing-mutation");
  });
});
