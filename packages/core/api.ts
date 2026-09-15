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
 *       document: (_args, next) => `# Example\n\n${next()}`,
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
