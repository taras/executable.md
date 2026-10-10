/**
 * The live repository provider, assembled where it can be.
 *
 * Kept apart from `run-repositories.ts` because that module is on the shared
 * command path and this one names the Deno adapter, whose module graph reaches
 * `node:sqlite`. Bun has no such built-in, so a static import of this from
 * shared code would stop `xmd` loading there — not refuse a repository
 * operation, but fail to start at all. Only `deno.ts` and `compiled.ts` import
 * this file, and both of them are Deno.
 *
 * Managed checkouts live beneath `~/.xmd/repositories` and survive every
 * execution: what is in one is somebody's work, and nothing deletes one. There
 * is no environment variable naming a different root, because the only caller
 * that needs one is a test, and a test is handed the root directly.
 */

import type { Operation } from "effection";
import { cwd, hostFilesHandler } from "@executablemd/runtime";
import {
  denoRepositoryHost,
  useRetainedRepositoryEntry,
  useRunComposition,
} from "@executablemd/git/deno";
import type { HelperAssembly } from "@executablemd/git/credential-helper";
import { DEFAULT_REPOSITORY_ROOT } from "./run-repositories.ts";
import type { RepositoryInstaller } from "./run-repositories.ts";
import type { ReplEntryHost, ReplEntryHostFactory } from "./repl-repositories.ts";

/**
 * The live provider Deno and the compiled binary install.
 *
 * It reads no configuration. The two GitHub variables belong to the adapter
 * inside `@executablemd/git`, which reads them when an invoked GitHub-backed
 * operation needs them — so a run that opens no pull request and files no issue
 * reads neither, and an operator who wrote something unusable learns it from
 * the operation that needed it rather than from a command that was only
 * starting up.
 */
export function denoRunRepositories(
  helper: HelperAssembly,
  root: string = DEFAULT_REPOSITORY_ROOT,
): RepositoryInstaller {
  return function* (): Operation<void> {
    yield* useRunComposition({
      root,
      // The directory this execution starts in, which is where the ambient
      // repository is discovered from. Read through the contextual Api rather
      // than from the process, so a nested execution that composed its own
      // working directory is discovered from that one.
      cwd: yield* cwd(),
      helper,
    });
  };
}

/**
 * The retained host one REPL entry runs its repository work through.
 *
 * Built per entry, inside that entry's own task, which is what the factory is
 * for: the owner it retains under is this execution and this admitted entry,
 * and everything it acquires — a lease, a credential session, a scratch
 * directory — belongs to the task that asked for it and ends with it. A cold
 * view calls none of this, because nothing executes there to ask.
 *
 * Managed checkouts live under the same root an ordinary run uses, for the same
 * reason: what is in one is somebody's work, and which entry wrote it does not
 * change where it lives.
 */
export function denoReplEntryHost(
  helper: HelperAssembly,
  root: string = DEFAULT_REPOSITORY_ROOT,
): ReplEntryHostFactory {
  return function* (request): Operation<ReplEntryHost> {
    const entry = yield* useRetainedRepositoryEntry({
      executionId: request.executionId,
      entryKey: request.entryKey,
      source: request.source,
      // Where this entry started, which is where its ambient checkout is
      // looked for. Read through the contextual Api rather than from the
      // process, and read once: a resume takes the root its own history
      // recorded instead of looking again.
      cwd: yield* cwd(),
      managedRoot: root,
      host: denoRepositoryHost({ helper }),
      // Ordinary file behavior, for everything outside a selected checkout. The
      // entry's own handlers perform it directly rather than routing back
      // through the public chain, which is what keeps a write beside the
      // document ordinary and a write inside a checkout retained.
      files: hostFilesHandler(),
    });
    return { installation: entry.installation, files: entry.files };
  };
}
