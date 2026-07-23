/**
 * @module
 * Testing vocabulary for executable.md documents (specs/testing-spec.md).
 *
 * `<Testing>` activates testing mode for its expanded subtree, `<Test>`
 * defines an atomic test, and the assertion components map to `@std/assert`.
 *
 * Composition with core execution:
 *
 * ```ts
 * import { execute } from "@executablemd/core";
 * import { useTesting } from "@executablemd/testing";
 *
 * const tests = yield* useTesting();
 * const execution = yield* execute(options);
 * const outcome = yield* execution;          // Result<string>
 * const results = yield* tests.results;
 * ```
 *
 * Vocabulary registration (`installTestingVocabulary`) is distinct from
 * testing-mode activation (`useTesting()` at the root, or a `<Testing>`
 * element for a subtree).
 */

export { Test, testing, record, results, TestFailureError } from "./src/test-api.ts";
export type { TestApi, TestResult, BoundaryOutcome } from "./src/test-api.ts";
export { installTestingVocabulary } from "./src/vocabulary.ts";
export { useTesting } from "./src/use-testing.ts";
export type { Testing } from "./src/use-testing.ts";
