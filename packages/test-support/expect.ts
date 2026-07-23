/**
 * Cross-platform expect re-export.
 *
 * Bun overrides the bare "expect" module with its own built-in
 * which doesn't export `expect` as a named export. This module
 * provides a unified expect that works on all runtimes:
 * - Bun: re-exports from bun:test
 * - Node/Deno: re-exports from npm expect package
 */

// deno-lint-ignore no-explicit-any
const g = globalThis as any;

let _expect: typeof import("expect").expect;

if (typeof g.Bun !== "undefined") {
  // @ts-ignore: Bun-only module
  const bunTest = await import("bun:test");
  _expect = bunTest.expect;
} else {
  const mod = await import("expect");
  _expect = mod.expect;
}

export const expect = _expect;
