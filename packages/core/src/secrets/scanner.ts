/**
 * The offline secret scanner.
 *
 * One scanner is created per execution. It pins its rule configuration at
 * creation and generates the HMAC key its fingerprints are derived under, so
 * fingerprints are comparable within an execution and meaningless outside it.
 *
 * The scanner performs no network access, no rule download, no telemetry, and
 * no subprocess execution. Everything it needs is resolved from the module
 * graph at import time.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { lintSource } from "@secretlint/core";
import { creator as recommended } from "@secretlint/secretlint-rule-preset-recommend";
import { createFingerprinter, SecretScannerError, toSecretFinding } from "./findings.ts";
import type { SecretFinding } from "./findings.ts";

/** Scans text for credentials. Created once per execution. */
export interface SecretScanner {
  /** Findings for `content`, empty when nothing matched. */
  scan(content: string): Operation<SecretFinding[]>;
}

/** The subset of a Secretlint message a finding is built from. */
interface LintMessage {
  ruleId: string;
  messageId: string;
  range: readonly [number, number];
  loc?: { start: { line: number; column: number } };
}

/**
 * The detector call, isolated so a test can substitute a failing one.
 *
 * Deliberately not re-exported from the package: proving the scanner fails
 * closed requires a detector that throws, and there is no way to make the real
 * one throw on demand. Substituting it is a test concern, not an API.
 */
export type LintFn = (
  content: string,
  filePath: string,
) => Promise<{
  messages: readonly LintMessage[];
}>;

const CONFIG = {
  rules: [
    {
      id: "@secretlint/secretlint-rule-preset-recommend",
      rule: recommended,
    },
  ],
};

const lint: LintFn = (content, filePath) =>
  lintSource({
    source: { filePath, content, ext: ".jsonl", contentType: "text" },
    options: {
      config: CONFIG,
      // Masked messages are never read — findings carry no message at all —
      // but masking keeps the value out of anything Secretlint might log on
      // its own.
      maskSecrets: true,
    },
  });

/**
 * Create the scanner for one execution.
 *
 * `filePath` is what Secretlint reports findings against. It is a label only —
 * nothing is read from disk.
 */
export function createSecretScanner(filePath = "/journal.jsonl"): SecretScanner {
  return createScannerWith(lint, filePath);
}

/**
 * Internal seam: the scanner over an arbitrary detector.
 *
 * Not exported from `mod.ts`. See {@link LintFn}.
 */
export function createScannerWith(detect: LintFn, filePath = "/journal.jsonl"): SecretScanner {
  const fingerprint = createFingerprinter();

  return {
    *scan(content: string): Operation<SecretFinding[]> {
      if (content.length === 0) {
        return [];
      }

      let messages: readonly LintMessage[];

      try {
        // `until` releases this operation on cancellation but cannot cancel
        // the detector's promise; an in-flight scan may finish and be dropped.
        // What matters is that a cancelled scan never reaches its caller, so
        // nothing downstream persists.
        //
        // The result also carries `sourceContent`. It is normalized here and
        // never assigned anywhere that outlives this function.
        messages = (yield* until(detect(content, filePath))).messages;
      } catch {
        // The detector's own error can quote the content it choked on, so it
        // is dropped rather than wrapped.
        throw new SecretScannerError("scanning");
      }

      try {
        return messages.map((message) => toSecretFinding(message, content, fingerprint));
      } catch {
        throw new SecretScannerError("normalizing findings");
      }
    },
  };
}
