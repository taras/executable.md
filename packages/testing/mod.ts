/**
 * @module
 * Testing components for executable.md documents (specs/testing-spec.md).
 *
 * `<Testing>` activates testing mode for its expanded subtree, `<Test>` — the
 * construct core owns, whose behavior this package supplies — defines an atomic
 * test, and the assertion components build on `node:assert/strict`.
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
 * Several documents share fixtures, never sessions. Provider and fixture state
 * that spans a suite belongs in an enclosing scope; each document then gets one
 * child scope holding one `useTesting()` session and one `execute()` or
 * `executeInstalled()` call:
 *
 * ```ts
 * yield* useStubFs(files);                 // fixtures the whole suite shares
 * for (const path of documents) {
 *   yield* scoped(function* () {
 *     const tests = yield* useTesting();    // one session per document
 *     const outcome = yield* yield* execute({ path, stream: new InMemoryStream() });
 *     report(path, outcome, yield* tests.results);
 *   });
 * }
 * ```
 *
 * A session's results are cumulative and its completion policy is the whole
 * run's, so one session around the loop would let a zero-test document pass on
 * the strength of an earlier document's tests.
 *
 * Three things are distinct, and only the third makes tests run:
 *
 * 1. `installTestingComponents()` registers `<Testing>`, the assertions and
 *    what core's `<Test>` does. It activates nothing.
 * 2. `TestApi.testing` is the public mode switch, and replaceable policy.
 * 3. `useTesting()` for one root execution, and `<Testing>` for a lexical
 *    subtree, are the complete activations: each owns the collector, the final
 *    flush and the settlement that make a test result mean something.
 *
 * Registration plus `Test.around({ testing: () => true })` is not a substitute
 * for the third. A `<Test>` under that composition refuses before its body
 * expands, and the document fails.
 *
 * Canonical core enforces that refusal. Registration installs the guard, and
 * core's own `<Test>` consults it before minting a harness and before
 * dispatching `TestBehavior` — so middleware composed around what a test does
 * cannot answer for whether it may run. Activation policy, the proof,
 * collection, flushing and settlement all remain this package's.
 */

export { Test, testing, record, results, TestFailureError } from "./src/test-api.ts";
export type { TestApi, TestResult, BoundaryOutcome } from "./src/test-api.ts";
export { installTestingComponents, TESTING_REGISTRATIONS } from "./src/components.ts";
export { useTesting } from "./src/use-testing.ts";
// The nested-execution harness. This package owns the authored components and
// the request-only host-profile surface; the trusted answer is attached to the
// test-harness installation as a captured value.
export { ExecutionHost, ExecutionHostError } from "./src/execution-host.ts";
// The authority path. A trusted host attaches this to `executeInstalled()`, and
// canonical `<Test>` calls it with each invocation's harness; a document run
// without it recognizes `<Execution>` and refuses it.
export { testHarnessInstallation } from "./src/execution-harness.ts";
export type {
  ChildInvocation,
  ChildSettlement,
  ExecutionHostApi,
  ExecutionHostProvider,
  ExecutionHostRequest,
  ExecutionOutcome,
  HostProfileName,
  HostProfileRequest,
  JournalPolicy,
  WorkflowRunScope,
} from "./src/execution-host.ts";
export type { Testing } from "./src/use-testing.ts";
