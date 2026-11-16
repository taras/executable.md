/**
 * @module
 *
 * The consumer API of `@executablemd/agent`: the contextual Agent operations a
 * Plugin composes around, the operations a provider and an author's own code
 * reach, and the contracts they are written in.
 *
 * ```ts
 * import { Agent } from "@executablemd/agent/api";
 * import { Plugin } from "@executablemd/core/api";
 *
 * export default Plugin({
 *   name: "example",
 *   *install() {
 *     yield* Agent.around({
 *       *prompt([content, options], next) {
 *         return yield* next(`Be brief.\n\n${content}`, options);
 *       },
 *     });
 *     return undefined;
 *   },
 * });
 * ```
 *
 * `Plugin`, `Execution` and the rest of the generic execution surface stay in
 * `@executablemd/core/api`. What a host installs — the Agent vocabulary, a
 * provider for a region it projects, held conversations and the readers of
 * retained Prompts — is in `@executablemd/agent/host`.
 */

/**
 * The Agent Api, and the contracts its operations are written in.
 *
 * A Plugin composes agent work the same way it composes a document: around
 * these operations, in the ordinary order. What it reaches here is
 * provider-neutral — exact choice IDs, normalized options, and the session a
 * provider issued — and never a protocol type belonging to whichever provider
 * happens to be installed.
 */
export { Agent } from "./src/agent-api.ts";
// The one deny decision, so a host writing its own permission policy reaches
// the same rule the base handler and every built-in policy reach rather than
// spelling "reject_once, then reject_always, otherwise cancel" again.
export { denyPermission } from "./src/agent-api.ts";
export type {
  AgentApi,
  AgentOption,
  AgentOptions,
  AgentOptionSet,
  AgentOptionsRequest,
  AgentPromptEvent,
  PromptImage,
  LaunchOptions,
  PermissionMode,
  PermissionOption,
  PermissionOutcome,
  PermissionRequest,
  PromptOptions,
  Session,
  SessionIdentity,
  SessionConfiguration,
  SessionLaunchResult,
} from "./src/agent-api.ts";
export { AgentPromptError } from "./src/errors.ts";
/**
 * The opaque session request a `<Session>` element routes. A handler reads its
 * descriptive name; only the delivered launch coordinator reads the engine identity.
 */
export { AgentSessionProtocolError, isSessionRequest } from "./src/session-request.ts";
export type { AgentSessionRequest } from "./src/session-request.ts";
/**
 * The provider a retained conversation does its work through.
 *
 * Here, beside `Agent`, because it is the other half of the same boundary: a
 * host that serves saved conversations installs this object in its provider's
 * own scope, and the conversation reads it once in its own. Ordinary `<Session>`
 * and `<Prompt>` keep composing through `Agent`, which is what middleware is
 * for; a chat does not, because what holds it to the configuration it was
 * created under cannot be something a handler may route around.
 *
 * A held turn is captured here and reached through this object's own receiver.
 * Its content and cold stream are composed by ordinary outer `Agent.prompt`
 * middleware above a turn-local terminal bound to this provider, the selected
 * agent and the exact checked Session — so composition changes the text and the
 * stream, never which provider answers. What this provider receives is the text
 * the journal retains; a composition that changed the checked call is refused
 * before any native work, and nothing routes through ordinary provider handlers
 * as a fallback. Subscription-owned cleanup belongs to that conversation's turn.
 *
 * One name for the interface and the Context, as `Agent` already has.
 */
export { AgentConversationProvider } from "./src/conversation-provider.ts";
/**
 * One authentic use of a conversation, and what a reader may ask about one.
 *
 * A use is a `Session`, so nothing composing around these operations has to
 * know about it. `claimsConfiguration()` answers for any value; `isSessionUse()`,
 * `sessionOf()` and `configurationOf()` answer for a value this build issued,
 * and refuse a rebuilt, copied or foreign one rather than reading it as an
 * ordinary session.
 *
 * Reading is not acting. Which installation a use belongs to, and whether it is
 * the one this operation was authored with, are settled where the operation
 * reaches the provider — through the coordinator this package delivers there.
 * So a handler may see what a use says and delegate it, and still cannot pair a
 * conversation with settings of its own.
 *
 * Issuing one is `useConfiguredSession()`, which is the only way one comes into
 * being.
 */
export {
  AgentSessionUseError,
  claimsConfiguration,
  configurationOf,
  isSessionUse,
  sessionOf,
} from "./src/session-use.ts";
export type { AgentSessionUse } from "./src/session-use.ts";
export { useConfiguredSession } from "./src/launch-install.ts";
// Native session launch — the records one launch retains, and the request its
// public route carries. What runs and retains a phase is not here
// and is not anywhere: it is delivered to the selected provider.
export { AgentLaunchError, sameExecutableBuild } from "./src/launch.ts";
export type {
  DetachedLaunchRecord,
  ExecutableBuildBindingV1,
  ExitedLaunchRecord,
  IdentityProvenance,
  InstructionReconciliation,
  LaunchFailure,
  LaunchFailureClass,
  LaunchPhase,
  LaunchRecord,
  MaterializationPlan,
  MaterializationUsage,
  MaterializedLaunchRecord,
  PreparedLaunchRecord,
} from "./src/launch.ts";
export { AgentLaunchProtocolError } from "./src/launch-request.ts";
export type { AgentLaunchRequest } from "./src/launch-request.ts";
export type { AgentLaunchPhases, AgentLaunchCoordinator } from "./src/launch-coordinator.ts";
export { launchAgentSession } from "./src/launch-install.ts";
// What a provider reports through the coordinator's optional usage receiver,
// and what a canonical Prompt record retains of it.
export type {
  PromptUsage,
  PromptUsageReporter,
  ReportedTokens,
  UsageBuild,
  UsageCoverage,
  UsageProvenance,
  UsageReading,
} from "./src/usage.ts";
// What settles one session setup. A provider receives the handle through the
// coordinator delivered to its factory; the types are here so it can name them.
export type {
  AgentSessionSetup,
  AgentSessionSetupState,
  ConfigureAgentSession,
  ProviderSessionConfiguration,
} from "./src/session-setup.ts";
// The checkpoint type, because the coordinator's signature names it. The carrier
// itself is exported from nowhere: writing one is reachable only through a
// delivered coordinator, and reading one only from the prompt this package is
// running.
export { AgentPromptCheckpointError } from "./src/checkpoint.ts";
export type { AgentPromptCheckpoint } from "./src/checkpoint.ts";
// `installAgentProvider` is deliberately absent: it takes a launch coordinator,
// and a coordinator reachable by import is one every package and every loaded
// copy can reach. A host installs a registered provider through
// `useProviderInstallation()` from `./host`, which mints one and delivers it
// privately to the factory through this invocation's terminal.
export { AgentProviders, registerAgentProvider } from "./src/provider-api.ts";
export type {
  AgentProviderApi,
  AgentProviderFactory,
  AgentProviderOptions,
} from "./src/provider-api.ts";
