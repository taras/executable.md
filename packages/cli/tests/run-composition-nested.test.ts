/**
 * Tier ORC — a nested `host="run"` child under an ordinary run.
 *
 * A child is a root execution in a scope that does not descend from the
 * document's, so everything it is given has to be given deliberately: its own
 * provider instance, and the working directory the `<Execution>` was written
 * in. This file is about both, and about what must *not* cross that boundary.
 *
 * The root execution's own provider is asked separately, in
 * `run-composition-deno.test.ts`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, scoped, until } from "effection";
import { realpath } from "node:fs/promises";
import { exists, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collect, execute, inlineSource, installAgentComponents } from "@executablemd/core";
import { runCli } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { useCompositionComponents } from "@executablemd/workflow";
import { useRunComposition } from "@executablemd/workflow/deno";
import { FileStream } from "../src/file-stream.ts";

/** Git, with an environment a caller's own configuration cannot reach into. */
function git(args: readonly string[], cwd: string, home: string): string {
  const outcome = spawnSync("git", [...args], {
    cwd,
    env: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (outcome.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${outcome.status}: ${outcome.stderr}`);
  }
  return outcome.stdout.trim();
}

/** A bare repository this suite can publish to, made from a real checkout. */
function* useRemote(): Operation<string> {
  const home = yield* useTempDirectory("xmd-orc-remote-home-");
  const parent = yield* until(realpath(yield* useTempDirectory("xmd-orc-remote-")));
  const seed = join(parent, "seed");
  git(["init", "--initial-branch=main", seed], parent, home);
  git(["commit", "--allow-empty", "-m", "first"], seed, home);
  const bare = join(parent, "remote.git");
  git(["clone", "--bare", "--", seed, bare], parent, home);
  return bare;
}

/** A repository the command is "run in", and a managed root of this suite's own. */
function* useAmbient(
  locator?: string,
): Operation<{ checkout: string; root: string; home: string }> {
  const home = yield* useTempDirectory("xmd-orc-home-");
  // Canonical, so what this fixture names and what Git reports are one string.
  const parent = yield* until(realpath(yield* useTempDirectory("xmd-orc-ambient-")));
  const checkout = join(parent, "checkout");
  if (locator === undefined) {
    git(["init", "--initial-branch=main", checkout], parent, home);
    git(["commit", "--allow-empty", "-m", "first"], checkout, home);
  } else {
    git(["clone", "--", locator, checkout], parent, home);
  }
  const managed = yield* until(realpath(yield* useTempDirectory("xmd-orc-managed-")));
  return { checkout, root: join(managed, "repositories"), home };
}

/** Run one document under the ordinary provider, on a stream a caller chose. */
function runOrdinary(
  source: string,
  options: {
    root: string;
    cwd: string;
    journal?: string;
    /** Installed after the components, where a provider's own middleware goes. */
    agent?: () => Operation<void>;
  },
): Operation<unknown> {
  return scoped(function* () {
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return options.cwd;
        },
      },
      { at: "min" },
    );
    yield* useHostFiles();
    yield* installAgentComponents();
    yield* useCompositionComponents();
    yield* useRunComposition({ root: options.root, cwd: options.cwd });
    if (options.agent !== undefined) {
      yield* options.agent();
    }
    // `--journal` is exactly this: the file-backed stream instead of the
    // in-memory one, created by the command before the run begins.
    const stream =
      options.journal === undefined ? new InMemoryStream() : new FileStream(options.journal);
    return yield* collect(yield* execute({ ...inlineSource(source), stream }));
  });
}

describe("ORC19 — a nested run profile", () => {
  /**
   * The claims here are about a real `<Execution host="run">` child, so they
   * are asked of a real `xmd run` — a subprocess, launched the way a person
   * launches one.
   *
   * ## Why a subprocess, and why from nowhere
   *
   * A child is a root execution in a scope that does not descend from the
   * document's, so it inherits no `API.Env` handler and its working directory
   * is whatever the host installs for it. When that propagation breaks, the
   * child falls back to the *process* directory — and an in-process suite's
   * process directory is this repository. A regression would then discover this
   * checkout as its ambient repository and operate on it: branches, worktrees
   * and commits in the tree the suite is running from.
   *
   * So the process directory is a temporary directory that is not a Git
   * checkout at all. Every repository, every managed root and every document is
   * under a fixture-owned temporary directory, and `HOME` is one too — which is
   * what moves `~/.xmd/repositories` out of the way, since a run takes its
   * managed root from there and no option names another. A break cannot reach a
   * shared checkout because, from where these processes stand, there is no
   * checkout to reach: the child refuses for want of a repository.
   *
   * That refusal is the last test below, and it is what keeps the first one
   * honest. Without it, "the child worked" would be equally well explained by
   * the child having found a repository some other way.
   *
   * ## Why `<Testing>` rather than `xmd test`
   *
   * Two of these claims are about what a *parent* holds while its child runs —
   * publication evidence, and a lease. `xmd test` installs no repository
   * provider for its own document, by design: only its children get one. So the
   * parent here is an ordinary `xmd run`, which has a provider of its own, and
   * `<Testing>` turns on the harness for the region containing the children.
   */
  interface Nested {
    readonly checkout: string;
    readonly home: string;
    /** Where a run of this fixture keeps its managed checkouts. */
    readonly managed: string;
    /** The process directory every run below is launched from. */
    readonly outside: string;
    readonly documents: string;
  }

  /**
   * A repository to work in, a home to be nobody in, and a directory to stand
   * in that is neither.
   */
  function* useNested(locator?: string): Operation<Nested> {
    const ambient = yield* useAmbient(locator);
    // An ordinary run commits as the invoking user and refuses when the host
    // cannot say who that is, so the identity a child would use is configured
    // here — in this fixture's `HOME`, never the developer's.
    yield* writeTextFile(
      join(ambient.home, ".gitconfig"),
      ["[user]", "\tname = Nested Fixture", "\temail = nested@example.invalid", ""].join("\n"),
    );
    return {
      checkout: ambient.checkout,
      home: ambient.home,
      // Where `denoRunRepositories` puts them when nothing names a root, which
      // is every `xmd run`. Fixture-owned because `HOME` is.
      managed: join(ambient.home, ".xmd", "repositories"),
      outside: yield* until(realpath(yield* useTempDirectory("xmd-orc-outside-"))),
      documents: yield* until(realpath(yield* useTempDirectory("xmd-orc-documents-"))),
    };
  }

  /** One `xmd run` of `source`, from a directory that is not a repository. */
  function* runNested(
    source: string,
    fixture: Nested,
    expected: "passes" | "fails" = "passes",
  ): Operation<string> {
    const document = join(fixture.documents, "nested.md");
    yield* writeTextFile(document, source);
    const run = yield* runCli(["run", document], {
      // The whole point: nothing about where this process stands names a
      // repository, so only what the document says can put a child in one.
      cwd: fixture.outside,
      env: { HOME: fixture.home },
      timeout: 180_000,
    }).join();
    const reported = `${run.stdout}\n${run.stderr}`;
    const passed = run.code === 0;
    if (passed !== (expected === "passes")) {
      throw new Error(`xmd run exited ${run.code}, expected to ${expected}:\n${reported}`);
    }
    return reported;
  }

  /** A child document, as one escaped `source` attribute value. */
  function child(source: string): string {
    return JSON.stringify(source);
  }

  /** The `<Worktree>` child, which reaches its repository ambiently. */
  const AMBIENT_WORKTREE = child('<Worktree name="child" branch="child" as="w" />\n\n{w}\n');

  it("stands the child where the document is, not where the process is", function* () {
    const fixture = yield* useNested();

    // The `<Dir>` is the only thing that puts anything in a repository. If the
    // contextual directory did not reach the child it would stand in
    // `fixture.outside` and refuse — which is exactly what the last test here
    // shows happens when the `<Dir>` is absent.
    const reported = yield* runNested(
      [
        `<Dir path="${fixture.checkout}">`,
        "",
        "<Testing>",
        "",
        '<Test name="a run child operates repositories">',
        "",
        `<Execution host="run" source={${AMBIENT_WORKTREE}} as="child">`,
        '<CollectOutput as="output" />',
        "<AssertEquals actual={child.result.ok} expected={true} />",
        // What it bound is a managed checkout under *this* run's root, so the
        // child really resolved `<Worktree>` through a provider of its own
        // rather than reporting a path it never made.
        `<AssertStringIncludes actual={output} expected="${fixture.managed}" />`,
        "</Execution>",
        "",
        "</Test>",
        "",
        "</Testing>",
        "",
        "</Dir>",
        "",
      ].join("\n"),
      fixture,
    );
    expect(reported).not.toContain("not inside a Git checkout");

    // And the worktree is on disk, belonging to the repository the document
    // named — observed from outside the run that made it, so this is the state
    // the child left rather than a line it printed.
    const slots = join(fixture.managed, "worktrees");
    const [repository] = yield* readdir(slots);
    const [slot] = yield* readdir(join(slots, repository ?? ""));
    const bound = join(slots, repository ?? "", slot ?? "", "checkout");
    expect(yield* readTextFile(join(bound, ".git"))).toContain("gitdir:");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], bound, fixture.home)).toBe("child");
    // It is a linked worktree of the ambient checkout the `<Dir>` named, which
    // is the whole claim: the child discovered its repository from the
    // directory the *document* was standing in.
    expect(
      git(["rev-parse", "--path-format=absolute", "--git-common-dir"], bound, fixture.home),
    ).toBe(join(fixture.checkout, ".git"));
  });

  it("does not let one child's Push authorize its sibling", function* () {
    const remote = yield* useRemote();
    const fixture = yield* useNested(remote);

    // Both sides are children, and both reach the *same* repository — the
    // ambient one, which they discover from the `<Dir>` this `<Execution>` is
    // written in. Sequential sharing is what makes that work: caller-owned
    // ambient Git is nobody's managed slot, so it carries no lease, and one
    // execution can hand it to the next.
    //
    // The claim is that each execution gets a provider of its own, so evidence
    // one earns does not authorize the next. The parent/child direction of the
    // same boundary is asked separately, from a process standing in a
    // repository.
    const publishes = child(
      [
        '<Git.Switch branch="pushed-by-first" />',
        '<File path="first.md">first</File>',
        '<Git.Add paths="first.md" />',
        '<Git.Commit message="First" as="commit" />',
        "<Git.Push />",
        "",
      ].join("\n"),
    );
    const asks = child('<PullRequest title="sibling" as="pr" />\n');

    yield* runNested(
      [
        `<Dir path="${fixture.checkout}">`,
        "",
        "<Testing>",
        "",
        '<Test name="a sibling cannot use another child\'s publication">',
        "",
        // The first child really publishes, through a provider of its own.
        `<Execution host="run" source={${publishes}} as="first">`,
        "<AssertEquals actual={first.result.ok} expected={true} />",
        "</Execution>",
        "",
        // The second stands in the same repository, immediately after, and
        // holds none of it. If Push evidence outlived one execution this would
        // succeed.
        `<Execution host="run" source={${asks}} as="second">`,
        "<AssertEquals actual={second.result.ok} expected={false} />",
        '<AssertStringIncludes actual={String(second.result.error)} expected="holds no successful" />',
        "</Execution>",
        "",
        "</Test>",
        "",
        "</Testing>",
        "",
        "</Dir>",
        "",
      ].join("\n"),
      fixture,
    );

    // The first child's publication really happened, so what the sibling
    // lacked is evidence rather than a branch: the remote carries the commit,
    // observed from outside the run that made it.
    expect(git(["rev-parse", "pushed-by-first"], remote, fixture.home)).not.toBe("");
  });

  it("gives a child its own lease owner, and keeps the parent's when it ends", function* () {
    const remote = yield* useRemote();
    const fixture = yield* useNested(remote);

    const selection = `<Repository name="project" url="${remote}">`;
    // The same repository and the same worktree name, so parent and child ask
    // the operating system for one slot.
    const asks = child(
      `${selection}\n<Worktree name="shared" branch="shared" as="w" />\n</Repository>\n`,
    );

    yield* runNested(
      [
        selection,
        "",
        // The parent takes the lease on `shared` and holds it for its whole
        // run.
        '<Worktree name="shared" branch="shared" as="parent" />',
        "",
        "<Testing>",
        "",
        '<Test name="a child holds its own leases">',
        "",
        // A provider sharing the parent's held set would answer out of it and
        // succeed without asking the operating system anything; one with an
        // owner of its own asks, and is refused because the parent is still
        // holding it.
        `<Execution host="run" source={${asks}} as="first">`,
        "<AssertEquals actual={first.result.ok} expected={false} />",
        '<AssertStringIncludes actual={String(first.result.error)} expected="another process is working in" />',
        "</Execution>",
        "",
        // A second child, after the first has torn down. The parent's lease
        // survived that teardown, so this one is refused for the same reason
        // rather than finding the slot free.
        `<Execution host="run" source={${asks}} as="second">`,
        "<AssertEquals actual={second.result.ok} expected={false} />",
        '<AssertStringIncludes actual={String(second.result.error)} expected="another process is working in" />',
        "</Execution>",
        "",
        "</Test>",
        "",
        "</Testing>",
        "",
        "</Repository>",
        "",
      ].join("\n"),
      fixture,
    );
  });

  /**
   * The same fixture, with the process standing *inside* a disposable checkout.
   *
   * The escape argument is different here and still holds: a regression in
   * contextual-directory propagation reaches the process directory, and the
   * process directory is a temporary clone this fixture made and owns. There is
   * nothing shared to reach. The non-Git case above keeps the other half of the
   * argument — that the propagation is real rather than incidentally agreeing
   * with where the process happens to stand.
   */
  function* useInRepository(): Operation<Nested & { readonly remote: string }> {
    const remote = yield* useRemote();
    const fixture = yield* useNested(remote);
    // The process stands in the caller's own checkout, which is what an
    // ordinary `xmd run` stands in. Nothing here is a managed slot, so nothing
    // here is leased, and two executions can use it one after the other.
    return { ...fixture, remote, outside: fixture.checkout };
  }

  /** One branch, published once, asked about from both directions. */
  const PUBLISHES = [
    '<Git.Switch branch="shared-head" />',
    '<File path="published.md">published</File>',
    '<Git.Add paths="published.md" />',
    '<Git.Commit message="Published" as="commit" />',
    "<Git.Push />",
  ];

  /**
   * `<PullRequest>` reaches its Git host through `source.open()`, and the
   * evidence gate runs ahead of it. The refusal says so itself — "Nothing was
   * observed at the Git host, and no pull request was created" — so that
   * sentence is the claim rather than an inference from it.
   *
   * The second assertion is the corroborating one: a local file origin is not
   * a Git host, so an execution that had got past the gate would have failed
   * with "no usable origin" instead. Its absence and the sentence's presence
   * are two independent readings of the same ordering.
   */
  const REFUSED_BEFORE_HOST_ACCESS = "Nothing was observed at the Git host";

  function refusedBeforeHostAccess(binding: string): string[] {
    return [
      `<AssertEquals actual={${binding}.result.ok} expected={false} />`,
      `<AssertStringIncludes actual={String(${binding}.result.error)} expected="holds no successful" />`,
      `<AssertStringIncludes actual={String(${binding}.result.error)} expected="${REFUSED_BEFORE_HOST_ACCESS}" />`,
      `<AssertNotMatch actual={String(${binding}.result.error)} expected={/no usable origin/} />`,
    ];
  }

  it("does not let a parent's Push authorize its child", function* () {
    const fixture = yield* useInRepository();

    // The parent publishes in the ambient checkout the process is standing in;
    // the child, immediately after, asks for a pull request from that same
    // checkout, origin, branch and head. Everything about the repository is
    // identical between them. The only thing that differs is which provider
    // holds the Push evidence.
    yield* runNested(
      [
        ...PUBLISHES,
        "",
        "<Testing>",
        "",
        '<Test name="a child cannot use its parent\'s publication">',
        "",
        `<Execution host="run" source={${child('<PullRequest title="child" as="pr" />\n')}} as="opened">`,
        ...refusedBeforeHostAccess("opened"),
        "</Execution>",
        "",
        "</Test>",
        "",
        "</Testing>",
        "",
      ].join("\n"),
      fixture,
    );

    // The parent's publication was real, so what the child lacked is evidence.
    expect(git(["rev-parse", "shared-head"], fixture.remote, fixture.home)).toBe(
      git(["rev-parse", "HEAD"], fixture.checkout, fixture.home),
    );
  });

  it("does not let a child's Push authorize its parent", function* () {
    const fixture = yield* useInRepository();

    // The other direction, in the same checkout. The child publishes and tears
    // down; the parent — whose provider has been installed the whole time —
    // then asks for a pull request from the head its own child just pushed.
    //
    // The parent's refusal ends the document, which is what a refusal at
    // document level is supposed to do, so this run is expected to fail and the
    // refusal is read out of what it reported. The child's test block runs
    // first and is reported before it.
    const reported = yield* runNested(
      [
        "<Testing>",
        "",
        '<Test name="a child publishes for itself alone">',
        "",
        `<Execution host="run" source={${child(PUBLISHES.join("\n") + "\n")}} as="published">`,
        "<AssertEquals actual={published.result.ok} expected={true} />",
        "</Execution>",
        "",
        "</Test>",
        "",
        "</Testing>",
        "",
        '<PullRequest title="parent" as="pr" />',
        "",
      ].join("\n"),
      fixture,
      "fails",
    );

    // The parent is refused for want of evidence, and before its Git host is
    // reached.
    expect(reported).toContain("holds no successful");
    expect(reported).toContain(REFUSED_BEFORE_HOST_ACCESS);
    expect(reported).not.toContain("no usable origin");
    // The child's assertions passed, so the publication it was refused credit
    // for really happened.
    expect(reported).not.toContain("❌");
    expect(git(["rev-parse", "shared-head"], fixture.remote, fixture.home)).toBe(
      git(["rev-parse", "HEAD"], fixture.checkout, fixture.home),
    );
  });

  it("refuses outside a repository when nothing places the child in one", function* () {
    const fixture = yield* useNested();

    // The same child as the first test, with the `<Dir>` removed and nothing
    // else changed. This is what a break in contextual-directory propagation
    // looks like from the child's side — and it is a refusal, in a temporary
    // directory, rather than work done in whatever checkout the process
    // happened to be launched from.
    yield* runNested(
      [
        "<Testing>",
        "",
        '<Test name="a child placed nowhere reaches no repository">',
        "",
        `<Execution host="run" source={${AMBIENT_WORKTREE}} as="child">`,
        "<AssertEquals actual={child.result.ok} expected={false} />",
        '<AssertStringIncludes actual={String(child.result.error)} expected="is not inside a Git checkout" />',
        "</Execution>",
        "",
        "</Test>",
        "",
        "</Testing>",
        "",
      ].join("\n"),
      fixture,
    );

    // Nothing was checked out for it. The managed root itself exists — every
    // run creates one before a document expands — so what says the child did no
    // work is that it never reached a repository to make a slot under.
    expect(yield* exists(fixture.managed)).toBe(true);
    expect(yield* exists(join(fixture.managed, "worktrees"))).toBe(false);
  });
});
