/**
 * @module
 *
 * The host boundary of `@executablemd/agent`: what a distribution's own host
 * installs to give an execution the Agent vocabulary, and what it reads back
 * from a retained journal.
 *
 * ```ts
 * import { installAgentComponents } from "@executablemd/agent/host";
 *
 * // In the host's own setup, in the scope its execution runs in:
 * yield* installAgentComponents({ defaultAgent: "claude" });
 * ```
 *
 * Core by itself contributes no Agent registrations. A host that installs this
 * package's components gets `<AgentProvider>`, `<Agent>`, `<Session>`,
 * `<Session.Launch>`, `<Prompt>`, `<ApproveAll>` and `<AskPermission>` under
 * the same component origin, documentation owner and durable identities core
 * used before the package existed, so retained journals and authored documents
 * read the same.
 *
 * Kept apart from `./api` for the reason core keeps its own `./host`: nothing a
 * document, a component or a middleware package reaches by importing the
 * consumer API can install a provider for a region it did not author or decide
 * where a prompt is journaled.
 */

// Agent components — <Agent>/<Session>/<Prompt> over a provider-factory seam.
export {
  AGENT_REGISTRATIONS,
  agentDocumentation,
  agentIdentityComponents,
  installAgentComponents,
  useAgentComponents,
} from "./src/components.ts";
export type { AgentComponentsOptions } from "./src/components.ts";
export {
  installApproveAll,
  installApproveReads,
  installAskPermission,
  installPermissionMode,
  installPromptFailurePolicy,
} from "./src/permission.ts";

/**
 * Installing a registered provider.
 *
 * `useProviderInstallation()` mints a launch coordinator and delivers it
 * privately to the provider factory through this invocation's terminal.
 */
export { useProviderInstallation } from "./src/launch-install.ts";

/**
 * Installing one Agent provider for the invocation that projects the content it
 * covers.
 *
 * The narrowest act of infrastructure: a trusted host component that
 * establishes a constrained ceiling around content it projects installs the
 * provider *in* that invocation, exactly as `<AgentProvider>` does, because a
 * provider installed in a frame nested inside it would be invisible to the very
 * content it was selected for.
 */
export { installInvocationAgentProvider } from "./src/launch-install.ts";

/**
 * One retained agent conversation, run over a held execution.
 *
 * A root is evaluated by the execution that captured the selection it runs
 * under, through `HostExecution.evaluateGeneratedXmdRoot` or the same method on
 * an `AgentConversation`.
 */
export {
  AgentConversationError,
  AgentReplyWithheldError,
  useAgentConversation,
} from "./src/conversation.ts";
export type { AgentConversation, AgentConversationRequest } from "./src/conversation.ts";

/**
 * Where a completed Prompt publishes, for a host that retains something beside
 * it.
 *
 * A value the host holds and passes. An ordinary run installs none and
 * publishes exactly as it always did. A host that installs one moves the
 * `agent_prompt` append inside the transaction it opened, so what it keeps
 * beside that event commits with the event or not at all.
 */
export { useAgentPromptPublisher } from "./src/publication.ts";
export type {
  AgentPromptAssociation,
  AgentPromptHandle,
  AgentPromptObservation,
  AgentPromptPublication,
  AgentPromptPublisher,
} from "./src/publication.ts";

/**
 * The durable Agent Prompt record, for a host that reads a retained journal.
 *
 * A sealed workflow artifact classifies each Agent session by what its retained
 * Prompts say, and the only thing that can answer that is the parser the live
 * run already records through. A second reading of the same durable value would
 * be a second contract, so the parser and the effect type it belongs to cross
 * the boundary instead.
 */
export { AGENT_PROMPT, parsePromptRecord } from "./src/journal.ts";
export type { PromptRecord } from "./src/journal.ts";
export { readPromptDiagnostic } from "./src/errors.ts";
