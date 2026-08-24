/**
 * The request one invocation issued, branded so no other can present it.
 *
 * A private class field is the carrier. It is per-object and genuinely
 * unforgeable — `Reflect.ownKeys` does not reach it, a copy made with spread
 * does not carry it, and code outside this module cannot read or write it — so
 * "was this minted for this invocation?" is a question only the minting code
 * can answer.
 *
 * A module-scoped registry would answer the same question and is not used: it
 * would be one process-lifetime object shared by every run. A contextual one is
 * worse for this purpose — replaceable state is exactly what an identity check
 * must not rest on.
 *
 * Structural equality could not do the work either. Two `<PullRequest.*>`
 * elements reading the same number produce requests with identical members, and
 * a handler that kept the first and returned it in place of the second would be
 * choosing which invocation's evidence the second one binds.
 */

import type { PullRequestReadKind, PullRequestReadRequest } from "./pull-request-read-records.ts";
import type { GitPushRepositoryIdentity } from "./git-push-records.ts";

class IssuedReadRequest implements PullRequestReadRequest {
  readonly #invocation: string;
  readonly repository: GitPushRepositoryIdentity;
  readonly number: number;
  readonly kind: PullRequestReadKind;

  constructor(invocation: string, request: PullRequestReadRequest) {
    this.#invocation = invocation;
    this.repository = Object.freeze({ ...request.repository });
    this.number = request.number;
    this.kind = request.kind;
    Object.freeze(this);
  }

  /** Which invocation this was issued for, when it was issued by this module. */
  static issuedFor(request: PullRequestReadRequest): string | undefined {
    return #invocation in request ? request.#invocation : undefined;
  }
}

/** Record a request this host issued for `invocation`, and answer with it. */
export function mintReadRequest(
  invocation: string,
  request: PullRequestReadRequest,
): PullRequestReadRequest {
  return new IssuedReadRequest(invocation, request);
}

/** Whether this exact object is the request minted for this exact invocation. */
export function isReadRequestFor(invocation: string, request: PullRequestReadRequest): boolean {
  return IssuedReadRequest.issuedFor(request) === invocation;
}
