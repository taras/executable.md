/**
 * Tier ORC — ambient discovery and local Git under an ordinary `xmd run`.
 *
 * What repository an ordinary run is *in*, and what it may do to it without
 * leaving it: the primary checkout, a linked worktree, what an `origin` does
 * and does not authorize, lexical working directories, and the local Git
 * operations that write to the caller's own tree.
 *
 * The claims here are about a filesystem rather than a database. There is no
 * WorkflowRun, no Workspace, no journal and nothing to replay. Every repository
 * is real, every Git command is real, and the managed root is a temporary
 * directory of the suite's own — no test ever touches the user's
 * `~/.xmd/repositories`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { ensureDir, exists, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { until } from "effection";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { UnresolvedGitIdentityError } from "../src/deno/run-composition/errors.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";
import {
  causedBy,
  commonDirectoryOf,
  countingOrdinaryHost,
  haltAtGate,
  statedIdentity,
  subcommands,
  raised,
  runOrdinaryDocument,
  recordingAccess,
  useHostCheckout,
  useManagedRoot,
  useOriginlessCheckout,
  worktreeSlotOf,
} from "./support/run-composition.ts";
import {
  GITHUB_LOCATOR,
  REMOTE,
  isMissingAmbient,
  reviewRoutes,
} from "./support/run-composition-tier.ts";

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

  it("refuses every root element that needs a repository outside a Git checkout", function* () {
    const root = yield* useManagedRoot();
    // A directory that is not inside any Git checkout.
    const elsewhere = yield* useManagedRoot();

    const outside = [
      `<Worktree name="w" branch="b" as="w" />`,
      `<Git.Switch branch="b" />`,
      `<Git.Add paths="a.md" />`,
      `<Git.Commit message="m" as="c" />`,
      `<Git.Push />`,
      `<PullRequest title="t" as="pr" />`,
    ];
    for (const source of outside) {
      const counting = countingOrdinaryHost();
      const failure = yield* raised(
        runOrdinaryDocument(source, {
          root,
          cwd: elsewhere,
          host: counting.host,
        }),
      );
      const refusal = causedBy(failure, isMissingAmbient);
      // The element travels in the message, so a failure says which of the six
      // reported something else.
      expect(`${source} ${refusal?.name}`).toBe(`${source} NoAmbientRepositoryError`);
      expect(String(refusal)).toContain("Run xmd from inside one");
      // Discovery asked Git where it was and stopped. Nothing published, nothing
      // authenticated, no transport.
      expect(counting.counters.sessions).toEqual([]);
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
    }
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
  it("does local work with no origin, and refuses to publish before reaching anything", function* () {
    const root = yield* useManagedRoot();
    const solo = yield* useOriginlessCheckout();

    // Worktree, Switch, Add and Commit all work without an origin: none of them
    // has anywhere to go.
    const bound = yield* runOrdinaryDocument(
      [
        `<Worktree name="feature" branch="feature" as="worktree" />`,
        "<Dir path={worktree}>",
        `<Git.Switch branch="feature-two" />`,
        `<File path="local.md">no remote</File>`,
        `<Git.Add paths="local.md" />`,
        `<Git.Commit message="Local only" as="commit" />`,
        "</Dir>",
      ].join("\n"),
      { root, cwd: solo.root },
    );
    expect(typeof bound).toBe("string");
    expect(solo.run("log", "-1", "--pretty=%s", "feature-two")).toBe("Local only");

    // Push and PullRequest each refuse, and each refuses before a credential is
    // read, a session is opened or a byte leaves for a Git host.
    for (const source of [`<Git.Push />`, `<PullRequest title="t" as="pr" />`]) {
      const counting = countingOrdinaryHost();
      const github = recordingAccess({});
      const failure = yield* raised(
        runOrdinaryDocument(source, {
          root,
          cwd: solo.root,
          host: counting.host,
          gitHubPullRequests: { access: gitHubSource(github.access) },
          gitHubIssues: { ceiling: [GITHUB_LOCATOR], access: gitHubSource(github.access) },
        }),
      );
      expect(`${source} ${String(failure)}`).toContain("no usable origin");
      // No authentication session was opened for any locator.
      expect(counting.counters.sessions).toEqual([]);
      // No transport ran: neither observation nor publication.
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      // And nothing was asked of a Git host — no credential, no request.
      expect(github.credentials).toBe(0);
      expect(github.requests).toEqual([]);
    }
  });

  it("opens a session and transports when there is an origin, so the counters can fail", function* () {
    // The same counters, on a repository that *does* have an origin. Without
    // this, every assertion above would pass on a counter that can never be
    // incremented — which is the one way "nothing was reached" lies.
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const counting = countingOrdinaryHost();

    yield* runOrdinaryDocument([`<Git.Switch branch="published" />`, `<Git.Push />`].join("\n"), {
      root,
      cwd: checkout.root,
      host: counting.host,
    });

    expect(counting.counters.sessions).toEqual([remote.locator]);
    expect(subcommands(counting.counters)).toContain("ls-remote");
    expect(subcommands(counting.counters)).toContain("push");
  });

  it("reaches a Git host when one is configured, so those counters can fail too", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const endpoint = "https://api.github.test";
    const github = recordingAccess(reviewRoutes(endpoint), endpoint);

    yield* runOrdinaryDocument(
      `<PullRequest.Reviews url="${GITHUB_LOCATOR}/pull/4" as="reviews" />`,
      {
        root,
        cwd: checkout.root,
        gitHubPullRequests: { allowed: [GITHUB_LOCATOR], access: gitHubSource(github.access) },
      },
    );

    expect(github.credentials).toBeGreaterThan(0);
    expect(github.requests.length).toBeGreaterThan(0);
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

  it("restores the enclosing directory when the body is cancelled", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const slot = worktreeSlotOf(root, commonDirectoryOf(checkout), "halted");

    // The document is torn down from outside with `<Gate />` still in flight,
    // inside the Worktree body. The installation lives on the invocation's own
    // scope, so unwinding it is what restores the enclosing directory.
    yield* haltAtGate(
      [
        `<Worktree name="halted" branch="halted">`,
        `<File path="written.md">written before the halt</File>`,
        "<Gate />",
        "</Worktree>",
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    // The Worktree's own file is where the body was standing, and the enclosing
    // checkout never received it.
    expect(yield* exists(`${slot.checkout}/written.md`)).toBe(true);
    expect(yield* exists(`${checkout.root}/written.md`)).toBe(false);

    // And the enclosing directory is usable again: a later execution writes at
    // the ambient checkout, not inside the Worktree.
    yield* runOrdinaryDocument(`<File path="after.md">after</File>`, {
      root,
      cwd: checkout.root,
    });
    expect(yield* exists(`${checkout.root}/after.md`)).toBe(true);
    expect(yield* exists(`${slot.checkout}/after.md`)).toBe(false);
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

  it("keeps what a cancelled document had already done, and claims no rollback", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    yield* haltAtGate(
      [
        `<Git.Switch branch="interrupted" />`,
        `<File path="staged.md">staged before the halt</File>`,
        `<Git.Add paths="staged.md" />`,
        "<Gate />",
        `<Git.Commit message="never reached" as="commit" />`,
      ].join("\n"),
      { root, cwd: checkout.root },
    );

    // Both transitions really happened, and nothing took them back.
    expect(checkout.run("rev-parse", "--abbrev-ref", "HEAD")).toBe("interrupted");
    expect(checkout.run("diff", "--cached", "--name-only")).toContain("staged.md");
    // And the commit the document never reached was never made.
    expect(checkout.run("log", "-1", "--pretty=%s")).not.toBe("never reached");
  });

  it("commits as the invoking user, not as the workflow identity", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    yield* runOrdinaryDocument(
      [
        `<File path="mine.md">mine</File>`,
        `<Git.Add paths="mine.md" />`,
        `<Git.Commit message="Authored by me" as="commit" />`,
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        identity: statedIdentity("Ada Lovelace <ada@example.test> 1 +0000"),
      },
    );

    expect(checkout.run("log", "-1", "--pretty=%an|%ae|%cn|%ce")).toBe(
      "Ada Lovelace|ada@example.test|Ada Lovelace|ada@example.test",
    );
    expect(checkout.run("log", "-1", "--pretty=%an")).not.toBe("Executable.md workflow");
  });

  it("takes author and committer separately when the host resolves them apart", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    yield* runOrdinaryDocument(
      [
        `<File path="pair.md">pair</File>`,
        `<Git.Add paths="pair.md" />`,
        `<Git.Commit message="Two identities" as="commit" />`,
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        identity: statedIdentity(
          "Ada Lovelace <ada@example.test> 1 +0000",
          "Grace Hopper <grace@example.test> 1 +0000",
        ),
      },
    );

    expect(checkout.run("log", "-1", "--pretty=%an|%ae|%cn|%ce")).toBe(
      "Ada Lovelace|ada@example.test|Grace Hopper|grace@example.test",
    );
  });

  it("refuses to commit when the host cannot say who the commit is by", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const before = checkout.run("rev-parse", "HEAD");

    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<File path="orphan.md">orphan</File>`,
          `<Git.Add paths="orphan.md" />`,
          `<Git.Commit message="Nobody" as="commit" />`,
        ].join("\n"),
        { root, cwd: checkout.root, identity: statedIdentity(undefined) },
      ),
    );

    expect(failure).toBeInstanceOf(UnresolvedGitIdentityError);
    expect(String(failure)).toContain("git config --global user.name");
    // Nothing was committed, and no identity was substituted.
    expect(checkout.run("rev-parse", "HEAD")).toBe(before);
    // The staging that came before it still happened: this refuses the commit,
    // not the document that led to it.
    expect(checkout.run("diff", "--cached", "--name-only")).toContain("orphan.md");
  });

  it("leaves every other component usable when no identity resolves", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // Repository, Worktree, Dir, Switch and Add all work: none of them writes a
    // commit object, so none of them needs to know who anybody is.
    const rendered = yield* runOrdinaryDocument(
      [
        `<Repository name="project" url="${remote.locator}" as="repository" />`,
        `<Worktree name="usable" branch="usable" as="worktree" />`,
        "<Dir path={worktree}>",
        `<Git.Switch branch="usable-two" />`,
        `<File path="fine.md">fine</File>`,
        `<Git.Add paths="fine.md" />`,
        "</Dir>",
        "",
        "ran",
      ].join("\n"),
      { root, cwd: checkout.root, identity: statedIdentity(undefined) },
    );
    expect(String(rendered)).toContain("ran");
  });

  it("keeps hooks, monitors, signing and repository helpers disabled", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const outside = yield* useTempDirectory("xmd-ordinary-hooks-");
    const marks = { pre: `${outside}/pre-commit`, post: `${outside}/post-commit` };

    // A repository that does everything it can to run a program of its own: two
    // hooks, a signing program, a file-system monitor and a credential helper.
    for (const [hook, mark] of [
      ["pre-commit", marks.pre],
      ["post-commit", marks.post],
    ] as const) {
      yield* ensureDir(`${checkout.root}/.githooks`);
      yield* writeTextFile(
        `${checkout.root}/.githooks/${hook}`,
        `#!/bin/sh\nprintf ran > ${mark}\n`,
      );
      yield* until(chmod(`${checkout.root}/.githooks/${hook}`, 0o755));
    }
    checkout.run("config", "core.hooksPath", ".githooks");
    checkout.run("config", "commit.gpgSign", "true");
    checkout.run("config", "gpg.program", `${outside}/absent-signer`);
    checkout.run("config", "core.fsmonitor", `${outside}/absent-monitor`);
    checkout.run("config", "credential.helper", `!${outside}/absent-helper`);

    yield* runOrdinaryDocument(
      [
        `<File path="safe.md">safe</File>`,
        `<Git.Add paths="safe.md" />`,
        `<Git.Commit message="Still isolated" as="commit" />`,
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        identity: statedIdentity("Ada Lovelace <ada@example.test> 1 +0000"),
      },
    );

    // The identity is the only thing borrowed. Neither hook ran, the commit is
    // unsigned, and the monitor and helper programs — which do not exist —
    // never had to.
    expect({
      pre: yield* exists(marks.pre),
      post: yield* exists(marks.post),
    }).toEqual({ pre: false, post: false });
    expect(checkout.run("log", "-1", "--pretty=%G?")).toBe("N");
    expect(checkout.run("log", "-1", "--pretty=%an")).toBe("Ada Lovelace");
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
