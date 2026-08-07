/**
 * Tier GT — the Git capability.
 *
 * `Git.revParse()` verifies and resolves one revision expression in the
 * contextual working directory. The default invokes the Git CLI; a host or a
 * test replaces it lexically. Nothing here shells out: every test either
 * replaces `Git` or stubs the process boundary beneath it, so the suite runs
 * the same wherever it is checked out.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { API } from "@executablemd/runtime";
import { Git, revParse } from "../src/git.ts";

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

describe("Tier GT — the Git capability", () => {
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
      return yield* revParse("main^{commit}");
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
        yield* revParse("main^{commit}");
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
        yield* revParse("main^{commit}");
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
  it("GT4: an inner replacement reaches revParse rather than being shadowed", function* () {
    const calls: ExecCall[] = [];

    const resolved = yield* scoped(function* () {
      yield* useExecStub(calls, { exitCode: 0, stdout: `${OID}\n`, stderr: "" });
      yield* Git.around(
        {
          // deno-lint-ignore require-yield
          *revParse() {
            return "outer";
          },
        },
        { at: "min" },
      );

      return yield* scoped(function* () {
        yield* Git.around(
          {
            // deno-lint-ignore require-yield
            *revParse() {
              return "inner";
            },
          },
          { at: "min" },
        );
        return yield* revParse("main^{commit}");
      });
    });

    expect(resolved).toBe("inner");
    // A replaced provider does not reach the process at all.
    expect(calls).toHaveLength(0);
  });
});
