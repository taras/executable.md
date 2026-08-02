/**
 * Scripted answers, for a test that must not open anything.
 *
 * A test installs an ordered queue rather than writing a provider, because a
 * hand-written provider is a second implementation of the contract and would
 * pass whether or not core still honoured it. What a document exercises here is
 * the real `<Elicit>`: the same compilation, the same request, the same
 * validation, the same journal. Only the person is replaced.
 *
 * The queue is exact in both directions, and both directions are failures a
 * silent helper would hide. Asking more often than the test scripted means the
 * document did something the test did not describe. Scripting more than was
 * asked means the test believes an elicitation happens that does not — a test
 * that stopped exercising what it names would otherwise keep passing.
 *
 * Replay consumes nothing: a restored answer never reaches a provider, so a
 * document that replays half its elicitations needs only the responses it will
 * actually ask for.
 *
 * Installed from an eval block inside a `<Test>`, which is the one approved use
 * of eval for Context Api middleware:
 *
 * ```md
 * <Test name="a decision">
 *
 * ```ts persist eval
 * yield* scriptElicitations([{ decision: "approve" }]);
 * ```
 *
 * <Elicit schema={decisionSchema} as="decision">Approve?</Elicit>
 * <AssertEquals actual={decision.decision} expected="approve" />
 * </Test>
 * ```
 *
 * A `persist` block installs on the test's own eval scope, so the queue and its
 * teardown check live exactly as long as the test and are removed with it. There
 * is nothing for a document to remember to call.
 */

import { ensure } from "effection";
import type { Operation } from "effection";

import { Elicitation } from "./elicitation-api.ts";
import { parseJson } from "./json.ts";
import type { Json } from "./types.ts";

/** A queue that ran out, or one that was never emptied. */
export class ScriptedElicitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptedElicitationError";
  }
}

/**
 * Answer the next `count` elicitations from `responses`, in order.
 *
 * The responses are parsed here rather than where they are consumed, so a
 * response that is not JSON is a mistake in the test reported at the line that
 * wrote it — not later, disguised as a provider failure.
 */
export function* scriptElicitations(responses: readonly Json[]): Operation<void> {
  const queue = responses.map((response) => parseJson(response));
  let consumed = 0;

  yield* Elicitation.around(
    {
      // deno-lint-ignore require-yield
      *elicit() {
        if (consumed >= queue.length) {
          throw new ScriptedElicitationError(
            `no scripted response for elicitation ${consumed + 1}: ` +
              `${queue.length} scripted, ${consumed} already consumed`,
          );
        }
        return queue[consumed++];
      },
    },
    { at: "min" },
  );

  // Registered immediately after the install and before anything can spawn, so
  // it is the last destructor to run and its failure is the one the test sees.
  yield* ensure(function* () {
    const unused = queue.length - consumed;
    if (unused > 0) {
      throw new ScriptedElicitationError(
        `${unused} scripted elicitation response${unused === 1 ? "" : "s"} ` +
          `never used: ${queue.length} scripted, ${consumed} consumed`,
      );
    }
  });
}
