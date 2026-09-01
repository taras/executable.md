/**
 * Tier ORC — what only the runtime that operates repositories can be asked.
 *
 * Everything here needs the live provider, which needs a kernel-released
 * advisory lock, so it is Deno's alone. The parity half — that Node and Bun
 * describe the same language and operate none of it — is
 * `run-composition.test.ts`, which runs everywhere.
 *
 * Three claims: where a Session launched in a managed Worktree lands, that a
 * diagnostic trace grants nothing, and that a nested `host="run"` child gets a
 * provider of its own.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, scoped, until } from "effection";
import { realpath } from "node:fs/promises";
import { exists, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { API, NativeLauncher, useHostFiles } from "@executablemd/runtime";
import { Err } from "effection";
import { testHarnessInstallation, useTesting } from "@executablemd/testing";
import { executeInstalled } from "@executablemd/core/host";
import { testingExecutionHost } from "../src/testing-host.ts";
import { denoRunRepositories } from "../src/deno-repositories.ts";
import type { RepositoryInstaller } from "../src/run-repositories.ts";
import { TEST_HELPER } from "../../workflow/tests/support/composition.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import {
  Agent,
  collect,
  execute,
  inlineSource,
  installAgentComponents,
  registerAgentProvider,
} from "@executablemd/core";
import { runCli } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { deriveSessionKey, sessionCandidates } from "../../acp/src/session-key.ts";
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

describe("ORC7 — a Session launched in a managed Worktree", () => {
  it("hands the launch that worktree's own root and a session key of its own", function* () {
    const ambient = yield* useAmbient();

    /** Every launch this document routed, as the placement it was given. */
    const routed: { cwd: string; session: string | undefined }[] = [];

    // The public launch surface a provider answers. A real `<Session.Launch>`
    // reaches exactly this, through the same installation `xmd run` makes, and
    // what it is handed is the placement: the directory the session belongs to.
    const capture = function* (): Operation<void> {
      // A registered provider, reached the way `<AgentProvider>` reaches one.
      // Only a registered provider is handed the launch authority, so only one
      // can settle a launch — middleware can route a request and cannot
      // perform it, which is the boundary this uses rather than works around.
      yield* registerAgentProvider("probe", function* (options, authority) {
        yield* Agent.around(
          {
            // deno-lint-ignore require-yield
            *agent([name]): Operation<string> {
              return name ?? options.defaultAgent;
            },
            *launch([request]): Operation<void> {
              routed.push({
                cwd: request.cwd,
                session: typeof request.session === "string" ? request.session : undefined,
              });
              // Settled as a refusal rather than performed: this suite is about
              // where a launch is placed, and starting a native UI would need a
              // terminal nothing here has.
              yield* authority.refuse(request, {
                phase: "prepared",
                agent: "codex",
                sessionKey: deriveSessionKey(
                  "codex",
                  request.cwd,
                  typeof request.session === "string" ? request.session : undefined,
                ),
                provider: "probe",
                nativeSessionId: "probe-session",
                sessionState: "created",
                instructionChannel: "probe",
                instructionReconciliation: "installed",
                identityProvenance: "provider-returned",
                instructionsDigest: "0".repeat(64),
                instructions: request.instructions,
                cwd: request.cwd,
                additionalDirectories: [...request.additionalDirectories],
                permissionMode: request.permissionMode,
                launcher: "probe",
                failure: {
                  class: "unsupported-capability",
                  message: "this suite launches nothing",
                },
              });
            },
          },
          { at: "min" },
        );
      });
      // The terminal a native launch reserves before it is routed. Reserving is
      // what `xmd run` installs a real launcher for; a suite installs one that
      // owns nothing, so the launch reaches the surface below rather than
      // failing on a host with no terminal.
      yield* NativeLauncher.around(
        {
          // deno-lint-ignore require-yield
          *reserve(): Operation<void> {},
          // deno-lint-ignore require-yield
          *flush(): Operation<void> {},
        },
        { at: "min" },
      );
    };

    // One launch inside a managed Worktree, and one in the ambient checkout, in
    // the same document — so the two placements are decided by where each
    // element was written and by nothing else.
    const bound = yield* runOrdinary(
      [
        '<AgentProvider name="probe" defaultAgent="codex">',
        `<Worktree name="review" branch="review" as="w" />`,
        // The provider settles each launch as a refusal, so the region that
        // prints one is what lets the second launch happen at all. What is
        // under test is where each was placed, not whether a UI started.
        "<PrintErrors>",
        "<Dir path={w}>",
        '<Session.Launch session="implementer">',
        "INSIDE",
        "</Session.Launch>",
        "</Dir>",
        '<Session.Launch session="implementer">',
        "OUTSIDE",
        "</Session.Launch>",
        "</PrintErrors>",
        "</AgentProvider>",
        "",
        "{w}",
      ].join("\n"),
      { root: ambient.root, cwd: ambient.checkout, agent: capture },
    );
    const worktree = String(bound).trim().split("\n").at(-1) ?? "";
    expect(yield* exists(worktree)).toBe(true);

    // Both launches were routed, and each received the directory it was
    // written in.
    expect(routed).toHaveLength(2);
    expect(routed[0]?.cwd).toBe(worktree);
    expect(routed[1]?.cwd).toBe(ambient.checkout);
    expect(routed[0]?.session).toBe("implementer");
    expect(routed[1]?.session).toBe("implementer");

    // The same agent and the same session name in the two places are two
    // sessions, because the placement differs.
    const agent = "codex";
    const inWorktree = deriveSessionKey(agent, routed[0]?.cwd ?? "", "implementer");
    const inAmbient = deriveSessionKey(agent, routed[1]?.cwd ?? "", "implementer");
    expect(inWorktree).not.toBe(inAmbient);

    // Supporting evidence for *why* the placement stops at the worktree: `.git`
    // there is a file, and the candidate walk is bounded by it.
    expect(yield* readTextFile(`${worktree}/.git`)).toContain("gitdir:");
    const candidates = yield* sessionCandidates(agent, worktree);
    expect(candidates.map((candidate: { cwd: string }) => candidate.cwd)).toEqual([worktree]);
    const ambientCandidates = yield* sessionCandidates(agent, ambient.checkout);
    expect(ambientCandidates.map((candidate: { cwd: string }) => candidate.cwd)).toEqual([
      ambient.checkout,
    ]);
  });
});

describe("ORC18 — the journal is diagnostic", () => {
  it("performs the same live work with and without a trace, once each", function* () {
    const first = yield* useAmbient();
    const second = yield* useAmbient();
    const trace = join(second.root, "..", "diagnostic.jsonl");

    const document = [
      `<Worktree name="traced" branch="traced" as="w" />`,
      "<Dir path={w}>",
      `<File path="made.md">made</File>`,
      `<Git.Add paths="made.md" />`,
      `<Git.Commit message="Traced" as="commit" />`,
      "</Dir>",
    ].join("\n");

    yield* runOrdinary(document, { root: first.root, cwd: first.checkout });
    yield* runOrdinary(document, {
      root: second.root,
      cwd: second.checkout,
      journal: trace,
    });

    // One live mutation per invocation, either way: each repository has exactly
    // one commit on the branch beyond the one it started with.
    for (const ambient of [first, second]) {
      expect(
        git(["log", "--oneline", "traced"], ambient.checkout, ambient.home).split("\n"),
      ).toHaveLength(2);
      expect(git(["log", "-1", "--pretty=%s", "traced"], ambient.checkout, ambient.home)).toBe(
        "Traced",
      );
    }

    // The trace was newly created by that run and holds its events.
    expect(yield* exists(trace)).toBe(true);
    const written = yield* readTextFile(trace);
    expect(written.length).toBeGreaterThan(0);

    // And it is not continuation. A third execution handed that exact trace
    // performs its own work against its own repository — the trace neither
    // restores the earlier commit nor stands in for one.
    const third = yield* useAmbient();
    yield* runOrdinary(document, {
      root: third.root,
      cwd: third.checkout,
      journal: trace,
    });
    expect(git(["log", "-1", "--pretty=%s", "traced"], third.checkout, third.home)).toBe("Traced");
    expect(
      git(["log", "--oneline", "traced"], third.checkout, third.home).split("\n"),
    ).toHaveLength(2);
  });
});

describe("ORC15 — a trace is not evidence", () => {
  it("refuses a PullRequest handed the trace of an execution that really published", function* () {
    const remote = yield* useRemote();
    const first = yield* useAmbient(remote);
    const trace = join(first.root, "..", "published.jsonl");

    // A real publication, written into a real diagnostic trace.
    yield* runOrdinary(
      [
        `<Git.Switch branch="traced-push" />`,
        `<File path="pushed.md">pushed</File>`,
        `<Git.Add paths="pushed.md" />`,
        `<Git.Commit message="Pushed" as="commit" />`,
        `<Git.Push />`,
      ].join("\n"),
      { root: first.root, cwd: first.checkout, journal: trace },
    );
    const published = git(["rev-parse", "HEAD"], first.checkout, first.home);
    expect(git(["rev-parse", "traced-push"], remote, first.home)).toBe(published);
    expect(yield* exists(trace)).toBe(true);
    const written = yield* readTextFile(trace);
    // The trace holds this run's own events, and none of them is the
    // publication: an ordinary run journals no repository effect at all, so
    // there is not even a record for a later run to misread as evidence.
    expect(written.length).toBeGreaterThan(0);
    expect(written).toContain("import_component");
    expect(written).not.toContain("git-push");
    expect(written).not.toContain("git_host");

    // A new execution, on the same checkout, on the same branch, at the same
    // commit — handed that exact file as its journal, and containing only a
    // pull request.
    const failure = yield* raisedValue(
      runOrdinary(`<PullRequest title="Traced" as="pullRequest" />`, {
        root: first.root,
        cwd: first.checkout,
        journal: trace,
      }),
    );
    expect(String(failure)).toContain("holds no successful <Git.Push> result");

    // The second run wrote its own events after the first run's, which is what
    // a trace is: a file appended to, never a file read back. Nothing in it
    // authorized anything, and there is still no publication recorded anywhere
    // in it.
    const after = yield* readTextFile(trace);
    expect(after.startsWith(written)).toBe(true);
    expect(after.length).toBeGreaterThan(written.length);
    expect(after).not.toContain("git-push");
    expect(after).not.toContain("git_host");
  });
});

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
    // written in.
    //
    // Two things force that shape, and both are worth stating because they
    // bound what this proves. A managed checkout stays leased for the whole run
    // of whoever touched it, so a parent and a child cannot share one: the
    // child would be refused for want of the slot and never reach
    // `<PullRequest>`. And a run discovers its ambient repository once, when
    // its provider is installed, from the directory the *process* stands in —
    // which here is deliberately not a repository at all. So the parent has no
    // repository of its own to publish from, and the publishing side has to be
    // a child too.
    //
    // What that leaves is the same boundary asked of two siblings: each
    // execution gets a provider of its own, so evidence one earns does not
    // authorize the next. The parent's side of the isolation is the lease test
    // below, where a parent's hold survives its child's teardown.
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

/** Whatever this operation raised, as a value. */
function* raisedValue(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
  } catch (error) {
    return error;
  }
  throw new Error("the operation did not fail");
}
