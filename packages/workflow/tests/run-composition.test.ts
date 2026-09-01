/**
 * Tier ORC — the repository vocabulary under an ordinary `xmd run`.
 *
 * The claims here are about a filesystem rather than a database. There is no
 * WorkflowRun, no Workspace, no journal and nothing to replay: what makes a
 * checkout this execution's is an advisory lock, and what makes it the same
 * checkout tomorrow is the sidecar beside it.
 *
 * Every repository in this file is real, every Git command is real, and the
 * managed root is a temporary directory of the suite's own — no test ever
 * touches the user's `~/.xmd/repositories`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, type Operation } from "effection";
import { exists, readdir, rm, writeTextFile } from "@effectionx/fs";
import { GitOperationAuthorityError } from "../src/composition/errors.ts";
import {
  ManagedCheckoutError,
  NoAmbientRepositoryError,
} from "../src/deno/run-composition/errors.ts";
import { git, remoteBranch, useBareRemote } from "./support/git-remotes.ts";
import {
  causedBy,
  commonDirectoryOf,
  raised,
  readSidecar,
  repositorySlotOf,
  runOrdinaryDocument,
  useHostCheckout,
  useManagedRoot,
  useOriginlessCheckout,
  worktreeSlotOf,
  type HostCheckout,
} from "./support/run-composition.ts";

const REMOTE = {
  commits: [
    { message: "first", entries: [{ path: "which.txt", content: "main\n" }] },
    {
      message: "release",
      branch: "release",
      entries: [{ path: "which.txt", content: "release\n" }],
    },
  ],
} as const;

function isManagedRefusal(value: unknown): value is ManagedCheckoutError {
  return value instanceof ManagedCheckoutError;
}

function isAuthorityFailure(value: unknown): value is GitOperationAuthorityError {
  return value instanceof GitOperationAuthorityError;
}

function isMissingAmbient(value: unknown): value is NoAmbientRepositoryError {
  return value instanceof NoAmbientRepositoryError;
}

/** Every entry a slot holds, sorted, so a byte-level comparison is stable. */
function* entriesOf(path: string): Operation<string[]> {
  if (!(yield* exists(path))) {
    return [];
  }
  return [...(yield* readdir(path))].sort();
}

describe("ORC3 — the ambient primary checkout", () => {
  it("switches, stages and commits in the repository the command was run in", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="feature" />`,
        `<File path="notes.md">ordinary</File>`,
        `<Git.Add paths="notes.md" />`,
        `<Git.Commit message="Write notes" as="commit" />`,
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    // The person's own checkout moved, and it is what a later `git` sees.
    expect(checkout.run("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(checkout.run("log", "-1", "--pretty=%s")).toBe("Write notes");
    expect(checkout.run("show", "--pretty=", "--name-only", "HEAD")).toContain("notes.md");
  });

  it("refuses a root Worktree outside a repository and names how to run inside one", function* () {
    const root = yield* useManagedRoot();
    // A directory that is not inside any Git checkout.
    const elsewhere = yield* useManagedRoot();

    const failure = yield* raised(
      runOrdinaryDocument(`<Worktree name="w" branch="b" as="w" />`, {
        root,
        cwd: elsewhere,
      }),
    );
    const refusal = causedBy(failure, isMissingAmbient);
    expect(refusal).toBeInstanceOf(NoAmbientRepositoryError);
    expect(String(refusal)).toContain("Run xmd from inside one");
  });
});

describe("ORC4 — the ambient linked worktree", () => {
  it("follows the common directory for identity and the worktree root for work", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const primary = yield* useHostCheckout(remote.locator);
    // A linked worktree made by hand, exactly as a person would.
    const linked = `${primary.root}-linked`;
    primary.run("worktree", "add", "-b", "sidecar", linked);

    const before = primary.run("rev-parse", "HEAD");

    yield* scoped(function* () {
      yield* runOrdinaryDocument(
        [
          `<File path="from-worktree.md">here</File>`,
          `<Git.Add paths="from-worktree.md" />`,
          `<Git.Commit message="In the worktree" as="commit" />`,
        ].join("\n"),
        // The command is run *in the linked worktree*.
        { root, cwd: linked },
      );
    });

    // The worktree advanced; the primary checkout did not.
    expect(primary.run("rev-parse", "HEAD")).toBe(before);
    expect(primary.run("log", "-1", "--pretty=%s", "sidecar")).toBe("In the worktree");
  });
});

describe("ORC5 — origin is not local authority", () => {
  it("creates a Worktree and commits with no origin, and refuses to publish", function* () {
    const root = yield* useManagedRoot();
    const solo = yield* useOriginlessCheckout();

    const bound = yield* runOrdinaryDocument(
      [
        `<Worktree name="feature" branch="feature" as="worktree" />`,
        "<Dir path={worktree}>",
        `<File path="local.md">no remote</File>`,
        `<Git.Add paths="local.md" />`,
        `<Git.Commit message="Local only" as="commit" />`,
        "</Dir>",
      ].join("\n"),
      { root, cwd: solo.root },
    );
    expect(typeof bound).toBe("string");
    expect(solo.run("log", "-1", "--pretty=%s", "feature")).toBe("Local only");

    // Push refuses before a credential, a session or a transport exists.
    const failure = yield* raised(runOrdinaryDocument(`<Git.Push />`, { root, cwd: solo.root }));
    const refusal = causedBy(failure, isAuthorityFailure);
    expect(refusal).toBeInstanceOf(GitOperationAuthorityError);
    expect(String(refusal)).toContain("no usable origin");
  });
});

describe("ORC6 — lexical working directories", () => {
  it("restores the enclosing directory after a Worktree body and a Dir body", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // A relative `<File>` path resolves against the contextual working
    // directory, so where each one lands is where the document was standing.
    const common = commonDirectoryOf(checkout);
    yield* runOrdinaryDocument(
      [
        `<File path="outer.md">outer</File>`,
        `<Worktree name="inner" branch="inner" as="worktree" />`,
        `<Worktree name="lexical" branch="lexical">`,
        `<File path="within.md">within</File>`,
        "</Worktree>",
        "<Dir path={worktree}>",
        `<File path="bound.md">bound</File>`,
        "</Dir>",
        `<File path="after.md">after</File>`,
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    const lexical = worktreeSlotOf(root, common, "lexical");
    const bound = worktreeSlotOf(root, common, "inner");
    expect(yield* exists(`${checkout.root}/outer.md`)).toBe(true);
    // Each body observed its own checkout.
    expect(yield* exists(`${lexical.checkout}/within.md`)).toBe(true);
    expect(yield* exists(`${bound.checkout}/bound.md`)).toBe(true);
    // Restored: the sibling after both is back in the enclosing directory.
    expect(yield* exists(`${checkout.root}/after.md`)).toBe(true);
    expect(yield* exists(`${lexical.checkout}/after.md`)).toBe(false);
    expect(yield* exists(`${bound.checkout}/after.md`)).toBe(false);
  });

  it("restores the enclosing directory when the body fails", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // The refusal is printed rather than fatal, so the document goes on — and
    // what it goes on in is the directory the Worktree body was installed over.
    yield* runOrdinaryDocument(
      [
        "<PrintErrors>",
        `<Worktree name="failing" branch="failing">`,
        `<Git.Add paths="absent-on-purpose.md" />`,
        "</Worktree>",
        "</PrintErrors>",
        `<File path="after.md">after</File>`,
      ].join("\n"),
      { root, cwd: checkout.root },
    );
    expect(yield* exists(`${checkout.root}/after.md`)).toBe(true);
    const failing = worktreeSlotOf(root, commonDirectoryOf(checkout), "failing");
    expect(yield* exists(`${failing.checkout}/after.md`)).toBe(false);
  });
});

describe("ORC8 — managed checkouts are persistent", () => {
  it("leaves the checkout, its metadata and its working files after the run", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const common = commonDirectoryOf(checkout);
    const slot = worktreeSlotOf(root, common, "kept");

    yield* runOrdinaryDocument(
      [
        `<Worktree name="kept" branch="kept">`,
        `<File path="draft.md">unfinished</File>`,
        "</Worktree>",
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    expect(yield* exists(slot.checkout)).toBe(true);
    expect(yield* exists(`${slot.checkout}/draft.md`)).toBe(true);
    const sidecar = yield* readSidecar(slot);
    expect(sidecar).toMatchObject({
      kind: "worktree",
      version: 1,
      name: "kept",
      requestedBranch: "kept",
      requestedBase: null,
      owner: common,
    });
  });

  it("keeps the checkout after an authored failure inside the Worktree body", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "survivor");

    yield* raised(
      runOrdinaryDocument(
        [
          `<Worktree name="survivor" branch="survivor">`,
          `<File path="kept.md">written before the failure</File>`,
          `<Git.Add paths="absent-on-purpose.md" />`,
          "</Worktree>",
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );

    expect(yield* exists(`${slot.checkout}/kept.md`)).toBe(true);
    expect(yield* readSidecar(slot)).toMatchObject({ kind: "worktree" });
  });
});

describe("ORC9 — compatible reuse", () => {
  it("reuses the same checkout and preserves the work the first run left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    const document = `<Repository name="project" url="${remote.locator}" as="repository" />`;

    const first = yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const created = yield* readSidecar(slot);

    // Work a person would do between two runs: a new branch and a commit.
    git(["switch", "-c", "later"], slot.checkout, checkout.home);
    git(["commit", "--allow-empty", "-m", "moved on"], slot.checkout, checkout.home);
    const moved = git(["rev-parse", "HEAD"], slot.checkout, checkout.home);

    const second = yield* runOrdinaryDocument(document, { root, cwd: checkout.root });

    expect(second).toBe(first);
    expect(yield* readSidecar(slot)).toEqual(created);
    // Neither the branch it is on nor the commit it holds was reset.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], slot.checkout, checkout.home)).toBe("later");
    expect(git(["rev-parse", "HEAD"], slot.checkout, checkout.home)).toBe(moved);
  });
});

describe("ORC10 — a conflict changes nothing", () => {
  it("refuses a changed base and leaves the slot byte-identical", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    yield* runOrdinaryDocument(`<Repository name="project" url="${remote.locator}" as="r" />`, {
      root,
      cwd: checkout.root,
    });
    const before = yield* readSidecar(slot);
    const beforeEntries = yield* entriesOf(slot.slot);

    const failure = yield* raised(
      runOrdinaryDocument(
        `<Repository name="project" url="${remote.locator}" base="release" as="r" />`,
        { root, cwd: checkout.root },
      ),
    );
    const refusal = causedBy(failure, isManagedRefusal);
    expect(refusal?.reason).toBe("incompatible-reuse");
    expect(yield* readSidecar(slot)).toEqual(before);
    expect(yield* entriesOf(slot.slot)).toEqual(beforeEntries);
  });

  it("refuses a Worktree asked for on a different branch", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "review");

    yield* runOrdinaryDocument(`<Worktree name="review" branch="one" as="w" />`, {
      root,
      cwd: checkout.root,
    });
    const before = yield* readSidecar(slot);

    const failure = yield* raised(
      runOrdinaryDocument(`<Worktree name="review" branch="two" as="w" />`, {
        root,
        cwd: checkout.root,
      }),
    );
    expect(causedBy(failure, isManagedRefusal)?.reason).toBe("incompatible-reuse");
    expect(yield* readSidecar(slot)).toEqual(before);
  });
});

describe("ORC11 — an interrupted creation", () => {
  it("adopts a metadata-free checkout that is exactly what creation would have left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    const document = `<Repository name="project" url="${remote.locator}" as="r" />`;
    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const written = yield* readSidecar(slot);
    // Exactly the state an interruption between the clone and the sidecar
    // leaves: the checkout, and nothing describing it.
    yield* rm(slot.metadata);
    expect(yield* readSidecar(slot)).toBe(undefined);

    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    expect(yield* readSidecar(slot)).toEqual(written);
  });

  it("refuses a slot holding something creation would never have left", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = repositorySlotOf(root, remote.locator, "project");

    const document = `<Repository name="project" url="${remote.locator}" as="r" />`;
    yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    yield* rm(slot.metadata);
    // An unexplained entry beside the checkout.
    yield* writeTextFile(`${slot.slot}/stray.txt`, "who put this here\n");
    const beforeEntries = yield* entriesOf(slot.slot);

    const failure = yield* raised(runOrdinaryDocument(document, { root, cwd: checkout.root }));
    expect(causedBy(failure, isManagedRefusal)?.reason).toBe("partial-creation");
    expect(yield* entriesOf(slot.slot)).toEqual(beforeEntries);
    expect(yield* readSidecar(slot)).toBe(undefined);
  });
});

describe("ORC13 — live local Git", () => {
  it("makes real, non-transactional changes and claims no rollback on failure", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="partway" />`,
          `<File path="staged.md">staged before the failure</File>`,
          `<Git.Add paths="staged.md" />`,
          `<Git.Add paths="never-existed.md" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    expect(failure).toBeInstanceOf(Error);

    // The switch and the first Add really happened, and nothing took them back.
    expect(checkout.run("rev-parse", "--abbrev-ref", "HEAD")).toBe("partway");
    expect(checkout.run("diff", "--cached", "--name-only")).toContain("staged.md");
  });

  it("refuses a branch another checkout of the same repository holds", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    yield* runOrdinaryDocument(`<Worktree name="held" branch="held" as="w" />`, {
      root,
      cwd: checkout.root,
    });

    const failure = yield* raised(
      runOrdinaryDocument(`<Git.Switch branch="held" />`, { root, cwd: checkout.root }),
    );
    expect(String(failure)).toContain("branch-checked-out-elsewhere");
  });
});

describe("ORC14 — live Push evidence", () => {
  it("publishes the branch and lets exactly that head reach the Git host adapter", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="published" />`,
          `<File path="published.md">published</File>`,
          `<Git.Add paths="published.md" />`,
          `<Git.Commit message="Publish" as="commit" />`,
          `<Git.Push />`,
          `<PullRequest title="Publish" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );

    // The branch really is at the remote, at the commit this execution made.
    expect(remoteBranch(remote, "published")).toBe(checkout.run("rev-parse", "HEAD"));
    // And the pull request got past the evidence gate: what stopped it is the
    // adapter declining a locator that is not a github.com repository, which is
    // the step *after* the local authorization this criterion is about.
    expect(String(failure)).toContain("only for repositories on github.com");
    expect(String(failure)).not.toContain("holds no successful <Git.Push> result");
  });

  it("does not let a Push of another branch authorize this one", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="elsewhere" />`,
          `<Git.Push />`,
          `<Git.Switch branch="unpublished" />`,
          `<PullRequest title="Not this one" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    expect(String(failure)).toContain("holds no successful <Git.Push> result");
    expect(remoteBranch(remote, "unpublished")).toBe(undefined);
  });

  it("lets the latest publication of a destination decide", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="moving" />`,
          `<File path="one.md">one</File>`,
          `<Git.Add paths="one.md" />`,
          `<Git.Commit message="One" as="first" />`,
          `<Git.Push />`,
          `<File path="two.md">two</File>`,
          `<Git.Add paths="two.md" />`,
          `<Git.Commit message="Two" as="second" />`,
          // The head has moved past what was published, and no second Push
          // followed it.
          `<PullRequest title="Moved on" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    expect(String(failure)).toContain("published that branch at a different commit");
  });
});

describe("ORC15 — evidence cannot cross runs", () => {
  it("refuses a PullRequest in an execution that published nothing", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(`<PullRequest title="Nothing pushed" as="pr" />`, {
        root,
        cwd: checkout.root,
      }),
    );
    expect(String(failure)).toContain("holds no successful <Git.Push> result");
  });
});

/** Two executions in one process must not share a checkout registry. */
describe("ORC12 — exclusive ownership within one host", () => {
  it("releases a slot's lease when the execution ends, so a later one takes it", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout: HostCheckout = yield* useHostCheckout(remote.locator);

    const document = `<Worktree name="serial" branch="serial" as="w" />`;
    const first = yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    const second = yield* runOrdinaryDocument(document, { root, cwd: checkout.root });
    expect(second).toBe(first);
  });
});
