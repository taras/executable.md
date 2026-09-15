/**
 * @module
 *
 * The consumer API of `@executablemd/core`: the contextual APIs a Plugin
 * composes a run through, and the values it hands the host.
 *
 * A Plugin depends on this package and imports from here. It is a separate
 * entrypoint from `.` — which is the engine's own surface, and large — and from
 * `./host`, which is the infrastructure boundary a distribution's own host
 * assembles an execution at.
 *
 * ```ts
 * import { Plugin, Document } from "@executablemd/core/api";
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
 * A selected Plugin is trusted executable code. Loading one runs its module's
 * top level, and installing one runs its `install` with this process's own
 * authority. Nothing here is a sandbox.
 */

export { Plugin, parsePluginValue } from "./src/plugin.ts";
export type { PluginInstallation, PluginInstallRequest } from "./src/plugin.ts";

export {
  ActivePlugins,
  activePlugins,
  Document,
  document,
  DOCUMENT_PLACEHOLDER,
  RootMetadata,
  rootMetadata,
} from "./src/plugin-apis.ts";
export type { ActivePluginsApi, DocumentApi, RootMetadataApi } from "./src/plugin-apis.ts";

/**
 * The declarations a `PluginInstallation` carries, and what builds one.
 *
 * `Markdown({…})` and `sourceDigest` are re-exported from the host boundary
 * because a Plugin is exactly the trusted code that declares exact Markdown: a
 * value it cannot construct is a member it cannot fill in.
 */
export { Markdown, sourceDigest } from "./src/components/declared-markdown.ts";
export type {
  MarkdownComponent,
  MarkdownComponentInput,
} from "./src/components/declared-markdown.ts";
export { Structural } from "./src/execution-declarations.ts";
export type {
  ExpansionChunk,
  ExpansionRegion,
  ExpansionRequest,
  StructuralInput,
} from "./src/execution-declarations.ts";
export type { JournalAdmission } from "./src/execute.ts";
