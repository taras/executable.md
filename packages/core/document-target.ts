/**
 * @module
 *
 * How an exact document target is spelled, for runtimes that cannot load a
 * Markdown parser.
 *
 * `isCanonicalDocumentTarget` is already public from the package root under
 * that fuller name. This subpath selects the spelling predicate without the
 * catalog and selector machinery behind it, and without the root barrel's host
 * surface. Same function, narrower resolution path.
 */

export { isCanonicalTarget as isCanonicalDocumentTarget } from "./src/document-target-spelling.ts";
