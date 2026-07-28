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
const PLACEHOLDER_WORDS =
  "example|placeholder|redacted|dummy|sample|changeme|change|todo|fixme|test|fake|your|my|the|here|value|goes|xxx";

const PLACEHOLDER = new RegExp(
  [
    // Deliberate placeholder syntax, whole value only.
    "^\\$\\{[^}]*\\}$", // ${GITHUB_TOKEN}
    "^\\$[A-Za-z_][A-Za-z0-9_]*$", // $GITHUB_TOKEN
    "^<[^>]*>$", // <redacted>
    "^\\{\\{[^}]*\\}\\}$", // {{token}}
    "^x+$",
    "^\\*+$",
    "^\\.+$",
    "^-+$",
    "^(none|null|undefined|empty|unset|omitted|redacted)$",
    // Documentation prose: lowercase *words* joined by one separator, at
    // least one of which is a placeholder word. `your-api-key-here` and
    // `example-key-for-documentation` qualify.
    //
    // Segments are length-bounded because that is what separates a word from
    // a credential: `dummyabcdefghijklmnopqrstuvwx` and
    // `sk-live-test-abcdefghijklmnopqrstuvwx` both contain a placeholder word
    // but carry a random run no word ever looks like, and neither may be
    // waved through.
    `^[a-z0-9]{1,15}(?:[-_ .][a-z0-9]{1,15})*$(?<=(?:^|[-_ .])(?:${PLACEHOLDER_WORDS})(?:[-_ .].*)?)`,
  ].join("|"),
  "i",
);

/**
 * Whether a value is a placeholder rather than a credential.
 *
 * Split out so the contract is testable directly: the boundary between
 * "documented placeholder" and "secret that happens to contain a word like
 * test" is the difference between usable default-on detection and a rule that
 * either blocks fixtures or misses real credentials.
 */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
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

/** A credential-named field and its value, in JSON, YAML, env, or escaped JSON. */
const FIELD = new RegExp(`${Q}\\b(?:${FIELD_NAMES})\\b${Q}\\s*[:=]\\s*${Q}([^"'\\s,}\\\\]+)`, "gi");

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
        report(source.content, BEARER, 1, "BEARER_TOKEN");
        report(source.content, OPENAI, 0, "OPENAI_KEY");
        report(source.content, FIELD, 1, "CREDENTIAL_FIELD");

        function report(
          content: string,
          pattern: RegExp,
          group: number,
          messageId: keyof typeof messages,
        ): void {
          // A /g regex carries lastIndex across calls; each scan starts fresh.
          pattern.lastIndex = 0;

          for (const match of content.matchAll(pattern)) {
            const value = group === 0 ? match[0] : match[group];
            if (value === undefined || match.index === undefined) {
              continue;
            }
            if (messageId !== "OPENAI_KEY" && !looksLikeSecret(value)) {
              continue;
            }

            const start = match.index + match[0].lastIndexOf(value);
            context.report({
              message: t(messageId),
              range: [start, start + value.length],
            });
          }
        }
      },
    };
  },
};
