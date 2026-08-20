/**
 * The one Issue surface: upsert an issue in the tracker a document named.
 *
 * There is no registry here, no resolver, no routing protocol, no phase API and
 * no private terminal. A provider is ordinary middleware around this operation,
 * which is the whole mechanism: an adapter composes `IssueApi.around(...)`,
 * looks at the destination it was handed, and either handles the request or
 * delegates it untouched.
 *
 * ## Matching, and what matching commits a provider to
 *
 * Without an explicit discriminator a provider matches its own URLs — GitHub's
 * middleware recognizes the URLs it can act on and passes everything else
 * along. With one, only the provider registered under that exact name may
 * handle the request, which is what makes a self-hosted deployment addressable.
 *
 * Once middleware matches, it owns the answer. Its validation and its refusal
 * are final: it does not delegate after matching, and no provider catches
 * {@link NoIssueProvider} to implement a fallback. A refusal from the selected
 * provider is the end of the request rather than the start of a search for
 * another one, because a search is how a document that named one service
 * quietly reaches a different one.
 *
 * ## What may not cross this boundary
 *
 * A credential, an endpoint, a raw payload, a provider's own identity for the
 * issue and every reconciliation detail stay inside the middleware that holds
 * them. What comes back is the issue's URL, and nothing else.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

/** The stable name every loaded copy composes through. */
export const ISSUE_API = "executablemd.workflow.issue";

/** What a document asked for, normalized. */
export interface IssueInput {
  readonly title: string;
  readonly description: string;
  /** Deduplicated and code-point sorted. Empty is `[]`, never absent. */
  readonly tags: readonly string[];
  /** The opaque provider account identifier, or `null` for none. */
  readonly assignee: string | null;
}

/** Where the issue goes, and what makes two attempts at it the same one. */
export interface IssueUpsertOptions {
  /** The canonical target URL of the container new issues are created in. */
  readonly url: string;
  /** The explicit discriminator, when the tracker named one. */
  readonly provider?: string;
  /**
   * What makes a second attempt the same attempt.
   *
   * Derived by the durable envelope from the canonical target and this run's
   * own effect identity, so a provider never invents it and an interrupted
   * attempt is recognized by the next one. A provider carries it wherever its
   * service can hold a mark, which is how "already created" is answered
   * without a local record.
   */
  readonly idempotencyKey: string;
}

/** What a document binds: the issue's URL, and nothing else. */
export interface IssueResult {
  readonly url: string;
}

/**
 * No middleware matched the destination.
 *
 * The base error, reported unchanged when every provider delegated. It names
 * the URL and the discriminator because those are the document's own words and
 * the thing an author has to fix; it names nothing a provider holds.
 */
export class NoIssueProvider extends Error {
  override name = "NoIssueProvider";

  readonly url: string;
  readonly provider: string | undefined;

  constructor(url: string, provider: string | undefined) {
    super(
      provider === undefined
        ? `no issue provider handles ${url}. Install one, or name the provider on the ` +
            `<IssueTracker> so a provider that does not recognize the URL can still be asked.`
        : `no issue provider is installed under ${provider}, so nothing can create an issue ` +
            `in ${url}.`,
    );
    this.url = url;
    this.provider = provider;
  }
}

export interface IssueApi {
  /** Create or bring up to date one issue in the tracker these options name. */
  upsert(issue: IssueInput, options: IssueUpsertOptions): Operation<IssueResult>;
}

/**
 * The public Issue surface. Its own default reports that nothing handled it.
 *
 * Reaching this default means every installed provider delegated, which is an
 * ordinary authoring outcome rather than a failure of the boundary: the
 * document named a destination this deployment has no adapter for.
 */
export const IssueApi: Api<IssueApi> = createApi<IssueApi>(ISSUE_API, {
  // deno-lint-ignore require-yield
  *upsert(_issue: IssueInput, options: IssueUpsertOptions): Operation<IssueResult> {
    throw new NoIssueProvider(options.url, options.provider);
  },
});
