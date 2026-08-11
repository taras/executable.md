/**
 * @module
 *
 * The infrastructure boundary of document execution.
 *
 * Attaching an admission to an execution is a host act, not an authoring one:
 * it decides what a retained history must satisfy before the document is
 * allowed to replay from it. Keeping it behind its own entrypoint is what makes
 * that visible at the import — nothing a document, a component or a middleware
 * package reaches by importing `@executablemd/core` can require anything of a
 * journal.
 *
 * The value crosses as a plain function the host holds and passes:
 *
 * ```ts
 * import { executeInstalled } from "@executablemd/core/host";
 *
 * const execution = yield* executeInstalled(options, [installation]);
 * ```
 *
 * That is also why a separately loaded package composes here. It hands the host
 * a closure and the host hands it to canonical core; neither of them agrees on
 * a name, looks anything up, or shares a registry, so there is nothing for a
 * second copy to disagree about and nothing for anyone else to reach.
 */

export { executeInstalled } from "./src/execute.ts";
export type { ExecutionInstallation, JournalAdmission } from "./src/execute.ts";
