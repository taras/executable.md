/**
 * The credential gate a run's owner can apply for itself.
 *
 * Secret detection belongs where the write happens, for the same reason schema
 * judgment does: a caller that decides for itself decides nothing. The full
 * scanner is `@secretlint`'s and needs a Node runtime, which a run's owner does
 * not have — so the owner applies this, and the runner applies the full scanner
 * as well before it offers anything.
 *
 * This is deliberately a floor and not a replacement. It matches the shapes
 * that are unambiguous on sight — issued token formats, a bearer credential,
 * and a credential-named field carrying an opaque value — and it matches them
 * with the same conservatism the repository's own rules use: a placeholder is
 * not a credential, and neither is a short or obviously descriptive value.
 *
 * What it must never do is report what it matched. A diagnostic quoting the
 * value would publish, in a place nothing filters, exactly what the gate exists
 * to keep out of retained state.
 */

/** What was recognized, named by kind and never by content. */
export interface CredentialSighting {
  /** The kind of credential this looks like, as a stable name. */
  readonly kind: string;
}

/** Issued token formats that are unmistakable on sight. */
const ISSUED: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { kind: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { kind: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "stripe-key", pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/ },
  { kind: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "private-key-block", pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  {
    kind: "json-web-token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

/** A bearer credential, whatever issued it. */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i;

/**
 * Field names that carry a credential, as word parts.
 *
 * The same field arrives under every convention a producer happens to use —
 * `apiKey` from JSON, `api_key` from an environment, `api-key` from a header —
 * so the names are matched by their parts rather than by one spelling.
 */
const FIELDS = [
  ["api", "key"],
  ["access", "token"],
  ["refresh", "token"],
  ["client", "secret"],
  ["session", "token"],
  ["secret", "key"],
  ["private", "key"],
  ["auth", "token"],
  ["authorization"],
  ["password"],
  ["passwd"],
  ["apikey"],
]
  .map((parts) => parts.join("[-_ ]?"))
  .join("|");

/**
 * A credential-named field carrying an opaque value.
 *
 * The value has to look like a secret rather than like prose: long enough to be
 * one, and drawn from the alphabet issued credentials use.
 */
const NAMED_FIELD = new RegExp(`"?(?:${FIELDS})"?\\s*[:=]\\s*"?([A-Za-z0-9._~+/-]{12,})"?`, "i");

/** Words that mark a value as a stand-in rather than a credential. */
const PLACEHOLDERS = [
  "example",
  "placeholder",
  "redacted",
  "dummy",
  "sample",
  "changeme",
  "todo",
  "fixme",
  "your",
  "xxxx",
];

/**
 * Everything this recognizes in one piece of content, by kind.
 *
 * Deduplicated, because a kind seen twice is the same finding about the same
 * delivery, and ordered so two runs describe one value the same way.
 */
export function sightCredentials(content: string): CredentialSighting[] {
  const found = new Set<string>();
  for (const { kind, pattern } of ISSUED) {
    if (pattern.test(content)) {
      found.add(kind);
    }
  }
  if (BEARER.test(content)) {
    found.add("bearer-credential");
  }
  const named = NAMED_FIELD.exec(content);
  if (named !== null && !placeholder(named[1] ?? "")) {
    found.add("credential-field");
  }
  return [...found].toSorted().map((kind) => ({ kind }));
}

/** Whether a matched value reads as a stand-in rather than as a credential. */
function placeholder(value: string): boolean {
  const lowered = value.toLowerCase();
  return PLACEHOLDERS.some((word) => lowered.includes(word));
}

/** What a refusal says, which is the kinds and never the content. */
export function describeCredentials(sightings: readonly CredentialSighting[]): string {
  return sightings.map((sighting) => sighting.kind).join(", ");
}
