/**
 * @module
 *
 * The infrastructure boundary of document execution.
 *
 * An installation carries the two things only a host may contribute, and both
 * are acts of infrastructure rather than of authoring:
 *
 * - **Admissions** constrain a retained history *before* it is replayed from.
 *   They decide what a journal must already say for this execution to be
 *   allowed to continue it.
 * - **Preparations** perform trusted durable work *inside* the durable root,
 *   after admission and before any public `Execution.document` policy or the
 *   root import. They are `Workflow` operations, so what they prepare is
 *   journaled: on a live run they execute and record, on a partial continuation
 *   they run again and restore what they already recorded rather than
 *   performing it twice, and on a completed terminal replay they are not
 *   entered at all. They are what lets a host — the workflow package, for one —
 *   prepare a run in the journal that the document then runs against.
 *
 * A third act of infrastructure sits beside them. **Generated XMD** is source
 * an Agent produced, and `evaluateGeneratedXmd()` is how a trusted host runs it:
 * the complete fragment is preflighted before its first effect, only the pinned
 * observation identities the host admitted may execute, and what was admitted is
 * recorded as one ordinary durable event before the first observation. It is
 * reached from a preparation, because what it performs belongs in the run's
 * journal.
 *
 * Both stop at the first refusal, and a refusal stops only what has not
 * happened yet: durable effects an earlier preparation completed stay
 * retained and are not rolled back, and the durable root records the refusal as
 * its own terminal. Because core binds such a terminal to the exact root source
 * and target it was about, an identical execution replays that failure instead
 * of finding a history it cannot read.
 *
 * Keeping both behind their own entrypoint is what makes that visible at the
 * import: nothing a document, a component or a middleware package reaches by
 * importing `@executablemd/core` can require anything of a journal or write to
 * one ahead of the document.
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
export type { DurablePreparation } from "./src/document-request.ts";
export { WorkflowBundleError } from "./src/components/bundle.ts";
export type { WorkflowBundleComponent, WorkflowComponentBundle } from "./src/components/bundle.ts";
export {
  evaluateGeneratedXmd,
  GeneratedXmdError,
  pinnedComponent,
  pinnedFetch,
} from "./src/generated-xmd.ts";
export type {
  GeneratedObservation,
  GeneratedRequest,
  GeneratedXmdRequest,
} from "./src/generated-xmd.ts";
