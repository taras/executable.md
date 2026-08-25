/**
 * The one pull-request surface: read a collection by URL, or upsert a pull
 * request for a branch this run published.
 *
 * Two operations rather than one, because they are different questions about
 * different objects. A read names the pull request it wants and needs no
 * Repository in scope — the URL *is* the identity, and the reviews, comments
 * and checks it holds are things anyone with the URL can be authorized to see.
 * An upsert names a branch this run published and asks for one pull request
 * from it to exist saying something, which is a reconciliation and needs the
 * run's own evidence.
 *
 * There is no registry here, no resolver, no routing protocol and no private
 * terminal. A provider is ordinary middleware around these operations, which is
 * the whole mechanism: an adapter composes `PullRequestAPI.around(...)`, looks
 * at what it was handed, and either handles the request or delegates it
 * untouched. The rule is applied to each method independently, so a provider
 * may own reads for a host and delegate its upserts, or the reverse.
 *
 * This supersedes the request-only policy route and the invocation-private
 * terminal an earlier revision of #576 carried. Those existed to keep evidence
 * off a public surface; what they cost was a second authority model beside the
 * one the Issue surface already had, and a read that needed a Repository in
 * scope to name a pull request by number. Selected middleware owning its own
 * answer is the settled shape.
 *
 * ## Matching, and what matching commits a provider to
 *
 * Without an explicit discriminator a provider matches its own URLs — GitHub's
 * middleware recognizes the URLs it can act on and passes everything else
 * along. With one, only the provider registered under that exact name may
 * handle the request.
 *
 * Once middleware matches, it owns the answer. Its validation and its refusal
 * are final: it does not delegate after matching, and no provider catches
 * {@link NoPullRequestProvider} to implement a fallback. A refusal from the
 * selected provider is the end of the request rather than the start of a search
 * for another one, because a search is how a document that named one service
 * quietly reaches a different one.
 *
 * ## What may not cross this boundary
 *
 * A credential, an endpoint, a raw payload and every pagination detail stay
 * inside the middleware that holds them. What comes back is the normalized
 * evidence, or the pull request's own identity.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { PullRequestReadKind, PullRequestReadResult } from "./pull-request-read-records.ts";
import type { PullRequestResult } from "./pull-request-records.ts";
import type { RepositoryRecord } from "./records.ts";

/** The stable name every loaded copy composes through. */
export const PULL_REQUEST_API = "executablemd.workflow.pull-request";

/** Which collection a read wants, and where it may be sent. */
export interface PullRequestReadOptions {
  /** Which of the three collections this read is for. */
  readonly kind: PullRequestReadKind;
  /** The explicit discriminator, for a self-hosted or non-standard URL. */
  readonly provider?: string;
}

/**
 * What a document asked a pull request to say, normalized.
 *
 * The four fields an upsert moves, and the number that decides whether this is
 * a request for *a* pull request or for *that* one.
 */
export interface PullRequestInput {
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly base: string;
  /** The pull request to update, or `null` to ask for one to exist. */
  readonly number: number | null;
}

/**
 * Where the pull request goes, and what the provider needs to get it there.
 *
 * Unlike a read, an upsert is about a branch in a checkout this run holds, so
 * the Repository record and the working directory the component observed travel
 * with it. They are what the selected provider authenticates against the run's
 * own retained state before it publishes anything.
 */
export interface PullRequestUpsertOptions {
  readonly repository: RepositoryRecord;
  readonly workingDirectory: string;
  /** The explicit discriminator, when the document named one. */
  readonly provider?: string;
}

/** Which of the two questions is being asked. */
export type PullRequestOperation = "read" | "upsert";

/**
 * No middleware matched the destination.
 *
 * Reported unchanged when every provider delegated. It names the URL and the
 * discriminator because those are the document's own words and the thing an
 * author has to fix; it names nothing a provider holds.
 */
export class NoPullRequestProvider extends Error {
  override name = "NoPullRequestProvider";

  readonly operation: PullRequestOperation;
  /** The URL a read named, or the Repository an upsert named. */
  readonly subject: string;
  readonly provider: string | undefined;

  constructor(operation: PullRequestOperation, subject: string, provider: string | undefined) {
    // A read names a URL and an upsert names a Repository, so the sentence says
    // which it is rather than calling a Repository a URL.
    const named =
      operation === "read"
        ? `the pull request at ${subject}`
        : `pull requests for the Repository named ${JSON.stringify(subject)}`;
    super(
      provider === undefined
        ? `no pull-request provider handles ${named}. Install one, or name the provider so a ` +
            "provider that does not recognize it can still be asked."
        : `no pull-request provider is installed under ${provider}, so nothing handles ${named}.`,
    );
    this.operation = operation;
    this.subject = subject;
    this.provider = provider;
  }
}

export interface PullRequestApi {
  /** Read one collection the pull request this URL names already holds. */
  read(url: string, options: PullRequestReadOptions): Operation<PullRequestReadResult>;

  /**
   * Create or bring up to date one pull request for the selected checkout.
   *
   * Answers with the identity #295 settled, unchanged by this surface. Issue's
   * upsert answers with a URL alone because that is the whole of its portable
   * contract; a pull request already has a stronger shipped one — a revision
   * loop reads `number` back on its next pass, and a reviewer is shown the head
   * and base its verdict is about — and adopting Issue's topology does not
   * erase it.
   */
  upsert(
    pullRequest: PullRequestInput,
    options: PullRequestUpsertOptions,
  ): Operation<PullRequestResult>;
}

/** The public pull-request surface. Its own default reports that nothing handled it. */
export const PullRequestAPI: Api<PullRequestApi> = createApi<PullRequestApi>(PULL_REQUEST_API, {
  // deno-lint-ignore require-yield
  *read(url: string, options: PullRequestReadOptions): Operation<PullRequestReadResult> {
    throw new NoPullRequestProvider("read", url, options.provider);
  },
  // deno-lint-ignore require-yield
  *upsert(
    _pullRequest: PullRequestInput,
    options: PullRequestUpsertOptions,
  ): Operation<PullRequestResult> {
    throw new NoPullRequestProvider("upsert", options.repository.name, options.provider);
  },
});
