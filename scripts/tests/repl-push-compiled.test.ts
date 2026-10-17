/**
 * The same publication journey, against the compiled binary (#181 E1).
 *
 * A compiled `xmd` has no checkout to read from and no module graph to lose a
 * module out of — it has whatever `deno compile` embedded. The entry capability
 * is assembled by `compiled.ts`, which is a different entrypoint from the one
 * the source row runs, so a binary built without it would start a REPL, refuse
 * the publication, and the defect would appear at a person's first attempt to
 * publish rather than here.
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
import { replPushJourney } from "../../packages/cli/tests/support/repl-push-journey.ts";

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

describe("the compiled binary's REPL publications", () => {
  it("E1: carries the publication capability, so a branch is published once", function* (): Operation<void> {
    yield* requireBinary();
    yield* replPushJourney(compiled);
  });
});
