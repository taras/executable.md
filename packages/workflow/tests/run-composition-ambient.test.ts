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
import { join } from "node:path";
import { symlink } from "node:fs/promises";
import { API, cwd } from "@executablemd/runtime";
import { spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { selectedRepository } from "../src/composition/context.ts";
import type { RepositorySelection } from "../src/composition/selection.ts";
import type { ComponentRegistration } from "@executablemd/core";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { ensureDir, exists, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
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

/** A component that records the whole Repository selection in scope. */
function selectionProbe(seen: (RepositorySelection | undefined)[]): ComponentRegistration {
  return {
    name: "Stated",
    origin: "test",
    props: { type: "object", additionalProperties: false },
    *fn(): Operation<string> {
      seen.push(yield* selectedRepository());
      return "";
    },
  };
}

describe("ORC6 — Dir makes the directory it names", () => {
  // ORC6: the ordering claim and the two path rules, in one document.
  it("ORC6: creates missing parents, keeps an absolute path, and finishes before content", function* () {
    const root = yield* useManagedRoot();
    const checkout = (yield* useOriginlessCheckout()).root;
    const elsewhere = yield* useTempDirectory("xmd-orc6-absolute-");

    // The ordering probe. A nested `<File>` proves nothing about ordering,
    // because a write creates its own parents recursively — it would land
    // whether or not the ensure had finished. This runs *first* inside the
    // region and records what it finds: whether the directory is already there,
    // and what the contextual working directory is at that moment.
    const observed: { exists: boolean; cwd: string }[] = [];
    const probe: ComponentRegistration = {
      name: "Observes",
      origin: "test://observes",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(): Operation<string> {
        const here = yield* cwd();
        observed.push({ exists: yield* exists(here), cwd: here });
        return "";
      },
    };

    yield* runOrdinaryDocument(
      [
        '<Dir path="made/deep">',
        "",
        "<Observes />",
        "",
        '<File path="inside.md">landed</File>',
        "",
        "</Dir>",
        "",
        `<Dir path="${join(elsewhere, "written", "here")}">`,
        "",
        "<Observes />",
        "",
        '<File path="outside.md">also landed</File>',
        "",
        "</Dir>",
        "",
      ].join("\n"),
      { root, cwd: checkout, components: [probe] },
    );

    // Before any other content ran, the directory already existed and was the
    // contextual working directory. That is the ordering claim, observed rather
    // than inferred.
    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual({ exists: true, cwd: join(checkout, "made", "deep") });
    expect(observed[1]).toEqual({
      exists: true,
      cwd: join(elsewhere, "written", "here"),
    });

    // Every missing parent, and the file that landed after them.
    expect(yield* readTextFile(join(checkout, "made", "deep", "inside.md"))).toBe("landed");
    // The absolute target names exactly that place — not a rebase beneath cwd.
    expect(yield* readTextFile(join(elsewhere, "written", "here", "outside.md"))).toBe(
      "also landed",
    );
    expect(yield* exists(join(checkout, elsewhere.replace(/^\//, "")))).toBe(false);
  });

  // ORC6a: an existing directory is adopted. Asserted on the bytes and on the
  // entry list, because a provider that removed and recreated it would pass a
  // test that only checked the directory exists.
  it("ORC6a: an existing directory keeps its contents", function* () {
    const root = yield* useManagedRoot();
    const checkout = (yield* useOriginlessCheckout()).root;
    yield* ensureDir(join(checkout, "kept", "sub"));
    yield* writeTextFile(join(checkout, "kept", "planted.txt"), "the bytes that were here");

    yield* runOrdinaryDocument(
      '<Dir path="kept">\n\n<File path="added.md">added</File>\n\n</Dir>\n',
      { root, cwd: checkout },
    );

    expect(yield* readTextFile(join(checkout, "kept", "planted.txt"))).toBe(
      "the bytes that were here",
    );
    expect((yield* readdir(join(checkout, "kept"))).sort()).toEqual([
      "added.md",
      "planted.txt",
      "sub",
    ]);
  });

  // ORC6b: a non-directory refuses before content, at the target and on the way
  // to it, and what the document is told carries no host path or platform code.
  it("ORC6b: a file or a special entry, at the target or on the way, refuses", function* () {
    const root = yield* useManagedRoot();
    const checkout = (yield* useOriginlessCheckout()).root;
    yield* writeTextFile(join(checkout, "occupied"), "a file");
    yield* writeTextFile(join(checkout, "pointee"), "what the link names");
    yield* until(symlink(join(checkout, "pointee"), join(checkout, "linked")));

    // The same four positions the host contract covers, asked of the shipped
    // element: a regular file and a supported special entry, each at the target
    // and each on the way to it.
    for (const path of ["occupied", "occupied/below", "linked", "linked/below"]) {
      const printed = String(
        yield* runOrdinaryDocument(
          `<PrintErrors>\n<Dir path="${path}">\n\nINSIDE\n\n</Dir>\n</PrintErrors>\n`,
          { root, cwd: checkout },
        ),
      );
      expect(`${path}: ${printed.includes("not a directory")}`).toBe(`${path}: true`);
      expect(`${path}: ${printed.includes("INSIDE")}`).toBe(`${path}: false`);
      expect(`${path}: ${printed.includes(checkout)}`).toBe(`${path}: false`);
      expect(`${path}: ${/ENOTDIR|ENOENT|errno/i.test(printed)}`).toBe(`${path}: false`);
    }

    // Nothing the refusals touched changed.
    expect(yield* readTextFile(join(checkout, "occupied"))).toBe("a file");
    expect(yield* readTextFile(join(checkout, "pointee"))).toBe("what the link names");
  });

  // ORC6c: the enclosing directory comes back, on each of the three ways out.
  // A `<File>` written after the region is what says where the document is
  // standing — the path is relative, so it lands wherever cwd points.
  it("ORC6c: the enclosing directory is restored after success, failure and cancellation", function* () {
    const root = yield* useManagedRoot();
    const checkout = (yield* useOriginlessCheckout()).root;

    yield* runOrdinaryDocument(
      [
        '<Dir path="inner">',
        "",
        '<File path="within.md">within</File>',
        "",
        "</Dir>",
        "",
        '<File path="after-success.md">after</File>',
        "",
      ].join("\n"),
      { root, cwd: checkout },
    );
    expect(yield* exists(join(checkout, "inner", "within.md"))).toBe(true);
    expect(yield* exists(join(checkout, "after-success.md"))).toBe(true);

    yield* runOrdinaryDocument(
      [
        "<PrintErrors>",
        '<Dir path="inner">',
        "",
        '<File path="../../escape.md">no</File>',
        "",
        "</Dir>",
        "</PrintErrors>",
        "",
        '<File path="after-failure.md">after</File>',
        "",
      ].join("\n"),
      { root, cwd: checkout },
    );
    // Beside the checkout root, not beside `inner`: the region restored cwd on
    // its way out even though the content inside it failed.
    expect(yield* exists(join(checkout, "after-failure.md"))).toBe(true);
    expect(yield* exists(join(checkout, "inner", "after-failure.md"))).toBe(false);

    // And after cancellation. This one is observed rather than inferred from a
    // later run: a fresh execution is handed its cwd explicitly, so where its
    // files land says nothing about what the cancelled one restored.
    //
    // The gate is inside the region, so the halt lands with `<Dir>`'s cwd
    // installed. What the enclosing scope reads afterwards is the restoration.
    const reached = withResolvers<void>();
    const seen: string[] = [];
    yield* scoped(function* () {
      yield* API.Env.around(
        {
          // deno-lint-ignore require-yield
          *cwd(): Operation<string> {
            return checkout;
          },
        },
        { at: "min" },
      );
      const halted = yield* spawn(() =>
        runOrdinaryDocument('<Dir path="inner">\n\n<Gate />\n\n</Dir>\n', {
          root,
          cwd: checkout,
          components: [
            {
              name: "Gate",
              origin: "test",
              props: { type: "object", additionalProperties: false },
              *fn(): Operation<string> {
                // Read from inside the region, so the pair below is
                // "installed" then "restored" rather than one reading.
                seen.push(yield* cwd());
                reached.resolve();
                yield* suspend();
                return "";
              },
            },
          ],
        }),
      );
      yield* reached.operation;
      yield* halted.halt();
      seen.push(yield* cwd());
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(join(checkout, "inner"));
    expect(seen[1]).toBe(checkout);
  });

  // ORC6d: the operation is about a directory. The Repository selection in
  // scope, and every member of its identity, is the same inside the region and
  // after it.
  it("ORC6d: Repository selection and identity are unchanged by Dir", function* () {
    const root = yield* useManagedRoot();
    const remote = yield* useBareRemote(REMOTE);
    const checkout = (yield* useHostCheckout(remote.locator)).root;
    const seen: (RepositorySelection | undefined)[] = [];

    yield* runOrdinaryDocument(
      [
        '<Stated as="before" />',
        '<Dir path="within">',
        "",
        '<Stated as="inside" />',
        "",
        "</Dir>",
        "",
        '<Stated as="after" />',
        "",
      ].join("\n"),
      { root, cwd: checkout, components: [selectionProbe(seen)] },
    );

    expect(seen).toHaveLength(3);
    // The whole selection, member by member: identifier, name, checkout path
    // and every member of the identity. A Dir that had re-selected anything
    // would differ in one of them.
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
  });

  // ORC6e: creation is persistent. A directory made inside a region whose
  // content then fails is still there, and so is one made in a run that was
  // cancelled — there is no rollback and no teardown removal on this profile.
  it("ORC6e: a created directory survives failed content and cancellation", function* () {
    const root = yield* useManagedRoot();
    const checkout = (yield* useOriginlessCheckout()).root;

    yield* runOrdinaryDocument(
      '<PrintErrors>\n<Dir path="made-then-failed">\n\n<File path="../../no.md">no</File>\n\n</Dir>\n</PrintErrors>\n',
      { root, cwd: checkout },
    );
    expect(yield* exists(join(checkout, "made-then-failed"))).toBe(true);

    // Halted with a component still in flight inside the region. The gate is
    // reached only after the ensure, so the halt lands strictly after creation
    // — a halt that arrived first would prove nothing about teardown.
    const reached = withResolvers<void>();
    const halted = yield* spawn(() =>
      runOrdinaryDocument('<Dir path="made-then-halted">\n\n<Gate />\n\n</Dir>\n', {
        root,
        cwd: checkout,
        components: [
          {
            name: "Gate",
            origin: "test",
            props: { type: "object", additionalProperties: false },
            *fn(): Operation<string> {
              reached.resolve();
              yield* suspend();
              return "";
            },
          },
        ],
      }),
    );
    yield* reached.operation;
    yield* halted.halt();
    expect(yield* exists(join(checkout, "made-then-halted"))).toBe(true);
  });
});
