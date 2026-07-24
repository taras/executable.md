/**
 * Tier TT — WhenPrompt template tests (specs/test-agent-spec.md
 * §WhenPrompt templates).
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { matchPrompt, parseTemplate } from "../src/template.ts";
import type { ParsedTemplate } from "../src/template.ts";

function parsed(source: string): ParsedTemplate {
  const result = parseTemplate(source);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.template;
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
      expect(result.captures).toEqual({ subject: "packages/core", revision: "abc123" });
    }
  });

  it("TT3: repeated captures must agree", function* () {
    const template = parsed("{?word} equals {?word}");
    const same = matchPrompt(template, "alpha equals alpha", {});
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.captures).toEqual({ word: "alpha" });
    }
    expect(matchPrompt(template, "alpha equals beta", {}).ok).toBe(false);
  });

  it("TT4: adjacent capture holes are rejected as ambiguous", function* () {
    const direct = parseTemplate("Review {?a}{?b} now");
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.error).toContain("ambiguous");
    }
    const viaBinding = parseTemplate("Review {?a}{existing} now");
    expect(viaBinding.ok).toBe(false);
  });

  it("TT5: bindings constrain the prompt from existing values", function* () {
    const template = parsed("Summarize {review.subject}");
    const env = { review: { subject: "packages/core" } };
    expect(matchPrompt(template, "Summarize packages/core", env).ok).toBe(true);
    const wrong = matchPrompt(template, "Summarize something-else", env);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.kind).toBe("mismatch");
      expect(wrong.expected).toBe("Summarize {review.subject}");
      expect(wrong.actual).toBe("Summarize something-else");
    }
  });

  it("TT6: an unresolved binding is a configuration error, never a capture", function* () {
    const template = parsed("Summarize {review.subject}");
    const result = matchPrompt(template, "Summarize anything", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("config");
      expect(result.message).toContain("review.subject");
    }
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
      expect(result.captures.subject).toBe("packages/core");
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
