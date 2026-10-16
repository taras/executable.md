/**
 * @module
 *
 * The infrastructure boundary of document execution.
 *
 * An installation carries the two things only a host may contribute, and both
 * are acts of infrastructure rather than of authoring:
 *
 * - **Admissions** constrain a saved history *before* it is replayed from.
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
 * A third act of infrastructure sits beside them, and it is not on this module
 * at all. **Generated XMD** is source an Agent produced, and what a host
 * contributes to running it is one selection of component names and authored
 * forms, composed through the ordinary `Component.generated` property on
 * `@executablemd/core/api`. Core reads that selection once before public
 * execution policy, resolves each selected name through the ordinary import
 * chain, and derives the identity, the effect and the contract of every
 * selected spelling from the declaration that owns the implementation. The
 * complete fragment is then preflighted before its first effect, and what was
 * admitted is recorded as one ordinary durable event before the first generated
 * effect — inside the owning authored expansion of the public `<Evaluate>`
 * element, so the admission and every effect belong to that expansion's own
 * durable sequence.
 *
 * Both stop at the first refusal, and a refusal stops only what has not
 * happened yet: durable effects an earlier preparation completed stay
 * saved and are not rolled back, and the durable root records the refusal as
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
/**
 * `ExecutionInitialization` is the fourth, and it is input rather than
 * infrastructure: the root JSON bindings one execution starts with, supplied
 * beside the root source by whoever already holds them.
 *
 * It is exported here and nowhere else. `execute()` does not take it, no
 * authoring export names it, and no installation carries it — a document that
 * could name what a previous execution saved could ask for it, and the only
 * host with a predecessor to inherit from is the one that kept the journal.
 */
export type {
  ExecutionInitialization,
  ExecutionInstallation,
  JournalAdmission,
} from "./src/execute.ts";
/**
 * How a trusted host supplies the implementation behind a selected name.
 *
 * An installer, not a definition: canonical execution runs it before the
 * generated selection is captured and hands it a registrar fixed to this
 * installation's origin. The registrar composes import middleware, and every
 * invocation of that middleware receives its own request — fixed to the name
 * and position it was asked, and closed when that invocation ends — which is
 * the only thing that states what the provider is returning. Canonical
 * execution then decides whether that is an implementation it may retain, and
 * resolves the name itself through the ordinary import chain.
 */
export type {
  ComponentAnswerHandler,
  ComponentAnswerInstallation,
  ComponentAnswerRegistrar,
  ComponentAnswerRequest,
} from "./src/component-answers.ts";
/**
 * The response shape a saved request answers with, and the detaching a host
 * needs to read one.
 *
 * The record an authored `<Fetch>` retains, through the same code, so a
 * fragment's observation and a document's are the same shape and a continuation
 * restores either.
 */
export type { FetchResponseRecord } from "./src/fetch-response.ts";
export { detachHeaders, detachStatus } from "./src/fetch-response.ts";
/**
 * Why canonical execution could not capture a host's generated selection.
 *
 * The selection itself is stated through `Component.generated`, which is an
 * ordinary contextual property on the consumer surface rather than a host
 * input: a host composes middleware that answers with the names and forms it
 * offers, and core derives everything else from the declarations that own those
 * implementations. What stays here is the refusal a host is held to.
 */
export { EvaluationProfileError } from "./src/evaluation-profile.ts";
export { GeneratedSelectionError } from "./src/generated-selection.ts";
/**
 * Whether a failure is core refusing the generated request itself — see
 * `src/generated-request-refusal.ts`.
 *
 * One fact, and nothing beyond it. Core states that the request's own text was
 * refused: a construct it may not write, a form or prop written wrongly, a name
 * that is not available here, an ordinary captured read reporting `Err`. It
 * says nothing about whether that is correctable, whether a host may ask again,
 * or whether another turn should happen. Those are the caller's decisions, and
 * a host that reads this answer is the one making them.
 *
 * A reader, and deliberately not a marker: a host asks what core refused and
 * cannot state a refusal itself. Everything core did not refuse this way answers
 * `undefined` — stale history, a revoked profile, a provider that threw, a
 * secret rejection, a teardown failure — so an answer here is never one of those
 * wearing the same shape.
 */
export { generatedRequestRefusal } from "./src/generated-request-refusal.ts";
/**
 * Whether an Agent answered with a Plan draft or a read-only information
 * request — see `src/plan-response.ts`.
 *
 * A pure function over text, deciding nothing. It is core's because the
 * rule has to agree with core about where a Markdown body begins and what a
 * heading is; a classifier that disagreed would send a draft to evaluation.
 */
export { classifyPlanResponse } from "./src/plan-response.ts";
export type { PlanResponseKind } from "./src/plan-response.ts";
export type { DurablePreparation } from "./src/document-request.ts";

/**
 * What a trusted host declares to an execution when one of its components
 * names durable work after its own invocation — see
 * `src/invocation-identity.ts`. The identity authenticator is delivered to the
 * factory and published nowhere.
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
/**
 * What a recorded elicitation retains beside its answer, for a host that reads
 * history back.
 *
 * The field name and the reader travel together so that a host displaying an
 * answered question reads the same shape core wrote, and reads it by parsing:
 * the description is journal data, and a schema that merely looked plausible
 * would reach a form as one.
 */
export { ELICITATION_SCHEMA_FIELD, readElicitationSchema } from "./src/elicit-journal.ts";
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
 *
 * A declaration states which kind it is, and `Markdown({…})` is how this
 * repository states it: a host describes its asset, and the constructor writes
 * the discriminant after the description, so an input carrying a `kind` of its
 * own does not decide what the declaration is. `MarkdownComponentInput` is what
 * a host writes and `MarkdownComponent` is what comes back.
 */
/**
 * Reading an untyped module export as a Plugin — see `src/plugin.ts`.
 *
 * Admission rather than construction, and a host boundary for the same reason
 * the rest of this module is one: a distribution decides what it is willing to
 * install, and what comes back on success is the admitted value itself rather
 * than a copy, so a Plugin keeps every member it carries and `install` keeps
 * the receiver its own module gave it. `Plugin({…})` is the consumer-facing
 * constructor and stays on `./api`.
 */
export { parsePluginValue } from "./src/plugin.ts";

export {
  DeclaredMarkdownError,
  Markdown,
  sourceDigest,
} from "./src/components/declared-markdown.ts";
export type {
  MarkdownComponent,
  MarkdownComponentInput,
} from "./src/components/declared-markdown.ts";

/**
 * Structural syntax a trusted host declares to an execution — see
 * `src/execution-declarations.ts`.
 *
 * The seventh act of infrastructure, and the same shape as the rest: plain
 * immutable data the host holds and passes, beside the handler that expands it.
 * A declaration states a construct and the regions written directly inside it;
 * the installation that declares them supplies the one `expand` captured with
 * them. Both arms cross on one `declarations` list, so what a name means here
 * is decided by one catalog rather than by two that can disagree.
 *
 * The expansion types are exported because a host types its own handler with
 * them. `ExpansionRegion.expand()` is the capability a handler is given over
 * the regions written inside its own construct — everything else a request
 * carries is an authored fact about where the occurrence was written.
 */
// `Structural` is the interface and the constructor that builds one, so the one
// export carries both — a host writes `Structural({…})` and types with the same
// name.
export { ExecutionDeclarationError, Structural } from "./src/execution-declarations.ts";
/**
 * Which half of one installation's structural pair is missing — see
 * `src/execution-declarations.ts`.
 *
 * Exported because a host that assembles installations of its own — from
 * Plugins, say — must hold each one to the same rule this boundary holds an
 * execution to, and *before* the assembly reaches anything that describes or
 * validates the vocabulary. Two copies of that rule would be two rules, and the
 * one that ran earlier would be the one nobody tested.
 */
export { incompleteStructural } from "./src/execution-declarations.ts";
export type { IncompleteStructural } from "./src/execution-declarations.ts";
export type {
  ExecutionDeclaration,
  ExpansionChunk,
  ExpansionRegion,
  ExpansionRequest,
  StructuralInput,
} from "./src/execution-declarations.ts";

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
export { GeneratedXmdError } from "./src/generated-xmd.ts";

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
  AgentPromptHandle,
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
 * The durable Agent Prompt record, for a host that reads a saved journal.
 *
 * A sealed workflow artifact classifies each Agent session by what its saved
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

/**
 * Where a trusted host states the description its profile shows.
 *
 * A setup operation rather than a value on the installation, because what it
 * binds is two things: the lazy source, and the documentation contributions
 * that are in scope where it is called. `xmd plan` needs both — a Plan is a
 * program a later `xmd run` executes, so the vocabulary the agent must be shown
 * is that profile's, and so is the long-form prose a named lookup renders.
 *
 * It reads nothing when called and installs ordinary providers, so nearer
 * middleware still answers, delegates or transforms. Stating a description
 * confers no execution authority.
 */
export { useSyntax } from "./src/use-syntax.ts";
