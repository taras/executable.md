/**
 * Where an ordinary `xmd run` keeps the repositories it manages, and what it is
 * allowed to reach.
 *
 * This is the only module in the CLI that names the managed root, exactly as
 * `deno-workflow.ts` is the only one that names the run store. What a document
 * writes decides which repository it wants; this decides where a clone of it
 * lands, which issue trackers and pull requests this deployment authorizes, and
 * how the host writes its own credential helper.
 *
 * Managed checkouts live beneath `~/.xmd/repositories` and survive every
 * execution: what is in one is somebody's work — a branch, a worktree an agent
 * is still editing, an uncommitted change — and nothing deletes one. There is
 * no environment variable naming a different root, because the only caller that
 * needs one is a test, and a test is handed the root directly.
 *
 * Node and Bun install none of this. They register the same thirteen
 * declarations, so `xmd syntax` describes one language and a document resolves
 * the same names everywhere, and every operation then reaches a clear
 * provider-absence error before anything local or remote is touched.
 *
 * Nothing here imports the Deno adapter. This module is on the shared command
 * path, and the adapter's module graph reaches `node:sqlite` — a built-in Bun
 * does not have — so a static import of it here would stop `xmd` loading there
 * at all. The live installer lives beside the entrypoints that can use it, in
 * `deno-repositories.ts`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Operation } from "effection";

/** Where managed repositories and worktrees live. */
export const DEFAULT_REPOSITORY_ROOT: string = join(homedir(), ".xmd", "repositories");

/**
 * How one document execution obtains repository operations, or does not.
 *
 * A function rather than a value, because the provider is installed *inside*
 * the execution scope and holds that execution's own invocation identity,
 * leases and Push evidence. A nested `<Execution host="run">` calls it again
 * and gets a fresh instance, which is what keeps a child's evidence and locks
 * out of its parent and its siblings.
 */
export type RepositoryInstaller = () => Operation<void>;

/**
 * The runtimes that register the vocabulary and operate none of it.
 *
 * Installing nothing is the whole implementation: `<Repository>`, `<Worktree>`,
 * the Git operations, `<Issue>` and `<PullRequest>` each reach their own Api's
 * default, which reports an absent provider before a lock, a credential, a
 * subprocess or a request exists. `<Dir>` is unaffected — it needs no provider.
 */
export function unsupportedRepositories(): Operation<void> {
  return noRepositories();
}

// deno-lint-ignore require-yield
function* noRepositories(): Operation<void> {}
