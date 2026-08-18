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
 * Component registration (`installTestingComponents`) is distinct from
 * testing-mode activation (`useTesting()` at the root, or a `<Testing>`
 * element for a subtree).
 */

export { Test, testing, record, results, TestFailureError } from "./src/test-api.ts";
export type { TestApi, TestResult, BoundaryOutcome } from "./src/test-api.ts";
export { installTestingComponents } from "./src/components.ts";
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
