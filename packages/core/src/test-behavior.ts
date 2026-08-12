/**
 * What core's `<Test>` does, supplied from outside (specs/testing-spec.md).
 *
 * Core owns the `<Test>` construct because core owns what an invocation of it
 * means for the run: a checked command failure inside one is that test's
 * outcome rather than the document's (§3.6). What core does not own is testing
 * — activation, isolated bindings, the timeout, how a failure is classified,
 * what is recorded and how it is reported are all `@executablemd/testing`'s.
 *
 * So the construct is core's and the behavior arrives here. This surface names
 * no component and takes no function: a package supplies what `<Test>` does,
 * and canonical core alone decides which element that is. Nothing installed
 * here can make another component contain a failure.
 *
 * The Api name is stable, which is what lets a testing package loaded beside a
 * second copy of core reach the copy that is expanding the document without
 * either copy handing the other a function to compare.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { Json } from "./types.ts";

export interface TestBehaviorApi {
  /**
   * Expand one `<Test>` element and answer with what it renders.
   *
   * Called from inside the invocation, so everything the invocation
   * established — its content, its scope, its expansion position — is reachable
   * from the handler exactly as it is from an ordinary component body.
   */
  test(props: Record<string, Json>): Operation<Json>;
}

export const TestBehavior: Api<TestBehaviorApi> = createApi<TestBehaviorApi>("TestBehavior", {
  /**
   * No testing package, no test.
   *
   * The invocation fails rather than rendering nothing: a document that writes
   * `<Test>` is asking for a test, and a run that quietly produced an empty
   * string would report a document full of tests as a document that passed.
   */
  // deno-lint-ignore require-yield
  *test(): Operation<Json> {
    throw new Error("<Test> requires a testing package to supply what a test does.");
  },
});
