/**
 * A second loaded copy of canonical core is not canonical core.
 *
 * A package can be loaded twice — two versions in a dependency tree, a
 * workspace resolving one specifier two ways, a document that imports the file
 * directly. Every capability core keeps out of reach is kept there by a private
 * field, and a private field belongs to the class that declared it: the copy's
 * classes are different classes, so what the copy builds is not what this copy
 * recognizes, in either direction.
 *
 * This loads the same source under a distinct specifier, which is exactly what
 * a second copy is at runtime. What a second copy of the built-in `eval`
 * terminal can and cannot do is held where it is observable — as a registered
 * modifier, in `packages/testing/tests/execution-harness.test.ts` — because the
 * answer there is about the invocation and not about a field on a value.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, scoped } from "effection";
import type { Operation } from "effection";
import { installTestHarness, provideTestHarnessInstallers } from "../src/test-harness.ts";
import type { TestHarness } from "../src/test-harness.ts";

type HarnessModule = typeof import("../src/test-harness.ts");

/** The same file again, under a specifier the module map has not seen. */
function load<T>(specifier: string): Operation<T> {
  return call(() => import(specifier) as Promise<T>);
}

describe("a separately loaded copy of core", () => {
  it("cannot deliver test-harness installers to this copy's <Test>", function* () {
    const copy = yield* load<HarnessModule>("../src/test-harness.ts?loaded-copy");
    let delivered = 0;
    const installer = function* (_harness: TestHarness): Operation<void> {
      delivered += 1;
    };

    yield* scoped(function* () {
      // The context is keyed by name, so the copy's publication lands in the
      // same slot this copy reads. What it holds is the copy's own value, and
      // a value this module did not build authorizes nothing.
      yield* copy.provideTestHarnessInstallers([installer]);
      yield* installTestHarness();
    });
    expect(delivered).toBe(0);

    // The control, so the refusal above is about the copy and not about the
    // shape of the call.
    yield* scoped(function* () {
      yield* provideTestHarnessInstallers([installer]);
      yield* installTestHarness();
    });
    expect(delivered).toBe(1);
  });
});
