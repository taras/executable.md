/**
 * Which provider a canonical Issue target selects when a context named none.
 *
 * The table lives with the trusted host rather than in the shared boundary, and
 * that placement is enforced: the shared coordination surface may not name a
 * provider, because the first adapter naming itself in a shared contract is how
 * a neutral boundary quietly becomes one provider's. A host installs adapters,
 * so a host is what knows which well-known service is behind a host name.
 *
 * Wherever it lives, the mapping is a compatibility contract. The resolved
 * provider is part of durable identity, so a target that selected one provider
 * yesterday and another today would ask a different service about the same
 * retained position. Changing an entry here is a breaking change.
 *
 * A host name with no entry resolves to nothing, and `<Issue>` then refuses
 * locally with the remedy: a context that names the provider outright. That is
 * the ordinary path for a self-hosted tracker, and it is deliberately not a
 * guess.
 */

/** The well-known hosts this host resolves without being told. */
const WELL_KNOWN: readonly { readonly host: string; readonly provider: string }[] = Object.freeze([
  Object.freeze({ host: "github.com", provider: "github" }),
]);

/** The suffix form, for services that give every tenant its own subdomain. */
const TENANTED: readonly { readonly suffix: string; readonly provider: string }[] = Object.freeze([
  Object.freeze({ suffix: ".atlassian.net", provider: "atlassian" }),
]);

/** The provider this canonical target selects on its own, or `undefined`. */
export function builtInIssueProvider(target: string): string | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  const exact = WELL_KNOWN.find((entry) => entry.host === url.hostname);
  if (exact !== undefined) {
    return exact.provider;
  }
  const tenanted = TENANTED.find((entry) => url.hostname.endsWith(entry.suffix));
  return tenanted?.provider;
}
