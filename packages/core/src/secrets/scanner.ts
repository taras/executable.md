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
import { lintSource } from "./secretlint.ts";
import { creator as recommended } from "@secretlint/secretlint-rule-preset-recommend";
import { createFingerprinter, SecretScannerError, toSecretFinding } from "./findings.ts";
import type { SecretFinding } from "./findings.ts";
import { xmdCredentialRule } from "./rules.ts";

/** Scans text for credentials. Created once per execution. */
export interface SecretScanner {
  /** Findings for `content`, empty when nothing matched. */
  scan(content: string): Operation<SecretFinding[]>;
}

/**
 * Where one detection matched, in the coordinates of the scanned text.
 *
 * Core-private and never journaled, rendered or attached to an error: a range
 * over text that holds a credential is a pointer at that credential. It
 * exists so the one owner that may present or approve a reply's findings can
 * say exactly which bytes it presented and approved.
 */
export interface SecretSpan {
  readonly ruleId: string;
  readonly messageId: string;
  readonly start: number;
  readonly end: number;
}

class RangedScanner implements SecretScanner {
  readonly scan: SecretScanner["scan"];
  readonly #ranges: (content: string) => Operation<SecretSpan[]>;

  constructor(scan: SecretScanner["scan"], ranges: (content: string) => Operation<SecretSpan[]>) {
    this.scan = scan;
    this.#ranges = ranges;
  }

  static locate(scanner: SecretScanner, content: string): Operation<SecretSpan[]> | undefined {
    return #ranges in scanner ? scanner.#ranges(content) : undefined;
  }
}

/**
 * Where `scanner` finds credentials in `content`, or nothing when this module
 * did not build it.
 *
 * Fails closed exactly as `scan()` does: a detector that throws is a
 * {@link SecretScannerError} carrying no source.
 */
export function* locateSecrets(
  scanner: SecretScanner,
  content: string,
): Operation<SecretSpan[] | undefined> {
  const locate = RangedScanner.locate(scanner, content);
  return locate === undefined ? undefined : yield* locate;
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
    {
      id: xmdCredentialRule.meta.id,
      rule: xmdCredentialRule,
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

  function* detected(content: string): Operation<readonly LintMessage[]> {
    try {
      return (yield* until(detect(content, filePath))).messages;
    } catch {
      throw new SecretScannerError("scanning");
    }
  }

  const scanner: SecretScanner = {
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
  return new RangedScanner(scanner.scan, function* (content: string): Operation<SecretSpan[]> {
    if (content.length === 0) {
      return [];
    }
    const messages = yield* detected(content);
    try {
      return messages.map((message) => {
        const [start, end] = message.range;
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end <= start ||
          end > content.length
        ) {
          throw new Error("range");
        }
        return Object.freeze({ ruleId: message.ruleId, messageId: message.messageId, start, end });
      });
    } catch {
      throw new SecretScannerError("normalizing findings");
    }
  });
}
