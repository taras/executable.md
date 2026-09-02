/**
 * Tier ORC — what only the runtime that operates repositories can be asked.
 *
 * Everything here needs the live provider, which needs a kernel-released
 * advisory lock, so it is Deno's alone. The parity half — that Node and Bun
 * describe the same language and operate none of it — is
 * `run-composition.test.ts`, which runs everywhere.
 *
 * Three claims about a root execution's own provider: where a Session launched
 * in a managed Worktree lands, that an ordinary journal is diagnostic, and that
 * a diagnostic trace grants nothing. What a nested `host="run"` child gets is a
 * separate question about a separate provider instance, asked in
 * `run-composition-nested.test.ts`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, scoped, until } from "effection";
import { realpath } from "node:fs/promises";
import { exists, readTextFile } from "@effectionx/fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { API, NativeLauncher, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import {
  Agent,
  collect,
  execute,
  inlineSource,
  installAgentComponents,
  registerAgentProvider,
} from "@executablemd/core";
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

/**
 * Run one document under the ordinary provider, on a stream a caller chose.
 *
 * The commit identity is stated rather than read from the host. The provider's
 * production default is the caller's own `git config`, so leaving it alone
 * makes `<Git.Commit>` refuse on any machine without `user.name` set — every CI
 * runner — and turns these cases into an assertion about who ran them.
 */
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
    yield* useRunComposition({
      root: options.root,
      cwd: options.cwd,
      // deno-lint-ignore require-yield
      *identity(): Operation<string | undefined> {
        return "Fixture <fixture@example.invalid> 0 +0000";
      },
    });
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

/** Whatever this operation raised, as a value. */
function* raisedValue(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
  } catch (error) {
    return error;
  }
  throw new Error("the operation did not fail");
}
