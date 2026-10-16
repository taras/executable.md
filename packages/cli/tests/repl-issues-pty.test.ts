/**
 * The whole public behavior of an entry's issues, on a real terminal, from
 * source (#181 E8).
 *
 * ## One suite, two behavior, by runtime
 *
 * Deno is where the entry issue host exists, so the Deno branch runs the
 * journeys. Node and Bun assemble none — the Deno adapter's module graph
 * reaches `node:sqlite`, which Bun has not — so their branch runs the other
 * behavior that matters, which is that `<Issue>` there reports no provider
 * rather than reaching a transport nobody installed. Neither branch silently
 * skips its own behavior.
 *
 * The journeys themselves are `support/repl-issues-journey.ts`, shared with the
 * compiled row so the two cannot drift.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { cliRuntime, cliShellCommand } from "@executablemd/test-support/launch";
import type { Operation } from "effection";
import {
  replIssuesAdoptionJourney,
  replIssuesJourney,
  replIssuesUnsupported,
} from "./support/repl-issues-journey.ts";

const JOURNEY = cliRuntime() === "deno";

/** How this suite invokes `xmd`: the production entrypoint for this runtime. */
function sourceCommand(args: readonly string[]): string {
  return cliShellCommand([...args]);
}

describe("a REPL entry's issues, across leaving and coming back", () => {
  it(
    JOURNEY
      ? "E8: a filed issue and the snapshot it read answer again at the printed location"
      : "E8: this runtime resolves <Issue> and reports that it has no provider",
    function* (): Operation<void> {
      yield* JOURNEY ? replIssuesJourney(sourceCommand) : replIssuesUnsupported(sourceCommand);
    },
  );

  if (JOURNEY) {
    it("E8: an accepted create this end never learned of is adopted, not repeated", function* (): Operation<void> {
      yield* replIssuesAdoptionJourney(sourceCommand);
    });
  }
});
