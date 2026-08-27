/**
 * A repository TypeScript component that cannot survive being imported.
 *
 * `xmd syntax` reports it by origin alone, so this module's top level never
 * runs — and if a change ever made inspection import a repository module, this
 * is what would make that visible instead of merely slow.
 */
throw new Error("Opaque.ts was imported, and syntax inspection must never import one");
