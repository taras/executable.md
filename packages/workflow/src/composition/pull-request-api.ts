/**
 * The request-only policy route a pull-request read passes through
 * (specs/workflow-workspace-spec.md §7.7).
 *
 * Public middleware is entitled to know what a document is about to read, and
 * to stop it: a host that narrows which pull requests a run may look at, a test
 * that refuses the network, a policy that allows reviews and not checks. So the
 * request crosses this Api, where anything installed in scope sees it and may
 * throw, delegate to `next`, or pass it along.
 *
 * What does not cross it is the evidence. This route answers with a *request*,
 * never with a review, a comment or a check, so there is no return value here
 * that could become what a document binds or what the journal retains. A
 * handler that wants to change the answer has nothing to change it to.
 *
 * ## Why the answer is an object rather than a value
 *
 * The component creates one request object for the activation it is running,
 * hands that object to this route, and keeps it. The terminal behind the route
 * is given both and admits the read only when they are the same object.
 *
 * Identity rather than shape, and rather than a name. Two invocations on the
 * same number produce equal requests, so structural equality would let one
 * stand in for the other. An expansion identifier would be worse: it is stable
 * across continuations, so a handler could keep a genuine request from one
 * execution and present it in the next execution of the same element, and every
 * name-based check would call it current. A fresh object per activation is what
 * makes "the request this component is holding right now" a question with one
 * answer.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { PullRequestReadRequest } from "./pull-request-read-records.ts";

/** The contextual name this route is reached under, across loaded copies. */
export const PULL_REQUEST_API = "executablemd.workflow.pull-request";

export interface PullRequestApi {
  /**
   * Observe the read a document is about to perform.
   *
   * Answers with the request to perform, which is the request it was given.
   * Refusing is raising; narrowing is refusing a subset. It never answers with
   * evidence, and reshaping a request is not something it can do — the terminal
   * admits only the object the component is holding.
   */
  read(request: PullRequestReadRequest): Operation<PullRequestReadRequest>;
}

export const PullRequestAPI: Api<PullRequestApi> = createApi<PullRequestApi>(PULL_REQUEST_API, {
  // deno-lint-ignore require-yield
  *read(request: PullRequestReadRequest): Operation<PullRequestReadRequest> {
    return request;
  },
});
