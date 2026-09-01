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
import { scoped, until, type Operation } from "effection";
import { realpath } from "node:fs/promises";
import { exists, readTextFile } from "@effectionx/fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collect, execute, inlineSource } from "@executablemd/core";
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
function* useAmbient(locator?: string): Operation<{ checkout: string; root: string; home: string }> {
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
  options: { root: string; cwd: string; journal?: string },
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
    yield* useCompositionComponents();
    yield* useRunComposition({ root: options.root, cwd: options.cwd });
    // `--journal` is exactly this: the file-backed stream instead of the
    // in-memory one, created by the command before the run begins.
    const stream =
      options.journal === undefined ? new InMemoryStream() : new FileStream(options.journal);
    return yield* collect(yield* execute({ ...inlineSource(source), stream }));
  });
}

describe("ORC7 — a Session launched in a managed Worktree", () => {
  it("receives the worktree's own Git root and a session key of its own", function* () {
    const ambient = yield* useAmbient();

    // A managed Worktree, made by the ordinary provider.
    const bound = String(
      yield* runOrdinary(`<Worktree name="review" branch="review" as="w" />\n\n{w}`, {
        root: ambient.root,
        cwd: ambient.checkout,
      }),
    ).trim();
    expect(yield* exists(bound)).toBe(true);

    // `.git` there is a file, not a directory — which is what bounds the walk.
    expect(yield* readTextFile(`${bound}/.git`)).toContain("gitdir:");

    // The candidate walk from inside it stops at the worktree root, so a
    // Session placed there is placed in the worktree rather than in the
    // repository it belongs to.
    const candidates = yield* sessionCandidates("codex", bound);
    expect(candidates.map((candidate) => candidate.cwd)).toEqual([bound]);

    // And its key is its own: the same agent and the same session name in the
    // ambient checkout is a different session.
    const inWorktree = deriveSessionKey("codex", bound, "implementer");
    const inAmbient = deriveSessionKey("codex", ambient.checkout, "implementer");
    expect(inWorktree).not.toBe(inAmbient);

    // The ambient checkout's own walk is unaffected, and reaches its own root.
    const ambientCandidates = yield* sessionCandidates("codex", ambient.checkout);
    expect(ambientCandidates.map((candidate) => candidate.cwd)).toEqual([ambient.checkout]);
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
    yield* runOrdinary(document, { root: second.root, cwd: second.checkout, journal: trace });

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
    yield* runOrdinary(document, { root: third.root, cwd: third.checkout, journal: trace });
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
  it("gives each execution a provider of its own, with no shared leases", function* () {
    const ambient = yield* useAmbient();

    // Two executions in sequence, each constructing its own provider against
    // the same managed root and the same slot. The second is only possible if
    // the first released — which is what a provider per execution means.
    const document = `<Worktree name="nested" branch="nested" as="w" />\n\n{w}`;
    const parent = String(
      yield* runOrdinary(document, { root: ambient.root, cwd: ambient.checkout }),
    ).trim();
    const child = String(
      yield* runOrdinary(document, { root: ambient.root, cwd: ambient.checkout }),
    ).trim();
    expect(child).toBe(parent);

    // And a provider constructed inside another execution's scope holds its own
    // evidence: the inner one has published nothing, so its `<PullRequest>` is
    // refused even though the outer one is standing in the same checkout.
    const failure = yield* raisedValue(
      scoped(function* () {
        yield* API.Env.around(
          {
            // deno-lint-ignore require-yield
            *cwd(): Operation<string> {
              return ambient.checkout;
            },
          },
          { at: "min" },
        );
        yield* useHostFiles();
        yield* useCompositionComponents();
        yield* useRunComposition({ root: ambient.root, cwd: ambient.checkout });
        // A second, nested provider — exactly what an isolated `host="run"`
        // child constructs from the same installer.
        return yield* scoped(function* () {
          yield* useRunComposition({ root: ambient.root, cwd: ambient.checkout });
          return yield* collect(
            yield* execute({
              ...inlineSource(`<PullRequest title="Nothing published" as="pr" />`),
              stream: new InMemoryStream(),
            }),
          );
        });
      }),
    );
    expect(String(failure)).toMatch(/no usable origin|holds no successful <Git.Push> result/);
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
