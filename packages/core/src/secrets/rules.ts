/**
 * XMD-owned credential rules.
 *
 * These close measured gaps in `@secretlint/secretlint-rule-preset-recommend`.
 * Every one is high-confidence and pattern-based: this module does not attempt
 * probabilistic PII classification or entropy scanning.
 *
 * Gaps closed, verified against the preset:
 *
 * - a generic `Authorization: Bearer <opaque>` value, which no preset rule
 *   matches;
 * - OpenAI keys that lack the `T3BlbkFJ` marker the preset's rule requires;
 * - credential-bearing structured fields such as `apiKey` and `accessToken`.
 */

import type { SecretLintRuleCreator } from "@secretlint/types";

/**
 * Credential field names, as word parts.
 *
 * Journals carry the same field under every convention a producer happens to
 * use — `apiKey` from JSON, `api_key` from a shell environment, `api-key` from
 * a YAML header, `API KEY` from prose. Splitting the names into parts lets one
 * pattern accept all of them instead of a rule that silently only covers
 * whichever spelling its author had in mind.
 */
const CREDENTIAL_FIELDS = [
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
];

/** `api[-_ ]?key`, matching camelCase, snake_case, kebab-case, and spaced. */
const FIELD_NAMES = CREDENTIAL_FIELDS.map((parts) => parts.join("[-_ ]?")).join("|");

/**
 * A value that names a credential instead of being one.
 *
 * Recognition is restricted to *complete* placeholder values and deliberate
 * placeholder forms. An earlier version matched these words anywhere in the
 * value, which meant a real credential was waved through as soon as it
 * happened to contain `test` — the substring check was a hole, not a
 * convenience.
 */
const PLACEHOLDER_WORDS = new Set([
  "example",
  "placeholder",
  "redacted",
  "dummy",
  "sample",
  "changeme",
  "change",
  "todo",
  "fixme",
  "test",
  "fake",
  "your",
  "my",
  "the",
  "here",
  "value",
  "goes",
  "xxx",
]);

/** Deliberate placeholder syntax. The whole value, never a fragment of one. */
const EXPLICIT_FORMS = [
  /^\$\{[^}]*\}$/, // ${GITHUB_TOKEN}
  /^\$[A-Za-z_][A-Za-z0-9_]*$/, // $GITHUB_TOKEN
  /^<[^>]*>$/, // <redacted>
  /^\{\{[^}]*\}\}$/, // {{ api_key }}
  /^x+$/i,
  /^\*+$/,
  /^\.+$/,
  /^-+$/,
  /^(none|null|undefined|empty|unset|omitted|redacted)$/i,
];

/**
 * Documentation prose: lowercase words joined by single separators.
 *
 * Every segment must be lowercase letters only. That is the line between
 * prose and a credential, and it has to be enforced case-sensitively — an
 * earlier version applied the `i` flag to this pattern, which quietly made
 * `[a-z]` match uppercase and let `aB1cD2e-test-F3gH4iJ5` pass as words.
 * Digits are excluded for the same reason.
 */
const WORDS = /^[a-z]{1,15}(?:[-_ .][a-z]{1,15})*$/;

/**
 * Whether a value names a credential instead of being one.
 *
 * A value qualifies only as a *complete* placeholder: deliberate syntax, or
 * prose in which every segment is a word and at least one is a placeholder
 * word. Containing a placeholder word is never enough on its own — treating
 * it as enough is a hole a real credential walks through as soon as it
 * happens to include `test`.
 */
export function isPlaceholder(value: string): boolean {
  if (EXPLICIT_FORMS.some((form) => form.test(value))) {
    return true;
  }
  if (!WORDS.test(value)) {
    return false;
  }
  return value.split(/[-_ .]/).some((segment) => PLACEHOLDER_WORDS.has(segment));
}

/** The minimum length a value must reach before it can be a credential. */
export const MIN_SECRET_LENGTH = 16;

/** The minimum number of distinct characters a credential-like value has. */
export const MIN_DISTINCT_CHARACTERS = 8;

/**
 * A value long and varied enough to plausibly be a real credential.
 *
 * The thresholds are the documented trade-off: a genuinely short or
 * low-entropy secret in a credential-named field can pass here. Rejecting on
 * the field name alone would stop runs over `password: changeme` in a fixture,
 * and the only remedy available is disabling detection wholesale — which turns
 * off every provider rule too.
 */
export function looksLikeSecret(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH) {
    return false;
  }
  if (isPlaceholder(value)) {
    return false;
  }

  // A credential mixes character classes. Prose, file paths, and repeated
  // filler do not, and those are what a journal is otherwise full of.
  const classes = [/[a-z]/, /[A-Z0-9]/, /[^A-Za-z]/].filter((cls) => cls.test(value)).length;
  if (classes < 2) {
    return false;
  }

  return new Set(value).size >= MIN_DISTINCT_CHARACTERS;
}

/**
 * Messages never quote the matched value — a finding carries no message at
 * all, and Secretlint's own reporting must stay safe if it ever renders one.
 */
const messages = {
  BEARER_TOKEN: {
    en: () => "found an authorization bearer token",
  },
  CREDENTIAL_FIELD: {
    en: () => "found a credential-bearing field with a secret-like value",
  },
  OPENAI_KEY: {
    en: () => "found an OpenAI API key",
  },
};

/**
 * A quote that may be backslash-escaped.
 *
 * The gate scans `serializeDurableEvent()` output, so a credential inside a
 * journalled document arrives as `{\"apiKey\":\"…\"}` — one level of JSON
 * escaping deeper than the same text on disk. A rule that only accepts bare
 * quotes silently stops working at exactly the boundary it exists to guard.
 */
const Q = `\\\\?["']?`;

/** `Authorization: Bearer <opaque>`, and the bare `Bearer <token>` form. */
const BEARER = new RegExp(
  `(?<=authorization${Q}\\s*[:=]\\s*${Q}|\\bBearer\\s)(?:Bearer\\s+)?([A-Za-z0-9._~+/=-]{16,})`,
  "gi",
);

/** `sk-` and `sk-proj-` keys, with or without the preset's `T3BlbkFJ` marker. */
const OPENAI = /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;

/**
 * A credential-named field and its complete value.
 *
 * A quoted value runs to its closing quote, spaces and punctuation included —
 * stopping at the first space truncates `"correct horse Battery 123!"` to
 * `correct`, which is short enough to fall under every threshold and be
 * waved through. Only an unquoted value ends at whitespace.
 */
const FIELD = new RegExp(
  `${Q}\\b(?:${FIELD_NAMES})\\b${Q}\\s*[:=]\\s*` +
    `(?:\\\\?"([^"\\\\]+)\\\\?"|\\\\?'([^'\\\\]+)\\\\?'|([^\\s,}"'\\\\]+))`,
  "gi",
);

/** An auth scheme in front of the value it carries. */
const SCHEME = /^(?:Bearer|Token|Basic|ApiKey)\s+/i;

/**
 * The XMD rule. Registered alongside the recommended preset; the two are
 * independent, so an overlap simply produces two findings for one value.
 */
export const xmdCredentialRule: SecretLintRuleCreator = {
  meta: {
    id: "@executablemd/secretlint-rule-credentials",
    recommended: true,
    type: "scanner",
    supportedContentTypes: ["text"],
    docs: {
      url: "https://executable.md/docs/journal",
    },
  },
  messages,
  create(context, _options) {
    const t = context.createTranslator(messages);

    return {
      file(source) {
        report(source.content, BEARER, "BEARER_TOKEN");
        report(source.content, OPENAI, "OPENAI_KEY");
        report(source.content, FIELD, "CREDENTIAL_FIELD");

        function report(content: string, pattern: RegExp, messageId: keyof typeof messages): void {
          // A /g regex carries lastIndex across calls; each scan starts fresh.
          pattern.lastIndex = 0;

          for (const match of content.matchAll(pattern)) {
            // The value is the first capture that participated, or the whole
            // match for a pattern that captures nothing (OpenAI).
            const value = match.slice(1).find((group) => group !== undefined) ?? match[0];
            if (value === undefined || match.index === undefined) {
              continue;
            }

            // `authorization: Bearer <token>` carries its scheme into the
            // field value; the credential is what follows it.
            const credential = value.replace(SCHEME, "");

            if (messageId === "OPENAI_KEY") {
              // An OpenAI-shaped value still has to be a value. A documented
              // `sk-your-openai-api-key-here` is prose that happens to wear
              // the prefix, and rejecting it would block documentation.
              if (isPlaceholder(credential.replace(/^sk-(?:proj-)?/, ""))) {
                continue;
              }
            } else if (!looksLikeSecret(credential)) {
              continue;
            }

            const start = match.index + match[0].lastIndexOf(credential);
            context.report({
              message: t(messageId),
              range: [start, start + credential.length],
            });
          }
        }
      },
    };
  },
};
