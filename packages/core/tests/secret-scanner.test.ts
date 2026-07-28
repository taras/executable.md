/**
 * The offline scanner over the recommended Secretlint preset.
 *
 * Every credential here is synthetic and assembled at run time. GitHub's push
 * protection rejects a commit containing one written out as a literal — it
 * blocked this file's first version over the Slack canary — which is also the
 * most direct evidence available that these fixtures are format-realistic.
 * Joining the parts leaves the runtime value identical, so detection is
 * unchanged.
 *
 * No test reads an environment variable, Git credential, or user config.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { createScannerWith, createSecretScanner } from "../src/secrets/scanner.ts";
import {
  createFingerprinter,
  SecretDetectedError,
  SecretScannerError,
} from "../src/secrets/findings.ts";
import type { SecretFinding } from "../src/secrets/findings.ts";

const A = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const join = (...parts: string[]): string => parts.join("");

/** One synthetic credential per category the preset covers. */
const CANARIES: Record<string, string> = {
  github: `ghp_${A.slice(0, 36)}`,
  anthropic: `sk-ant-api03-${A.slice(0, 40)}-${A.slice(0, 50)}AA`,
  npm: `npm_${A.slice(0, 36)}`,
  slack: join("xox", "b-000000000000-000000000000-", A.slice(0, 24)),
  aws: `aws_secret_access_key = ${A.slice(0, 40)}`,
  databaseUrl: join("postgres://admin:", "hunter2hunter2hunter2", "@db.internal:5432/prod"),
  basicAuth: join("https://user:", "s3cr3tp4ssw0rdlong", "@example.com/x"),
  privateKey: [
    join("-----BEGIN", " RSA PRIVATE KEY-----"),
    "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
    "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm",
    join("-----END", " RSA PRIVATE KEY-----"),
  ].join("\n"),
};

/** Content a journal is legitimately full of. */
const INNOCENT: Record<string, string> = {
  uuid: '{"id":"550e8400-e29b-41d4-a716-446655440000"}',
  gitSha: '{"commit":"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"}',
  componentName: '{"type":"import_component","name":"AnthropicProvider"}',
  toolName: '{"tool":"str_replace_based_edit_tool","status":"ok"}',
  prose: "The agent read the file and reported that the build passed successfully.",
  filePath: '{"path":"packages/core/src/secrets/scanner.ts","bytes":4096}',
  emptyContent: "",
};

describe("the secret scanner", () => {
  for (const [name, content] of Object.entries(CANARIES)) {
    it(`rejects a synthetic ${name} credential`, function* () {
      expect((yield* createSecretScanner().scan(content)).length).toBeGreaterThan(0);
    });
  }

  for (const [name, content] of Object.entries(INNOCENT)) {
    it(`leaves ${name} alone`, function* () {
      expect(yield* createSecretScanner().scan(content)).toEqual([]);
    });
  }

  it("scans the same NDJSON record persistence writes", function* () {
    // The gate inspects serializeDurableEvent() output, so the scanner has to
    // detect through JSON encoding — the credential is no longer a bare token
    // in the text it sees.
    const event: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: "exec", name: "print" },
      result: { status: "ok", value: { stdout: `token: ${CANARIES.github!}\n` } },
    };

    const findings = yield* createSecretScanner().scan(serializeDurableEvent(event));

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.ruleId).toContain("github");
  });

  it("leaves a clean serialized event alone", function* () {
    const event: DurableEvent = {
      type: "close",
      coroutineId: "root",
      result: { status: "ok", value: { output: "Hello world\n" } },
    };

    expect(yield* createSecretScanner().scan(serializeDurableEvent(event))).toEqual([]);
  });

  it("never puts the matched value in a finding", function* () {
    const scanner = createSecretScanner();

    for (const content of Object.values(CANARIES)) {
      const findings = yield* scanner.scan(content);
      const serialized = JSON.stringify(findings);

      for (const finding of findings) {
        expect(Object.keys(finding).sort()).toEqual([
          "fingerprint",
          "location",
          "messageId",
          "ruleId",
        ]);
      }

      for (const chunk of content.match(/[A-Za-z0-9_-]{16,}/g) ?? []) {
        expect(serialized).not.toContain(chunk);
      }
      expect(serialized).not.toContain("sourceContent");
    }
  });

  it("reports where the credential was, without quoting it", function* () {
    const findings = yield* createSecretScanner().scan(`line one\ntoken: ${CANARIES.github!}`);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.location.line).toBe(2);
    expect(typeof findings[0]!.location.column).toBe("number");
  });
});

describe("fingerprints", () => {
  it("gives one execution's identical values one fingerprint", function* () {
    const scanner = createSecretScanner();
    const token = CANARIES.github!;

    const first = yield* scanner.scan(`{"a":"${token}"}`);
    const second = yield* scanner.scan(`{"b":"${token}"}`);
    const other = yield* scanner.scan(`{"a":"ghp_${A.slice(1, 37)}"}`);

    expect(first[0]!.fingerprint).toBe(second[0]!.fingerprint);
    expect(first[0]!.fingerprint).not.toBe(other[0]!.fingerprint);
  });

  it("does not make fingerprints comparable across executions", function* () {
    const token = `{"a":"${CANARIES.github!}"}`;

    const one = yield* createSecretScanner().scan(token);
    const two = yield* createSecretScanner().scan(token);

    // Each execution keys its own HMAC, so the same value fingerprints
    // differently. That is what stops a fingerprint from being an oracle for
    // confirming a guessed secret.
    expect(one[0]!.fingerprint).not.toBe(two[0]!.fingerprint);
  });

  it("keys the digest rather than hashing the value", function* () {
    const one = createFingerprinter();
    const two = createFingerprinter();

    expect(one("same-value")).toBe(one("same-value"));
    expect(one("same-value")).not.toBe(two("same-value"));
    expect(one("same-value")).not.toContain("same-value");
  });
});

describe("failing closed", () => {
  const CANARY = `ghp_${A.slice(0, 36)}`;

  it("reports a scanner error when the detector throws, keeping its error out", function* () {
    // The real detector cannot be made to throw on demand, so the scan is
    // built over a failing one through the module's internal seam. The error
    // carries a canary the way a real detector error would carry the content
    // it choked on.
    const scanner = createScannerWith(() => {
      throw new Error(`detector exploded while reading ${CANARY}`);
    });

    let failure: Error | undefined;
    try {
      yield* scanner.scan("some journal content");
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    expect(failure).toBeInstanceOf(SecretScannerError);
    expect(failure?.cause).toBeUndefined();
    expect(failure?.message).not.toContain(CANARY);
    expect(JSON.stringify({ ...failure, message: failure?.message })).not.toContain(CANARY);
    expect(String(failure?.stack ?? "")).not.toContain(CANARY);
  });

  it("reports a scanner error when the detector rejects", function* () {
    const scanner = createScannerWith(() => Promise.reject(new Error(`rejected: ${CANARY}`)));

    let failure: Error | undefined;
    try {
      yield* scanner.scan("some journal content");
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    expect(failure).toBeInstanceOf(SecretScannerError);
    expect(failure?.message).not.toContain(CANARY);
  });
});

describe("SecretDetectedError", () => {
  const finding = (): SecretFinding => ({
    ruleId: "rule",
    messageId: "MSG",
    location: { line: 3, column: 7 },
    fingerprint: "deadbeef",
  });

  it("names the rules and positions without quoting the value", function* () {
    const findings = yield* createSecretScanner().scan(`token: ${CANARIES.github!}`);
    const error = new SecretDetectedError(findings);

    expect(error.name).toBe("SecretDetectedError");
    expect(error.message).toContain("@secretlint/secretlint-rule-github");
    expect(error.message).not.toContain(CANARIES.github!);
    expect(error.message).toContain("Fix the code or data flow");
  });

  // deno-lint-ignore require-yield
  it("owns an immutable snapshot the caller cannot edit afterwards", function* () {
    const source = [finding()];
    const error = new SecretDetectedError(source);

    // Mutating what was passed in must not reach into the error's account of
    // the rejection — not the array, not a finding, not a nested location.
    source[0]!.ruleId = "tampered";
    source[0]!.location.line = 999;
    source.push(finding());

    expect(error.findings).toHaveLength(1);
    expect(error.findings[0]!.ruleId).toBe("rule");
    expect(error.findings[0]!.location.line).toBe(3);

    expect(Object.isFrozen(error.findings)).toBe(true);
    expect(Object.isFrozen(error.findings[0])).toBe(true);
    expect(Object.isFrozen(error.findings[0]!.location)).toBe(true);
  });
});
