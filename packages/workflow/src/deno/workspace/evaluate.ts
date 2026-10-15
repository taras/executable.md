/**
 * What a workflow run offers canonical core's Evaluate component
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * The workflow attachment offers one selection of component names and authored
 * forms, as ordinary `Component.generated` middleware installed in the scope
 * that executes the document. Canonical execution reads the final answer once,
 * before public execution policy, resolves each selected name through the
 * ordinary import chain, and derives the identity, the effect and the contract
 * of every selected spelling from the declaration that owns the implementation.
 * Props, bindings, Context, middleware and generated names cannot widen it.
 *
 * The generic selection is core's `<File>` in both spellings and its
 * self-closing `<File.Delete>`. A host that wants more selects the names and
 * forms it registered or its providers answer for; `Dir` and `Fetch` are among
 * those, so a generic Workflow host that did not choose either does not gain
 * one. `allow` selects classes, defaulting to read, and never supplies
 * permission.
 *
 * Selected names run ordinary canonical components through contextual
 * API.Files/API.Fetch, existing middleware, effective Permissions and the run's
 * effect transaction. Deletion remains a workspace_file effect. Relative paths
 * use the run's contextual cwd, including Dir/Repository/Worktree placement,
 * never the invocation host cwd.
 *
 * What is deliberately absent is everything live. There is no Workspace
 * snapshot input and no request inventory: a destination policy belongs to the
 * owner that performs the request, immediately before transport, and the
 * effective Fetch timeout is resolved from contextual Config where the request
 * is made.
 */

import { Component } from "@executablemd/core/api";
import type { GeneratedSelection } from "@executablemd/core/api";
import type { InvocationForm } from "@executablemd/core";
import { Permissions } from "@executablemd/runtime/api";
import type { FetchInit } from "@executablemd/runtime";
import type { Operation } from "effection";

/**
 * What a host may add to a workflow run's generated selection.
 *
 * Adapter-private values, supplied before the document runs. Every one of them
 * is additive: production may supply none, which is the generic selection above
 * and nothing else. A document prop supplies none of them.
 */
export interface GeneratedEvaluationOptions {
  /**
   * Further component names and authored forms this host offers.
   *
   * Names and spellings, like the generic selection itself. What each selected
   * spelling runs as comes from the declaration that owns its implementation,
   * so a host adds a name here and never a contract for it.
   */
  readonly components?: Readonly<Record<string, readonly InvocationForm[]>>;
  /**
   * The exact requests this run may send, for a host that bounds them.
   *
   * Stating any of them does two separate things, and only the first is about
   * the selection: self-closing `<Fetch>` joins the names a fragment may
   * write, and a `Permissions` restriction is installed in the scope that
   * performs the work. The restriction is the bound — it reads the actual
   * destination, method and headers after every `API.Fetch` transformation and
   * immediately before transport — so what a fragment or a document is
   * admitted to *name* and what a request may *reach* stay two questions.
   *
   * Stating none bounds nothing and offers no `<Fetch>`: an unbounded network
   * read is a decision this host does not make on a run's behalf, and offering
   * a name a request could never satisfy would tell an agent it had something
   * it does not.
   */
  readonly requests?: readonly WorkflowRequestBound[];
}

/**
 * One request a bounded workflow run may send.
 *
 * The destination and the method with it, and the complete set of headers.
 * Headers are compared whole rather than as a subset: a bound that admitted a
 * request carrying additional headers would admit a credential nobody stated.
 */
export interface WorkflowRequestBound {
  readonly url: string;
  /** Defaults to `GET`, compared case-insensitively. */
  readonly method?: string;
  /**
   * The complete headers. Omitted is none, not "any".
   *
   * One spelling per name. Two differently cased spellings of one name state no
   * single value for it, and this refuses rather than choosing one.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The generic names and forms a workflow run offers.
 *
 * Core's `<File>` in both spellings and its self-closing `<File.Delete>`. A
 * run that offers nothing further offers exactly this.
 */
export function workflowGeneratedSelection(
  options: GeneratedEvaluationOptions = {},
): GeneratedSelection {
  return selected(options.components, (options.requests ?? []).length > 0);
}

/**
 * The same names and forms, from values this host has already read.
 *
 * Separate from the exported function because the installer below must not read
 * the host's options a second time: whether `<Fetch>` is offered and what a
 * request may reach are two halves of one statement, and two readings of an
 * accessor-backed option are two statements. So the installer reads once and
 * both halves are derived from what it captured.
 */
function selected(
  components: Readonly<Record<string, readonly InvocationForm[]>> | undefined,
  bounded: boolean,
): GeneratedSelection {
  return {
    File: ["self-closing", "paired"],
    "File.Delete": ["self-closing"],
    // Offered only where this host bounds what a request may reach. A name
    // whose every request the live terminal would refuse is a name a fragment
    // could write and never successfully call.
    ...(bounded ? { Fetch: ["self-closing"] as const } : {}),
    ...(components ?? {}),
  };
}

/**
 * Offer that selection for this scope.
 *
 * Installed where the document will execute, which is inside the Workspace
 * attachment: a selection offered in a scope that ends before the execution
 * would leave a chain core reads nothing from.
 *
 * It answers rather than delegating. A workflow run's selection is the host
 * statement for that run, so an ordinary command's fallback must not supplement
 * it — and a run that offers no `Dir` is not withholding an implementation so
 * much as never having offered the name.
 */
export function* useWorkflowGenerated(options: GeneratedEvaluationOptions = {}): Operation<void> {
  // One reading of each option, and everything below derives from it. Read
  // before the selection is offered, because a bound this host cannot state is
  // a host statement that is wrong rather than a request that is refused: a
  // name offered under it would be a name whose policy nobody settled.
  const bounds = captureBounds(options.requests ?? []);
  const components = options.components;
  // `bounds`, not the options: the name is offered exactly where a request
  // policy was installed, so a reading that stated no bound cannot be followed
  // by one that offers `<Fetch>` under no policy at all.
  const selection = selected(components, bounds.length > 0);
  yield* Component.around({ generated: () => selection });
  if (bounds.length === 0) {
    return;
  }
  // The live terminal policy. It delegates rather than answering `true`, so an
  // enclosing restriction still refuses what it refused, and it reads the
  // request as it would go out — after every `API.Fetch` transformation and
  // immediately before transport.
  yield* Permissions.around({
    fetch: ([input, init], next) =>
      bounds.some((bound) => permits(bound, input, init)) ? next(input, init) : false,
  });
}

/**
 * The bounds this host stated, copied once and frozen.
 *
 * Captured here rather than read at each request. The caller still holds the
 * objects it passed, and a policy that read them again would be comparing a
 * request against whatever they said by then — so a bound edited in place after
 * installation moves nothing.
 */
function captureBounds(
  requests: readonly WorkflowRequestBound[],
): readonly Readonly<{ url: string; method: string; headers: ReadonlyMap<string, string> }>[] {
  return Object.freeze(
    requests.map((request) => {
      const headers = capturedHeaders(request.headers);
      if (headers === undefined) {
        throw new WorkflowRequestBoundError(
          `a bounded workflow request for ${request.url} states ${AMBIGUOUS_HEADERS}`,
        );
      }
      return Object.freeze({
        url: request.url,
        method: normalizedMethod(request.method),
        headers,
      });
    }),
  );
}

/** A bound this host cannot state. Raised where it is installed, not later. */
class WorkflowRequestBoundError extends Error {}

const AMBIGUOUS_HEADERS =
  "two spellings of one header name. A request carries one value per name: a " +
  "transport joins differently cased occurrences into a single sent header, so " +
  "neither occurrence is what goes out, and a policy that compared one of them " +
  "would authorize a value nobody stated.";

/**
 * Whether this bound admits the request that is about to go out.
 *
 * Destination and method exactly, and the headers whole: the same names and the
 * same values, nothing missing and nothing extra. Header names are compared
 * case-insensitively because that is what a header name means; values are not.
 * A request this cannot read one value per name from is refused rather than
 * normalized, so what is compared is always the request as it will be sent.
 */
function permits(
  bound: Readonly<{ url: string; method: string; headers: ReadonlyMap<string, string> }>,
  input: string,
  init: FetchInit | undefined,
): boolean {
  if (bound.url !== input || bound.method !== normalizedMethod(init?.method)) {
    return false;
  }
  const sent = capturedHeaders(init?.headers);
  // Ambiguity is refused, never resolved. This bound admits a request whose
  // headers it can read exactly, and two spellings of one name are not one
  // header anybody stated — so there is nothing here to compare and the
  // request is not this bound's.
  if (sent === undefined || sent.size !== bound.headers.size) {
    return false;
  }
  for (const [name, value] of bound.headers) {
    if (sent.get(name) !== value) {
      return false;
    }
  }
  return true;
}

function normalizedMethod(method: string | undefined): string {
  return (method ?? "GET").toUpperCase();
}

/**
 * The headers by name, or nothing at all when they name one header twice.
 *
 * Names are read case-insensitively because that is what a header name means.
 * What that makes ambiguous is a record carrying two spellings of one name:
 * what the transport sends for it is neither entry, so there is no reading of
 * such a record that describes the request. Both the host's bound and the
 * outgoing request are read through here, so neither side can collapse a
 * collision into whichever spelling happened to be last.
 */
function capturedHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> | undefined {
  const captured = new Map<string, string>();
  for (const [name, value] of Object.entries(headers ?? {})) {
    const named = name.toLowerCase();
    if (captured.has(named)) {
      return undefined;
    }
    captured.set(named, value);
  }
  return captured;
}
