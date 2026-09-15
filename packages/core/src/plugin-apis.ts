/**
 * The three contextual APIs a Plugin composes a document through.
 *
 * Each is a value-returning Api: the terminal answers with what the execution
 * would use on its own, and a Plugin installs middleware that wraps that answer.
 * Composition therefore needs no registry, no ordering table and no winner —
 * the first Plugin installed is the outermost wrapper and the execution's own
 * answer is innermost.
 *
 * The keys are stable, namespaced and unbranded on purpose. A Plugin loaded
 * from a module that resolved its own copy of this package reads the same key
 * canonical execution published, so the two copies compose instead of silently
 * installing two independent stacks.
 *
 * The key is what identifies an Api across copies, so it carries the owning
 * package and the boundary rather than the public name alone: an unrelated
 * package that happens to build an Api called `Document` addresses a different
 * context and cannot intercept, replace or observe this one. The public names
 * stay `Document`, `RootMetadata` and `ActivePlugins` — the spelling a consumer
 * writes is not the spelling two copies have to agree on.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

import type { Plugin } from "./plugin.ts";

/** The key canonical core publishes the document envelope under. */
const DOCUMENT_KEY = "executablemd.core.plugin.document";

/** The key canonical core publishes the root's composed metadata under. */
const ROOT_METADATA_KEY = "executablemd.core.plugin.root-metadata";

/** The key canonical core publishes the active Plugin list under. */
const ACTIVE_PLUGINS_KEY = "executablemd.core.plugin.active-plugins";

/**
 * The exact text the document terminal answers with.
 *
 * Written the way an author writes a self-closing element, because that is what
 * a wrapper composes around: a Plugin that returns this unchanged has wrapped
 * nothing, and the execution runs the original root directly.
 */
export const DOCUMENT_PLACEHOLDER = "<Document />";

/**
 * The document one execution runs, as Markdown a Plugin may wrap.
 *
 * The terminal answers with `"<Document />"` — the placeholder canonical
 * execution projects the already parsed and targeted root into. Middleware
 * returns Markdown containing that placeholder wherever the original document
 * belongs, and may contain it more than once: each occurrence is its own
 * wrapper occurrence, projecting the same root under its own expansion
 * identity.
 *
 * It is an operation rather than a value, because deciding what to wrap a
 * document in is work. A Plugin composing one may read its configuration, ask
 * the filesystem where it is standing, or consult anything else an operation
 * can reach, and it delegates with `yield* next()`:
 *
 * ```ts
 * yield* Document.around({
 *   *document(args, next) {
 *     if (yield* inRepo()) {
 *       return `<Repository><Worktree>${yield* next()}</Worktree></Repository>`;
 *     }
 *     return yield* next();
 *   },
 * });
 * ```
 *
 * An authored `<Document />` is an ordinary element and resolves as one. Only
 * the placeholders canonical execution mints from this answer project anything.
 */
export interface DocumentApi {
  document(): Operation<string>;
}

export const Document: Api<DocumentApi> = createApi<DocumentApi>(DOCUMENT_KEY, {
  // deno-lint-ignore require-yield
  *document(): Operation<string> {
    return DOCUMENT_PLACEHOLDER;
  },
});

/**
 * The composed document envelope.
 *
 * Read once per execution, before the body runs. A middleware that answered
 * with something other than text fails here, where the wrapper was asked for,
 * rather than part-way through scanning it.
 */
export const document: Operation<string> = {
  *[Symbol.iterator]() {
    const composed = yield* Document.operations.document();
    if (typeof composed !== "string") {
      throw new Error(`Document middleware answers with Markdown text, got ${typeof composed}`);
    }
    return composed;
  },
};

/**
 * The root document's ordinary metadata, as a Plugin may extend it.
 *
 * The terminal is the root's own `meta` record. Middleware composes around it
 * and answers with the record the run reads for `{meta.key}` interpolation and
 * for `<If test={meta.x}>`. It changes that record and nothing else: props,
 * `required`, `returns`, target selection and the metadata of every imported
 * component are outside it.
 */
export interface RootMetadataApi {
  readonly metadata: Readonly<Record<string, unknown>>;
}

export const RootMetadata: Api<RootMetadataApi> = createApi<RootMetadataApi>(ROOT_METADATA_KEY, {
  metadata: {},
});

/**
 * The composed root metadata, detached and frozen.
 *
 * Detached because a middleware that answered with the record it was handed
 * would otherwise keep a live reference into the running document's metadata;
 * frozen because the execution reads it from then on and nothing may rewrite
 * what it already read.
 */
export const rootMetadata: Operation<Readonly<Record<string, unknown>>> = {
  *[Symbol.iterator]() {
    const composed = yield* RootMetadata.operations.metadata;
    if (typeof composed !== "object" || composed === null || Array.isArray(composed)) {
      throw new Error("RootMetadata middleware answers with a metadata record");
    }
    return Object.freeze({ ...composed });
  },
};

/**
 * The Plugins active for this command, in the order they were installed.
 *
 * The complete list, installed before the first `install()` runs, so every
 * Plugin and every later consumer reads the same one. An execution nobody
 * installed Plugins for reads the empty list rather than failing: the API is
 * how a Plugin asks what it is running beside, not a claim that any exist.
 */
export interface ActivePluginsApi {
  readonly plugins: readonly Plugin[];
}

export const ActivePlugins: Api<ActivePluginsApi> = createApi<ActivePluginsApi>(
  ACTIVE_PLUGINS_KEY,
  { plugins: Object.freeze([]) },
);

/** The active Plugin list, as an immutable ordered snapshot. */
export const activePlugins: Operation<readonly Plugin[]> = {
  *[Symbol.iterator]() {
    const composed = yield* ActivePlugins.operations.plugins;
    if (!Array.isArray(composed)) {
      throw new Error("ActivePlugins middleware answers with a list of Plugin values");
    }
    return Object.freeze([...composed]);
  },
};
