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
 * Node and Bun configure none of this. They select the provider-neutral
 * bundled Plugin, so `xmd syntax` describes one language and a document
 * resolves the same names everywhere, and every operation then reaches a clear
 * provider-absence error before anything local or remote is touched.
 *
 * Nothing here imports the Deno adapter. This module is on the shared command
 * path, and the adapter's module graph reaches `node:sqlite` — a built-in Bun
 * does not have — so a static import of it here would stop `xmd` loading there
 * at all. The configured Plugin that holds this root lives beside the
 * entrypoints that can use it, in `deno-repositories.ts`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Where managed repositories and worktrees live. */
export const DEFAULT_REPOSITORY_ROOT: string = join(homedir(), ".xmd", "repositories");
