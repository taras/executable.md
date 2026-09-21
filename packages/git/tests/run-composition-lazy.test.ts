/**
 * What installing the ordinary repository provider costs, capability by
 * capability.
 *
 * Installing it must cost nothing at all, and a document that writes no
 * repository component must keep costing nothing. Proving that by looking for
 * an absent managed root proves only one of six things — so each capability is
 * counted separately here, and the claim is that *every* count is zero.
 *
 * Counted rather than forbidden, because these are not all refusable: a Git
 * session is a temporary directory, an invocation identity is a random string,
 * and neither has a boundary that can throw. What each one has is a moment it
 * is acquired, and counting those moments says exactly when.
 *
 * The same counters then prove the other half: an operation that needs a
 * capability acquires it *once*, however many times it is asked for.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { all, scoped, spawn } from "effection";
import type { Operation } from "effection";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { collect, execute, inlineSource } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useHostFiles } from "@executablemd/runtime";
import { useRunComposition } from "../src/deno/run-composition/provider.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { RepositoryComposition } from "@executablemd/git/api";
import type { RepositoryHost, GitInvocation, GitOutcome } from "../src/deno/composition/host.ts";

/** Every acquisition this provider can make, counted where it happens. */
interface Acquisitions {
  /** Temporary directories the host was asked for: the Git session's `HOME`. */
  directories: number;
  /** `git` invocations, which is what ambient discovery costs. */
  commands: string[][];
  /** Commit-identity reads. */
  identities: number;
}

function counters(): Acquisitions {
  return { directories: 0, commands: [], identities: 0 };
}

/**
 * A host that records what it was asked for and answers plausibly.
 *
 * Substituted at the leaf — the subprocess and the temporary directory — which
 * is the boundary a repository arranged on disk cannot make deterministic.
 * Everything above it is the real provider.
 */
function counting(seen: Acquisitions, directory: string): RepositoryHost {
  return {
    *useDirectory(): Operation<string> {
      seen.directories += 1;
      return directory;
    },
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      seen.commands.push([...invocation.args]);
      // Whatever it asked, the answer is "this is not a checkout": that is the
      // cheapest true answer outside a repository, and it is what makes the
      // ambient case below a discovery that found nothing rather than one that
      // never ran.
      return { code: 128, stdout: "", stderr: "not a git repository" };
    },
  };
}

/** One document, run with the provider installed over a counting host. */
function* run(source: string, seen: Acquisitions): Operation<string> {
  const directory = yield* useTempDirectory("xmd-lazy");
  const root = yield* useTempDirectory("xmd-lazy-root");
  return String(
    yield* scoped(function* () {
      yield* useHostFiles();
      yield* useCompositionComponents();
      yield* useRunComposition({
        root,
        cwd: directory,
        host: counting(seen, directory),
        // Stated, so a commit identity read is this counter rather than a
        // subprocess: what is under test is *when* it is read.
        // deno-lint-ignore require-yield
        identity: function* (): Operation<string | undefined> {
          seen.identities += 1;
          return undefined;
        },
      });
      return yield* collect(
        yield* execute({ ...inlineSource(source), stream: new InMemoryStream() }),
      );
    }),
  );
}

describe("what the ordinary repository provider acquires, and when", () => {
  it("acquires nothing at installation", function* () {
    const seen = counters();
    const directory = yield* useTempDirectory("xmd-lazy");
    const root = yield* useTempDirectory("xmd-lazy-root");
    yield* scoped(function* () {
      yield* useRunComposition({ root, cwd: directory, host: counting(seen, directory) });
    });
    expect(seen).toEqual({ directories: 0, commands: [], identities: 0 });
  });

  it("acquires nothing for a document that writes no repository component", function* () {
    const seen = counters();
    const rendered = yield* run("a plain document\n", seen);
    // The document really ran — an empty render would satisfy every count.
    expect(rendered).toContain("a plain document");
    expect(seen).toEqual({ directories: 0, commands: [], identities: 0 });
  });

  it("acquires no repository capability for a bare <Dir>", function* () {
    const seen = counters();
    const rendered = yield* run('<Dir path="notes">local work only</Dir>\n', seen);
    expect(rendered).toContain("local work only");
    // `<Dir>` makes a directory. It selects no repository, runs no `git`, opens
    // no session and reads no identity.
    expect(seen).toEqual({ directories: 0, commands: [], identities: 0 });
  });

  it("discovers the ambient repository once, when something first asks", function* () {
    const seen = counters();
    yield* scoped(function* () {
      const directory = yield* useTempDirectory("xmd-lazy");
      const root = yield* useTempDirectory("xmd-lazy-root");
      yield* useRunComposition({ root, cwd: directory, host: counting(seen, directory) });
      expect(seen.commands).toEqual([]);

      // Two concurrent asks. Single-flight means one discovery, not two — and
      // the second must not start a fresh one merely because the first had not
      // finished.
      const answers = yield* all([yield* spawn(() => ambient()), yield* spawn(() => ambient())]);
      expect(answers).toEqual([false, false]);
    });

    // One session for the discovery, and one discovery however many asked.
    expect(seen.directories).toBe(1);
    expect(seen.commands.length > 0).toBe(true);
    const discoveries = seen.commands.filter((args) => args.includes("rev-parse"));
    expect(`rev-parse invocations: ${discoveries.length}`).toBe("rev-parse invocations: 1");
    // And nothing asked about a commit identity.
    expect(seen.identities).toBe(0);
  });
});

/** Whether an ambient repository was found, asked through the public Api. */
function* ambient(): Operation<boolean> {
  try {
    yield* RepositoryComposition.operations.ambientRepository();
    return true;
  } catch {
    return false;
  }
}
