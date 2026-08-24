/**
 * How a workflow run asks a person, and waits durably for the answer
 * (specs/executable-mdx-spec.md §6.16, §6.17).
 *
 * A document writes the same `<Elicit>` it writes anywhere:
 *
 * ```md
 * <Elicit schema={decisionSchema} as="decision">
 *   {assessment.question}
 * </Elicit>
 * ```
 *
 * Under `xmd run` that opens a form and blocks until somebody fills it in.
 * Under `xmd workflow` it publishes a retained request, settles the run
 * `suspended`, and gives the executor lock back — so the process, the Workspace
 * attachment and the Agent processes need not stay alive while a person thinks.
 * `xmd workflow answer` retains the answer and `xmd workflow resume` continues.
 *
 * The document says none of that. It names no suspension, no run, no position
 * and no controller, and there is no v1 Markdown spelling for `suspendFor()`
 * afterwards. Where the asking happens has always been the host's decision;
 * this is a host making it.
 *
 * ## Why this registers a component instead of only a provider
 *
 * A provider alone would be the obvious shape, and it does not work.
 *
 * Core's `<Elicit>` reaches its provider from *inside* a durable operation: it
 * wraps the asking in `persistElicitation()` so a replay restores the answer
 * instead of asking twice. A provider that called `suspendFor()` there would
 * publish its `suspension_request` in the same durable coroutine, ahead of the
 * `elicit` entry that never settles — because the run suspends around it. The
 * resumed execution replays that coroutine, reaches the elicit operation, and
 * finds the wrong entry waiting:
 *
 * ```text
 * DivergenceError: Divergence at root[3]:
 *   expected suspension_request("ab60…"), got elicit("elicit:probe.md:1:1")
 * ```
 *
 * Giving the wait its own coroutine from inside that live path does not rescue
 * it either: a child spawned there is halted before it publishes anything, and
 * the outer entry settles with that failure instead of suspending.
 *
 * A durable wait has to be the outermost durable thing at its position.
 * Anything enclosing it owns a journal slot the wait will occupy first. So the
 * workflow's `Elicit` does what core's does *minus the durable record*, and the
 * wait underneath it is retained by the suspension protocol rather than by the
 * elicitation journal. There is one record of the answer, not two.
 *
 * ## What still answers ahead of this
 *
 * An `<Answers>` region installs its own provider at `min` in a nested scope,
 * so it answers first and the run never suspends — which is how a test, a demo
 * or a non-interactive region says what the answer is, visibly, in the
 * document. Any other public Elicitation middleware is in the same position: it
 * may answer the question or refuse it, and in both cases the run it affects is
 * a run that never suspended. None of them continues a suspended one. That
 * takes a run whose status is `suspended`, whose stop reason names the retained
 * request, an answer that passes the retained response schema and the secret
 * gate, and a later resume claiming it at the exact position that published it
 * — none of which is reachable from inside the execution.
 */

import type { Operation } from "effection";
import {
  content,
  Elicitation,
  prepareElicitation,
  registerComponents,
  runPreparedElicitation,
} from "@executablemd/core";
import type { ElicitationRequest, Json } from "@executablemd/core";
import { elicitProps, elicitReturns } from "@executablemd/core/host";
import { suspendFor } from "./suspend.ts";

/** How this registration names itself, in a refusal and in the registry. */
export const SUSPENSION_ORIGIN = "@executablemd/workflow/suspension";

/** What a retained elicitation request calls itself. */
export const ELICITATION_REQUEST_KIND = "elicitation";

/**
 * Core's `<Elicit>`, without the journal wrapper.
 *
 * The three steps and their order are core's, and they matter for the same
 * reasons: the schema compiles first, so an unusable one fails before anybody
 * is asked; the content expands next, because the rendered message is what the
 * person is shown and what the retained request carries; the asking is last.
 *
 * What is missing is deliberate. Core also fingerprints the question and
 * refuses a recorded answer given to a different one — a guard over its own
 * `elicit` record. There is no such record here, so there is nothing to guard:
 * the answer is claimed at the durable position that published the request, and
 * two questions in one procedure sit at two positions.
 */
export function* Elicit(props: Record<string, Json>): Operation<Json> {
  const prepared = yield* prepareElicitation(props.schema);
  const message = yield* content();
  return yield* runPreparedElicitation(prepared, message);
}

/**
 * Register the component and install the provider, together.
 *
 * One operation rather than two exports, because either half alone is wrong.
 * The component without the provider asks a question no host answers; the
 * provider without the component suspends from inside core's durable record and
 * diverges on the resume.
 */
export function* useWorkflowElicitation(): Operation<void> {
  yield* registerComponents([
    {
      name: "Elicit",
      origin: SUSPENSION_ORIGIN,
      props: elicitProps,
      returns: elicitReturns,
      fn: Elicit,
    },
  ]);

  // `{ at: "min" }` is not decoration. Middleware installed at the default
  // position runs outermost, so the CLI's WebForm provider — installed in an
  // enclosing scope — would answer ahead of this one and nothing would suspend.
  yield* Elicitation.around(
    {
      *elicit([request]: [ElicitationRequest]): Operation<unknown> {
        return yield* suspendFor({
          request: { kind: ELICITATION_REQUEST_KIND, message: request.message },
          responseSchema: request.schema,
        });
      },
    },
    { at: "min" },
  );
}
