/**
 * The entry capability this host carries, as inert code.
 *
 * `run-profile.ts` does the same thing one layer up: a runtime entrypoint
 * selects a value before any command is dispatched, and the shared command path
 * reads it without importing an adapter. This is that selection for the one
 * thing a REPL entry needs and an ordinary run does not — a capability built
 * per *entry*, for the exact execution and entry key the entry belongs to.
 *
 * What crosses is a factory, and nothing else. It holds code and this
 * deployment's configuration; it holds no owner, no site, no provider, no
 * credential, no Git session and no identity, so nothing read from here is
 * authority over permission, durable identity or reconciliation. The owner is
 * derived by the session for the entry it is about to run, and the identity
 * inside the installation is minted by canonical core.
 *
 * Deno and the compiled binary select a value; Node and Bun leave the default
 * absence, which is what makes `<Issue>` on those runtimes reach its ordinary
 * missing-provider refusal rather than a half-configured host.
 *
 * It is CLI-private. No package member exports it and no selector names it:
 * this is the host saying what an entry runs with.
 */

import { createContext } from "effection";
import type { Context } from "effection";
import type { ExecutionInstallation } from "@executablemd/core/host";

/**
 * What one entry's capability is built from: the owner of that entry's retained
 * work.
 *
 * Called inside the entry task, once, for the entry about to execute. Calling
 * it performs nothing — what it answers with is a declaration, an admission and
 * an installation callback the execution runs in its own scope.
 */
export type ReplEntryInstallation = (owner: string) => ExecutionInstallation;

/** The factory this host runs REPL entries with, or absence. */
export const ReplEntryHost: Context<ReplEntryInstallation | undefined> = createContext<
  ReplEntryInstallation | undefined
>("executablemd.cli.replEntryInstallation", undefined);
