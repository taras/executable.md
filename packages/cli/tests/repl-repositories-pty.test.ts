/**
 * R11/R12 — the actual command, on a real terminal, in a real repository.
 *
 * Every other row of this story injects something: a terminal, a session, a
 * host. This one injects nothing. It launches the production entrypoint for
 * whichever runtime the suite is running under, on a pty with a real window,
 * inside a real Git checkout of a real bare remote, types an entry the way a
 * person types one, and then **leaves** — and comes back with the location the
 * command printed, as a second invocation of the public CLI.
 *
 * What that proves is the part no fake can: that the command assembles a
 * retained host per entry at all, that an entry's repository work reaches a
 * checkout and a remote, and that reopening the printed location shows that work
 * rather than doing it again. The protocol underneath it — which effects freeze,
 * what a replay skips, who owns a lane — is `repl-repositories.test.ts`, where a
 * journal can be read and crafted. Here the journal is wherever the command put
 * it, and that is the point.
 *
 * Under Node and Bun the same file proves the other half: those runtimes
 * register the vocabulary and operate none of it, so repository work refuses
 * before anything local exists, while ordinary file work keeps working.
 *
 * The terminal itself is `./fixtures/pty.ts`, which `repl-exit-pty` drives too,
 * and the repository is `./fixtures/repl-repository-world.ts`, which the compiled
 * row drives too. A host that can allocate no pty fails there rather than
 * passing on nothing.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { cliRuntime, cliShellCommand } from "@executablemd/test-support/launch";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { creations, gitHubStore, issueCreations } from "../../git/tests/support/github.ts";
import { allocate, ended, LEAVE_MS, reaching as reach, REACH_MS, showing } from "./fixtures/pty.ts";
import {
  ENTRY,
  git,
  histories,
  journeyThrough,
  printed,
  SECOND,
  settledErr,
  settledOk,
  submit,
  useJourneyEnvironment,
  useWorld,
} from "./fixtures/repl-repository-world.ts";

/** How long one entry's own repository work may take to reach the screen. */
const WORK_MS = 120_000;

describe("REPL repositories: the command on a real terminal", () => {
  if (cliRuntime() === "deno") {
    it("R11: every boundary, left while its question waits and reopened", function* () {
      const world = yield* useWorld("xmd-rj-");
      const store = gitHubStore({ token: "journey-credential" });
      // The heads this forge answers about are the ones the remote really
      // holds, because the branch this journey publishes is a real branch.
      store.resolveHead = (branch) =>
        git(["rev-parse", branch], world.remote, world.home) || undefined;
      const environment = yield* useJourneyEnvironment(world, store);

      yield* journeyThrough(
        world,
        store,
        (location) =>
          allocate(
            cliShellCommand(["repl", "--deny-all", ...(location === undefined ? [] : [location])]),
            world.home,
            world.checkout,
            environment,
          ),
        { reach: REACH_MS, work: WORK_MS, leave: LEAVE_MS },
      );

      // One history, and one of everything the journey did: the walk proved
      // each boundary twice, and this is the whole of it afterwards.
      expect(yield* histories(world.home)).toHaveLength(1);
      expect(creations(store)).toBe(1);
      expect(issueCreations(store)).toBe(1);
    });

    it("R11: an entry publishes from a real checkout, and the location reopens it", function* () {
      const world = yield* useWorld("xmd-ra-");

      // 1. The public command, in that checkout, with nothing substituted.
      const first = yield* scoped(function* (): Operation<{
        location: string;
        status: number;
        commit: string;
      }> {
        const pty = yield* allocate(
          cliShellCommand(["repl", "--deny-all"]),
          world.home,
          world.checkout,
        );
        yield* showing(pty, "[exit]", REACH_MS);
        yield* submit(pty, ENTRY);

        // Settled, and settled successfully — which for this document means
        // every boundary in it answered: the write, the add, the commit and the
        // publication.
        yield* showing(pty, settledOk(1), WORK_MS);
        const commit = git(["rev-parse", "HEAD"], world.checkout, world.home);

        // Leaving: reached the way a person reaches it, and then nothing more
        // is sent — the command ends because the command decided to.
        yield* reach(pty, "[exit]", LEAVE_MS);
        yield* pty.type("\r");
        const status = yield* ended(
          pty,
          LEAVE_MS,
          "an entry that operated a repository had settled, so this is a teardown that " +
            "joins a retained host rather than one that has nothing to join.",
        );
        return { location: printed(yield* pty.shows()), status, commit };
      });

      expect(first.status).toBe(0);
      // The work is real and it is the entry's: a commit this checkout did not
      // have before, and a remote branch that moved to it.
      expect(first.commit).not.toBe(world.seeded);
      expect(git(["rev-parse", "main"], world.remote, world.home)).toBe(first.commit);
      expect(git(["show", "main:typed.md"], world.remote, world.home)).toBe("typed at a terminal");

      // One history, holding this entry's own retained records.
      const before = yield* histories(world.home);
      expect(before).toHaveLength(1);
      expect(before[0]).toContain("repl_repository_result");

      // 2. A second invocation of the same public command, handed the location
      //    the first one printed. The entry that already ran is shown — its
      //    output is on the screen before anything is typed — and the entry
      //    after it is this invocation's own work.
      const second = yield* scoped(function* (): Operation<number> {
        const pty = yield* allocate(
          cliShellCommand(["repl", "--deny-all", first.location]),
          world.home,
          world.checkout,
        );
        // The entry that already ran is on the screen before anything is typed,
        // and it is settled: this invocation read the history the first one
        // left rather than starting one of its own.
        yield* showing(pty, settledOk(1), REACH_MS);
        yield* submit(pty, SECOND);
        yield* showing(pty, settledOk(2), WORK_MS);
        yield* reach(pty, "[exit]", LEAVE_MS);
        yield* pty.type("\r");
        return yield* ended(pty, LEAVE_MS);
      });
      expect(second).toBe(0);

      const after = yield* histories(world.home);
      // The same history, extended: what the first invocation acknowledged is a
      // prefix of what the second one left, byte for byte.
      expect(after).toHaveLength(1);
      expect(after[0]?.startsWith(before[0] ?? "")).toBe(true);
      expect((after[0] ?? "").length).toBeGreaterThan((before[0] ?? "").length);
      // And the first entry's publication was shown rather than repeated: the
      // remote is where that entry left it, and the second entry's own commit
      // sits on top of it locally, unpublished.
      expect(git(["rev-parse", "main"], world.remote, world.home)).toBe(first.commit);
      expect(git(["rev-parse", "HEAD~1"], world.checkout, world.home)).toBe(first.commit);
    });
  } else {
    it("R12: this runtime operates no repository, and refuses before it tries", function* () {
      const world = yield* useWorld("xmd-ra-");

      const screen = yield* scoped(function* (): Operation<string[]> {
        const pty = yield* allocate(
          cliShellCommand(["repl", "--deny-all"]),
          world.home,
          world.checkout,
        );
        yield* showing(pty, "[exit]", REACH_MS);
        // Ordinary file work, which every runtime does.
        yield* submit(pty, '<File path="ordinary.md">ordinary</File>');
        yield* showing(pty, settledOk(1), WORK_MS);
        // Repository work, which this one does not: the refusal names the
        // absent provider rather than something local going wrong.
        yield* submit(pty, '<Git.Add paths="ordinary.md" />');
        yield* showing(pty, settledErr(2), WORK_MS);
        // Read while the REPL is still drawn, because leaving hands the screen
        // back: after the command ends, what the pane holds is the shell's, and
        // a row that asked it then would be asking the wrong screen.
        const refusal = yield* pty.shows();
        yield* reach(pty, "[exit]", LEAVE_MS);
        yield* pty.type("\r");
        expect(yield* ended(pty, LEAVE_MS)).toBe(0);
        return refusal;
      });

      // Refused before anything local existed: no managed root, so no lock, no
      // credential and no subprocess either.
      expect(screen.join("\n")).toContain("provider");
      expect(yield* until(readdir(world.home))).not.toContain(".xmd");
      // And the ordinary write happened, which is what keeps this a refusal
      // about repositories rather than about files.
      expect(yield* until(readFile(join(world.checkout, "ordinary.md"), "utf8"))).toBe("ordinary");
      // Nothing reached the repository: the checkout is where the fixture left
      // it, with the untracked file beside it.
      expect(git(["rev-parse", "HEAD"], world.checkout, world.home)).toBe(world.seeded);
      expect(git(["status", "--porcelain"], world.checkout, world.home)).toBe("?? ordinary.md");
    });
  }
});
