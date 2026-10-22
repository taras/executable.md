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
 * deployment's configuration — the managed root and the credential-helper
 * assembly; it holds no owner, no site, no provider, no credential, no Git
 * session and no identity, so nothing read from here is authority over
 * permission, durable identity or reconciliation. The owner is
 * derived by the session for the entry it is about to run, and the identity
 * inside the installation is minted by canonical core.
 *
 * Deno and the compiled binary select a value; Node and Bun leave the default
 * absence, which is what makes `<Issue>` and `<Git.Push />` on those runtimes
 * reach their ordinary missing-provider refusals rather than a half-configured
 * host.
 *
 * It is CLI-private. No package member exports it and no selector names it:
 * this is the host saying what an entry runs with.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import type { ExecutionInstallation } from "@executablemd/core/host";

/**
 * What one entry's capability is built from: the owner of that entry's retained
 * work.
 *
 * Called inside the entry task, once, for the entry about to execute. What it
 * answers with is declarations, admissions and an installation callback the
 * execution runs in its own scope.
 *
 * It is an operation because an entry's capability may have to *register*
 * something in that task before the execution starts — the repository
 * capability registers the `Execution.init` its own state is created by. It
 * still acquires nothing: no directory, no lease, no `git`, no credential and
 * no initialization of its own happens here, and the registration belongs to
 * the entry task rather than to a scope that closes when this returns.
 */
export type ReplEntryInstallation = (
  owner: string,
  placement?: { readonly projectCwd?: string; readonly workspace?: string },
) => Operation<ExecutionInstallation>;

/** The factory this host runs REPL entries with, or absence. */
export const ReplEntryHost: Context<ReplEntryInstallation | undefined> = createContext<
  ReplEntryInstallation | undefined
>("executablemd.cli.replEntryInstallation", undefined);
