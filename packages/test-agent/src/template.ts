/**
 * WhenPrompt template matching (specs/test-agent-spec.md §WhenPrompt
 * templates). Pure functions — no Effection — so every rule is unit
 * testable: whole-prompt anchoring, `{?name}` captures, `{binding}`
 * constraints, repeated-capture agreement, and adjacent-capture
 * ambiguity.
 */

export type TemplateToken =
  | { kind: "literal"; text: string }
  | { kind: "capture"; name: string }
  | { kind: "binding"; path: string };

export interface ParsedTemplate {
  source: string;
  tokens: TemplateToken[];
  captureNames: string[];
}

export type TemplateParseResult =
  | { ok: true; template: ParsedTemplate }
  | { ok: false; error: string };

const CAPTURE_HOLE = /^\{\?([A-Za-z_$][A-Za-z0-9_$]*)\}/;
const BINDING_HOLE = /^\{([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\}/;
const MALFORMED_CAPTURE = /^\{\?/;

export function parseTemplate(source: string): TemplateParseResult {
  const tokens: TemplateToken[] = [];
  const captureNames: string[] = [];
  let literal = "";
  let position = 0;

  const flushLiteral = () => {
    if (literal) {
      tokens.push({ kind: "literal", text: literal });
      literal = "";
    }
  };

  while (position < source.length) {
    const rest = source.slice(position);
    const capture = CAPTURE_HOLE.exec(rest);
    if (capture) {
      flushLiteral();
      const previous = tokens.at(-1);
      if (previous && previous.kind !== "literal") {
        return {
          ok: false,
          error:
            "adjacent capture holes without literal text between them are ambiguous: " +
            `"${source}"`,
        };
      }
      const name = capture[1]!;
      if (!captureNames.includes(name)) {
        captureNames.push(name);
      }
      tokens.push({ kind: "capture", name });
      position += capture[0].length;
      continue;
    }
    if (MALFORMED_CAPTURE.test(rest)) {
      return { ok: false, error: `malformed capture hole at position ${position}: "${source}"` };
    }
    const binding = BINDING_HOLE.exec(rest);
    if (binding) {
      flushLiteral();
      const previous = tokens.at(-1);
      if (previous && previous.kind === "capture") {
        // A binding resolves to arbitrary text before matching, so a
        // capture directly followed by a binding has no fixed delimiter
        // either — same ambiguity as two adjacent captures.
        return {
          ok: false,
          error: "a capture hole directly followed by another hole is ambiguous: " + `"${source}"`,
        };
      }
      tokens.push({ kind: "binding", path: binding[1]! });
      position += binding[0].length;
      continue;
    }
    literal += source[position];
    position++;
  }
  flushLiteral();

  return { ok: true, template: { source, tokens, captureNames } };
}

export type TemplateMatchResult =
  | { ok: true; captures: Record<string, string> }
  | { ok: false; kind: "mismatch" | "config"; expected: string; actual: string; message: string };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveBinding(path: string, env: Record<string, unknown>): string | undefined {
  const segments = path.split(".");
  let current: unknown = env;
  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === "string" ? current : undefined;
}

export function matchPrompt(
  template: ParsedTemplate,
  prompt: string,
  env: Record<string, unknown>,
): TemplateMatchResult {
  let pattern = "^";
  const groupIndexByName = new Map<string, number>();
  let groupCount = 0;

  for (const token of template.tokens) {
    if (token.kind === "literal") {
      pattern += escapeRegExp(token.text);
    } else if (token.kind === "capture") {
      const existing = groupIndexByName.get(token.name);
      if (existing === undefined) {
        groupCount++;
        groupIndexByName.set(token.name, groupCount);
        pattern += "([\\s\\S]+?)";
      } else {
        // A repeated capture must match the same text as its first use.
        pattern += `\\${existing}`;
      }
    } else {
      const resolved = resolveBinding(token.path, env);
      if (resolved === undefined) {
        return {
          ok: false,
          kind: "config",
          expected: template.source,
          actual: prompt,
          message:
            `template "${template.source}" references "{${token.path}}", ` +
            "which is not a bound string value — an unresolved binding is a " +
            "configuration error, never an implicit capture",
        };
      }
      pattern += escapeRegExp(resolved);
    }
  }
  pattern += "$";

  const match = new RegExp(pattern).exec(prompt);
  if (!match) {
    return {
      ok: false,
      kind: "mismatch",
      expected: template.source,
      actual: prompt,
      message: `prompt did not match the active stage.\nexpected template: ${template.source}\nactual prompt: ${prompt}`,
    };
  }

  const captures: Record<string, string> = {};
  for (const [name, index] of groupIndexByName) {
    captures[name] = match[index]!;
  }
  return { ok: true, captures };
}
