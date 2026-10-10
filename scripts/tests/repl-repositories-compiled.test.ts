/**
 * The compiled `xmd repl`, operating a real repository on a real terminal.
 *
 * A retained REPL entry's repository host is assembled at a runtime-named
 * entrypoint — `compiled.ts` hands `runXmd` the Deno entry host, the same way
 * `deno.ts` does — and everything behind it is module graph: the provider, the
 * Git host, the credential helper the binary re-enters as a subprocess of
 * itself. A build that dropped any of that ships a binary which draws the REPL,
 * accepts an entry, and then refuses the first `<Git.Add>` in it, at a person's
 * terminal rather than here.
 *
 * So this is the source row's journey (`packages/cli/tests/repl-repositories-pty`)
 * run against `dist/xmd`: one entry writes, commits and publishes out of an
 * ambient checkout into a bare remote, the command is left through `[exit]`, and
 * the location it printed is reopened by a second invocation of the binary. Both
 * halves matter here — the first says the host was assembled at all, the second
 * says the entry's records were written somewhere the binary can read back.
 *
 * It runs against `dist/xmd`, so `deno task build` has to have happened. A
 * missing binary is reported as the setup it is rather than as a failure of the
 * claim, which is why no test shard carries this file: `smoke` builds the binary
 * through README.md#Build and runs it there.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { shellQuote } from "@executablemd/test-support/launch";
import { exists } from "@effectionx/fs";
import { scoped } from "effection";
import type { Operation } from "effection";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allocate,
  ended,
  LEAVE_MS,
  reaching,
  REACH_MS,
  showing,
} from "../../packages/cli/tests/fixtures/pty.ts";
import {
  ENTRY,
  git,
  histories,
  printed,
  settledOk,
  submit,
  useWorld,
} from "../../packages/cli/tests/fixtures/repl-repository-world.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINARY = path.join(ROOT, "dist", "xmd");

/** How long one entry's own repository work may take to reach the screen. */
const WORK_MS = 120_000;

describe("compiled xmd repl", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("R11: an entry publishes from a real checkout, and the location reopens it", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }
    const world = yield* useWorld("xmd-repl-repos-compiled-");
    const line = (...args: string[]): string =>
      [BINARY, "repl", "--deny-all", ...args].map(shellQuote).join(" ");

    // 1. The binary, in that checkout, with nothing substituted and no checkout
    //    of its own to fall back on: what it carries is what it has.
    const first = yield* scoped(function* (): Operation<{ location: string; commit: string }> {
      const pty = yield* allocate(line(), world.home, world.checkout);
      yield* showing(pty, "[exit]", REACH_MS);
      yield* submit(pty, ENTRY);

      // Settled, and settled successfully — which for this document means the
      // write, the add, the commit and the publication each answered.
      yield* showing(pty, settledOk(1), WORK_MS);
      const commit = git(["rev-parse", "HEAD"], world.checkout, world.home);

      yield* reaching(pty, "[exit]", LEAVE_MS);
      yield* pty.type("\r");
      expect(
        yield* ended(
          pty,
          LEAVE_MS,
          "the compiled binary had operated a repository, so this is a teardown that joins " +
            "a retained host rather than one that has nothing to join.",
        ),
      ).toBe(0);
      return { location: printed(yield* pty.shows()), commit };
    });

    // The work is real and it is the entry's: a commit this checkout did not
    // have, a remote branch that moved to it, and the file readable out of it.
    expect(first.commit).not.toBe(world.seeded);
    expect(git(["rev-parse", "main"], world.remote, world.home)).toBe(first.commit);
    expect(git(["show", "main:typed.md"], world.remote, world.home)).toBe("typed at a terminal");

    const before = yield* histories(world.home);
    expect(before).toHaveLength(1);
    expect(before[0]).toContain("retained_repository_completion");

    // 2. The same binary, handed the location the first invocation printed. The
    //    entry that already ran is on the screen before anything is typed, and
    //    nothing of it is done again.
    yield* scoped(function* (): Operation<void> {
      const pty = yield* allocate(line(first.location), world.home, world.checkout);
      yield* showing(pty, settledOk(1), REACH_MS);
      yield* reaching(pty, "[exit]", LEAVE_MS);
      yield* pty.type("\r");
      expect(yield* ended(pty, LEAVE_MS)).toBe(0);
    });

    // Read back rather than rebuilt: the records the first invocation wrote are
    // still exactly what is there, and the publication did not happen twice.
    expect(yield* histories(world.home)).toEqual(before);
    expect(git(["rev-parse", "main"], world.remote, world.home)).toBe(first.commit);
  });
});
