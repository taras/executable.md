/**
 * `<Testing>` as an ordinary function component (spec §5.3).
 *
 * It marks a region as a testing boundary: tests inside it run, their results
 * collect here, and the boundary reports how many ran and how many failed.
 *
 * Its body is projected with `tryContent()` rather than `content()` because
 * `<Testing>` does not intercept raised segments — that is `<Test>`'s job — so
 * an error written beside a test settles where it was written and the boundary
 * still reports. `content()` would replace the whole boundary with that failure
 * and lose the report with it.
 */

import { hasContent, invocation, tryContent } from "@executablemd/core";
import type { ComponentInvocationMetadata, Json, PropsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import { Test, boundary } from "./test-api.ts";
import type { TestResult } from "./test-api.ts";
import { persistBoundaryOutcome } from "./journal.ts";
import { flushStaged } from "./test-component.ts";

export const TESTING_PROPS: PropsSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** `path:line:column`, `line:column`, or `unknown` — the durable boundary key. */
function formatLocation(metadata: ComponentInvocationMetadata): string {
  const position = metadata.position;
  if (!position) {
    return "unknown";
  }
  const at = `${position.line}:${position.column}`;
  return position.path ? `${position.path}:${at}` : at;
}

export function* Testing(): Operation<Json> {
  const local: TestResult[] = [];
  yield* Test.around(
    {
      testing: () => true,
      // deno-lint-ignore require-yield
      *results() {
        return local;
      },
      *record([result], next) {
        local.push(result);
        yield* next(result);
      },
    },
    { at: "min" },
  );

  const projected = (yield* hasContent()) ? yield* tryContent() : { text: "" };

  // Every test in this boundary has settled, so their staged results — and any
  // teardown upgrade applied to them — are final and can be journaled. Doing it
  // before the outcome below is what makes that outcome count them.
  yield* flushStaged();

  // A body that stopped never finished being a boundary, so there is no outcome
  // to report and nothing to journal: the failure travels on untouched. Only a
  // projection that ran to the end has counted every test it contains — errors
  // it *collected* are part of its text and leave it complete.
  if (projected.failure !== undefined) {
    throw projected.failure;
  }

  // Journal the outcome before the root Close so a full replay can restore it
  // without re-expanding this boundary.
  const outcome = yield* persistBoundaryOutcome(
    {
      tests: local.length,
      failed: local.filter((result) => result.status === "fail").length,
    },
    formatLocation(yield* invocation()),
  );
  yield* boundary(outcome);

  return projected.text;
}
