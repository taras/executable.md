/**
 * Tier GO9, the half that needs a runtime which operates repositories.
 *
 * Two subjects, both of which need a real `git` under a real checkout.
 *
 * One case, kept apart from `git-observations.test.ts` because its subject is a
 * *managed* selection: it clones a remote into a managed root and adds a
 * worktree, which this repository holds under a kernel-released exclusive
 * advisory lock taken through the Deno runtime. Node and Bun expose no
 * equivalent, so there the document cannot reach the checkout at all and the
 * case fails on the lock rather than on anything it asserts.
 *
 * Everything else about which checkout answers stays portable and stays in
 * `git-observations.test.ts`: the sibling checkouts distinguished by content,
 * and the foreign and edited selections refused before a host is reached. What
 * only this file can observe is that an ambient checkout, a lexical Repository,
 * a Worktree and a `<Dir>` inside one each answer from their own checkout.
 *
 * The second subject is what an interrupted read leaves behind. That belongs
 * here rather than above the provider: what it establishes is about a process
 * the native host started and a scratch directory it owned, and nothing stated
 * in terms of the published repository handle can see either. A wrapper around the handle
 * sees a call and its answer and never the child between them, so residue
 * observed afterwards could not tell an interrupted read from one that never
 * began.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { exists, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import type { Json } from "@executablemd/durable-streams";
import { capturingProbe, writeFixtureFile } from "./support/observations.ts";
import {
  runOrdinaryDocument,
  useHostCheckout,
  useManagedRoot,
  useOriginlessCheckout,
} from "./support/run-composition.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { REMOTE } from "./support/run-composition-tier.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type {
  GitBytes,
  GitInvocation,
  GitOutcome,
  RepositoryHost,
} from "../src/deno/composition/host.ts";

/** The one bound value a case's document projected, as an object. */
function object(value: Json | undefined): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected one bound object, received ${JSON.stringify(value)}`);
  }
  return value;
}

function paths(value: Json | undefined): string[] {
  const listed = object(value).paths;
  if (!Array.isArray(listed)) {
    throw new Error(`expected a paths array, received ${JSON.stringify(listed)}`);
  }
  return listed.map((entry) => String(entry));
}

describe("GO9 — which checkout answers, through a managed selection", () => {
  it("reads the ambient checkout, a lexical Repository, a Worktree and a Dir inside one", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const ambient = yield* useHostCheckout(remote.locator);
    yield* writeFixtureFile(ambient.root, "only-here.txt", "ambient\n");
    ambient.run("add", "--", "only-here.txt");
    ambient.run("commit", "-m", "ambient only");
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        '<Git.Files limit={100} as="here" />',
        "",
        "<Captured value={here} />",
        "",
        `<Repository name="project" url="${remote.locator}">`,
        "",
        '<Git.Files limit={100} as="managed" />',
        "",
        "<Captured value={managed} />",
        "",
        '<Worktree name="side" branch="side">',
        "",
        '<Git.Changes compare="unstaged" as="inSide" />',
        "",
        "<Captured value={inSide} />",
        "",
        '<Dir path="deeper">',
        "",
        '<Git.Files limit={100} as="fromDir" />',
        "",
        "<Captured value={fromDir} />",
        "",
        "</Dir>",
        "",
        "</Worktree>",
        "",
        "</Repository>",
        "",
      ].join("\n"),
      { root, cwd: ambient.root, components: [capturingProbe(seen)] },
    );

    // The ambient checkout holds a path the managed clone never received, which
    // is how a read that answered from the wrong one would say so.
    expect(paths(seen[0])).toContain("only-here.txt");
    expect(paths(seen[1])).toEqual(["which.txt"]);
    expect(object(seen[2]).changes).toEqual([]);
    // A `<Dir>` beneath a Worktree stays inside that checkout, and the answer
    // is still relative to its repository root.
    expect(paths(seen[3])).toEqual(["which.txt"]);
  });
});

/** What a watched `git` child reported about its own lifetime. */
interface WatchedChildren {
  readonly spawned: Operation<void>;
  readonly observe: NonNullable<GitInvocation["observe"]>;
  observed(): number;
  closed(): boolean;
  alive(): boolean;
}

/** Whether this process is still running, asked of the operating system. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Watch the real children one invocation spawns.
 *
 * The production host forwards this to the one place a child exists, which is
 * the only point at which a case can see the process a command really started.
 */
function watchChildren(): WatchedChildren {
  const pids: number[] = [];
  let count = 0;
  let closes = 0;
  const first = withResolvers<void>();
  return {
    spawned: first.operation,
    observe(child): void {
      count += 1;
      if (child.pid !== undefined) {
        pids.push(child.pid);
      }
      child.on("close", () => {
        closes += 1;
      });
      first.resolve();
    },
    observed: () => count,
    closed: () => count > 0 && closes === count,
    alive: () => pids.some((pid) => running(pid)),
  };
}

/**
 * A script that reports it ran and then waits.
 *
 * What makes a child cut deterministic: the marker says the command really
 * reached this point, and the wait keeps it there until the halt arrives. The
 * process group teardown is what ends it.
 */
function* waitingScript(path: string, marker: string): Operation<void> {
  yield* writeTextFile(path, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nsleep 120\n`);
  yield* until(chmod(path, 0o755));
}

/** Wait until this path is there, or say what never appeared. */
function* appears(path: string): Operation<void> {
  const deadline = Date.now() + 30_000;
  while (!(yield* exists(path))) {
    if (Date.now() > deadline) {
      throw new Error(`${path} never appeared`);
    }
    yield* sleep(25);
  }
}

/** The production host, with every scratch directory recorded on the way out. */
function watchingHost(
  scratch: string[],
  intercept: (invocation: GitInvocation) => Partial<GitInvocation> | undefined,
): RepositoryHost {
  const host = denoRepositoryHost();
  const watched = (invocation: GitInvocation): GitInvocation => ({
    ...invocation,
    ...(intercept(invocation) ?? {}),
  });
  return {
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      return yield* host.git(watched(invocation));
    },
    *gitBytes(invocation: GitInvocation): Operation<GitBytes> {
      if (host.gitBytes === undefined) {
        throw new Error("the production host lends no byte capture");
      }
      return yield* host.gitBytes(watched(invocation));
    },
    *useDirectory(): Operation<string> {
      const directory = yield* host.useDirectory();
      scratch.push(directory);
      return directory;
    },
  };
}

describe("GO9 — what an interrupted native read leaves behind", () => {
  it("joins the read's own child and removes its scratch before settling", function* () {
    const checkout = yield* useOriginlessCheckout();
    const root = yield* useManagedRoot();
    yield* writeFixtureFile(checkout.root, "src/a.ts", "export const a = 1;\n");
    checkout.run("add", "--", "src/a.ts");
    checkout.run("commit", "-m", "a");
    yield* writeFixtureFile(checkout.root, "src/a.ts", "export const a = 11;\n");

    const watched = watchChildren();
    const scratch: string[] = [];
    const marker = join(checkout.home, "read-ran");
    const script = join(checkout.home, "waiting-fsmonitor");
    yield* waitingScript(script, marker);

    // The comparison refreshes the index before it answers, and a file-system
    // monitor is consulted while it does. This one reports that it ran and then
    // waits, holding the pipes the parent inherited — which is what makes the
    // cut land on a real child rather than between commands.
    const intercept = (invocation: GitInvocation): Partial<GitInvocation> | undefined =>
      invocation.args.includes("diff")
        ? {
            args: ["-c", `core.fsmonitor=${script}`, ...invocation.args],
            observe: watched.observe,
          }
        : undefined;

    yield* scoped(function* () {
      const task = yield* spawn(() =>
        runOrdinaryDocument(
          [
            '<Git.Diff compare="unstaged" as="diff" />',
            '<File path="sentinel.md">sentinel</File>',
          ].join("\n"),
          { root, cwd: checkout.root, host: watchingHost(scratch, intercept) },
        ),
      );
      // The marker says the descendant really ran and is holding the pipes.
      yield* appears(marker);
      yield* watched.spawned;
      yield* task.halt();
    });

    // The child is gone and both its pipes have ended; the scratch the read
    // owned is gone with it; and nothing after the read ran.
    expect(watched.observed() > 0).toBe(true);
    expect(watched.closed()).toBe(true);
    expect(watched.alive()).toBe(false);
    expect(scratch.length > 0).toBe(true);
    for (const directory of scratch) {
      expect(yield* exists(directory)).toBe(false);
    }
    expect(yield* exists(join(checkout.root, "sentinel.md"))).toBe(false);
  });
});
