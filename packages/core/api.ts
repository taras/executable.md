/**
 * @module
 *
 * The consumer API of `@executablemd/core`: the contextual APIs a Plugin
 * composes a run through, and the contracts it is written against.
 *
 * A Plugin depends on this package and imports from here. It is a separate
 * entrypoint from `.` — the engine's own surface, and large — and from
 * `./host`, the infrastructure boundary a distribution's own host assembles an
 * execution at. What a host declares with, and what a host admits an untyped
 * value through, stay there.
 *
 * ```ts
 * import { Document, Plugin } from "@executablemd/core/api";
 *
 * export default Plugin({
 *   name: "example",
 *   *install() {
 *     yield* Document.around({
 *       *document(_args, next) {
 *         return `# Example\n\n${yield* next()}`;
 *       },
 *     });
 *     return undefined;
 *   },
 * });
 * ```
 *
 * Selecting a Plugin is a decision to run its code: loading one runs its
 * module, and installing one runs its `install`. Selected Plugin code can
 * execute whatever the surrounding runtime permits, so nothing here is a
 * sandbox.
 */

export { Plugin } from "./src/plugin.ts";
export type { PluginInstallation, PluginInstallRequest } from "./src/plugin.ts";

export {
  ActivePlugins,
  activePlugins,
  Document,
  document,
  RootMetadata,
  rootMetadata,
} from "./src/plugin-apis.ts";
export type { ActivePluginsApi, DocumentApi, RootMetadataApi } from "./src/plugin-apis.ts";

/**
 * The Agent Api, and the contracts its operations are written in.
 *
 * A Plugin composes agent work the same way it composes a document: around
 * these operations, in the ordinary order. What it reaches here is
 * provider-neutral — exact choice IDs, normalized options, and the session a
 * provider issued — and never a protocol type belonging to whichever provider
 * happens to be installed.
 */
export { Agent } from "./src/agent/agent-api.ts";
export type {
  AgentApi,
  AgentOption,
  AgentOptions,
  AgentOptionSet,
  AgentOptionsRequest,
  AgentPromptEvent,
  PermissionMode,
  PermissionOption,
  PermissionOutcome,
  PermissionRequest,
  PromptOptions,
  Session,
  SessionConfiguration,
} from "./src/agent/agent-api.ts";
export type { AgentSessionRequest } from "./src/agent/session-request.ts";
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
 * reaches the provider — through the coordinator core delivers there. So a
 * handler may see what a use says and delegate it, and still cannot pair a
 * conversation with settings of its own.
 */
export {
  AgentSessionUseError,
  claimsConfiguration,
  configurationOf,
  isSessionUse,
  sessionOf,
} from "./src/agent/session-use.ts";
export type { AgentSessionUse } from "./src/agent/session-use.ts";
export type { AgentLaunchRequest } from "./src/agent/launch-request.ts";

/**
 * The types the accepted `PluginInstallation` members are written in.
 *
 * Types only. `Markdown({…})`, `sourceDigest` and `Structural({…})` construct
 * what a *host* declares to an execution, and they stay on `./host` with the
 * rest of that boundary: a Plugin is trusted code and imports them from there,
 * which is also where a reader looking for what may be declared will find them.
 */
export type { MarkdownComponent } from "./src/components/declared-markdown.ts";
export type {
  ExpansionChunk,
  ExpansionRegion,
  ExpansionRequest,
  Structural,
} from "./src/execution-declarations.ts";
export type { JournalAdmission } from "./src/execute.ts";
