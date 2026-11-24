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
export { ComponentModuleLoader } from "./src/component-module-loader.ts";
export type {
  PluginCommandOptions,
  PluginInstallation,
  PluginInstallRequest,
} from "./src/plugin.ts";

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

/**
 * The contextual Api a consumer installs middleware on, and the types one
 * `Component.expand` handler is written in.
 *
 * Exported here rather than from the root because this is the consumer-facing
 * boundary: a host that wants to watch an element expand needs the descriptor
 * and the shapes it will be handed, and nothing of the engine behind them.
 */
export { Component } from "./src/component-api.ts";
export type {
  ComponentApi,
  ComponentExpansionPhase,
  ComponentExpansionRequest,
  GeneratedSelection,
} from "./src/component-api.ts";
export type { Expansion } from "./src/expansion.ts";

/**
 * The execution a host composes around, and the requests its layers are handed.
 *
 * Three seams. `init` is the one a command host installs on: it establishes
 * the live dependencies this execution runs on, once, inside the scope the
 * invocation already owns. `execute` is the request-policy seam and `document`
 * wraps the whole expansion; both of those defaults refuse, because only
 * canonical core completes a document.
 */
export { Execution } from "./src/execute.ts";
export type { ExecutionApi } from "./src/execute.ts";
export type { ExecutionRequest } from "./src/execution-request.ts";
export type { DocumentRequest } from "./src/document-request.ts";

/**
 * The description in effect, as the thing a consumer composes on.
 *
 * The same descriptor the root exports, reachable from here as well because a
 * consumer installing middleware imports from `./api`. What the three
 * properties answer, and what composing on them does and does not change, is
 * in `src/syntax-api.ts`; `./host`'s `useSyntax` is how a host supplies one.
 */
export { Syntax } from "./src/syntax-api.ts";
export type { SyntaxApi } from "./src/syntax-api.ts";
export type { SyntaxSymbols } from "./src/inspect.ts";
