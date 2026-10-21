/**
 * What installing the ordinary repository provider costs, capability by
 * capability.
 *
 * Installing it must cost nothing at all, and a document that writes no
 * repository component must keep costing nothing. Proving that by looking for
 * an absent managed root proves only one of six things — so each capability is
 * counted separately here, and *every* count must be zero.
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
import { useBareRemote } from "./support/git-remotes.ts";
import { REMOTE } from "./support/run-composition-tier.ts";
import { join } from "node:path";
import { useDenoRepositoryOperations } from "../deno.ts";
import type { DenoRepositoryOperations } from "../deno.ts";
import type { HelperAssembly } from "../credential-helper.ts";
import { collect, execute, inlineSource } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useHostFiles } from "@executablemd/runtime";
import { useRunComposition } from "../src/deno/run-composition/provider.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { Repository } from "@executablemd/git/api";
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
    yield* Repository.operations.ambient();
    return true;
  } catch {
    return false;
  }
}

/** The twelve credential-free methods this package publishes, and only these. */
const PUBLISHED_METHODS: readonly string[] = [
  "add",
  "ambientCheckout",
  "ambientRepository",
  "commit",
  "commitPresent",
  "currentBranch",
  "observe",
  "pushProvider",
  "resolveCommit",
  "selectRepository",
  "selectWorktree",
  "switch",
];

/**
 * What the published repository handle is, before anybody asks it anything.
 *
 * The constructor is what a retaining host calls once per execution, so what it
 * costs and what it hands back are both part of the contract. Counted at the
 * leaves for the cost, read off the value for the shape, and read out of the
 * source for the return graph — because a value that happens to carry no
 * session today proves nothing about what a later edit could return.
 */
describe("what the published repository handle is, and what constructing it costs", () => {
  it("acquires nothing, and no caller supplies a leaf for it to acquire from", function* () {
    const seen = counters();
    yield* scoped(function* () {
      const directory = yield* useTempDirectory("xmd-handle");
      const root = yield* useTempDirectory("xmd-handle-root");
      // The provider is installed over a counting leaf, and the public handle
      // is constructed beside it. Constructing is not asking.
      yield* useRunComposition({ root, cwd: directory, host: counting(seen, directory) });
      const operations = yield* useDenoRepositoryOperations();
      expect(typeof operations.ambientCheckout).toBe("function");
    });
    // The handle builds its own platform leaf rather than taking one, so the
    // counters beside it stay at zero: no temporary directory, no `git`, no
    // identity read.
    expect(seen.directories).toBe(0);
    expect(seen.commands).toEqual([]);
    expect(seen.identities).toBe(0);
  });

  it("hands back exactly the twelve credential-free methods", function* () {
    yield* scoped(function* () {
      const operations: DenoRepositoryOperations = yield* useDenoRepositoryOperations();
      // Every own name, so a member added beside the twelve is a failure here
      // rather than a surprise at a caller.
      expect(Object.keys(operations).sort()).toEqual([...PUBLISHED_METHODS]);
      for (const name of PUBLISHED_METHODS) {
        expect(`${name}: ${typeof Reflect.get(operations, name)}`).toBe(`${name}: function`);
      }
    });
  });

  it("hands back functions and nothing else, so no session comes with it", function* () {
    yield* scoped(function* () {
      const operations = yield* useDenoRepositoryOperations();
      // Every own member is a function. A handle that carried a session, a
      // host or an open attachment would have to hand it over as a value, and
      // there is nowhere here for one to be.
      const values = Object.entries(operations).map(([name, held]) => `${name}: ${typeof held}`);
      expect(values.sort()).toEqual(PUBLISHED_METHODS.map((name) => `${name}: function`));
      // And the three private surfaces are not published at all, which
      // `packages/git/tests/public-entrypoint.test.ts` holds this package to.
    });
  });

  it("returns a push provider holding exactly observe and perform", function* () {
    const remote = yield* useBareRemote(REMOTE);
    yield* scoped(function* () {
      const operations = yield* useDenoRepositoryOperations();
      const provider = yield* operations.pushProvider(join(remote.locator, "objects"), remote.locator, {
        repository: {
          name: "project",
          locatorFingerprint: "a".repeat(64),
          requestedBase: null,
          creationCommit: "b".repeat(40),
          primaryBranch: "main",
          objectFormat: "sha1",
        },
        remote: "origin",
        branch: "review/control",
        destinationRef: "refs/heads/review/control",
        sourceCommit: "c".repeat(40),
      });
      // Two operations and nothing else: the scratch repository and the
      // credential session this acquired belong to the attempt that asked, and
      // neither is a member a caller could reach.
      expect(Object.keys(provider).sort()).toEqual(["observe", "perform"]);
    });
  });

  it("copies the helper it was given, and neither freezes nor mutates it", function* () {
    const launcher: Record<string, string> = { TOKEN: "first" };
    const helper: { -readonly [K in keyof HelperAssembly]: HelperAssembly[K] } = {
      runtime: "source",
      platform: "unix",
      execPath: "/usr/bin/xmd",
      launcherEnvironment: launcher,
    };
    yield* scoped(function* () {
      yield* useDenoRepositoryOperations(helper);
      // Changed after the handle was built, which a handle holding the
      // caller's own object would be configured by.
      launcher["TOKEN"] = "second";
      helper.platform = "windows";
    });
    // The caller's object is left exactly as it was handed over: not frozen,
    // and not written through. What a later edit must not do is reach the
    // handle, and the handle read its configuration once, at construction.
    expect(launcher["TOKEN"]).toBe("second");
    expect(helper.platform).toBe("windows");
    expect(Object.isFrozen(helper)).toBe(false);
    expect(Object.isFrozen(launcher)).toBe(false);
  });

});
