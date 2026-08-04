/**
 * Safe findings.
 *
 * A Secretlint result carries `sourceContent` — the complete text that was
 * scanned. Nothing in this module ever stores, returns, throws, or logs one.
 * A raw result is normalized to a {@link SecretFinding} at the moment it is
 * produced and then dropped, so no later code has the chance to leak it.
 */

import { createHmac } from "node:crypto";

/**
 * One detection, carrying nothing that could reconstruct the secret.
 *
 * The matched value is deliberately absent, and so is Secretlint's message —
 * `maskSecrets: true` masks it today, but a field that is never populated
 * cannot be un-masked by a future change to how masking works.
 */
export interface SecretFinding {
  /** The rule that matched, e.g. `@secretlint/secretlint-rule-github`. */
  ruleId: string;
  /** The rule's message identifier, e.g. `GITHUB_TOKEN`. */
  messageId: string;
  /** Where in the scanned text the match began. */
  location: {
    line: number;
    column: number;
  };
  /**
   * A keyed digest of the matched value, comparable only within the execution
   * that produced it. See {@link createFingerprinter}.
   */
  fingerprint: string;
}

/**
 * Derives fingerprints for one execution.
 *
 * The digest is an HMAC under a key generated in memory for this execution,
 * not a plain hash. A plain hash would be an oracle: anyone holding a
 * candidate secret could confirm it by recomputing the digest and comparing.
 * Keying it removes that, and costs only cross-execution comparability, which
 * nothing needs — a fingerprint exists to tell "this same value appeared
 * twice in this run" from "these are two different values".
 *
 * The key never leaves this closure: it is not persisted, logged, exposed on
 * a finding, or reachable from one.
 */
export function createFingerprinter(): (matched: string) => string {
  const key = crypto.getRandomValues(new Uint8Array(32));

  return function fingerprint(matched: string): string {
    return createHmac("sha256", key).update(matched).digest("hex").slice(0, 32);
  };
}

/**
 * Normalize one Secretlint message into a safe finding.
 *
 * `source` is the text that was scanned. The matched slice is read from it,
 * handed straight to the fingerprinter, and goes out of scope when this
 * function returns — it is never assigned to the finding.
 */
export function toSecretFinding(
  message: {
    ruleId: string;
    messageId: string;
    range: readonly [number, number];
    loc?: { start: { line: number; column: number } };
  },
  source: string,
  fingerprint: (matched: string) => string,
): SecretFinding {
  return {
    ruleId: message.ruleId,
    messageId: message.messageId,
    location: {
      line: message.loc?.start.line ?? 1,
      column: message.loc?.start.column ?? 0,
    },
    fingerprint: fingerprint(source.slice(message.range[0], message.range[1])),
  };
}

function describe(findings: readonly SecretFinding[]): string {
  return findings
    .map((finding) => `  ${finding.ruleId} at ${finding.location.line}:${finding.location.column}`)
    .join("\n");
}

/**
 * A credential was found in content that was about to be persisted.
 *
 * There is no allowlist, approval, or repair: a finding means a code or
 * data-flow defect that has to be fixed. The message names the rules and
 * positions and nothing else, so this error stays safe when it is serialized
 * into a close event or rendered as a printed error.
 */
export class SecretDetectedError extends Error {
  readonly findings: readonly SecretFinding[];

  constructor(findings: readonly SecretFinding[]) {
    super(
      `secret detection rejected content before it was persisted:\n${describe(findings)}\n` +
        `Fix the code or data flow that produced it.`,
    );
    this.name = "SecretDetectedError";
    this.findings = snapshot(findings);
  }
}

/**
 * An immutable copy of what was found.
 *
 * Freezing only the array would leave every finding — and every nested
 * `location` — writable through it, so a caller could edit the record of a
 * rejection after the fact. This error is the account of why content was
 * refused; it should not be editable by whoever receives it.
 */
function snapshot(findings: readonly SecretFinding[]): readonly SecretFinding[] {
  return Object.freeze(
    findings.map((finding) =>
      Object.freeze({
        ruleId: finding.ruleId,
        messageId: finding.messageId,
        location: Object.freeze({
          line: finding.location.line,
          column: finding.location.column,
        }),
        fingerprint: finding.fingerprint,
      }),
    ),
  );
}

/**
 * The detector itself failed, so the content could not be cleared.
 *
 * Failing closed is the point: an unusable detector must not become an open
 * gate. The originating error is deliberately dropped rather than attached as
 * `cause`, because a detector stack trace can quote the content it choked on.
 */
export class SecretScannerError extends Error {
  constructor(stage: string) {
    super(
      `secret detection failed during ${stage}, so the content was not persisted. ` +
        `The underlying error is withheld because it can contain scanned content.`,
    );
    this.name = "SecretScannerError";
  }
}
