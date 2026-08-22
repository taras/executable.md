/**
 * Tier WF — `<PullRequest>` as a document writes it.
 *
 * These drive the real component through a real run database, a real local bare
 * remote, a real `git` and a GitHub that answers out of a small model of the
 * part of the API this adapter uses. Nothing here reaches a network: the
 * document names a `github.com` repository, and the host adapter under test
 * runs Git against a bare repository in a temporary directory instead.
 *
 * That substitution is at the host boundary — which Git runs, and which GitHub
 * answers — and nowhere else. Every locator admission, every authority check,
 * every journal read and every classification below is the shipped code.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, type Operation } from "effection";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import { RepositoryContext } from "../src/composition/context.ts";
import {
  GitOperationAuthorityError,
  PullRequestAuthorityError,
} from "../src/composition/errors.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { createRun, useStorageRoot, withStorage } from "./support/storage.ts";
import { remoteBranch, remoteRefs, useBareRemote } from "./support/git-remotes.ts";
import type { BareRemote } from "./support/git-remotes.ts";
import {
  causedBy,
  countingHost,
  gitHostEvents,
  gitHostOutcomes,
  headCommit,
  raised,
  retainedRepositories,
  runWorkflowDocument,
  subcommands,
} from "./support/composition.ts";
import { creations, fakeGitHubAccess, gitHubStore, mutations } from "./support/github.ts";
import type { StoredPullRequest } from "./support/github.ts";
import {
  BODY,
  BRANCH,
  document,
  fixture,
  FORGED,
  LATER,
  LOCATOR,
  numbered,
  published,
  pullRequest,
  REMOTE,
  stored,
  TITLE,
  TOKEN,
} from "./support/pull-requests.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";

function isAuthorityFailure(value: unknown): value is PullRequestAuthorityError {
  return value instanceof PullRequestAuthorityError;
}

function isSelectionFailure(value: unknown): value is GitOperationAuthorityError {
  return value instanceof GitOperationAuthorityError;
}

/** What the run retains for its one Repository, so a suite can read a checkout. */
function* checkoutPath(database: WorkflowRunDatabase): Operation<string> {
  const [repository] = yield* retainedRepositories(database);
  if (repository === undefined) {
    throw new Error("the run retains no Repository");
  }
  return repository.record.checkoutPath;
}

/** The one Git-host record this run retains for its pull request. */
function* pullRequestRecord(database: WorkflowRunDatabase, index = 1): Operation<unknown> {
  const outcomes = yield* gitHostOutcomes(database);
  return parseGitHostReconciliationRecord(outcomes[index]?.record);
}

describe("workflow PullRequest", () => {
  it("opens one pull request for the branch this run published", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const rendered = String(
        yield* runWorkflowDocument(database, published(...pullRequest()), run.options),
      );

      const head = yield* headCommit(database, yield* checkoutPath(database));
      const [created] = run.store.pullRequests;
      expect(created?.title).toBe(TITLE);
      expect(created?.headRef).toBe(BRANCH);
      expect(created?.headSha).toBe(head.commit);
      expect(created?.baseRef).toBe("main");
      expect(created?.draft).toBe(false);
      // The rendered body, verbatim: the newline the element opens with is
      // part of what was written, and nothing here trims or reflows it.
      expect(created?.body).toBe(`\n${BODY}\n`);
      expect(creations(run.store)).toBe(1);

      // The binding is evidence of what the effect settled on.
      expect(rendered).toContain(`opened ${created?.number}`);
      expect(rendered).toContain("as open");

      const record = Object(yield* pullRequestRecord(database));
      expect(record.decision).toBe("performed");
      expect(record.preState).toEqual({ pullRequest: null });
      const [repository] = yield* retainedRepositories(database);
      expect(record.result).toEqual({
        repository: {
          name: "project",
          locatorFingerprint: repository?.record.locatorFingerprint,
          requestedBase: null,
          creationCommit: repository?.record.creationCommit,
          primaryBranch: "main",
          objectFormat: "sha1",
        },
        providerId: created?.nodeId,
        number: created?.number,
        url: `https://github.com/owner/repository/pull/${created?.number}`,
        state: "open",
        headSha: head.commit,
        baseSha: remoteBranch(remote, "main"),
      });
    });
  });

  it("takes an explicit base and draft, and defaults both", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      yield* runWorkflowDocument(
        database,
        published(...pullRequest(` base="main" draft={true}`)),
        run.options,
      );

      const [created] = run.store.pullRequests;
      expect(created?.draft).toBe(true);
      expect(created?.baseRef).toBe("main");
      // The base default is the Repository's recorded initial branch, which is
      // what the first document asserted by writing no base at all.
      const [repository] = yield* retainedRepositories(database);
      expect(repository?.record.primaryBranch).toBe("main");
    });
  });

  it("opens one with an empty body when it is written with no content", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      yield* runWorkflowDocument(
        database,
        published(`<PullRequest title="${TITLE}" as="pullRequest" />`),
        run.options,
      );
      const [created] = run.store.pullRequests;
      // The fixture stores an empty body as GitHub does, and the adapter reads
      // it back as the empty string the request asked for.
      expect(created?.body).toBeNull();
      const record = Object(yield* pullRequestRecord(database));
      expect(Reflect.get(Object(record.observations), "pullRequest")).toMatchObject({ body: "" });
    });
  });

  it("is refused before any authored work when it is written without as", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(database, published(`<PullRequest title="${TITLE}" />`), run.options),
      );
      // Core decides this, before the component's own work exists at all.
      expect(String(failure)).toContain("must be invoked with `as`");
      expect(run.store.requests).toHaveLength(0);
      expect(creations(run.store)).toBe(0);
    });
  });

  it("finishes its content before it observes anything at all", function* () {
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
            `<PullRequest title="${TITLE}" as="pullRequest">`,
            "<Failing />",
            "</PullRequest>",
          ),
          run.options,
          (run_) =>
            scoped(function* () {
              yield* registerComponents([failing]);
              return yield* run_();
            }),
        ),
      );

      expect(String(failure)).toContain("the body never finished");
      // A body that never finished is not a pull request that was observed.
      expect(run.store.requests).toHaveLength(0);
      expect(run.counting.counters.effects).not.toContain("git:pull-request");
    });
  });
});

describe("workflow PullRequest authority", () => {
  it("fails outside a Repository without observing a Git host", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          [`<PullRequest title="${TITLE}" as="pullRequest" />`, "", LATER].join("\n"),
          run.options,
        ),
      );
      expect(causedBy(failure, isAuthorityFailure)?.reason).toBe("no-repository-context");
      expect(String(failure)).not.toContain(LATER);
      expect(run.store.requests).toHaveLength(0);
    });
  });

  it("fails against a Repository record this run does not retain", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          [
            `<Repository name="project" url="${LOCATOR}" as="repository" />`,
            "<Dir path={repository}>",
            `<PullRequest title="${TITLE}" as="pullRequest" />`,
            "</Dir>",
          ].join("\n"),
          run.options,
          // A self-closing Repository installs no context of its own, so the
          // record the component observes is exactly this one — which is what a
          // replaced context is. It can misname a Repository; what it cannot do
          // is make one exist.
          (run_) =>
            scoped(function* () {
              yield* RepositoryContext.around({ current: () => FORGED }, { at: "min" });
              return yield* run_();
            }),
        ),
      );
      expect(causedBy(failure, isSelectionFailure)).toBeDefined();
      expect(run.store.requests).toHaveLength(0);
    });
  });

  it("fails when the working directory is inside no retained checkout", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published('<Dir path="/">', ...pullRequest(), "</Dir>"),
          run.options,
        ),
      );
      expect(causedBy(failure, isSelectionFailure)).toBeDefined();
      expect(run.store.requests).toHaveLength(0);
    });
  });

  it("fails before observing anything when HEAD names no branch", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published(
            // A checkout's `.git` is inside the Workspace, so a document can
            // write one — which is the only way to reach a detached HEAD.
            `<File path=".git/HEAD">{commit}</File>`,
            ...pullRequest(),
          ),
          run.options,
        ),
      );
      expect(causedBy(failure, isAuthorityFailure)?.reason).toBe("unnamed-branch");
      expect(run.store.requests).toHaveLength(0);
    });
  });

  it("fails when nothing published the branch it would name", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          document(
            `<Git.Switch branch="${BRANCH}" />`,
            `<File path="notes.md">`,
            "prepared",
            "</File>",
            `<Git.Add paths="notes.md" />`,
            `<Git.Commit message="prepare the release" as="commit" />`,
            ...pullRequest(),
            "",
            LATER,
          ),
          run.options,
        ),
      );

      const refusal = causedBy(failure, isAuthorityFailure);
      expect(refusal?.reason).toBe("missing-push-evidence");
      expect(String(refusal)).toContain("<Git.Push />");
      expect(run.store.requests).toHaveLength(0);
      // Fatal rather than printable: a later sibling must not run as though a
      // pull request had been opened.
      expect(String(failure)).not.toContain(LATER);
    });
  });

  it("fails when the branch moved after this run published it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          published(
            // A second commit after the push: the checkout's head is now a
            // commit this run never published.
            `<File path="more.md">`,
            "more",
            "</File>",
            `<Git.Add paths="more.md" />`,
            `<Git.Commit message="after the push" as="second" />`,
            ...pullRequest(),
          ),
          run.options,
        ),
      );
      expect(causedBy(failure, isAuthorityFailure)?.reason).toBe("conflicting-push-evidence");
      expect(run.store.requests).toHaveLength(0);
    });
  });

  it("refuses a Repository this adapter does not open pull requests for", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();
      const store = gitHubStore({ token: TOKEN });
      // The document names the bare repository directly, so the retained
      // locator is a local path rather than a repository on github.com.
      const source = [
        `<Repository name="project" url="${remote.locator}">`,
        `<Git.Switch branch="${BRANCH}" />`,
        `<File path="notes.md">`,
        "prepared",
        "</File>",
        `<Git.Add paths="notes.md" />`,
        `<Git.Commit message="prepare the release" as="commit" />`,
        `<Git.Push />`,
        ...pullRequest(),
        "</Repository>",
      ].join("\n");

      const failure = yield* raised(
        runWorkflowDocument(database, source, {
          composition: { host: counting.host, gitHub: gitHubSource(fakeGitHubAccess(store)) },
        }),
      );
      expect(String(failure)).toContain("does not support this effect kind");
      expect(store.requests).toHaveLength(0);
      // The refusal is the boundary failing, so nothing is journaled for it.
      expect(yield* gitHostEvents(database)).toHaveLength(1);
    });
  });
});

describe("workflow PullRequest reconciliation", () => {
  it("adopts the pull request an earlier attempt opened, and creates nothing more", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      yield* runWorkflowDocument(
        database,
        published(...pullRequest(), ...pullRequest()),
        run.options,
      );

      expect(run.store.pullRequests).toHaveLength(1);
      expect(creations(run.store)).toBe(1);

      const outcomes = yield* gitHostOutcomes(database);
      expect(parseGitHostReconciliationRecord(outcomes[1]?.record)?.decision).toBe("performed");
      const adopted = parseGitHostReconciliationRecord(outcomes[2]?.record);
      expect(adopted?.decision).toBe("adopted");
      expect(Reflect.get(Object(adopted?.preState), "pullRequest")).toMatchObject({
        number: run.store.pullRequests[0]?.number,
      });
    });
  });

  it("refuses an open pull request that says something else, and edits nothing", function* () {
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
            `<PullRequest title="Something else" as="second">`,
            BODY,
            "</PullRequest>",
            "",
            LATER,
          ),
          run.options,
        ),
      );

      expect(String(failure)).toContain("conflicts");
      // One pull request, unchanged. An unnumbered element asks for a pull
      // request to exist, not for whatever is there to become this one — the
      // document says which pull request it means by writing its number.
      expect(run.store.pullRequests).toHaveLength(1);
      expect(run.store.pullRequests[0]?.title).toBe(TITLE);
      expect(creations(run.store)).toBe(1);
      expect(String(failure)).not.toContain(LATER);
    });
  });

  it("refuses a closed pull request for the same branch pair", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote, [
        {
          nodeId: "PR_node_closed",
          number: 3,
          state: "closed",
          title: TITLE,
          body: `${BODY}\n`,
          draft: false,
          headRef: BRANCH,
          headSha: "0".repeat(40),
          baseRef: "main",
          baseSha: "0".repeat(40),
        },
      ]);
      const failure = yield* raised(
        runWorkflowDocument(database, published(...pullRequest()), run.options),
      );

      expect(String(failure)).toContain("conflicts");
      // A closed pull request never authorizes a second creation under the
      // same natural key.
      expect(creations(run.store)).toBe(0);
      expect(run.store.pullRequests).toHaveLength(1);
    });
  });

  it("refuses an ambiguous branch pair without creating a third", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const open = (number: number): StoredPullRequest => ({
        nodeId: `PR_node_${number}`,
        number,
        state: "open",
        title: TITLE,
        body: `${BODY}\n`,
        draft: false,
        headRef: BRANCH,
        headSha: "0".repeat(40),
        baseRef: "main",
        baseSha: "0".repeat(40),
      });
      const run = fixture(remote, [open(3), open(4)]);
      const failure = yield* raised(
        runWorkflowDocument(database, published(...pullRequest()), run.options),
      );

      expect(String(failure)).toContain("cannot prove");
      expect(creations(run.store)).toBe(0);
    });
  });

  it("publishes the shared unavailability when the host cannot answer", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      run.store.fault = { on: "list", status: 500 };
      const failure = yield* raised(
        runWorkflowDocument(database, published(...pullRequest()), run.options),
      );

      expect(String(failure)).toContain("temporarily unavailable");
      expect(creations(run.store)).toBe(0);
      const [, outcome] = yield* gitHostOutcomes(database);
      expect(outcome?.status).toBe("err");
      expect(outcome?.name).toBe("GitHostUnavailableError");
      expect(outcome?.message).not.toContain("500");
    });
  });

  it("adopts what a creation it could not read the answer to had already made", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      // The creation happens and the answer never arrives, which is the state
      // an interrupted POST leaves behind at this end.
      run.store.fault = { on: "create", status: 502, afterEffect: true };

      yield* runWorkflowDocument(database, published(...pullRequest()), run.options);

      // One creation, adopted by the one observation that followed it. A second
      // POST would have been the duplicate this whole design exists to avoid.
      expect(creations(run.store)).toBe(1);
      expect(run.store.pullRequests).toHaveLength(1);
      const record = Object(yield* pullRequestRecord(database));
      expect(record.decision).toBe("performed");
      expect(Reflect.get(Object(record.result), "number")).toBe(1);
    });
  });
});

describe("workflow PullRequest upsert", () => {
  /**
   * One run, one execution, over a GitHub that already holds this pull request.
   *
   * A document is expanded once: a completed root replays without running
   * anything appended to it, so a numbered element has to be in the document
   * the run executes rather than added to a second one. The seeded pull request
   * names the branch instead of a commit, and the fixture reads the commit when
   * it answers — which is what GitHub does too.
   */
  function* upsert(
    remote: BareRemote,
    seed: StoredPullRequest,
    element: string[],
    runId?: string,
  ): Operation<{ database: WorkflowRunDatabase; run: ReturnType<typeof fixture> }> {
    const database = yield* createRun(runId === undefined ? {} : { runId });
    const run = fixture(remote, [seed]);
    yield* runWorkflowDocument(database, published(...element), run.options);
    return { database, run };
  }

  it("records a no-op when the numbered pull request already says this", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const { database, run } = yield* upsert(remote, stored({ number: 12 }), numbered(12));

      // Nothing was mutated, and the no-op is the shared adoption.
      expect(mutations(run.store)).toEqual([]);
      const record = Object(yield* pullRequestRecord(database));
      expect(record.decision).toBe("adopted");
      expect(record.preState).toEqual(record.observations);
      expect(Reflect.get(Object(record.result), "number")).toBe(12);
      const head = yield* headCommit(database, yield* checkoutPath(database));
      expect(Reflect.get(Object(record.result), "headSha")).toBe(head.commit);
      expect(Reflect.get(Object(record.result), "baseSha")).toBe(remoteBranch(remote, "main"));
    });
  });

  it("brings the title, body and base of a numbered pull request up to date", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const { database, run } = yield* upsert(
        remote,
        stored({
          number: 12,
          title: "Draft title",
          body: "old body",
          baseRef: "develop",
          baseSha: "9".repeat(40),
        }),
        numbered(12),
      );

      const updated = run.store.pullRequests[0];
      expect(updated?.title).toBe(TITLE);
      expect(updated?.body).toBe(`\n${BODY}\n`);
      expect(updated?.baseRef).toBe("main");
      expect(creations(run.store)).toBe(0);
      expect(mutations(run.store)).toEqual(["patch"]);

      const record = Object(yield* pullRequestRecord(database));
      expect(record.decision).toBe("performed");
      // The pre-state is what was there, which is what makes a performed update
      // describable; the result names the base commit it moved to.
      expect(Reflect.get(Object(record.preState), "pullRequest")).toMatchObject({
        title: "Draft title",
        baseBranch: "develop",
      });
      const head = yield* headCommit(database, yield* checkoutPath(database));
      expect(Reflect.get(Object(record.result), "baseSha")).toBe(remoteBranch(remote, "main"));
      expect(Reflect.get(Object(record.result), "headSha")).toBe(head.commit);
    });
  });

  it("moves draft state to ready, and nothing else with it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const { run } = yield* upsert(remote, stored({ number: 12, draft: true }), numbered(12));
      expect(run.store.pullRequests[0]?.draft).toBe(false);
      // Draft is not a REST field, and nothing else differed.
      expect(mutations(run.store)).toEqual(["draft"]);
      expect(run.store.pullRequests[0]?.title).toBe(TITLE);
    });
  });

  it("moves draft state back to draft", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const { run } = yield* upsert(
        remote,
        stored({ number: 12, draft: false }),
        numbered(12, " draft={true}"),
      );
      expect(run.store.pullRequests[0]?.draft).toBe(true);
      expect(mutations(run.store)).toEqual(["draft"]);
    });
  });

  it("refuses a number that names another repository, head or state", function* () {
    const root = yield* useStorageRoot();

    const FOREIGN = [
      { headRepository: "someone/fork" },
      { headRef: "another-branch" },
      { state: "closed" as const },
    ];
    for (const [index, foreign] of FOREIGN.entries()) {
      // A remote of its own each time: the branch this document publishes would
      // otherwise already be there, and the second run would have nothing to
      // commit.
      const remote = yield* useBareRemote(REMOTE);
      yield* withStorage(root, function* () {
        const database = yield* createRun({ runId: `foreign-${index}` });
        const run = fixture(remote, [stored({ number: 12, ...foreign })]);
        const failure = yield* raised(
          runWorkflowDocument(database, published(...numbered(12)), run.options),
        );

        expect(String(failure)).toContain("conflicts");
        // Nothing was rewritten onto state this element did not prove.
        expect(mutations(run.store)).toEqual([]);
      });
    }
  });

  it("refuses a number the host will not answer for, and mutates nothing", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // No pull request under that number: a 404 is "missing, and I cannot
      // prove it", which never becomes absence and never creates anything.
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(database, published(...numbered(12)), run.options),
      );

      expect(String(failure)).toContain("temporarily unavailable");
      expect(mutations(run.store)).toEqual([]);
      expect(creations(run.store)).toBe(0);
    });
  });

  it("publishes an unavailability when only half of an update applied", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote, [stored({ number: 12, title: "Draft title", draft: true })]);
      run.store.fault = { on: "graphql", status: 502 };
      const failure = yield* raised(
        runWorkflowDocument(database, published(...numbered(12)), run.options),
      );

      expect(String(failure)).toContain("temporarily unavailable");
      // The REST half applied and was not repeated; the draft half did not.
      expect(run.store.pullRequests[0]?.title).toBe(TITLE);
      expect(run.store.pullRequests[0]?.draft).toBe(true);
      expect(mutations(run.store)).toEqual(["patch", "draft"]);
    });
  });

  it("finishes a partial update on the next attempt, repeating nothing", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: "interrupted-update" });
      const interrupted = fixture(remote, [
        stored({ number: 12, title: "Draft title", draft: true }),
      ]);
      interrupted.store.fault = { on: "graphql", status: 502 };
      yield* raised(runWorkflowDocument(database, published(...numbered(12)), interrupted.options));
      expect(interrupted.store.pullRequests[0]?.title).toBe(TITLE);
      expect(interrupted.store.pullRequests[0]?.draft).toBe(true);

      // A second run over the same host state. It publishes nothing new — the
      // branch is already there at this commit, so its Push adopts — and the
      // title is already what it should be, so only the draft transition is
      // left to make.
      const resumed = yield* createRun({ runId: "resumed-update" });
      const second = fixture(remote, interrupted.store.pullRequests);
      yield* runWorkflowDocument(
        resumed,
        document(`<Git.Switch branch="${BRANCH}" />`, `<Git.Push />`, ...numbered(12)),
        second.options,
      );

      expect(second.store.pullRequests[0]?.draft).toBe(false);
      expect(second.store.pullRequests[0]?.title).toBe(TITLE);
      expect(mutations(second.store)).toEqual(["draft"]);
      expect(Object(yield* pullRequestRecord(resumed)).decision).toBe("performed");
    });
  });

  it("requires this run's own Push before it updates a numbered pull request", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote, [stored({ number: 12 })]);
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          document(
            `<Git.Switch branch="${BRANCH}" />`,
            `<File path="notes.md">`,
            "prepared",
            "</File>",
            `<Git.Add paths="notes.md" />`,
            `<Git.Commit message="prepare the release" as="commit" />`,
            ...numbered(12),
          ),
          run.options,
        ),
      );

      expect(causedBy(failure, isAuthorityFailure)?.reason).toBe("missing-push-evidence");
      expect(run.store.requests).toHaveLength(0);
    });
  });

  it("cannot decide a walk it will not follow, and creates nothing", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      // A listing that names a next page somewhere this adapter will not go.
      run.store.link = '<https://elsewhere.invalid/pulls?page=2>; rel="next"';
      const failure = yield* raised(
        runWorkflowDocument(database, published(...pullRequest()), run.options),
      );

      expect(String(failure)).toContain("temporarily unavailable");
      expect(creations(run.store)).toBe(0);
      expect(run.store.pullRequests).toHaveLength(0);
    });
  });
});

/**
 * One element, an absent number, and the iteration that supplies it.
 *
 * The document below is the shape #537 exists for: an optional identity prop
 * that is not there yet, written once, and answered by what a preceding
 * iteration produced.
 */
describe("workflow PullRequest across a loop", () => {
  it("creates without a number, then updates the number it created", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    // One authored element, twice: the first iteration has no number to give
    // it — `pullRequest.number` is `undefined`, so the prop is absent and the
    // component asks for a pull request to exist — and the second gives it the
    // number the first one returned. That is the whole language change, read
    // through the shipped provider (#537).
    const source = published(
      '<Let as="pullRequest" value={{}} />',
      "<Loop max={2}>",
      `<PullRequest number={pullRequest.number} title={pullRequest.number ? "${TITLE} (revised)" ` +
        `: "${TITLE}"} as="pullRequest">`,
      `<If condition={pullRequest.number}>Revised notes.<Else>${BODY}</Else></If>`,
      "</PullRequest>",
      "</Loop>",
      "",
      "settled on {pullRequest.number}",
    );
    // The author wrote one invocation. Two would prove nothing about a number
    // that is absent until a result supplies it.
    expect(source.split("<PullRequest").length - 1).toBe(1);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      const rendered = String(yield* runWorkflowDocument(database, source, run.options));

      // One pull request, created once and then brought up to date — not two,
      // and not a second creation adopting the first.
      expect(creations(run.store)).toBe(1);
      expect(mutations(run.store)).toEqual(["create", "patch"]);
      expect(run.store.pullRequests).toHaveLength(1);
      const [settled] = run.store.pullRequests;
      expect(settled?.title).toBe(`${TITLE} (revised)`);
      expect(settled?.body).toBe("\nRevised notes.\n");
      expect(rendered).toContain(`settled on ${settled?.number}`);

      // The first request carries the normalized absence, and asks for a pull
      // request from this head; the second carries the created number, and
      // asks for that pull request.
      const created = Object(yield* pullRequestRecord(database, 1));
      const updated = Object(yield* pullRequestRecord(database, 2));
      expect(Reflect.get(Object(created.request), "inputs")).toMatchObject({ number: null });
      expect(Reflect.get(Object(created.request), "naturalKey")).toMatchObject({ mode: "create" });
      expect(Reflect.get(Object(updated.request), "inputs")).toMatchObject({
        number: settled?.number,
        title: `${TITLE} (revised)`,
      });
      expect(Reflect.get(Object(updated.request), "naturalKey")).toMatchObject({
        mode: "update",
        number: settled?.number,
      });
      expect(Reflect.get(Object(created.result), "number")).toBe(settled?.number);
      expect(Reflect.get(Object(updated.result), "number")).toBe(settled?.number);
    });
  });
});

describe("workflow PullRequest containment", () => {
  it("moves nothing local or remote of its own", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      yield* runWorkflowDocument(database, published(...pullRequest()), run.options);

      const head = yield* headCommit(database, yield* checkoutPath(database));
      const refs = remoteRefs(remote);
      expect(refs.get(`refs/heads/${BRANCH}`)).toBe(head.commit);
      // Exactly one push, and it is the one the document wrote.
      expect(subcommands(run.counting.counters).filter((name) => name === "push")).toHaveLength(1);
      expect(head.branch).toBe(BRANCH);
    });
  });

  it("keeps the credential, the locator and the payload out of everything durable", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      yield* runWorkflowDocument(database, published(...pullRequest()), run.options);

      const checkout = yield* checkoutPath(database);
      const events = yield* gitHostEvents(database);
      const journaled = JSON.stringify(events);

      expect(journaled).not.toContain(TOKEN);
      expect(journaled).not.toContain(LOCATOR);
      expect(journaled).not.toContain(remote.locator);
      expect(journaled).not.toContain(run.store.requests[0]?.url ?? "https://api.github.test");
      expect(journaled).not.toContain("checkoutPath");
      expect(journaled).not.toContain(checkout);
      // A member only a raw payload carries. The adapter reads eleven facts and
      // hands nothing else on.
      expect(journaled).not.toContain("_links");
      expect(journaled).not.toContain("octocat");
      expect(journaled).not.toContain("/private/tmp");
      expect(journaled).not.toContain("/var/folders");
    });
  });

  it("is an ordinary default a nested registration shadows", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const shadow: ComponentRegistration = {
        name: "PullRequest",
        origin: "test",
        props: { type: "object", additionalProperties: true },
        // deno-lint-ignore require-yield
        *fn(): Operation<string> {
          return "shadowed";
        },
      };
      const rendered = String(
        yield* runWorkflowDocument(
          database,
          published(`<PullRequest title="${TITLE}" />`),
          fixture(remote).options,
          (run_) =>
            scoped(function* () {
              yield* registerComponents([shadow]);
              return yield* run_();
            }),
        ),
      );
      expect(rendered).toContain("shadowed");
    });
  });

  it("acquires no provider under an ordinary run", function* () {
    const root = yield* useStorageRoot();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const failure = yield* raised(
        scoped(function* () {
          yield* useCompositionComponents();
          yield* RepositoryContext.around({ current: () => FORGED }, { at: "min" });
          return yield* collect(
            yield* execute({
              ...inlineSource(`<PullRequest title="${TITLE}" as="pullRequest" />`),
              stream: database.journal,
            }),
          );
        }),
      );

      // There is no host-less fallback. A pull request that "ran" without a
      // provider would say this run published something it never did.
      expect(String(failure)).toContain("no Git composition provider is installed");
    });
  });
});
