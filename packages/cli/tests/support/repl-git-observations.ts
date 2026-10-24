import { ensure, resource, until } from "effection";
import type { Operation, Result } from "effection";
import { rm } from "@effectionx/fs";
import { appendFile, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "@executablemd/runtime";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { gitPlugin } from "@executablemd/git";
import { replRepositoryPlugin } from "../../src/repl/repositories/plugin.ts";
import { ReplHost } from "../../src/repl/host.ts";
import type { ReplSession } from "../../src/repl/session.ts";
import { runGit } from "./fixture-git.ts";

export interface Fixture {
  readonly root: string;
  readonly checkout: string;
  readonly journals: string;
  /** The first commit, which every pinned read names. */
  readonly first: string;
  run(...args: string[]): Operation<string>;
}

/**
 * A committed checkout an entry is opened in.
 *
 * Committed, because a Repository identity is pinned at the commit HEAD named
 * when the entry opened: a checkout with no commit is one no selection can
 * name, which is a different story from this one.
 */
export function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-git-reads-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const checkout = join(root, "checkout");
    yield* runGit(root, ["init", "-b", "main", checkout], { home: root });
    yield* until(writeFile(join(checkout, "seed.md"), "seed\n"));
    yield* until(writeFile(join(checkout, "notes.md"), "first notes\n"));
    yield* runGit(checkout, ["add", "--", "seed.md", "notes.md"], { home: root });
    yield* runGit(checkout, ["commit", "-m", "first"], { home: root });
    const head = yield* runGit(checkout, ["rev-parse", "HEAD"], { home: root });
    yield* provide({
      root,
      checkout,
      journals: join(root, "journals"),
      first: head,
      run(...args: string[]): Operation<string> {
        return runGit(checkout, args, { home: root });
      },
    });
  });
}


/**
 * What a command contributes to an entry's execution.
 *
 * Taken from the Git Plugin's own contribution for the `repl` command rather
 * than written out here, because that contribution is the production path: the
 * admission that reads this feature's records travels with the vocabulary.
 */
export function* replInstallations(): Operation<readonly ExecutionInstallation[]> {
  // The command's own assembly of the bundled Plugin, which is what a profile
  // carries: the vocabulary and the domain admissions come from Git, and the
  // admission that reads an entry's own repository history back belongs to this
  // command, so asking the bundled Plugin alone would declare nothing here.
  const bundled = replRepositoryPlugin(gitPlugin);
  const install = bundled.install;
  if (install === undefined) {
    throw new Error("the bundled Plugin installs nothing");
  }
  const installed = yield* install.call(bundled, { command: "repl", args: [] });
  if (installed === undefined) {
    throw new Error("the bundled Plugin declared nothing for the repl command");
  }
  return [{ admissions: [...(installed.admissions ?? [])] }];
}

/** The host half a runtime entrypoint owns, installed here by the suite. */
export function useNodeReplHost(name: string): Operation<void> {
  return ReplHost.around(
    {
      // deno-lint-ignore require-yield
      *identify(): Operation<string> {
        return name;
      },
      *createExclusive([path]: [string]): Operation<void> {
        const handle = yield* until(open(path, "wx"));
        yield* until(handle.close());
      },
      *appendRecord([path, record]: [string, string]): Operation<void> {
        yield* until(appendFile(path, record));
      },
    },
    { at: "min" },
  );
}

export function useWorkingDirectory(directory: string): Operation<void> {
  return API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd(): Operation<string> {
        return directory;
      },
    },
    { at: "min" },
  );
}

export function opened(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}


/** The four reads at root, each binding its page. */
export const READS_AT_ROOT = (fixture: Fixture): string =>
  [
    '<Git.Files limit={100} as="files" />',
    "",
    '<Git.Changes compare="unstaged" as="changes" />',
    "",
    '<Git.Diff compare="unstaged" limit={100000} as="diff" />',
    "",
    `<Git.File commit="${fixture.first}" path="notes.md" as="source" />`,
    "",
    "Read {files.paths.length} paths.",
    "",
  ].join("\n");

