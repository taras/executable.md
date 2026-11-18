/**
 * What a `<PullRequest>` read's yq selects from the complete record, and how that
 * selection is paged (specs/workflow-workspace-spec.md §7.5).
 *
 * The complete input is the normalized record of {@link PullRequestDetails}, so yq
 * sees every member before anything is paged: a selection is always a selection
 * of the whole pull request. Omitted yq is `.`, which pages as one value — the
 * whole record — because no field of it is a string or an array the page cuts.
 *
 * Paging is the standard selected-value page the commit read uses: a string by
 * 4096 code points, an array by 20 items, anything else whole. There is no
 * default byte budget, and an explicit `maxBytes` counts the UTF-8 bytes of the
 * compact serialized page, navigation included.
 *
 * ## A navigation string is bound to one observation
 *
 * Each `next`, `prev` and `last` names the canonical URL and the content
 * fingerprint of the complete record it read. Following one against another URL,
 * or against a record that has since changed — including a body edit that leaves
 * the head commit alone — refuses as a stale continuation. A fresh read without a
 * continuation observes the current record.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { canonicalFingerprint, parseJson } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { pageSelectedValue, selectJson } from "@executablemd/core/host";
import type {
  SelectedValuePage,
  SelectedValuePageAdapter,
  SelectedValueRange,
  SelectedValueWindow,
} from "@executablemd/core/host";
import { PullRequestReadError } from "./errors.ts";
import { pullRequestDetailsJson } from "./pull-request-read-records.ts";
import type { PullRequestDetails } from "./pull-request-read-records.ts";

/** The text a navigation string names its observation by, as a page header. */
interface DetailsWindow {
  readonly url: string;
  readonly fingerprint: string;
  readonly query: string;
  readonly range: SelectedValueRange;
  readonly maxBytes: number | undefined;
}

/** The navigation string that reads this range of this query on this observation. */
function formatDetailsWindow(
  url: string,
  fingerprint: string,
  query: string,
  range: SelectedValueRange,
  maxBytes?: number,
): string {
  const header: (string | number)[] = [url, fingerprint, query, range.start, range.end];
  if (maxBytes !== undefined) {
    header.push(maxBytes);
  }
  return `select(${JSON.stringify(header)} != null) |\n(\n${query}\n) | .[${range.start}:${range.end}]`;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The window this expression is, or `undefined` when it is ordinary yq.
 *
 * Only an exact re-format of its own parse is recognized, so an expression a
 * person wrote that happens to start the same way is evaluated as written.
 */
function recognizeDetailsWindow(expression: string): DetailsWindow | undefined {
  const newline = expression.indexOf("\n");
  const line = newline === -1 ? expression : expression.slice(0, newline);
  if (!line.startsWith("select(") || !line.endsWith(" != null) |")) {
    return undefined;
  }
  let header: unknown;
  try {
    header = JSON.parse(line.slice(7, -11));
  } catch {
    return undefined;
  }
  if (!Array.isArray(header) || (header.length !== 5 && header.length !== 6)) {
    return undefined;
  }
  const [url, fingerprint, query, start, end, budget] = header;
  const from = count(start);
  const to = count(end);
  const maxBytes = budget === undefined ? undefined : count(budget);
  if (
    typeof url !== "string" ||
    typeof fingerprint !== "string" ||
    typeof query !== "string" ||
    from === undefined ||
    to === undefined ||
    from >= to ||
    (budget !== undefined && (maxBytes === undefined || maxBytes < 1))
  ) {
    return undefined;
  }
  const range = { start: from, end: to };
  return expression === formatDetailsWindow(url, fingerprint, query, range, maxBytes)
    ? { url, fingerprint, query, range, maxBytes }
    : undefined;
}

function refusal(
  element: string,
  reason: "invalid-query" | "stale-continuation",
  sentence: string,
  cause?: unknown,
): PullRequestReadError {
  const error = new PullRequestReadError(reason, element, sentence);
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function* evaluate(expression: string, input: string): Operation<Result<Json>> {
  try {
    const selected = yield* selectJson(expression, input);
    return selected.ok ? Ok(parseJson(JSON.parse(selected.value))) : selected;
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

function adapterFor(element: string, url: string, fingerprint: string): SelectedValuePageAdapter {
  return {
    format: (query, range, maxBytes) =>
      formatDetailsWindow(url, fingerprint, query, range, maxBytes),
    fits: (page: SelectedValuePage, maxBytes?: number) =>
      maxBytes === undefined || new TextEncoder().encode(JSON.stringify(page)).length <= maxBytes,
    tooLarge: () =>
      refusal(
        element,
        "invalid-query",
        "selected a value that does not fit maxBytes as one page. Use a narrower yq selection, " +
          'such as ".body" or ".title", to read a text by pages.',
      ),
  };
}

/**
 * The page this request selects from this record, or the read's refusal.
 *
 * Query before paging: the expression is evaluated over the complete record, and
 * only its selection is cut into pages. A continuation's observation is checked
 * before anything is evaluated, so a stale one never selects from the new record.
 */
export function* selectPullRequestDetailsPage(
  element: string,
  request: { readonly yq: string; readonly maxBytes: number | undefined },
  url: string,
  details: PullRequestDetails,
): Operation<SelectedValuePage> {
  const expression = request.yq;
  if (expression.trim() === "") {
    throw refusal(element, "invalid-query", "needs a nonempty yq expression. Omit yq to read .");
  }
  const recordJson = pullRequestDetailsJson(details);
  const fingerprint = canonicalFingerprint([url, recordJson]);
  const recognized = recognizeDetailsWindow(expression);
  if (
    recognized !== undefined &&
    (recognized.url !== url || recognized.fingerprint !== fingerprint)
  ) {
    throw refusal(
      element,
      "stale-continuation",
      "was given a navigation string for a pull request record it no longer holds. Read the " +
        "pull request again from its first page; a body or other field changed since then.",
    );
  }

  const maxBytes = request.maxBytes ?? recognized?.maxBytes;
  const serialized = JSON.stringify(recordJson);
  const selected = yield* evaluate(expression, serialized);
  if (!selected.ok) {
    throw refusal(
      element,
      "invalid-query",
      `could not select exactly one value with yq ${JSON.stringify(expression)}. Write an ` +
        'expression that yields one JSON value, such as ".body" or \'pick(["title", "state"])\', ' +
        "and collect several results with [ … ].",
      selected.error,
    );
  }
  let window: SelectedValueWindow | undefined;
  if (recognized !== undefined) {
    const base = yield* evaluate(recognized.query, serialized);
    if (base.ok && (typeof base.value === "string" || Array.isArray(base.value))) {
      window = {
        value: base.value,
        query: recognized.query,
        range: recognized.range,
        preserveWindow: recognized.maxBytes === maxBytes,
      };
    }
  }
  const page = pageSelectedValue(
    selected.value,
    expression,
    window,
    maxBytes,
    adapterFor(element, url, fingerprint),
  );
  if (!page.ok) {
    throw page.error;
  }
  return Object.freeze({ ...page.value });
}
