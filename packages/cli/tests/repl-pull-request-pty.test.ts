/**
 * The whole public behavior of a pull request and its evidence, on a real
 * terminal, from source (#181 V1, V9).
 *
 * Every other row of this feature's evidence installs its own host, which is
 * what makes those rows portable and deterministic. None of them can show the
 * thing a person actually does: type an entry that publishes a branch and opens
 * its pull request, walk away at a question, let the reviews change, and reopen
 * the printed location.
 *
 * ## One suite, two behaviors, by runtime
 *
 * Deno is where the entry capability exists, so the Deno branch runs the
 * journey. Node and Bun assemble none — the Deno adapter's module graph reaches
 * `node:sqlite`, which Bun has not — so their branch runs the other behavior
 * that matters, which is that `<PullRequest>` and its reads there refuse before
 * contacting anything. Neither branch silently skips its own behavior.
 *
 * The journey itself is `support/repl-pull-request-journey.ts`, shared with the
 * compiled row so the two cannot drift.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { cliRuntime, cliShellCommand } from "@executablemd/test-support/launch";
import type { Operation } from "effection";
import {
  replPullRequestJourney,
  replUnsupportedPullRequest,
} from "./support/repl-pull-request-journey.ts";

const JOURNEY = cliRuntime() === "deno";

/** How this suite invokes `xmd`: the production entrypoint for this runtime. */
function sourceCommand(args: readonly string[]): string {
  return cliShellCommand([...args]);
}

describe("a REPL entry's pull request, across leaving and coming back", () => {
  it(
    JOURNEY
      ? "V1: opens once, restores its identity and saved evidence, and reads again on answering"
      : "V9: this runtime refuses <PullRequest> and its reads before contacting anything",
    function* (): Operation<void> {
      yield* JOURNEY
        ? replPullRequestJourney(sourceCommand)
        : replUnsupportedPullRequest(sourceCommand);
    },
  );
});
