/**
 * Where an issue is created, and which provider is asked to create it.
 *
 * Two decisions live here, and both are made before routing exists. The URL a
 * context supplies is canonicalized, so one destination has one spelling in the
 * durable request, in the natural key and in every comparison a provider makes.
 * The provider is then resolved from that canonical URL unless the context
 * named one.
 *
 ## Automatic mapping belongs to the host, not to this module
 *
 * A canonical URL with no explicit discriminator is resolved by asking the
 * trusted host, which is where the table of well-known hosts lives. It is not
 * here, and that is enforced rather than merely intended: this is the shared
 * coordination surface, and the shared surface naming its first adapter is
 * exactly how a neutral boundary quietly becomes one provider's.
 *
 * The mapping is still a compatibility contract wherever it lives, because the
 * resolved provider is part of durable identity: a target that resolved to one
 * provider yesterday and another today would ask a different service for the
 * same retained position.
 *
 * A URL the host resolves nothing for is refused rather than guessed at. The
 * remedy is in the refusal — install a context carrying `provider` — because a
 * self-hosted tracker is an ordinary deployment and the document's author is
 * the one who knows which service is behind that host name.
 *
 * ## Canonical means refused, not repaired
 *
 * A credential, a query and a fragment each make a URL something other than the
 * plain name of a container, and none of them is stripped. Stripping would
 * publish a destination nobody wrote; refusing says what to write instead. What
 * canonicalization does do is drop a trailing slash and take the scheme and
 * host as the URL parser already lower-cases them, so two spellings of one
 * container are one string.
 */

import { IssueTargetError } from "./errors.ts";

/** What a lexical Issue context supplies, before anything is decided about it. */
export interface IssueTarget {
  readonly url: string;
  readonly provider?: string;
}

/** Where this invocation creates an issue, decided. */
export interface IssueDestination {
  /** The canonical container URL, as the durable request and key hold it. */
  readonly target: string;
  /** The resolved discriminator. Only a provider registered under it may act. */
  readonly provider: string;
}

/** The stable name of a provider: lower case, and a name rather than a phrase. */
const PROVIDER_NAME = /^[a-z][a-z0-9-]*$/;

/** The canonical form of this container URL, or `undefined` when it has none. */
export function canonicalIssueTarget(value: unknown): string | undefined {
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
  // A credential in the target, a query and a fragment each make this something
  // other than the plain name of a container. None is guessed at or stripped.
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
export function issueProviderName(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_NAME.test(value) ? value : undefined;
}

/**
 * The destination this context describes, or the refusal that says why not.
 *
 * Decided in one place so the component, the durable request and every
 * provider see one answer. An explicit discriminator wins over the built-in
 * mapping and is what makes a self-hosted tracker addressable; it does not
 * excuse the URL from being a URL, and the provider that receives it still
 * decides whether the target is one of its own.
 */
export function resolveIssueDestination(
  target: IssueTarget | undefined,
  /** What the host maps a canonical URL to, when the context named nothing. */
  resolve: (canonical: string) => string | undefined,
): IssueDestination {
  if (target === undefined) {
    throw new IssueTargetError(
      "no-issue-target",
      "it is written outside any lexical Issue context, so nothing says which tracker or " +
        'project a new issue belongs in. Write <IssueTarget url="…"> around it.',
    );
  }
  const canonical = canonicalIssueTarget(target.url);
  if (canonical === undefined) {
    throw new IssueTargetError(
      "invalid-target-url",
      "the Issue context does not carry an http or https URL naming one container, free of " +
        "credentials, query and fragment.",
    );
  }
  if (target.provider === undefined) {
    const resolved = resolve(canonical);
    if (resolved === undefined) {
      throw new IssueTargetError(
        "unresolved-provider",
        "this host maps no provider to that URL, and guessing one would ask an unrelated " +
          "service to create the issue. Install a context that names one, as " +
          '<IssueTarget url="…" provider="…">.',
      );
    }
    return Object.freeze({ target: canonical, provider: resolved });
  }
  const named = issueProviderName(target.provider);
  if (named === undefined) {
    throw new IssueTargetError(
      "invalid-provider",
      "a provider discriminator is a stable lower-case name, and that is not one.",
    );
  }
  return Object.freeze({ target: canonical, provider: named });
}

/**
 * Whether a canonical target is at or beneath one the host authorized.
 *
 * Whole path segments, so `…/octo/project` does not admit `…/octo/project-two`.
 * This is the shape a ceiling narrows through: a context may ask for something
 * further inside an authorized container and never for something outside it.
 */
export function withinIssueCeiling(ceiling: readonly string[], target: string): boolean {
  return ceiling.some((allowed) => target === allowed || target.startsWith(`${allowed}/`));
}
