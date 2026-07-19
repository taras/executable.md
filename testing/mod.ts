/**
 * @module
 * Testing vocabulary for executable.md documents (specs/testing-spec.md).
 *
 * `<Testing>` activates testing mode for its expanded subtree, `<Test>`
 * defines an atomic test, and the assertion components map to `@std/assert`.
 * Vocabulary registration (`installTestingVocabulary`) is distinct from
 * testing-mode activation (`executeDocument({ testing: true })` or a
 * `<Testing>` element).
 */

export { Test, testing, record, results, TestFailureError } from "./src/test-api.ts";
export type { TestApi, TestResult, BoundaryOutcome } from "./src/test-api.ts";
export { installTestingVocabulary } from "./src/vocabulary.ts";
export { executeDocument } from "./src/execute.ts";
