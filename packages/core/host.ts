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
/**
 * `ExecutionInitialization` is the fourth, and it is input rather than
 * infrastructure: the root JSON bindings one execution starts with, supplied
 * beside the root source by whoever already holds them.
 *
 * It is exported here and nowhere else. `execute()` does not take it, no
 * authoring export names it, and no installation carries it — a document that
 * could name what a previous execution retained could ask for it, and the only
 * host with a predecessor to inherit from is the one that kept the journal.
 */
export type {
  ExecutionInitialization,
  ExecutionInstallation,
  JournalAdmission,
} from "./src/execute.ts";
/**
 * What a trusted host states about generated-fragment evaluation.
 *
 * Only the input a host writes, and only here, because this is the trusted
 * surface `ExecutionInstallation` already lives on. What canonical execution
 * captures from it — the bound operations and their revocation — is unexported:
 * ordinary core publishes no getter for the active permissions and no way to install
 * a provider.
 */
export type {
  CapabilityEntry,
  ComponentAnswerEntry,
  FragmentEntry,
  FragmentEvaluationInput,
  FragmentForm,
  FragmentIdentity,
  FragmentWorkspaceAccess,
} from "./src/evaluation-profile.ts";
/**
 * How a trusted host supplies the implementation behind a `component-answer`
 * entry.
 *
 * An installer, not a definition: canonical execution runs it during profile
 * capture and hands it a registrar fixed to this installation's origin. The
 * registrar composes import middleware, and every invocation of that middleware
 * receives its own request — fixed to the name and position it was asked, and
 * closed when that invocation ends — which is the only thing that states what
 * the provider is returning. Canonical execution then decides whether that is
 * what the profile admitted, and resolves the name itself through the ordinary
 * import chain.
 */
export type {
  ComponentAnswerHandler,
  ComponentAnswerInstallation,
  ComponentAnswerRegistrar,
  ComponentAnswerRequest,
} from "./src/component-answers.ts";
/**
 * The private operations an admitted fragment performs, and the only ones it
 * can reach.
 *
 * A host hands its own provider methods here; canonical capture reads each one
 * off once and closes core's own fragment bodies over the bound result. There
 * is no ordinary-core export for these, no getter for a live one, and no way to
 * install one from a document — see `src/fragment-capabilities.ts`.
 */
export type {
  FragmentCapability,
  FragmentFetchAccess,
  FragmentFileAccess,
  FragmentPath,
  FragmentSearch,
  FragmentWrite,
} from "./src/fragment-capabilities.ts";
/**
 * The response shape a fragment transport answers with, and the detaching a
 * host needs to build one.
 *
 * The same record an authored `<Fetch>` retains, through the same code, so a
 * fragment's observation and a document's are the same shape and a continuation
 * restores either.
 */
export type { FetchResponseRecord } from "./src/fetch-response.ts";
export { detachHeaders, detachStatus } from "./src/fetch-response.ts";
/**
 * Core's own entries, for the hosts that admit them.
 *
 * Constructors rather than a table a host assembles from `CORE_REGISTRY`,
 * because each of them states a constraint the registry does not hold: which
 * spelling of `<File>` is being admitted, that admitting `<Fetch>` requires the
 * exact requests it may perform, and that `<Syntax />` is admitted as the
 * answer canonical resolution gives for it rather than as a body core supplies
 * a second time.
 */
export {
  directoryEntry,
  EvaluationProfileError,
  fetchEntry,
  fileDeleteEntry,
  fileReadEntry,
  fileWriteEntry,
  elicitWriteEntry,
  globReadEntry,
  syntaxReadEntry,
} from "./src/evaluation-profile.ts";
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
/**
 * The symbols a host's profile describes, when they are not the ones the
 * execution would derive from its own captured inputs — see
 * `src/syntax-reference.ts`.
 */
export type { SyntaxSymbolsProvider } from "./src/syntax-reference.ts";
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
/**
 * Evaluating generated source as a **root** rather than as a fragment — see
 * `src/generated-xmd.ts`.
 *
 * The same admission, the same durable record and the same pinned resolution,
 * in the one context that supplies `<Output>`: a root selects what it renders,
 * and the host is told whether it selected anything so an empty region and no
 * region at all are different answers. `<Content>` and `<Return>` stay
 * unavailable in both — neither has a caller to claim content from nor a value
 * body to answer.
 *
 * Which context an admission was made in is one of its ceilings, so a retained
 * root admission does not resume as a fragment or the reverse. Existing
 * `evaluateGeneratedXmd()` callers and every fragment record already written
 * keep exactly the behavior they had.
 *
 * It answers with a `Result` because the two kinds of failure are different
 * things for a host to be holding. An ordinary one — source core refused, or
 * work the root's own elements failed at — is the request's, and comes back as
 * `Err` carrying what the root had rendered when it failed. A failure of the
 * *run* does not: a journal that stopped describing it, a Files provider that
 * is not there, a teardown that failed, each keep the classification they
 * already have and leave this operation as themselves.
 */
export {
  evaluateGeneratedXmd,
  evaluateGeneratedXmdRoot,
  GeneratedXmdError,
  GeneratedXmdRootError,
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
  GeneratedRequest,
  GeneratedXmdRequest,
  GeneratedXmdRootResult,
  RetainedFragmentIdentity,
} from "./src/generated-xmd.ts";

/**
 * What an arriving generated root already says — see
 * `src/generated-xmd-preview.ts`.
 *
 * A host streaming a reply holds a prefix rather than a document, and showing
 * the person what it says is a different question from deciding whether it may
 * run. This answers the first and nothing else: a pure projection over the
 * accumulated prefix, with no `Operation`, because it reads no file, resolves
 * no name, invokes no component, evaluates no expression and grants no
 * admission. A prefix that projects cleanly has been granted nothing, and the
 * provider's own completion and `evaluateGeneratedXmdRoot()` remain the only
 * things that decide a root runs.
 *
 * It is core's because the alternative is a second reading of one syntax. A
 * host recognizing `<Output>` with a regular expression would have to re-decide
 * what a fence, a quoted `>`, an inline code span and a tag-like expression
 * are, and the two readings would disagree the first time one of them was
 * wrong.
 *
 * `incomplete` says the prefix ends in syntax still arriving, which is a
 * success rather than a refusal; invalid source — a region the language does
 * not allow where it is written — answers `Err`. The two are deliberately
 * distinct, and `incomplete: false` says only that this prefix is whole, never
 * that the provider has finished or that anything may execute.
 */
export { GeneratedXmdPreviewError, previewGeneratedXmdRoot } from "./src/generated-xmd-preview.ts";
export type { GeneratedXmdRootPreview } from "./src/generated-xmd-preview.ts";

/**
 * One retained agent conversation a trusted host holds open — see
 * `src/agent/conversation.ts`.
 *
 * The eighth act of infrastructure, and the longest-lived. A document's
 * `<Session>` and `<Prompt>` are written where the conversation belongs: inside
 * an expansion, with an element to name the placement and a journal already
 * around them. A host discussing something with an agent has neither, and still
 * needs the genuine thing — canonical placement, journaled turns, verified
 * configuration, and an identity the provider reattaches to tomorrow. So the
 * conversation is an execution the host keeps open, over the history stream it
 * supplies, under the installations it captured through `executeInstalled`.
 *
 * Kept here for the reason the rest of this module is: a conversation decides
 * what a journal holds and which provider it reaches, and nothing a document, a
 * component or a middleware package reaches by importing `@executablemd/core`
 * can open one.
 *
 * The handle is provided by a resource owned by the caller's scope. Holding it
 * past that scope reaches nothing, because the conversation it addressed was
 * cancelled — which is also why it can be reopened: a root that recorded its
 * terminal would replay instead.
 */
export { AgentConversationError, useAgentConversation } from "./src/agent/conversation.ts";
export type { AgentConversation, AgentConversationRequest } from "./src/agent/conversation.ts";

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
