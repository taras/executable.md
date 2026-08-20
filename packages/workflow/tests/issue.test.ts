/**
 * Tier WF — `<Issue>` as a document writes it.
 *
 * These drive the real component through a real run database, a real local bare
 * remote, a real `git`, a real executor lock and a GitHub that answers out of a
 * small model of the part of the API this adapter uses. Nothing here reaches a
 * network: the document names a `github.com` repository, and the host adapter
 * under test runs Git against a bare repository in a temporary directory
 * instead.
 *
 * The claim this suite exists for is that an issue is created only when
 * somebody approved this exact obligation. Everything else — the closed
 * disposition, the evidence that renders verbatim, the pull request the run has
 * to have opened itself — is what stands between a document declaring a
 * deferral and one being recorded.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, type Operation } from "effection";
import { registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import { IssueAuthorityError } from "../src/composition/errors.ts";
import {
  issueInputsJson,
  issueOriginMarker,
  issueNaturalKey,
  type IssueInputs,
} from "../src/composition/issue-records.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import type { GitHubAccess, GitHubHttpResponse } from "../src/deno/composition/github.ts";
import type { GitPushRepositoryIdentity } from "../src/composition/git-push-records.ts";
import type { PullRequestResult } from "../src/composition/pull-request-records.ts";
import { createRun, useStorageRoot, withStorage } from "./support/storage.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import {
  causedBy,
  raised,
  retainedRepositories,
  runWorkflowDocument,
} from "./support/composition.ts";
import { issueCreations, issuePatches } from "./support/github.ts";
import { fixture, LATER, published, pullRequest, REMOTE, TOKEN } from "./support/pull-requests.ts";
import {
  answer,
  attemptWorkflow,
  decidable,
  deferring,
  EVIDENCE,
  FINDING,
  IMPACT,
  ISSUE_TITLE,
  issue,
  issueWith,
  RATIONALE,
  recorded,
  suspensionRequests,
  TIMING,
  waitOf,
  type WorkflowAttempt,
} from "./support/issues.ts";

function isAuthorityFailure(value: unknown): value is IssueAuthorityError {
  return value instanceof IssueAuthorityError;
}

/**
 * A Git host whose credential cannot even be read.
 *
 * What a local refusal is claimed to need: no adapter, no credential and no
 * request. Reaching for any of the three fails the run here rather than letting
 * a refusal that happened after a token was read pass for one that happened
 * before.
 */
function credentialless(): GitHubAccess {
  return {
    endpoint: "https://api.github.test",
    // deno-lint-ignore require-yield
    *token(): Operation<string | undefined> {
      throw new Error("a refused issue read a credential");
    },
    // deno-lint-ignore require-yield
    *send(): Operation<GitHubHttpResponse> {
      throw new Error("a refused issue reached the Git host");
    },
  };
}

/** The one Git-host record this run retains for its issue. */
function issueRecord(attempt: WorkflowAttempt): Record<string, unknown> {
  const parsed = parseGitHostReconciliationRecord(attempt.outcomes[2]?.record);
  if (parsed === undefined) {
    throw new Error("the run retains no issue reconciliation record");
  }
  return Object(parsed);
}

describe("workflow Issue", () => {
  it("records one approved deferred obligation as an issue", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const run = fixture(remote);

    const { first, second } = yield* recorded(root, deferring(), run.options, {
      // The first execution stopped at the wait, having created nothing: what
      // the store saw by then belongs to the pull request before it.
      between: () => expect(issueCreations(run.store)).toBe(0),
    });
    expect(first.rendered).toBeUndefined();

    const [created] = run.store.issues;
    expect(created?.title).toBe(ISSUE_TITLE);
    expect(created?.state).toBe("open");
    expect(issueCreations(run.store)).toBe(1);
    expect(issuePatches(run.store)).toBe(0);

    // The evidence is in the body verbatim, with what a reader needs around it.
    expect(created?.body).toContain(EVIDENCE);
    expect(created?.body).toContain(RATIONALE);
    expect(created?.body).toContain(IMPACT);
    expect(created?.body).toContain(TIMING);
    expect(created?.body).toContain(FINDING);

    // The binding is evidence of what the effect settled on.
    expect(String(second.rendered)).toContain(`recorded ${created?.number}`);
    expect(String(second.rendered)).toContain("as open by performed");

    const record = issueRecord(second);
    expect(record.decision).toBe("performed");
    expect(record.preState).toEqual({ issue: null });
    const [repository] = second.repositories;
    expect(record.result).toEqual({
      repository: {
        name: "project",
        locatorFingerprint: repository?.record.locatorFingerprint,
        requestedBase: null,
        creationCommit: repository?.record.creationCommit,
        primaryBranch: "main",
        objectFormat: "sha1",
      },
      pullRequest: {
        number: run.store.pullRequests[0]?.number,
        url: `https://github.com/owner/repository/pull/${run.store.pullRequests[0]?.number}`,
      },
      providerId: created?.nodeId,
      number: created?.number,
      url: `https://github.com/owner/repository/issues/${created?.number}`,
      state: "open",
      finding: FINDING,
    });
  });
});

describe("workflow Issue disposition", () => {
  it("binds a skipped result for every decision that records nothing", function* () {
    const root = yield* useStorageRoot();

    // Written into the evidence, so a run that expanded it would fail here. A
    // decision that records nothing does not render what it would have said.
    const failing: ComponentRegistration = {
      name: "Failing",
      origin: "test",
      props: { type: "object", additionalProperties: true },
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        throw new Error("the evidence was expanded");
      },
    };

    yield* withStorage(root, function* () {
      for (const disposition of ["rejected", "fix-now", "inserted-repair"]) {
        // A remote of its own for each: a second run against the first's remote
        // would find the branch already published and the commit already made.
        const run = fixture(yield* useBareRemote(REMOTE));
        const database = yield* createRun({ runId: `decide-${disposition}` });
        const rendered = String(
          yield* runWorkflowDocument(
            database,
            published(
              ...pullRequest(),
              `<Issue finding="${FINDING}" disposition="${disposition}" pullRequest={pullRequest}` +
                ` title="${ISSUE_TITLE}" rationale="${RATIONALE}"` +
                ` dependencyImpact="${IMPACT}" intendedTiming="${TIMING}" as="issue">`,
              "<Failing />",
              "</Issue>",
              "",
              "decided {issue.disposition}",
            ),
            run.options,
            (execute) =>
              scoped(function* () {
                yield* registerComponents([failing]);
                return yield* execute();
              }),
          ),
        );
        expect(rendered).toContain(`decided ${disposition}`);
        // No wait was published, no provider was asked, and nothing reached the
        // Git host that the pull request before it did not.
        expect(suspensionRequests(yield* database.journal.readAll())).toHaveLength(0);
        expect(run.counting.counters.effects).not.toContain("git:issue");
        expect(issueCreations(run.store)).toBe(0);
      }
    });
  });

  it("refuses a disposition this element has no meaning for", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published(...pullRequest(), ...issueWith({ disposition: `"deferred"` }), "", LATER),
          run.options,
        ),
      );
      expect(causedBy(failure, isAuthorityFailure)?.reason).toBe("unknown-disposition");
      // The four words it does mean, so the refusal is actionable.
      expect(String(failure)).toContain("defer, rejected, fix-now, inserted-repair");
      expect(String(failure)).not.toContain(LATER);
      expect(suspensionRequests(yield* database.journal.readAll())).toHaveLength(0);
      expect(issueCreations(run.store)).toBe(0);
    });
  });
});

describe("workflow Issue authority", () => {
  it("is refused before any authored work when it is written without as", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published(
            ...pullRequest(),
            `<Issue finding="${FINDING}" disposition="defer" pullRequest={pullRequest}` +
              ` title="${ISSUE_TITLE}" rationale="${RATIONALE}"` +
              ` dependencyImpact="${IMPACT}" intendedTiming="${TIMING}" />`,
          ),
          run.options,
        ),
      );
      // Core decides this, before the component's own work exists at all.
      expect(String(failure)).toContain("must be invoked with `as`");
      expect(suspensionRequests(yield* database.journal.readAll())).toHaveLength(0);
      expect(issueCreations(run.store)).toBe(0);
    });
  });

  it("fails outside a Repository without publishing a wait", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          [
            ...published(...pullRequest()).split("\n"),
            `<Issue finding="${FINDING}" disposition="defer" pullRequest={pullRequest}` +
              ` title="${ISSUE_TITLE}" rationale="${RATIONALE}"` +
              ` dependencyImpact="${IMPACT}" intendedTiming="${TIMING}" as="issue">`,
            EVIDENCE,
            "</Issue>",
            "",
            LATER,
          ].join("\n"),
          run.options,
        ),
      );
      expect(causedBy(failure, isAuthorityFailure)?.reason).toBe("no-repository-context");
      expect(String(failure)).not.toContain(LATER);
      expect(suspensionRequests(yield* database.journal.readAll())).toHaveLength(0);
      expect(issueCreations(run.store)).toBe(0);
    });
  });

  it("refuses evidence that is not a pull-request result, before the wait", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published(
            ...pullRequest(),
            ...issueWith({ pullRequest: `{{ number: pullRequest.number }}` }),
          ),
          run.options,
        ),
      );
      expect(causedBy(failure, isAuthorityFailure)?.reason).toBe(
        "unreadable-pull-request-evidence",
      );
      expect(suspensionRequests(yield* database.journal.readAll())).toHaveLength(0);
      expect(issueCreations(run.store)).toBe(0);
    });
  });

  it("finishes its evidence before it publishes a wait", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    const failing: ComponentRegistration = {
      name: "Failing",
      origin: "test",
      props: { type: "object", additionalProperties: true },
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        throw new Error("the body never finished");
      },
    };

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published(
            ...pullRequest(),
            `<Issue finding="${FINDING}" disposition="defer" pullRequest={pullRequest}` +
              ` title="${ISSUE_TITLE}" rationale="${RATIONALE}"` +
              ` dependencyImpact="${IMPACT}" intendedTiming="${TIMING}" as="issue">`,
            "<Failing />",
            "</Issue>",
          ),
          run.options,
          (execute) =>
            scoped(function* () {
              yield* registerComponents([failing]);
              return yield* execute();
            }),
        ),
      );
      expect(String(failure)).toContain("the body never finished");
      // Evidence that never finished is not an obligation anybody was asked
      // to approve.
      expect(suspensionRequests(yield* database.journal.readAll())).toHaveLength(0);
      expect(issueCreations(run.store)).toBe(0);
    });
  });
});

describe("workflow Issue approval", () => {
  it("publishes the exact normalized request, and reaches no Git host for it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const run = fixture(remote);

    const first = yield* attemptWorkflow(root, "start", deferring(), run.options);
    const wait = waitOf(first);

    const [repository] = first.repositories;
    const created = run.store.pullRequests[0];
    const identity: GitPushRepositoryIdentity = Object.freeze({
      name: "project",
      locatorFingerprint: String(repository?.record.locatorFingerprint),
      requestedBase: null,
      creationCommit: String(repository?.record.creationCommit),
      primaryBranch: "main",
      objectFormat: "sha1",
    });
    const evidence: PullRequestResult = Object.freeze({
      repository: identity,
      providerId: String(created?.nodeId),
      number: Number(created?.number),
      url: `https://github.com/owner/repository/pull/${created?.number}`,
      state: "open",
      headSha: String(created?.headSha),
      baseSha: String(created?.baseSha),
    });
    const inputs: IssueInputs = Object.freeze({
      repository: identity,
      pullRequest: evidence,
      finding: FINDING,
      disposition: "defer",
      title: ISSUE_TITLE,
      body: `\n${EVIDENCE}\n`,
      rationale: RATIONALE,
      dependencyImpact: IMPACT,
      intendedTiming: TIMING,
    });

    // What is approved is the request itself, member for member — including the
    // evidence verbatim and the whole PullRequest result it was decided against.
    expect(wait.request.request).toEqual(issueInputsJson(inputs));
    expect(wait.request.responseSchema).toEqual({
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
      additionalProperties: false,
    });
    expect(suspensionRequests(first.events)).toHaveLength(1);
    expect(issueCreations(run.store)).toBe(0);

    // Nothing about the credential or the marker leaves the provider: the wait
    // a human reads carries the request and nothing a host said.
    expect(JSON.stringify(wait.request)).not.toContain(TOKEN);
    expect(JSON.stringify(wait.request)).not.toContain(issueOriginMarker(issueNaturalKey(inputs)));
  });

  it("records nothing when the approval is declined", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const run = fixture(remote);

    const { second } = yield* recorded(root, decidable(), run.options, {
      value: { approved: false },
    });

    expect(String(second.rendered)).toContain("recorded defer");
    expect(issueCreations(run.store)).toBe(0);
    expect(run.store.issues).toHaveLength(0);
    // The provider was never asked, so no Git-host effect exists for the issue.
    expect(second.outcomes).toHaveLength(2);
  });

  it("refuses to record an obligation against a pull request this run has no result for", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const run = fixture(remote);

    // A whole, well-formed PullRequest result naming a pull request nothing in
    // this run reconciled. It is not conflicting — this run says nothing about
    // that pull request at all — so what the document is missing is the
    // <PullRequest> that would have produced it.
    const source = published(
      ...pullRequest(),
      ...issueWith({ pullRequest: `{{ ...pullRequest, providerId: "PR_node_absent" }}` }),
    );
    const first = yield* attemptWorkflow(root, "start", source, run.options);
    const delivered = yield* answer(root, waitOf(first).suspensionId, { approved: true });
    expect(delivered.ok).toBe(true);
    // The resume replays the push and the pull request out of the journal, so a
    // host it cannot reach is what proves the refusal happened before one was.
    const second = yield* attemptWorkflow(root, "resume", source, {
      composition: { host: run.counting.host, gitHub: credentialless() },
    });

    expect(causedBy(second.thrown, isAuthorityFailure)?.reason).toBe(
      "missing-pull-request-evidence",
    );
    expect(issueCreations(run.store)).toBe(0);
  });

  it("refuses to record an obligation against a pull request this run did not open", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const run = fixture(remote);

    // The evidence is a whole, well-formed PullRequest result naming a pull
    // request with another number — the one thing a document could plausibly
    // put here that this run never reconciled.
    const source = published(
      ...pullRequest(),
      ...issueWith({ pullRequest: `{{ ...pullRequest, number: 99 }}` }),
    );
    const first = yield* attemptWorkflow(root, "start", source, run.options);
    const delivered = yield* answer(root, waitOf(first).suspensionId, { approved: true });
    expect(delivered.ok).toBe(true);
    const second = yield* attemptWorkflow(root, "resume", source, {
      composition: { host: run.counting.host, gitHub: credentialless() },
    });

    expect(causedBy(second.thrown, isAuthorityFailure)?.reason).toBe(
      "conflicting-pull-request-evidence",
    );
    expect(issueCreations(run.store)).toBe(0);
  });
});
