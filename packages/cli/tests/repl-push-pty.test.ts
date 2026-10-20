/**
 * The whole public behavior of a publication, on a real terminal, from source
 * (#181 E1, E9).
 *
 * Every other row of this feature's evidence installs its own host, which is
 * what makes those rows portable and deterministic. None of them can show the
 * thing a person actually does: type an entry that commits and publishes a
 * branch, walk away from it at a question, advance the branch from a shell, and
 * reopen the printed location. So this launches the production entrypoint for
 * the host runtime on a pty, against a bare remote it seeded, and reads the
 * answer off the screen, off the checkout and off that remote.
 *
 * ## One suite, two behaviors, by runtime
 *
 * Deno is where the entry capability exists, so the Deno branch runs the
 * journey. Node and Bun assemble none — the Deno adapter's module graph reaches
 * `node:sqlite`, which Bun has not — so their branch runs the other behavior
 * that matters, which is that `<Git.Push />` there refuses before it contacts
 * anything. Neither branch silently skips its own behavior.
 *
 * The journeys themselves are `support/repl-push-journey.ts` and
 * `support/repl-pull-request-journey.ts`, each shared with its compiled row so
 * the two cannot drift.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { cliRuntime, cliShellCommand } from "@executablemd/test-support/launch";
import type { Operation } from "effection";
import { replPushJourney, replUnsupportedPush } from "./support/repl-push-journey.ts";
import {
  replPullRequestJourney,
  replUnsupportedPullRequest,
} from "./support/repl-pull-request-journey.ts";

const JOURNEY = cliRuntime() === "deno";

/** How this suite invokes `xmd`: the production entrypoint for this runtime. */
function sourceCommand(args: readonly string[]): string {
  return cliShellCommand([...args]);
}

describe("a REPL entry's publication, across leaving and coming back", () => {
  it(
    JOURNEY
      ? "E1: publishes once, answers again on reopening, and a new entry publishes today's branch"
      : "E9: this runtime refuses <Git.Push /> before it contacts a remote",
    function* (): Operation<void> {
      yield* JOURNEY ? replPushJourney(sourceCommand) : replUnsupportedPush(sourceCommand);
    },
  );

  it(
    JOURNEY
      ? "B9: opens a pull request, answers its evidence again on reopening, and reads afresh after"
      : "B10: this runtime refuses <PullRequest> and its reads before it contacts anything",
    function* (): Operation<void> {
      yield* JOURNEY
        ? replPullRequestJourney(sourceCommand)
        : replUnsupportedPullRequest(sourceCommand);
    },
  );
});
