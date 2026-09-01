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
 * identity the host admitted for that name *and* that authored form may
 * execute, and what was admitted is recorded as one ordinary durable event
 * before the first generated effect. The host states a `read` table and a
 * `write` table and the caller selects between them, so admitting an
 * observation is not admitting a mutation. It is an `Operation`: the
 * production workflow reaches it through its host-declared `<Evaluate>`
 * component inside the owning authored expansion — not through a
 * `DurablePreparation` — so the admission and every durable effect the
 * admitted fragment performs belong to that expansion's own durable sequence.
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

/**
 * A **test harness installer** is the third, and it is a delivery rather than a
 * capability anybody can ask for. Running another document as a root is
 * infrastructure — its own root import, its own journal, its own scope — so who
 * may do it is decided by canonical `<Test>`, and what it is handed to is
 * decided here, by the host, as a function it holds and passes. There is no
 * reader: nothing published, nothing named, and nothing for a same-name context
 * or a second loaded copy to reach.
 */
export { executeInstalled } from "./src/execute.ts";
export type { ExecutionInstallation, JournalAdmission } from "./src/execute.ts";
export type { DurablePreparation } from "./src/document-request.ts";

/**
 * What a trusted host declares to an execution when one of its components names
 * durable work after its own invocation — see `src/invocation-identity.ts`.
 * The claimant is delivered to the factory and published nowhere.
 */
export { ComponentInvocationError } from "./src/invocation-identity.ts";
export type { IdentityClaimant, IdentityComponent } from "./src/invocation-identity.ts";
/**
 * Core's own `<Elicit>` schema, for a host that registers a second one.
 *
 * A workflow run resolves `Elicit` to a registration of its own, which asks the
 * same question and reaches the same Elicitation Api but writes no durable
 * record of its own. What it must not do is declare a *different* component:
 * two hand-written copies of one props schema are two schemas, and no test
 * catches the day they stop agreeing. So the second registration takes core's,
 * the way the pinned generated identities take core's definitions.
 */
export { props as elicitProps, returns as elicitReturns } from "./src/components/Elicit.ts";
export { WorkflowBundleError } from "./src/components/bundle.ts";
export type { WorkflowBundleComponent, WorkflowComponentBundle } from "./src/components/bundle.ts";

/**
 * Exact Markdown a trusted host declares to an execution — see
 * `src/components/declared-markdown.ts`.
 *
 * The fifth act of infrastructure, and the same shape as the rest: plain
 * immutable data the host holds and passes. The host states the bytes, their
 * origin and their digest, and canonical core refuses the declaration if what
 * the host said about them is not what they say about themselves. `sourceDigest`
 * is the same hash core checks against, so a build states the digest of what it
 * actually shipped rather than a constant someone updates by hand.
 */
export { DeclaredMarkdownError, sourceDigest } from "./src/components/declared-markdown.ts";
export type { DeclaredMarkdownComponent } from "./src/components/declared-markdown.ts";

/**
 * Installing one Agent provider for the invocation that projects the content it
 * covers.
 *
 * The sixth act of infrastructure, and the narrowest: a trusted host component
 * that establishes a constrained ceiling around content it projects installs the
 * provider *in* that invocation, exactly as `<AgentProvider>` does, because a
 * provider installed in a frame nested inside it would be invisible to the very
 * content it was selected for. Kept here for the reason the rest of this module
 * is: nothing a document, a component or a middleware package reaches by
 * importing `@executablemd/core` can install a provider for a region it did not
 * author.
 */
export { installInvocationAgentProvider } from "./src/agent/launch-install.ts";
export {
  evaluateGeneratedXmd,
  GeneratedXmdError,
  pinnedComponent,
  pinnedFetch,
  pinnedFileDelete,
  pinnedFileRead,
  pinnedFileWrite,
  pinnedMutation,
} from "./src/generated-xmd.ts";
export type {
  GeneratedComponentForm,
  GeneratedEffectClass,
  GeneratedMutation,
  GeneratedObservation,
  GeneratedObservationResult,
  GeneratedObservationValue,
  GeneratedRequest,
  GeneratedXmdRequest,
} from "./src/generated-xmd.ts";

/**
 * Where a completed Prompt publishes, for a host that retains something beside
 * it.
 *
 * The fourth act of infrastructure, and the same shape as the three above: a
 * value the host holds and passes. An ordinary run installs none and publishes
 * exactly as it always did. A host that installs one moves the `agent_prompt`
 * append inside the transaction it opened, so what it keeps beside that event
 * commits with the event or not at all.
 *
 * Kept here for the reason the rest of this module is: nothing a document, a
 * component or a middleware package reaches by importing `@executablemd/core`
 * can decide where a prompt is journaled.
 */
export { useAgentPromptPublisher } from "./src/agent/publication.ts";
export type {
  AgentPromptAssociation,
  AgentPromptPublication,
  AgentPromptPublisher,
} from "./src/agent/publication.ts";

export { TestHarnessError } from "./src/test-harness.ts";
export type {
  TestHarness,
  TestHarnessAuthorization,
  TestHarnessBinding,
  TestHarnessInstaller,
} from "./src/test-harness.ts";

/**
 * The durable Agent Prompt record, for a host that reads a retained journal.
 *
 * A sealed workflow artifact classifies each Agent session by what its retained
 * Prompts say, and the only thing that can answer that is the parser the live
 * run already records through. A second reading of the same durable value would
 * be a second contract, so the parser and the effect type it belongs to cross
 * the boundary instead.
 */
export { AGENT_PROMPT, parsePromptRecord } from "./src/agent/journal.ts";
export type { PromptRecord } from "./src/agent/journal.ts";

/**
 * `<Answers>` as detached configuration, for the host that installs it.
 *
 * A nested run's answers are declared in one document and answered in another,
 * so the matcher language and the provider that reads it are separated here:
 * `installAnswerProvider()` turns what a declaration parsed to back into this
 * scope's elicitation provider.
 */
export { installAnswerProvider } from "./src/answers.ts";
export type { AnswerConfiguration, AnswerMatcher } from "./src/answers.ts";

/**
 * Where a trusted harness follows its own declaration scan.
 *
 * A harness reading a construct's children in two passes decides which of them
 * are declarations. It cannot decide that from the definition alone: a
 * structural construct expands descendants without resolving a component, so
 * expansion reports where each list begins and ends and the harness counts.
 * Nothing authored reaches this — what a scanner records is data it reads back
 * from its own closure.
 */
export { DeclarationScan } from "./src/declaration-scan.ts";
export type { AnswersPlacement, DeclarationScanner } from "./src/declaration-scan.ts";
