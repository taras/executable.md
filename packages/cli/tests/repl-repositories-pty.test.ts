/**
 * The whole public behavior, on a real terminal, from source (#181 E1, E9).
 *
 * Every other row of this feature's evidence installs its own host, which is
 * what makes those rows portable and deterministic. None of them can show the
 * thing a person actually does: type an entry that writes files, walk away from
 * it at a question, change those files from a shell, and reopen the printed
 * location. So this launches the production entrypoint for the host runtime on
 * a pty, inside a checkout it seeded, and reads the answer off the screen and
 * off the filesystem.
 *
 * ## One suite, two behavior, by runtime
 *
 * Deno is where the entry host exists, so the Deno branch runs the journey. Node
 * and Bun assemble no entry host at all — the Deno adapter's module graph
 * reaches `node:sqlite`, which Bun has not — so their branch runs the other
 * behavior that matters, which is that a REPL there still performs ordinary file
 * and directory work. Neither branch silently skips its own behavior.
 *
 * The journey itself is `support/repl-files-journey.ts`, shared with the
 * compiled row so the two cannot drift.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { cliRuntime, cliShellCommand } from "@executablemd/test-support/launch";
import type { Operation } from "effection";
import {
  replFilesJourney,
  replGitJourney,
  replOrdinaryFileWork,
  replRepositoryJourney,
  replUnsupportedGit,
  replUnsupportedSelection,
} from "./support/repl-files-journey.ts";

const JOURNEY = cliRuntime() === "deno";

/** How this suite invokes `xmd`: the production entrypoint for this runtime. */
function sourceCommand(args: readonly string[]): string {
  return cliShellCommand([...args]);
}

describe("a REPL entry's files, across leaving and coming back", () => {
  it(
    JOURNEY
      ? "E1: a completed prefix answers again, and the suffix executes on the answer"
      : "E9: this runtime performs ordinary file and directory work and retains none of it",
    function* (): Operation<void> {
      yield* JOURNEY ? replFilesJourney(sourceCommand) : replOrdinaryFileWork(sourceCommand);
    },
  );

  it(
    JOURNEY
      ? "E1: a managed Repository is selected once, and answers again on reopening"
      : "E8: this runtime refuses a managed Repository before it reaches a clone",
    function* (): Operation<void> {
      yield* JOURNEY
        ? replRepositoryJourney(sourceCommand, "repository")
        : replUnsupportedSelection(sourceCommand);
    },
  );

  it(
    JOURNEY
      ? "E1: a committed object id answers again while the checkout has moved on"
      : "E8: this runtime refuses Add, Switch and Commit before a native operation",
    function* (): Operation<void> {
      yield* JOURNEY ? replGitJourney(sourceCommand, "ambient") : replUnsupportedGit(sourceCommand);
    },
  );

  if (JOURNEY) {
    it("E1: a managed Worktree's captured path routes a Dir, and answers again", function* (): Operation<void> {
      yield* replRepositoryJourney(sourceCommand, "worktree");
    });

    it("E1: a selected Worktree's Add and Commit answer again on reopening", function* (): Operation<void> {
      yield* replGitJourney(sourceCommand, "worktree");
    });
  }
});
