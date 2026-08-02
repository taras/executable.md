/**
 * Tier TT — WhenPrompt template tests (specs/test-agent-spec.md
 * §WhenPrompt templates).
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Result } from "effection";
import { matchPrompt, parseTemplate, PromptMismatchError } from "@executablemd/core";
import type { Captures, ParsedTemplate } from "@executablemd/core";

function parsed(source: string): ParsedTemplate {
  const result = parseTemplate(source);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** The mismatch a failed match carries, so a wrong failure fails the test. */
function mismatch(result: Result<Captures>): PromptMismatchError {
  if (result.ok) {
    throw new Error("expected the prompt not to match the template");
  }
  if (!(result.error instanceof PromptMismatchError)) {
    throw result.error;
  }
  return result.error;
}

describe("Tier TT — WhenPrompt templates", () => {
  it("TT1: literal templates match the complete prompt only", function* () {
    const template = parsed("Say hello world!");
    expect(matchPrompt(template, "Say hello world!", {}).ok).toBe(true);
    expect(matchPrompt(template, "Say hello world! ", {}).ok).toBe(false);
    expect(matchPrompt(template, "prefix Say hello world!", {}).ok).toBe(false);
  });

  it("TT2: captures bind prompt text and are returned as strings", function* () {
    const template = parsed("Review {?subject} at revision {?revision}");
    const result = matchPrompt(template, "Review packages/core at revision abc123", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ subject: "packages/core", revision: "abc123" });
    }
  });

  it("TT3: repeated captures must agree", function* () {
    const template = parsed("{?word} equals {?word}");
    const same = matchPrompt(template, "alpha equals alpha", {});
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.value).toEqual({ word: "alpha" });
    }
    expect(matchPrompt(template, "alpha equals beta", {}).ok).toBe(false);
  });

  it("TT4: adjacent capture holes are rejected as ambiguous", function* () {
    const direct = parseTemplate("Review {?a}{?b} now");
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.error.message).toContain("ambiguous");
    }
    const viaBinding = parseTemplate("Review {?a}{existing} now");
    expect(viaBinding.ok).toBe(false);
  });

  it("TT5: bindings constrain the prompt from existing values", function* () {
    const template = parsed("Summarize {review.subject}");
    const env = { review: { subject: "packages/core" } };
    expect(matchPrompt(template, "Summarize packages/core", env).ok).toBe(true);
    const wrong = mismatch(matchPrompt(template, "Summarize something-else", env));
    expect(wrong.kind).toBe("mismatch");
    expect(wrong.expected).toBe("Summarize {review.subject}");
    expect(wrong.actual).toBe("Summarize something-else");
  });

  it("TT6: an unresolved binding is a configuration error, never a capture", function* () {
    const template = parsed("Summarize {review.subject}");
    const unresolved = mismatch(matchPrompt(template, "Summarize anything", {}));
    expect(unresolved.kind).toBe("config");
    expect(unresolved.message).toContain("review.subject");
  });

  it("TT7: binding values are matched literally, not as regex", function* () {
    const template = parsed("Run {cmd.pattern} now");
    const env = { cmd: { pattern: "a.+b" } };
    expect(matchPrompt(template, "Run a.+b now", env).ok).toBe(true);
    expect(matchPrompt(template, "Run aXXb now", env).ok).toBe(false);
  });

  it("TT8: multiline templates match multiline prompts", function* () {
    const template = parsed("Review:\n{?subject}\nplease");
    const result = matchPrompt(template, "Review:\npackages/core\nplease", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.subject).toBe("packages/core");
    }
  });

  it("TT9: malformed capture holes fail to parse; odd braces stay literal", function* () {
    expect(parseTemplate("Review {?} now").ok).toBe(false);
    const braces = parsed("object {not a binding} text");
    expect(matchPrompt(braces, "object {not a binding} text", {}).ok).toBe(true);
  });

  it("TT10: captures never match empty text", function* () {
    const template = parsed("Review {?subject}!");
    expect(matchPrompt(template, "Review !", {}).ok).toBe(false);
  });
});
