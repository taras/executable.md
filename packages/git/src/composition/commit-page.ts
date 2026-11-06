/**
 * What a `<Git.Commit ref>` read hands yq, and how its selection is paged.
 *
 * The complete input is the commit's own facts in familiar Git-database
 * paths — `sha`, `author`, `committer`, `message`, `tree.sha`, `parents[].sha` —
 * and `git_verify_commit_result`, which is `null` unless verification was
 * requested. yq sees all of it before anything is paged, so a selection is
 * always a selection of the whole commit.
 *
 * Paging is the standard selected-value page: a string by 4096 code points, an
 * array by 20 items, anything else whole. There is no default byte budget —
 * nothing here has a protocol frame to fit — and an explicit `maxBytes` counts
 * the UTF-8 bytes of the compact serialized page, navigation included.
 *
 * ## A navigation string is bound to one commit
 *
 * Each `next`, `prev` and `last` names the full object id the read resolved, and
 * selects nothing from any other commit. Following one with a symbolic `ref`
 * that now resolves elsewhere refuses as a stale continuation rather than
 * quietly paging a different message; following it with that full id still
 * pages, because the commit it names cannot change.
 */

import type { Operation, Result } from "effection";
import { Err, Ok } from "effection";
import { parseJson } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import { pageSelectedValue, selectJson } from "@executablemd/core/host";
import type {
  SelectedValuePage,
  SelectedValuePageAdapter,
  SelectedValueRange,
  SelectedValueWindow,
} from "@executablemd/core/host";
import { GitObservationError } from "./errors.ts";
import type { GitCommitPage, GitCommitReadRequest } from "./observation-api.ts";

/** One stored identity line, exactly as the commit holds it. */
export interface GitCommitIdent {
  readonly name: string;
  readonly email: string;
  /** ISO 8601 for the stored instant, written at the stored offset. */
  readonly date: string;
}

/**
 * What `git verify-commit` reported for the read commit.
 *
 * `signed` comes from the commit object itself; `verifier_unavailable` is true
 * only when a signed commit's verification failed and the configured program
 * for its signature format is not an executable file. The receipt is Git's own
 * exit status and complete channels.
 */
export interface GitVerifyCommitResult {
  readonly signed: boolean;
  readonly verifier_unavailable: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The complete input a commit read's yq expression is evaluated over. */
export interface GitCommitFacts {
  readonly sha: string;
  readonly author: GitCommitIdent;
  readonly committer: GitCommitIdent;
  readonly message: string;
  readonly tree: { readonly sha: string };
  readonly parents: readonly { readonly sha: string }[];
  readonly git_verify_commit_result: GitVerifyCommitResult | null;
}

function identJson(ident: GitCommitIdent): Json {
  return { name: ident.name, email: ident.email, date: ident.date };
}

/** These facts as the JSON yq reads. */
function gitCommitFactsJson(facts: GitCommitFacts): Json {
  const verified = facts.git_verify_commit_result;
  return {
    sha: facts.sha,
    author: identJson(facts.author),
    committer: identJson(facts.committer),
    message: facts.message,
    tree: { sha: facts.tree.sha },
    parents: facts.parents.map((parent) => ({ sha: parent.sha })),
    git_verify_commit_result:
      verified === null
        ? null
        : {
            signed: verified.signed,
            verifier_unavailable: verified.verifier_unavailable,
            exitCode: verified.exitCode,
            stdout: verified.stdout,
            stderr: verified.stderr,
          },
  };
}

/** The navigation string that reads this range of this query on this commit. */
function formatCommitWindow(
  sha: string,
  query: string,
  range: SelectedValueRange,
  maxBytes?: number,
): string {
  const header: (string | number)[] = [sha, query, range.start, range.end];
  if (maxBytes !== undefined) {
    header.push(maxBytes);
  }
  return (
    `select(${JSON.stringify(header)} != null) |\n` +
    `select(.sha == ${JSON.stringify(sha)}) |\n(\n${query}\n) | .[${range.start}:${range.end}]`
  );
}

/** A navigation string this host formatted, read back. */
interface CommitWindow {
  readonly sha: string;
  readonly query: string;
  readonly range: SelectedValueRange;
  readonly maxBytes: number | undefined;
}

const OBJECT_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The window this expression is, or `undefined` when it is ordinary yq.
 *
 * Only an exact re-format of its own parse is recognized, so an expression a
 * person wrote that happens to start the same way is evaluated as written.
 */
function recognizeCommitWindow(expression: string): CommitWindow | undefined {
  const line = expression.slice(0, expression.indexOf("\n"));
  if (!line.startsWith("select(") || !line.endsWith(" != null) |")) {
    return undefined;
  }
  let header: unknown;
  try {
    header = JSON.parse(line.slice(7, -11));
  } catch {
    return undefined;
  }
  if (!Array.isArray(header) || (header.length !== 4 && header.length !== 5)) {
    return undefined;
  }
  const [sha, query, start, end, budget] = header;
  const from = count(start);
  const to = count(end);
  const maxBytes = budget === undefined ? undefined : count(budget);
  if (
    typeof sha !== "string" ||
    !OBJECT_ID.test(sha) ||
    typeof query !== "string" ||
    from === undefined ||
    to === undefined ||
    from >= to ||
    (budget !== undefined && (maxBytes === undefined || maxBytes < 1))
  ) {
    return undefined;
  }
  const range = { start: from, end: to };
  return expression === formatCommitWindow(sha, query, range, maxBytes)
    ? { sha, query, range, maxBytes }
    : undefined;
}

function refusal(
  element: string,
  reason: "invalid-query" | "stale-continuation",
  sentence: string,
  cause?: unknown,
): GitObservationError {
  const error = new GitObservationError(element, reason, `${element} ${sentence}`);
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

function adapterFor(element: string, sha: string): SelectedValuePageAdapter {
  return {
    format: (query, range, maxBytes) => formatCommitWindow(sha, query, range, maxBytes),
    fits: (page: SelectedValuePage, maxBytes?: number) =>
      maxBytes === undefined || new TextEncoder().encode(JSON.stringify(page)).length <= maxBytes,
    tooLarge: () =>
      refusal(
        element,
        "invalid-query",
        "selected a value that does not fit maxBytes as one page. Use a narrower yq selection, " +
          'such as ".message" or ".git_verify_commit_result.stderr", to read a text by pages.',
      ),
  };
}

/**
 * The page this request's yq selects from these facts, or the read's refusal.
 *
 * Query before paging: the expression is evaluated over the complete facts, and
 * only its selection is cut into pages.
 */
export function* selectCommitPage(
  element: string,
  request: GitCommitReadRequest,
  facts: GitCommitFacts,
): Operation<GitCommitPage> {
  const expression = request.yq;
  if (expression.trim() === "") {
    throw refusal(element, "invalid-query", "needs a nonempty yq expression. Omit yq to read .");
  }
  const recognized = recognizeCommitWindow(expression);
  if (recognized !== undefined && recognized.sha !== facts.sha) {
    throw refusal(
      element,
      "stale-continuation",
      `was given a navigation string for commit ${recognized.sha}, and ref=` +
        `${JSON.stringify(request.ref)} now names commit ${facts.sha}. Read the ref again from ` +
        "its first page, or pass the earlier commit's full id as ref to keep paging it.",
    );
  }
  const maxBytes = request.maxBytes ?? recognized?.maxBytes;
  const serialized = JSON.stringify(gitCommitFactsJson(facts));
  const selected = yield* evaluate(expression, serialized);
  if (!selected.ok) {
    throw refusal(
      element,
      "invalid-query",
      `could not select exactly one value with yq ${JSON.stringify(expression)}. Write an ` +
        'expression that yields one JSON value, such as ".message" or \'pick(["sha", "parents"])\', and ' +
        "collect several results with [ … ].",
      selected.error,
    );
  }
  let window: SelectedValueWindow | undefined;
  if (recognized !== undefined) {
    const base = yield* evaluate(
      `select(.sha == ${JSON.stringify(recognized.sha)}) |\n(\n${recognized.query}\n)`,
      serialized,
    );
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
    adapterFor(element, facts.sha),
  );
  if (!page.ok) {
    throw page.error;
  }
  return Object.freeze({ ...page.value });
}
