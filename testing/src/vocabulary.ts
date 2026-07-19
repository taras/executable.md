/**
 * Vocabulary registration (specs/testing-spec.md).
 *
 * Teaches the expansion loop the testing words — `<Testing>`, `<Test>`, and
 * the assertion components — via the core `expandInvocation` hook.
 * Registration is distinct from activation: installing the vocabulary leaves
 * `testing` false, so `<Test>` skips and assertions stay usable.
 *
 * Installs are scope-local; `executeDocument` owns the lifetime for CLI
 * runs. Direct core consumers call this inside their own bounded scope.
 */

import type { Operation } from "effection";
import { Component } from "@executablemd/core";
import { Test } from "./test-api.ts";
import { ASSERTIONS } from "./assertions.ts";
import { createTestHandlers } from "./handlers.ts";
import type { TestHandlers } from "./handlers.ts";

const TEST_TIMEOUT_MS = 20_000;

export function* installTestingVocabulary(options?: { verbose?: boolean }): Operation<void> {
  yield* installHandlers(createTestHandlers({ timeoutMs: TEST_TIMEOUT_MS }), options);
}

/**
 * Install a specific handler set. Internal seam: tests inject handlers built
 * with a short timeout; the public path always uses the fixed 20 seconds.
 */
export function* installHandlers(
  handlers: TestHandlers,
  options?: { verbose?: boolean },
): Operation<void> {
  if (options?.verbose) {
    yield* Test.around({ verbose: () => true });
  }
  yield* Component.around({
    *expandInvocation([invocation, ctx], next) {
      if (invocation.name === "Testing") {
        return { segments: yield* handlers.expandTesting(invocation, ctx) };
      }
      if (invocation.name === "Test") {
        return { segments: yield* handlers.expandTest(invocation, ctx) };
      }
      const assertion = ASSERTIONS.get(invocation.name);
      if (assertion) {
        return { segments: yield* handlers.expandAssertion(assertion, invocation, ctx) };
      }
      return yield* next(invocation, ctx);
    },
  });
}
