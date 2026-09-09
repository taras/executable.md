/**
 * Whether an Agent answered a Plan-producing turn with a draft or with a
 * read-only information request.
 *
 * One question, asked before anything else happens to the response: a draft is
 * never evaluated, and a request is never checked as a Plan. Getting that
 * ordering wrong in either direction is the whole risk — a draft that reached
 * evaluation would be program text the person has not approved, and a request
 * that reached structural validation would be reported to the Agent as a broken
 * Plan.
 *
 * ## The rule is lexical, and deliberately so
 *
 * A response is a **draft** when the first nonempty body block — after optional
 * frontmatter that is *closed* — is a nonempty level-one heading. Everything
 * else is an information candidate.
 *
 * Nothing here parses YAML. Frontmatter that opens and closes is removed by
 * finding its delimiters and nothing more, so a draft whose frontmatter is
 * closed but invalid stays a draft and reaches the repair path that exists to
 * tell the Agent what is wrong with it. Parsing it here would classify that
 * draft as a request and evaluate it.
 *
 * Frontmatter that never closes is *not* removed. What follows is then read as
 * ordinary Markdown, where a leading `---` is a thematic break rather than a
 * heading, so the response is a candidate — which is the answer the contract
 * asks for, arrived at by the ordinary rule rather than by a special case.
 *
 * ## Why the Markdown parser rather than a regular expression
 *
 * `# Title` and an underlined Setext title are one concept with two spellings,
 * and the repository already has something that knows that. Asking `remark`
 * means the classifier cannot disagree with the renderer about what a heading
 * is — and a `#` inside a fenced block, an indented code block or a comment is
 * not one.
 *
 * The response bytes are never modified. This answers a question about them and
 * hands the original text on.
 *
 * ## Why it lives in core rather than beside `Plan.md`
 *
 * It has to agree with two things core owns: where a Markdown body begins, and
 * what a heading is. `remark` and the `---` delimiters are both here, and the
 * classifier that disagreed with the structural check about where frontmatter
 * ended would send a draft to evaluation. It carries no authority of its own —
 * a pure function over text, offered to a trusted host through `core/host`.
 */

import { remark } from "remark";

/**
 * The heading node, derived from the parser rather than from a separate type
 * package — the same way `document-targets.ts` names its root children, so
 * there is one source for what the tree holds.
 */
type RootChild = ReturnType<ReturnType<typeof remark>["parse"]>["children"][number];
type Heading = Extract<RootChild, { type: "heading" }>;

/** What one Agent response is, for the workflow that has to act on it. */
export type PlanResponseKind = "draft" | "information";

/** The delimiter core's document parser recognizes, as text. */
const FENCE = "---";

/**
 * The body, with a closed frontmatter envelope removed.
 *
 * Only when it closes. An unterminated envelope is left exactly as written, so
 * the Markdown rule below sees the `---` for what it is.
 */
function body(source: string): string {
  const lines = source.split("\n");
  if (lines[0]?.trimEnd() !== FENCE) {
    return source;
  }
  for (let line = 1; line < lines.length; line++) {
    if (lines[line]?.trimEnd() === FENCE) {
      return lines.slice(line + 1).join("\n");
    }
  }
  // Opened and never closed: not an envelope, so nothing is removed.
  return source;
}

/**
 * Whether a heading carries any text at all.
 *
 * Read structurally rather than asserted: a heading's children are inline
 * nodes, and only some of them carry a literal `value`. An emphasized or coded
 * title is still a title, so anything with content counts and only a heading
 * with nothing in it at all is untitled.
 */
function titled(node: Heading): boolean {
  return node.children.some((child) =>
    "value" in child && typeof child.value === "string" ? child.value.trim().length > 0 : true,
  );
}

/**
 * Which of the two this response is.
 *
 * Validates nothing and modifies nothing: a draft this calls a draft may still
 * be a broken Plan, and saying so is the structural check's job.
 */
export function classifyPlanResponse(source: string): PlanResponseKind {
  const [first] = remark().parse(body(source)).children;
  if (first === undefined || first.type !== "heading" || first.depth !== 1) {
    return "information";
  }
  return titled(first) ? "draft" : "information";
}
