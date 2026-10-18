/**
 * The one seam between what a component produced and what the document binds.
 *
 * An invocation's result travels a fixed route: the producer runs once, its own
 * `returns` schema accepts what it produced, its invocation tears down and
 * joins — and only then is there a value for anything to transform. This Api is
 * where that transformation happens, and `yq` is the one the engine installs on
 * it.
 *
 * Both canonical paths call it: a Markdown component that declares `returns`, a
 * function component with or without one, and a Markdown body whose rendering
 * is its result. One seam rather than two is what keeps "select before you
 * bind" a property of the engine instead of a property of whichever producer
 * somebody wrote.
 *
 * ## It transforms a value and decides nothing
 *
 * A handler receives the accepted result and the query the invocation asked
 * for, and answers with the value to bind. That is all it can do. It cannot
 * make a refused producer succeed, rescue a return the schema rejected, repair
 * a cleanup that failed, reach the journal, or bind anything itself — by the
 * time it is asked, acceptance has already happened and publication has not.
 *
 * Nothing durable is decided here either. Permission, durable identity, which
 * occurrence a selected result belongs to and whether an append was
 * acknowledged are each settled by the execution that owns them, from state no
 * handler holds. A middleware answer is data.
 *
 * ## The terminal is the engine's own
 *
 * With no query the terminal answers with the same reference it was given, so
 * an ordinary invocation binds exactly what it always did — by reference,
 * including values JSON has no shape for. With a query it asks this execution's
 * engine, which validates the result as JSON, evaluates the expression and
 * validates the one answer as JSON.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

import { useValueQuery } from "./value-query.ts";

/** The key canonical core publishes the result seam under. */
const COMPONENT_RESULT_KEY = "executablemd.core.component-result";

/** What an invocation produced, and what it asked to be done with it. */
export interface ComponentResultRequest {
  /** The authored tag name, for a diagnostic that has to say where. */
  readonly component: string;
  /** The result the producer's own contract already accepted. */
  readonly value: unknown;
  /** The `yq` expression the invocation wrote, when it wrote one. */
  readonly query?: string;
}

/**
 * The value an invocation's accepted result becomes.
 *
 * Composable like every other contextual Api: a handler may read the request,
 * transform what the terminal answers, refuse by throwing, and delegate with
 * `yield* next(request)`. What it returns is the value — which is why it is
 * data and not authority.
 */
export interface ComponentResultApi {
  result(request: ComponentResultRequest): Operation<unknown>;
}

export const ComponentResult: Api<ComponentResultApi> = createApi<ComponentResultApi>(
  COMPONENT_RESULT_KEY,
  {
    *result(request: ComponentResultRequest): Operation<unknown> {
      if (request.query === undefined) {
        return request.value;
      }
      const queries = yield* useValueQuery();
      return yield* queries.select(request.query, request.value);
    },
  },
);

/**
 * The value to bind for one accepted result.
 *
 * Called by canonical expansion after acceptance and teardown and before
 * binding, publication or presentation. An invocation that wrote no `yq` still
 * crosses it, because a consumer composing around results composes around all
 * of them rather than only the queried ones.
 */
export function componentResult(request: ComponentResultRequest): Operation<unknown> {
  return ComponentResult.operations.result(request);
}
