/**
 * @module
 *
 * Canonical JSON ordering, for runtimes that cannot load a Node builtin.
 *
 * `canonicalize` is already public from the package root. This subpath exists
 * so a consumer can select it without loading the root barrel, which reaches
 * `node:crypto`, `node:process` and the rest of the host surface — a Cloudflare
 * Worker resolving that graph fails to typecheck, and the operation it needs is
 * pure. Same function, same behavior, narrower resolution path.
 */

export { canonicalize } from "./src/canonicalize.ts";
