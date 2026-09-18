/**
 * Which pull request a document named, decided before any provider sees it.
 *
 * Provider-neutral, and deliberately in one place: the component, the durable
 * request and every provider read one answer. Canonicalization here knows
 * nothing about GitHub — it establishes that a URL is a URL and reduces it to
 * the form the journal holds. Which service owns it is the provider's question,
 * asked afterwards.
 */

/** The stable name of a provider: lower case, and a name rather than a phrase. */
const PROVIDER_NAME = /^[a-z][a-z0-9-]*$/;

/** Where this invocation reads, decided. */
export interface PullRequestTarget {
  /** The canonical pull-request URL, as the durable request holds it. */
  readonly url: string;
  /**
   * The explicit discriminator, when the document named one.
   *
   * Absent means the destination is matched by URL: every provider looks at it
   * and the one that recognizes it handles the request. Present means only the
   * provider of that exact name may — which is what makes a self-hosted
   * deployment addressable when its URL is not one anybody recognizes.
   */
  readonly provider: string | undefined;
}

/**
 * The canonical form of this pull-request URL, or `undefined` when it has none.
 *
 * A credential in the URL, a query and a fragment each make this something
 * other than the plain name of a pull request. None is guessed at or stripped.
 */
export function canonicalPullRequestUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (url.hostname === "") {
    return undefined;
  }
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.protocol}//${url.host}${path}`;
}

/** Whether this string names a provider at all. */
export function pullRequestProviderName(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_NAME.test(value) ? value : undefined;
}
