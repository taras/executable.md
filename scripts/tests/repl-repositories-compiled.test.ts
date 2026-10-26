import { replMountsJourney } from "../../packages/cli/tests/support/repl-mounts-journey.ts";
/**
 * The same journey, against the compiled binary (#181 E1).
 *
 * A compiled `xmd` has no checkout to read from and no module graph to lose a
 * module out of — it has whatever `deno compile` embedded. The entry host is
 * assembled by `compiled.ts`, which is a different entrypoint from the one the
 * source row runs, so a binary that was built without it would start a REPL,
 * perform the file work and retain none of it: the defect would appear at a
 * person's first reopened location rather than here.
 *
 * It runs the *same* journey as the source row, from one shared module, so the
 * two cannot drift into asserting different things.
 *
 * It runs against `dist/xmd`, so `deno task build` has to have happened. A
 * missing binary is reported as the setup it is rather than as a failure of the
 * behavior.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { shellQuote } from "@executablemd/test-support/launch";
import { exists } from "@effectionx/fs";
import type { Operation } from "effection";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import {
  replFilesJourney,
  replGitJourney,
  replRepositoryJourney,
} from "../../packages/cli/tests/support/repl-files-journey.ts";

const ROOT = fromFileUrl(new URL("../..", import.meta.url));
const BINARY = join(ROOT, "dist", "xmd");

/** How this suite invokes the compiled `xmd`. */
function compiled(args: readonly string[]): string {
  return [shellQuote(BINARY), ...args].join(" ");
}

/** Refuse the row rather than skip it: a missing binary is missing evidence. */
function* requireBinary(): Operation<void> {
  if (!(yield* exists(BINARY))) {
    throw new Error(
      `this row drives the compiled binary and ${BINARY} is not there. Run \`deno task build\` ` +
        "first; a skipped row is missing evidence rather than a passing behavior.",
    );
  }
}

describe("the compiled binary's REPL entry files", () => {
  it("E1: carries the entry host, so a completed prefix answers again", function* (): Operation<void> {
    yield* requireBinary();
    yield* replFilesJourney(compiled);
  });

  it("E1: carries the managed selectors, so a Repository answers again", function* (): Operation<void> {
    yield* requireBinary();
    yield* replRepositoryJourney(compiled, "repository");
  });

  it("E1: carries the managed selectors, so a Worktree's path routes a Dir", function* (): Operation<void> {
    yield* requireBinary();
    yield* replRepositoryJourney(compiled, "worktree");
  });

  it("E1: carries the local Git handlers, so a committed id answers again", function* (): Operation<void> {
    yield* requireBinary();
    yield* replGitJourney(compiled, "ambient");
  });

  it("E1: carries them inside a selected Worktree too", function* (): Operation<void> {
    yield* requireBinary();
    yield* replGitJourney(compiled, "worktree");
  });
  it("the compiled binary carries workspace mount replay and live placement", function* () {
    yield* requireBinary();
    yield* replMountsJourney(compiled);
  });
});
