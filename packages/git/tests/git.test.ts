/**
 * Tier GT — the read-only Git query capability.
 *
 * `GitQuery.resolve()` verifies and resolves one revision expression in the
 * contextual working directory. The default invokes the Git CLI; a host or a
 * test replaces it lexically. Nothing here shells out: every test either
 * replaces `GitQuery` or stubs the process boundary beneath it, so the suite
 * runs the same wherever it is checked out.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { API, exec, useQuietProcessOutput } from "@executablemd/runtime";
import {
  gitObjectFormat,
  GitQuery,
  gitRoot,
  readGitObject,
  resolveGitRevision,
} from "@executablemd/git/api";

interface ExecCall {
  command: string[];
  cwd?: string;
}

type ExecResult = { exitCode: number; stdout: string; stderr: string };

/** Record what reaches the process boundary, and answer with `result`. */
function useExecStub(calls: ExecCall[], result: ExecResult): Operation<void> {
  return API.Process.around(
    {
      // deno-lint-ignore require-yield
      *exec([options]) {
        calls.push({
          command: options.command,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        });
        return result;
      },
    },
    { at: "min" },
  );
}

const OID = "9fceb02d0ae598e95dc970b74767f19372d61af8";

/**
 * The object format the real fixture is created with.
 *
 * `sha256` rather than the default, because the answer has to come from the
 * repository: a capability reporting a constant would pass against a `sha1`
 * fixture and say nothing.
 */
const FORMAT = "sha256";

/** What the fixture commits, and where. */
const DOCUMENT = "notes.md";
const COMMITTED = "the bytes the commit holds\n";

interface Checkout {
  /** The working tree root, as Git resolves it. */
  readonly root: string;
  /** A directory inside it, so an answer of "the root" is not an echo of the cwd. */
  readonly nested: string;
  /** The full object id of the one commit. */
  readonly commit: string;
}

/**
 * A real repository with one commit, arranged through the same process
 * boundary the capability itself reaches.
 *
 * The arrangement passes a neutralized environment, so whoever runs the suite
 * cannot configure it — a global `commit.gpgsign` would otherwise make the
 * fixture ask for a signing key. Nothing is neutralized for the assertions
 * afterwards: they install no `GitQuery` handler and run the default provider
 * exactly as production runs it, steering only which directory it is asked in.
 */
function* useCheckout(): Operation<Checkout> {
  const directory = yield* useTempDirectory("xmd-git-query-");
  // The path Git resolves rather than the one `mkdtemp` handed back: a system
  // temporary directory is reached through a symbolic link on macOS, and
  // `--show-toplevel` answers with the resolved one.
  const root = yield* until(realpath(directory));

  function* git(...args: string[]): Operation<string> {
    return yield* scoped(function* () {
      yield* useQuietProcessOutput();
      const result = yield* exec({
        command: ["git", ...args],
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          GIT_AUTHOR_NAME: "Tester",
          GIT_AUTHOR_EMAIL: "tester@example.invalid",
          GIT_COMMITTER_NAME: "Tester",
          GIT_COMMITTER_EMAIL: "tester@example.invalid",
        },
      });
      if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr ?? ""}`);
      }
      return (result.stdout ?? "").trim();
    });
  }

  yield* git("init", "--initial-branch=main", `--object-format=${FORMAT}`, ".");
  yield* writeTextFile(join(root, DOCUMENT), COMMITTED);
  yield* git("add", DOCUMENT);
  yield* git("commit", "-m", "Record the document");
  const commit = yield* git("rev-parse", "HEAD");

  const nested = join(root, "deep", "inside");
  yield* ensureDir(nested);

  return { root, nested, commit };
}

describe("Tier GT — the read-only Git query capability", () => {
  it("GT1: resolves a revision through the Git CLI in the contextual directory", function* () {
    const calls: ExecCall[] = [];

    const resolved = yield* scoped(function* () {
      yield* API.Env.around(
        {
          *cwd() {
            return "/somewhere";
          },
        },
        { at: "min" },
      );
      yield* useExecStub(calls, { exitCode: 0, stdout: `${OID}\n`, stderr: "" });
      return yield* resolveGitRevision("main^{commit}");
    });

    expect(resolved).toBe(OID);
    expect(calls).toHaveLength(1);
    // `--end-of-options` is what stops a revision that looks like a flag from
    // being read as one; `--verify` is what makes an unresolvable revision an
    // error rather than an echo.
    expect(calls[0]?.command).toEqual([
      "git",
      "rev-parse",
      "--verify",
      "--end-of-options",
      "main^{commit}",
    ]);
    expect(calls[0]?.cwd).toBe("/somewhere");
  });

  it("GT2: a non-zero exit fails, and says what Git reported", function* () {
    let message = "";

    yield* scoped(function* () {
      yield* useExecStub([], {
        exitCode: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
      });
      try {
        yield* resolveGitRevision("main^{commit}");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    });

    expect(message).toContain("128");
    expect(message).toContain("not a git repository");
  });

  it("GT3: a clean exit with nothing to show is still a failure", function* () {
    let message = "";

    yield* scoped(function* () {
      yield* useExecStub([], { exitCode: 0, stdout: "\n", stderr: "" });
      try {
        yield* resolveGitRevision("main^{commit}");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    });

    // An empty object id is not a commit, and trusting it would pin a run to
    // nothing at all.
    expect(message).toContain("main^{commit}");
  });

  // Providers install at "min" so a nested replacement wins. Installed at the
  // default "max" instead, an outer handler would shadow every inner one.
  it("GT4: an inner replacement reaches resolve() rather than being shadowed", function* () {
    const calls: ExecCall[] = [];

    const resolved = yield* scoped(function* () {
      yield* useExecStub(calls, { exitCode: 0, stdout: `${OID}\n`, stderr: "" });
      yield* GitQuery.around(
        {
          // deno-lint-ignore require-yield
          *resolve() {
            return "outer";
          },
        },
        { at: "min" },
      );

      return yield* scoped(function* () {
        yield* GitQuery.around(
          {
            // deno-lint-ignore require-yield
            *resolve() {
              return "inner";
            },
          },
          { at: "min" },
        );
        return yield* resolveGitRevision("main^{commit}");
      });
    });

    expect(resolved).toBe("inner");
    // A replaced provider does not reach the process at all.
    expect(calls).toHaveLength(0);
  });

  // The whole interface is replaceable, not merely the revision question: a
  // consumer that answers all four never reaches Git, and the direct aliases
  // are the operations it answered.
  it("GT5: a replacement answers all four questions, and invokes no Git", function* () {
    const calls: ExecCall[] = [];

    const answers = yield* scoped(function* () {
      yield* useExecStub(calls, { exitCode: 0, stdout: `${OID}\n`, stderr: "" });
      yield* GitQuery.around(
        {
          // deno-lint-ignore require-yield
          *resolve([revision]) {
            return `resolved:${revision}`;
          },
          // deno-lint-ignore require-yield
          *root() {
            return "/replaced/checkout";
          },
          // deno-lint-ignore require-yield
          *format() {
            return "sha256";
          },
          // deno-lint-ignore require-yield
          *read([commit, path]) {
            return `read:${commit}:${path}`;
          },
        },
        { at: "min" },
      );

      return {
        resolve: yield* resolveGitRevision("main^{commit}"),
        root: yield* gitRoot(),
        format: yield* gitObjectFormat(),
        read: yield* readGitObject(OID, "flows/release.md"),
      };
    });

    expect(answers).toEqual({
      resolve: "resolved:main^{commit}",
      root: "/replaced/checkout",
      format: "sha256",
      read: `read:${OID}:flows/release.md`,
    });
    expect(calls).toHaveLength(0);
  });

  // Every case above substitutes something — the process boundary or the Api
  // itself — so none of them runs the shipped default. These two do: a real
  // repository on disk, no `GitQuery` handler installed, and the Git CLI
  // answering.
  it("GT6: the default provider answers all four questions from a real checkout", function* () {
    const checkout = yield* useCheckout();

    const answers = yield* scoped(function* () {
      // The only thing installed is the contextual working directory, which is
      // how a host steers this capability. It is a directory *inside* the
      // checkout, so "the root" cannot be an echo of what was handed over.
      yield* API.Env.around(
        {
          *cwd() {
            return checkout.nested;
          },
        },
        { at: "min" },
      );
      return {
        resolved: yield* resolveGitRevision("HEAD^{commit}"),
        root: yield* gitRoot(),
        format: yield* gitObjectFormat(),
        read: yield* readGitObject(checkout.commit, DOCUMENT),
      };
    });

    expect(answers).toEqual({
      resolved: checkout.commit,
      root: checkout.root,
      format: FORMAT,
      read: COMMITTED,
    });

    // And what it read is the pinned object rather than the working tree: the
    // file is edited on disk and the same read still answers with the commit's
    // own bytes.
    yield* writeTextFile(join(checkout.root, DOCUMENT), "edited since the commit\n");
    const afterEdit = yield* scoped(function* () {
      yield* API.Env.around(
        {
          *cwd() {
            return checkout.nested;
          },
        },
        { at: "min" },
      );
      return yield* readGitObject(checkout.commit, DOCUMENT);
    });
    expect(afterEdit).toBe(COMMITTED);
  });

  it("GT7: outside a working tree the default refuses rather than answering", function* () {
    const elsewhere = yield* useTempDirectory("xmd-git-query-outside-");
    let message = "";

    yield* scoped(function* () {
      yield* API.Env.around(
        {
          *cwd() {
            return elsewhere;
          },
        },
        { at: "min" },
      );
      try {
        yield* gitRoot();
        // Reached only if the default answered, which is the defect this case
        // exists for: an empty message fails the assertion below.
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    });

    expect(message).toContain("which working tree this directory is in");
  });
});
