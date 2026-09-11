/**
 * @module
 *
 * How a document spells a component name, for runtimes that cannot load the
 * engine.
 *
 * `isComponentName` is already public from the package root. This subpath
 * selects it without the root barrel, which reaches `node:crypto`,
 * `node:process` and the rest of the host surface. Same function, narrower
 * resolution path.
 */

export { isComponentName } from "./src/component-name.ts";
