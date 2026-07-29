/**
 * The XMD-owned rules, and the contracts their thresholds encode.
 *
 * These rules exist because the recommended preset misses generic bearer
 * values, credential-bearing field names, and OpenAI keys without the
 * `T3BlbkFJ` marker. Their boundaries are load-bearing: too loose and
 * default-on detection blocks fixtures, too tight and it misses credentials.
 * Each threshold is tested at its exact edge rather than somewhere near it.
 *
 * Every canary is assembled at run time — a literal one is rejected by
 * GitHub's push protection — and none comes from the environment.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import type { SecretFinding } from "../src/secrets/findings.ts";
import { createSecretScanner } from "../src/secrets/scanner.ts";
import {
  isPlaceholder,
  looksLikeSecret,
  MIN_DISTINCT_CHARACTERS,
  MIN_SECRET_LENGTH,
} from "../src/secrets/rules.ts";

const A = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const OPAQUE = A.slice(0, 32);

/** Credentials the preset does not catch — the reason these rules exist. */
const CANARIES: Record<string, string> = {
  bearerHeader: `Authorization: Bearer ${A.slice(0, 40)}`,
  bearerJwt:
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  openaiPlain: `sk-${A.slice(0, 48)}`,
  openaiProject: `sk-proj-${A.slice(0, 48)}`,
};

/** The same credential field, in every spelling a journal actually carries. */
const FIELD_FORMS: Record<string, string> = {
  camelCase: `{"apiKey":"${OPAQUE}"}`,
  snake_case: `api_key=${OPAQUE}`,
  "kebab-case": `api-key: ${OPAQUE}`,
  spaced: `API KEY = ${OPAQUE}`,
  accessTokenCamel: `{"accessToken":"${OPAQUE}"}`,
  refreshTokenSnake: `refresh_token=${OPAQUE}`,
  clientSecretKebab: `client-secret: ${OPAQUE}`,
  sessionTokenSpaced: `session token = ${OPAQUE}`,
  authorizationField: `{"authorization":"${OPAQUE}"}`,
  passwordField: `{"password":"${OPAQUE}"}`,
  // A UUID is ordinary journal content on its own — and slice 1 proves a bare
  // one produces no finding. Inside a session-token field it is a credential,
  // because that is exactly the shape many session tokens take. The field
  // name is what changes the reading.
  uuidSessionToken: '{"sessionToken":"550e8400-e29b-41d4-a716-446655440000"}',
};

/** Content a journal is legitimately full of. */
const INNOCENT: Record<string, string> = {
  placeholderKey: '{"apiKey":"your-api-key-here"}',
  placeholderEnv: '{"authorization":"Bearer ${GITHUB_TOKEN}"}',
  placeholderShellEnv: "api_key=$GITHUB_TOKEN",
  placeholderRedacted: '{"password":"<redacted>"}',
  placeholderMask: '{"accessToken":"********"}',
  placeholderTemplate: '{"apiKey":"{{ api_key }}"}',
  shortPassword: '{"password":"changeme"}',
  emptyToken: '{"accessToken":""}',
  documentationValue: '{"apiKey":"example-key-for-documentation"}',
  bareUuid: '{"id":"550e8400-e29b-41d4-a716-446655440000"}',
};

describe("XMD credential rules", () => {
  for (const [name, content] of Object.entries(CANARIES)) {
    it(`rejects ${name}`, function* () {
      expect((yield* createSecretScanner().scan(content)).length).toBeGreaterThan(0);
    });
  }

  for (const [name, content] of Object.entries(FIELD_FORMS)) {
    it(`rejects a credential field written as ${name}`, function* () {
      expect((yield* createSecretScanner().scan(content)).length).toBeGreaterThan(0);
    });
  }

  for (const [name, content] of Object.entries(INNOCENT)) {
    it(`leaves ${name} alone`, function* () {
      expect(yield* createSecretScanner().scan(content)).toEqual([]);
    });
  }

  it("never puts the matched value in a finding", function* () {
    const scanner = createSecretScanner();

    for (const content of [...Object.values(CANARIES), ...Object.values(FIELD_FORMS)]) {
      const serialized = JSON.stringify(yield* scanner.scan(content));
      for (const chunk of content.match(/[A-Za-z0-9_.-]{16,}/g) ?? []) {
        expect(serialized).not.toContain(chunk);
      }
    }
  });
});

describe("scanning what persistence actually writes", () => {
  it("rejects a credential inside a root import_component event", function* () {
    // The root import journals the document source, so a credential written
    // into the document arrives at the gate through two levels of JSON
    // encoding: `{"apiKey":"…"}` in the file becomes `{\"apiKey\":\"…\"}` in
    // the serialized event. A rule that only accepts bare quotes stops working
    // exactly here — at the first event of every run.
    const source = `# Config\n\n\`\`\`json\n{"apiKey": "${OPAQUE}"}\n\`\`\`\n`;
    const event: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: "import_component", name: "__root__" },
      result: { status: "ok", value: { path: "README.md", content: source } },
    };

    const record = serializeDurableEvent(event);
    expect(record).toContain('\\"apiKey\\"');

    const findings = yield* createSecretScanner().scan(record);

    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(OPAQUE);
  });

  it("leaves a clean import_component event alone", function* () {
    const event: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: "import_component", name: "__root__" },
      result: {
        status: "ok",
        value: { path: "README.md", content: '# Doc\n\n{"apiKey": "your-api-key-here"}\n' },
      },
    };

    expect(yield* createSecretScanner().scan(serializeDurableEvent(event))).toEqual([]);
  });
});

describe("looksLikeSecret boundaries", () => {
  // Each fixture varies exactly one property and holds the other two clear of
  // their thresholds, so a failure names which contract broke.
  const MIXED_16 = "aB1cD2eF3gH4iJ5k";

  // deno-lint-ignore require-yield
  it("takes the exact minimum length and rejects one character less", function* () {
    expect(MIXED_16).toHaveLength(MIN_SECRET_LENGTH);
    expect(looksLikeSecret(MIXED_16)).toBe(true);
    expect(looksLikeSecret(MIXED_16.slice(0, MIN_SECRET_LENGTH - 1))).toBe(false);
  });

  // deno-lint-ignore require-yield
  it("takes the exact minimum distinct-character count and rejects one less", function* () {
    const atMinimum = "aB1cD2eF".repeat(3);
    const belowMinimum = "aB1cD2e".repeat(4).slice(0, 24);

    expect(new Set(atMinimum).size).toBe(MIN_DISTINCT_CHARACTERS);
    expect(new Set(belowMinimum).size).toBe(MIN_DISTINCT_CHARACTERS - 1);
    expect(atMinimum.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH);
    expect(belowMinimum.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH);
    expect(looksLikeSecret(atMinimum)).toBe(true);
    expect(looksLikeSecret(belowMinimum)).toBe(false);
  });

  // deno-lint-ignore require-yield
  it("needs more than one character class", function* () {
    // 20 distinct lowercase letters: long and varied, but one class only.
    expect(looksLikeSecret("abcdefghijklmnopqrst")).toBe(false);
    expect(looksLikeSecret("abcdefghijklmnopqrs1")).toBe(true);
  });
});

describe("placeholder recognition", () => {
  const PLACEHOLDERS = [
    "your-api-key-here",
    "example-key-for-documentation",
    "changeme",
    "test-token-value",
    "${GITHUB_TOKEN}",
    "$GITHUB_TOKEN",
    "<redacted>",
    "{{ api_key }}",
    "xxxxxxxxxxxxxxxx",
    "****************",
    "----------------",
    "none",
  ];

  for (const value of PLACEHOLDERS) {
    // deno-lint-ignore require-yield
    it(`treats ${value} as a placeholder`, function* () {
      expect(isPlaceholder(value)).toBe(true);
      expect(looksLikeSecret(value)).toBe(false);
    });
  }

  /**
   * The correction that matters: recognizing these words *anywhere* in a value
   * let a real credential through as soon as it happened to contain one.
   */
  const SECRETS_CONTAINING_PLACEHOLDER_WORDS = [
    `sk-live-test-${A.slice(0, 24)}`,
    `Xy9testAb3Kd8Qm2Zp7Lw`,
    `${A.slice(0, 16)}SAMPLE${A.slice(20, 32)}`,
    `dummyK3f9Qz2Lm8Xp4Rw7`,
    `${A.slice(0, 20)}-example`,
  ];

  for (const value of SECRETS_CONTAINING_PLACEHOLDER_WORDS) {
    // deno-lint-ignore require-yield
    it(`still rejects a secret-like value containing a placeholder word`, function* () {
      expect(isPlaceholder(value)).toBe(false);
      expect(looksLikeSecret(value)).toBe(true);
    });
  }

  it("rejects a credential field whose value merely mentions test", function* () {
    const findings = yield* createSecretScanner().scan(`{"apiKey":"Xy9testAb3Kd8Qm2Zp7Lw"}`);

    expect(findings.length).toBeGreaterThan(0);
  });
});

/**
 * A value is a placeholder only when the *whole* value is one. These are the
 * cases where an earlier version let a credential through: one segment equal
 * to a placeholder word was enough to excuse the rest.
 */
describe("a placeholder word in one segment does not excuse the value", () => {
  const SEGMENTED = ["aB1cD2e-test-F3gH4iJ5", "aB1cD2e-example-F3gH4iJ5"];

  for (const value of SEGMENTED) {
    // deno-lint-ignore require-yield
    it(`does not treat ${value} as a placeholder`, function* () {
      expect(isPlaceholder(value)).toBe(false);
      expect(looksLikeSecret(value)).toBe(true);
    });

    it(`detects ${value} in a credential field`, function* () {
      const findings = yield* createSecretScanner().scan(`{"apiKey":"${value}"}`);

      expect(findings.length).toBeGreaterThan(0);
      expect(JSON.stringify(findings)).not.toContain(value);
    });

    it(`detects ${value} in a Bearer header`, function* () {
      const findings = yield* createSecretScanner().scan(`Authorization: Bearer ${value}`);

      expect(findings.length).toBeGreaterThan(0);
      expect(JSON.stringify(findings)).not.toContain(value);
    });
  }

  const DOCUMENTATION = [
    "your-api-key-here",
    "example-key-for-documentation",
    "${GITHUB_TOKEN}",
    "$GITHUB_TOKEN",
    "<your-token>",
    "{{ api_key }}",
  ];

  for (const value of DOCUMENTATION) {
    it(`still leaves ${value} alone in a credential field`, function* () {
      expect(yield* createSecretScanner().scan(`{"apiKey":"${value}"}`)).toEqual([]);
    });
  }
});

describe("OpenAI-shaped documentation values", () => {
  const DOCUMENTED = ["sk-your-openai-api-key-here", "sk-proj-example-placeholder-key"];
  const REAL = [`sk-${A.slice(0, 48)}`, `sk-proj-${A.slice(0, 48)}`];

  for (const value of DOCUMENTED) {
    it(`leaves ${value} alone as raw text`, function* () {
      expect(yield* createSecretScanner().scan(`key: ${value}`)).toEqual([]);
    });

    it(`leaves ${value} alone inside a serialized root import`, function* () {
      const event: DurableEvent = {
        type: "yield",
        coroutineId: "root",
        description: { type: "import_component", name: "__root__" },
        result: {
          status: "ok",
          value: { path: "README.md", content: `Set OPENAI_API_KEY to ${value}.\n` },
        },
      };

      expect(yield* createSecretScanner().scan(serializeDurableEvent(event))).toEqual([]);
    });
  }

  for (const value of REAL) {
    it(`still detects a synthetic OpenAI key as raw text`, function* () {
      expect((yield* createSecretScanner().scan(`key: ${value}`)).length).toBeGreaterThan(0);
    });

    it(`still detects a synthetic OpenAI key inside a serialized root import`, function* () {
      const event: DurableEvent = {
        type: "yield",
        coroutineId: "root",
        description: { type: "import_component", name: "__root__" },
        result: { status: "ok", value: { path: "README.md", content: `key: ${value}\n` } },
      };

      const findings = yield* createSecretScanner().scan(serializeDurableEvent(event));

      expect(findings.length).toBeGreaterThan(0);
      expect(JSON.stringify(findings)).not.toContain(value);
    });
  }
});

describe("complete quoted field values", () => {
  // Stopping at the first space truncates this to `correct`, which is short
  // enough to fall under every threshold and be waved through.
  const PASSPHRASE = "correct horse Battery 123!";

  it("detects a passphrase with spaces and punctuation", function* () {
    const findings = yield* createSecretScanner().scan(`{"password":"${PASSPHRASE}"}`);

    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(PASSPHRASE);
    expect(JSON.stringify(findings)).not.toContain("horse");
  });

  it("detects the same passphrase inside a serialized event", function* () {
    const event: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: "import_component", name: "__root__" },
      result: {
        status: "ok",
        value: { path: "README.md", content: `{"password": "${PASSPHRASE}"}\n` },
      },
    };

    const record = serializeDurableEvent(event);
    expect(record).toContain('\\"password\\"');

    const findings = yield* createSecretScanner().scan(record);

    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(PASSPHRASE);
    expect(JSON.stringify(findings)).not.toContain("horse");
  });

  it("leaves a quoted documentation value alone", function* () {
    expect(yield* createSecretScanner().scan('{"password":"your-password-here"}')).toEqual([]);
  });
});

/**
 * A secret may contain the characters JSON uses to delimit and escape.
 *
 * Both cases put the escape near the *beginning* of a long value, which is
 * what makes them adversarial: a rule that stops at the first escape keeps
 * only the leading fragment, and a two-character fragment falls under every
 * threshold and is silently waved through.
 *
 * Fixtures are built with JSON.stringify so they are valid JSON by
 * construction rather than by hand-counting backslashes.
 */
describe("escapes inside a quoted credential field", () => {
  const TAIL = A.slice(0, 20);
  const WITH_QUOTE = `ab"cd${TAIL}`;
  const WITH_BACKSLASH = `ab\\cd${TAIL}`;

  /** The document text a producer would write. */
  const rawField = (secret: string): string => JSON.stringify({ password: secret });

  /** That same document text, journalled as a root import event. */
  const importEvent = (secret: string): DurableEvent => ({
    type: "yield",
    coroutineId: "root",
    description: { type: "import_component", name: "__root__" },
    result: {
      status: "ok",
      value: { path: "README.md", content: `${rawField(secret)}\n` },
    },
  });

  /** Nothing that could rebuild the secret may survive into a finding. */
  function assertOpaque(findings: unknown, secret: string): void {
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(TAIL);
    expect(serialized).not.toContain(TAIL.slice(0, 8));
  }

  const CASES: Record<string, string> = {
    "an escaped quote": WITH_QUOTE,
    "a literal backslash": WITH_BACKSLASH,
    // A closing quote cannot be recognized by the character after it: both of
    // these put a JSON delimiter directly after an escaped quote *inside* the
    // value, so any rule keyed on what follows ends the value here and keeps
    // only `ab`.
    "an escaped quote before a comma": `ab",cd${TAIL}`,
    "an escaped quote before whitespace": `ab" cd${TAIL}`,
  };

  for (const [name, secret] of Object.entries(CASES)) {
    it(`detects a value containing ${name}, as raw JSON`, function* () {
      const findings = yield* createSecretScanner().scan(rawField(secret));

      expect(findings.length).toBeGreaterThan(0);
      assertOpaque(findings, secret);
    });

    it(`detects a value containing ${name}, inside a serialized root import`, function* () {
      const findings = yield* createSecretScanner().scan(
        serializeDurableEvent(importEvent(secret)),
      );

      expect(findings.length).toBeGreaterThan(0);
      assertOpaque(findings, secret);
    });
  }
});

/**
 * One credential, three encodings, one scanner.
 *
 * A finding's fingerprint is derived from the text its reported range covers,
 * so the range has to start at the credential itself. An offset left pointing
 * at an opening quote hashes a different slice, and the same credential then
 * carries two fingerprints depending on whether it happened to be quoted —
 * which defeats the one thing a fingerprint is for.
 */
describe("reported offsets locate the credential itself", () => {
  const CRED = "aB3xK9mQ7pL2wR5t";

  const unquoted = `password=${CRED}`;
  const quoted = `{"password":"${CRED}"}`;
  const serialized = serializeDurableEvent({
    type: "yield",
    coroutineId: "root",
    description: { type: "import_component", name: "__root__" },
    result: { status: "ok", value: { path: "README.md", content: quoted } },
  });

  /** The XMD field finding, which is the one whose offset is under test. */
  function* fieldFinding(
    scanner: { scan: (c: string) => Operation<SecretFinding[]> },
    content: string,
  ) {
    const findings = (yield* scanner.scan(content)).filter(
      (finding) => finding.ruleId === "@executablemd/secretlint-rule-credentials",
    );
    expect(findings).toHaveLength(1);
    return findings[0]!;
  }

  it("gives one credential one fingerprint across all three encodings", function* () {
    // One scanner, so one HMAC key — fingerprints are only comparable within
    // a single execution by design.
    const scanner = createSecretScanner();

    const fromUnquoted = yield* fieldFinding(scanner, unquoted);
    const fromQuoted = yield* fieldFinding(scanner, quoted);
    const fromSerialized = yield* fieldFinding(scanner, serialized);

    expect(fromQuoted.fingerprint).toBe(fromUnquoted.fingerprint);
    expect(fromSerialized.fingerprint).toBe(fromUnquoted.fingerprint);
  });

  it("reports the credential's own index, not the quote or escape in front of it", function* () {
    const scanner = createSecretScanner();

    for (const content of [unquoted, quoted, serialized]) {
      const finding = yield* fieldFinding(scanner, content);

      // Every fixture is one line, so the column is the index in the string.
      expect(finding.location.line).toBe(1);
      expect(finding.location.column).toBe(content.indexOf(CRED));
      expect(content.slice(finding.location.column, finding.location.column + CRED.length)).toBe(
        CRED,
      );
    }
  });
});
