/**
 * Tier U — what a pull-request record is, and what authorizes one.
 *
 * Two claims live here and neither needs a Git host, a database or a document.
 * The first is that the retained shapes are exact: a record is read back for
 * the request that produced it, and a value carrying more, fewer or different
 * members than the contract declares describes something else. The second is
 * the admission scan — the closed reading of this run's own journal that
 * decides whether the branch a pull request would name is one the run
 * published.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { GIT_HOST_EFFECT } from "../src/git-host/effect.ts";
import { gitHostRequestFingerprint } from "../src/git-host/records.ts";
import type { GitHostReconciliationRecord } from "../src/git-host/records.ts";
import { PullRequestAuthorityError } from "../src/composition/errors.ts";
import {
  GIT_PUSH,
  parseGitPushInputs,
  parseGitPushNaturalKey,
  PUSH_REMOTE,
} from "../src/composition/git-push-records.ts";
import type { GitPushRepositoryIdentity } from "../src/composition/git-push-records.ts";
import {
  parsePullRequestInputs,
  pullRequestMode,
  parsePullRequestNaturalKey,
  parsePullRequestRecord,
  parsePullRequestResult,
  parsePullRequestSnapshot,
  PULL_REQUEST,
  pullRequestInputsJson,
  pullRequestNaturalKey,
  pullRequestNaturalKeyJson,
  pullRequestNumber,
  pullRequestResultOf,
} from "../src/composition/pull-request-records.ts";
import type {
  PullRequestInputs,
  PullRequestSnapshot,
} from "../src/composition/pull-request-records.ts";
import { admitPushEvidence } from "../src/composition/push-evidence.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER = "c".repeat(40);

const IDENTITY: GitPushRepositoryIdentity = Object.freeze({
  name: "project",
  locatorFingerprint: "0".repeat(64),
  requestedBase: null,
  creationCommit: "d".repeat(40),
  primaryBranch: "main",
  objectFormat: "sha1",
});

const OTHER_IDENTITY: GitPushRepositoryIdentity = Object.freeze({ ...IDENTITY, name: "other" });

const INPUTS: PullRequestInputs = Object.freeze({
  repository: IDENTITY,
  number: null,
  title: "Prepare 1.4",
  body: "Release notes for 1.4.\n",
  draft: false,
  headBranch: "publish/1.4",
  headSha: HEAD,
  baseBranch: "main",
});

/** The same request, naming one pull request by number. */
const NUMBERED: PullRequestInputs = Object.freeze({ ...INPUTS, number: 7 });

const SNAPSHOT: PullRequestSnapshot = Object.freeze({
  providerId: "PR_node_1",
  number: 7,
  url: "https://github.com/octo/project/pull/7",
  state: "open",
  title: INPUTS.title,
  body: INPUTS.body,
  draft: false,
  headBranch: INPUTS.headBranch,
  headSha: HEAD,
  baseBranch: "main",
  baseSha: BASE,
});

const RESULT = {
  repository: { ...IDENTITY },
  providerId: SNAPSHOT.providerId,
  number: SNAPSHOT.number,
  url: SNAPSHOT.url,
  state: "open",
  headSha: HEAD,
  baseSha: BASE,
};

function record(overrides: Partial<GitHostReconciliationRecord> = {}): GitHostReconciliationRecord {
  return {
    request: {
      identity: { runId: "run", expansionId: "expansion" },
      kind: PULL_REQUEST,
      inputs: pullRequestInputsJson(INPUTS),
      naturalKey: pullRequestNaturalKeyJson(pullRequestNaturalKey(INPUTS)),
    },
    preState: { pullRequest: null },
    observations: { pullRequest: { ...SNAPSHOT } },
    decision: "performed",
    result: { ...RESULT },
    ...overrides,
  };
}

/** A complete, well-formed Push reconciliation record, as the journal holds it. */
function pushRecord(options: {
  identity?: GitPushRepositoryIdentity;
  branch?: string;
  commit?: string;
}): Json {
  const identity = options.identity ?? IDENTITY;
  const branch = options.branch ?? INPUTS.headBranch;
  const commit = options.commit ?? HEAD;
  const destinationRef = `refs/heads/${branch}`;
  const repository: Json = { ...identity };
  return {
    request: {
      identity: { runId: "run", expansionId: "push" },
      kind: GIT_PUSH,
      inputs: { repository, remote: PUSH_REMOTE, branch, destinationRef, sourceCommit: commit },
      naturalKey: { repository, remote: PUSH_REMOTE, destinationRef },
    },
    preState: { remoteCommit: null },
    observations: { remoteCommit: commit },
    decision: "performed",
    result: {
      repository,
      remote: PUSH_REMOTE,
      branch,
      destinationRef,
      refspec: `${commit}:${destinationRef}`,
      sourceCommit: commit,
      observedRemoteCommit: commit,
    },
  };
}

/** The JSON these projections produce, as an object a test may vary. */
function fields(value: Json): Record<string, Json> {
  return Object(value);
}

function event(value: Json, status: "ok" | "err" = "ok"): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: GIT_HOST_EFFECT, name: "fingerprint" },
    result:
      status === "ok"
        ? { status: "ok", value }
        : { status: "err", error: { name: "GitHostConflictError", message: "refused" } },
  };
}

/** What one refusal of the scan is, as a reason rather than as a sentence. */
function refusal(events: readonly DurableEvent[]): string | undefined {
  try {
    admitPushEvidence(events, INPUTS);
    return undefined;
  } catch (error) {
    return error instanceof PullRequestAuthorityError ? error.reason : `unexpected: ${error}`;
  }
}

/** The same record, for the numbered request. */
function numberedRecord(
  overrides: Partial<GitHostReconciliationRecord> = {},
): GitHostReconciliationRecord {
  return {
    request: {
      identity: { runId: "run", expansionId: "expansion" },
      kind: PULL_REQUEST,
      inputs: pullRequestInputsJson(NUMBERED),
      naturalKey: pullRequestNaturalKeyJson(pullRequestNaturalKey(NUMBERED)),
    },
    preState: { pullRequest: { ...SNAPSHOT, title: "Before" } },
    observations: { pullRequest: { ...SNAPSHOT } },
    decision: "performed",
    result: { ...RESULT },
    ...overrides,
  };
}

describe("workflow pull-request records", () => {
  it("reads a complete record for the request that produced it", function* () {
    const outcome = parsePullRequestRecord(record(), INPUTS);
    expect(outcome?.decision).toBe("performed");
    expect(outcome?.result).toEqual(pullRequestResultOf(INPUTS, SNAPSHOT));
  });

  it("reads an adoption whose pre-state is the pull request it observed", function* () {
    const adopted = record({
      preState: { pullRequest: { ...SNAPSHOT } },
      decision: "adopted",
    });
    expect(parsePullRequestRecord(adopted, INPUTS)?.decision).toBe("adopted");
  });

  it("refuses a decision the pre-state does not support", function* () {
    expect(parsePullRequestRecord(record({ decision: "adopted" }), INPUTS)).toBeUndefined();
    expect(
      parsePullRequestRecord(
        record({ preState: { pullRequest: { ...SNAPSHOT } }, decision: "performed" }),
        INPUTS,
      ),
    ).toBeUndefined();
  });

  it("refuses an adoption whose pre-state names another pull request", function* () {
    const adopted = record({
      preState: { pullRequest: { ...SNAPSHOT, number: 9, providerId: "PR_node_9" } },
      decision: "adopted",
    });
    expect(parsePullRequestRecord(adopted, INPUTS)).toBeUndefined();
  });

  it("refuses observations that are not the pull request the request asks for", function* () {
    for (const damage of [
      { title: "Something else" },
      { body: "" },
      { draft: true },
      { headSha: OTHER },
      { baseBranch: "develop" },
      { headBranch: "publish/1.5" },
    ]) {
      expect(
        parsePullRequestRecord(
          record({ observations: { pullRequest: { ...SNAPSHOT, ...damage } } }),
          INPUTS,
        ),
      ).toBeUndefined();
    }
  });

  it("refuses a result that disagrees with what was observed", function* () {
    for (const damage of [
      { providerId: "PR_node_2" },
      { number: 8 },
      { url: "https://example.invalid/1" },
      { baseSha: OTHER },
    ]) {
      expect(
        parsePullRequestRecord(record({ result: { ...RESULT, ...damage } }), INPUTS),
      ).toBeUndefined();
    }
  });

  it("refuses a result naming another Repository, state or head", function* () {
    expect(
      parsePullRequestResult({ ...RESULT, repository: { ...OTHER_IDENTITY } }, INPUTS),
    ).toBeUndefined();
    expect(parsePullRequestResult({ ...RESULT, state: "closed" }, INPUTS)).toBeUndefined();
    expect(parsePullRequestResult({ ...RESULT, headSha: OTHER }, INPUTS)).toBeUndefined();
  });

  it("is exact about membership", function* () {
    expect(parsePullRequestResult({ ...RESULT, extra: 1 }, INPUTS)).toBeUndefined();
    const { url: _url, ...missing } = RESULT;
    expect(parsePullRequestResult(missing, INPUTS)).toBeUndefined();
    expect(parsePullRequestSnapshot({ ...SNAPSHOT, extra: 1 }, "sha1")).toBeUndefined();
    expect(
      parsePullRequestInputs({ ...fields(pullRequestInputsJson(INPUTS)), extra: 1 }),
    ).toBeUndefined();
    expect(
      parsePullRequestNaturalKey({
        ...fields(pullRequestNaturalKeyJson(pullRequestNaturalKey(INPUTS))),
        extra: 1,
      }),
    ).toBeUndefined();
  });

  it("reads a number as a number, and an object id in the repository's format", function* () {
    expect(pullRequestNumber(7)).toBe(7);
    for (const value of [0, -1, 1.5, "7", null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(pullRequestNumber(value)).toBeUndefined();
    }
    expect(
      parsePullRequestSnapshot({ ...SNAPSHOT, headSha: "A".repeat(40) }, "sha1"),
    ).toBeUndefined();
    expect(
      parsePullRequestSnapshot({ ...SNAPSHOT, baseSha: "b".repeat(64) }, "sha1"),
    ).toBeUndefined();
    expect(parsePullRequestSnapshot({ ...SNAPSHOT, state: "closed" }, "sha1")).toBeUndefined();
  });

  it("keeps an empty body, and refuses an absent one", function* () {
    const empty = { ...INPUTS, body: "" };
    expect(parsePullRequestInputs(pullRequestInputsJson(empty))?.body).toBe("");
    expect(
      parsePullRequestInputs({ ...fields(pullRequestInputsJson(INPUTS)), body: null }),
    ).toBeUndefined();
  });

  it("keys a numbered request by its number and an unnumbered one by its branches", function* () {
    expect(pullRequestNaturalKeyJson(pullRequestNaturalKey(INPUTS))).toEqual({
      mode: "create",
      repository: { ...IDENTITY },
      headBranch: INPUTS.headBranch,
      baseBranch: "main",
    });
    expect(pullRequestNaturalKeyJson(pullRequestNaturalKey(NUMBERED))).toEqual({
      mode: "update",
      repository: { ...IDENTITY },
      number: 7,
    });
    expect(pullRequestMode(INPUTS)).toBe("create");
    expect(pullRequestMode(NUMBERED)).toBe("update");
  });

  it("refuses a natural key that is neither shape, or one wearing the other's members", function* () {
    const create = fields(pullRequestNaturalKeyJson(pullRequestNaturalKey(INPUTS)));
    const update = fields(pullRequestNaturalKeyJson(pullRequestNaturalKey(NUMBERED)));
    expect(parsePullRequestNaturalKey({ ...create, mode: "upsert" })).toBeUndefined();
    expect(parsePullRequestNaturalKey({ ...create, number: 7 })).toBeUndefined();
    expect(parsePullRequestNaturalKey({ ...update, headBranch: "publish/1.4" })).toBeUndefined();
    expect(parsePullRequestNaturalKey({ ...update, number: 0 })).toBeUndefined();
    // A record read for one resource is never read for the other.
    expect(parsePullRequestRecord(record(), NUMBERED)).toBeUndefined();
    expect(parsePullRequestRecord(numberedRecord(), INPUTS)).toBeUndefined();
  });

  it("reads a performed update, which acted on the pull request it observed", function* () {
    const outcome = parsePullRequestRecord(numberedRecord(), NUMBERED);
    expect(outcome?.decision).toBe("performed");
    expect(outcome?.result).toEqual(pullRequestResultOf(NUMBERED, SNAPSHOT));
  });

  it("reads a numbered no-op as an adoption of what was already there", function* () {
    const noop = numberedRecord({
      preState: { pullRequest: { ...SNAPSHOT } },
      decision: "adopted",
    });
    expect(parsePullRequestRecord(noop, NUMBERED)?.decision).toBe("adopted");
  });

  it("refuses a performed update over nothing, and a created one over something", function* () {
    expect(
      parsePullRequestRecord(numberedRecord({ preState: { pullRequest: null } }), NUMBERED),
    ).toBeUndefined();
    expect(
      parsePullRequestRecord(
        record({ preState: { pullRequest: { ...SNAPSHOT, title: "Before" } } }),
        INPUTS,
      ),
    ).toBeUndefined();
  });

  it("refuses a performed update that had nothing to perform", function* () {
    // Identical pre-state and observation: whatever this record says, no
    // mutable field moved, and an update with nothing to do is an adoption.
    const nothing = numberedRecord({
      preState: { pullRequest: { ...SNAPSHOT } },
      decision: "performed",
    });
    expect(parsePullRequestRecord(nothing, NUMBERED)).toBeUndefined();
    // The same record, decided the way the state machine reaches it.
    expect(
      parsePullRequestRecord(
        numberedRecord({ preState: { pullRequest: { ...SNAPSHOT } }, decision: "adopted" }),
        NUMBERED,
      )?.decision,
    ).toBe("adopted");
  });

  it("refuses a performed update whose two halves name different pull requests", function* () {
    for (const damage of [
      { providerId: "PR_node_9" },
      { number: 9 },
      { headBranch: "publish/1.5" },
      { headSha: OTHER },
    ]) {
      expect(
        parsePullRequestRecord(
          numberedRecord({
            preState: { pullRequest: { ...SNAPSHOT, title: "Before", ...damage } },
          }),
          NUMBERED,
        ),
      ).toBeUndefined();
    }
  });

  it("refuses a result whose number is not the one that was asked for", function* () {
    expect(parsePullRequestResult({ ...RESULT, number: 9 }, NUMBERED)).toBeUndefined();
    // Unnumbered, the number is the host's to choose and is held to the
    // observations instead.
    expect(parsePullRequestResult({ ...RESULT, number: 9 }, INPUTS)?.number).toBe(9);
  });

  it("moves the request fingerprint but not the natural key when content changes", function* () {
    const complete = (inputs: PullRequestInputs) => ({
      identity: { runId: "run", expansionId: "expansion" },
      kind: PULL_REQUEST,
      inputs: pullRequestInputsJson(inputs),
      naturalKey: pullRequestNaturalKeyJson(pullRequestNaturalKey(inputs)),
    });
    const original = yield* gitHostRequestFingerprint(complete(INPUTS));

    for (const changed of [
      { ...INPUTS, title: "Prepare 1.5" },
      { ...INPUTS, body: "Different notes.\n" },
      { ...INPUTS, draft: true },
      { ...INPUTS, headSha: OTHER },
    ]) {
      expect(yield* gitHostRequestFingerprint(complete(changed))).not.toBe(original);
      // The external resource is the same one: a changed title does not open a
      // second place to look for the pull request it would edit.
      expect(pullRequestNaturalKeyJson(pullRequestNaturalKey(changed))).toEqual(
        pullRequestNaturalKeyJson(pullRequestNaturalKey(INPUTS)),
      );
    }

    // A different branch pair is a different resource, and says so. So is a
    // number, which moves the fingerprint and the key together.
    expect(
      pullRequestNaturalKeyJson(pullRequestNaturalKey({ ...INPUTS, baseBranch: "develop" })),
    ).not.toEqual(pullRequestNaturalKeyJson(pullRequestNaturalKey(INPUTS)));
    expect(yield* gitHostRequestFingerprint(complete(NUMBERED))).not.toBe(original);
    expect(pullRequestNaturalKeyJson(pullRequestNaturalKey(NUMBERED))).not.toEqual(
      pullRequestNaturalKeyJson(pullRequestNaturalKey(INPUTS)),
    );
  });
});

describe("workflow pull-request push admission", () => {
  it("admits one exact successful Push, and several of them", function* () {
    expect(refusal([event(pushRecord({}))])).toBeUndefined();
    expect(refusal([event(pushRecord({})), event(pushRecord({}))])).toBeUndefined();
  });

  it("ignores a valid Push of another Repository or another destination", function* () {
    expect(refusal([event(pushRecord({ identity: OTHER_IDENTITY }))])).toBe(
      "missing-push-evidence",
    );
    expect(refusal([event(pushRecord({ branch: "publish/1.5" }))])).toBe("missing-push-evidence");
  });

  it("ignores a record of another kind, and a Push that failed", function* () {
    const foreign = Object(pushRecord({}));
    foreign.request = { ...foreign.request, kind: "issue" };
    expect(refusal([event(foreign)])).toBe("missing-push-evidence");
    expect(refusal([event(pushRecord({}), "err")])).toBe("missing-push-evidence");
  });

  it("refuses when this run published that branch at another commit", function* () {
    expect(refusal([event(pushRecord({ commit: OTHER }))])).toBe("conflicting-push-evidence");
    // The exact proof does not rescue a conflicting one: a branch this run
    // published twice, at two commits, is not evidence of the current head.
    expect(refusal([event(pushRecord({})), event(pushRecord({ commit: OTHER }))])).toBe(
      "conflicting-push-evidence",
    );
  });

  it("fails closed on a successful Git-host record it cannot read", function* () {
    // A generic record that does not parse cannot be shown to be unrelated:
    // its kind is inside the part that would not read.
    expect(refusal([event({ nothing: true })])).toBe("unreadable-push-evidence");

    const key = Object(pushRecord({}));
    key.request = { ...key.request, naturalKey: { repository: {}, remote: "origin" } };
    expect(refusal([event(key)])).toBe("unreadable-push-evidence");

    const inputs = Object(pushRecord({}));
    inputs.request = { ...inputs.request, inputs: { nothing: true } };
    expect(refusal([event(inputs)])).toBe("unreadable-push-evidence");

    const result = Object(pushRecord({}));
    result.result = { ...Object(result.result), observedRemoteCommit: OTHER };
    expect(refusal([event(result)])).toBe("unreadable-push-evidence");
  });

  it("refuses when nothing was published at all", function* () {
    expect(refusal([])).toBe("missing-push-evidence");
  });

  /**
   * The record that reads as relevant and is not.
   *
   * Its natural key names this Repository and this destination, so the scan
   * takes it up. Everything inside it — the inputs, the refspec, the result —
   * is internally valid and names another Repository and another branch, at
   * this run's own head commit. A scan that trusted the key and then read the
   * inputs on their own terms would count it as proof that this branch was
   * published, on the strength of a publication of somebody else's.
   */
  it("refuses a record whose key and inputs name different publications", function* () {
    const foreign = Object(pushRecord({ identity: OTHER_IDENTITY, branch: "unrelated" }));
    foreign.request = {
      ...foreign.request,
      naturalKey: {
        repository: { ...IDENTITY },
        remote: PUSH_REMOTE,
        destinationRef: `refs/heads/${INPUTS.headBranch}`,
      },
    };
    // The halves are each valid on their own, which is the whole difficulty.
    expect(parseGitPushNaturalKey(Object(foreign.request).naturalKey)).toBeDefined();
    expect(parseGitPushInputs(Object(foreign.request).inputs)).toBeDefined();

    expect(refusal([event(foreign)])).toBe("unreadable-push-evidence");
  });

  it("refuses a record whose key names this branch and whose inputs name another", function* () {
    const drifted = Object(pushRecord({}));
    drifted.request = {
      ...drifted.request,
      naturalKey: {
        repository: { ...IDENTITY },
        remote: PUSH_REMOTE,
        destinationRef: `refs/heads/${INPUTS.headBranch}`,
      },
      inputs: {
        repository: { ...IDENTITY },
        remote: PUSH_REMOTE,
        branch: "somewhere-else",
        destinationRef: "refs/heads/somewhere-else",
        sourceCommit: HEAD,
      },
    };
    expect(refusal([event(drifted)])).toBe("unreadable-push-evidence");
  });
});
