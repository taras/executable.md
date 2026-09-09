/**
 * Tier PI3 — whether an Agent answered with a Plan draft or a request.
 *
 * The rule decides what happens to untrusted text next, and it is wrong in two
 * directions. A draft misread as a request is program text nobody approved
 * reaching evaluation; a request misread as a draft is a structural check
 * reporting a broken Plan to an Agent that never wrote one.
 *
 * So the rows are the boundary cases rather than the happy ones: what closes,
 * what does not, and what sits before the heading.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { classifyPlanResponse } from "../src/plan-response.ts";

const REQUEST = '<Glob include={["**/AGENTS.md"]} as="paths" />\n<Json value={paths} />\n';

describe("Tier PI3 — classifying one Agent response", () => {
  it("PI3: a level-one heading first, in either spelling, is a draft", function* () {
    for (const source of [
      "# Ask for and save your age\n\nAsk me for my age.\n",
      "Ask for and save your age\n=========================\n\nSteps follow.\n",
      // Leading blank lines are not a body block.
      "\n\n# Titled\n\nbody\n",
    ]) {
      expect(classifyPlanResponse(source)).toBe("draft");
    }
  });

  it("PI3: closed frontmatter is removed without being parsed", function* () {
    // Valid YAML, and the ordinary case.
    expect(classifyPlanResponse("---\nprops:\n  type: object\n---\n\n# Titled\n")).toBe("draft");
    // Closed but *invalid* YAML is still a draft. Parsing it here would call
    // this a request and evaluate it, when what it needs is the repair path
    // that exists to tell the Agent what is wrong with it.
    expect(classifyPlanResponse("---\nprops: [unclosed\n---\n\n# Titled\n")).toBe("draft");
    // An empty envelope is an envelope.
    expect(classifyPlanResponse("---\n---\n# Titled\n")).toBe("draft");
    // The exact shape `plan.test.ts` uses for "the agent authored a broken
    // root": unparseable YAML, closed, with a titled body.
    expect(
      classifyPlanResponse(
        ["---", "props: [", "---", "", "# Broken frontmatter", "", "hi", ""].join("\n"),
      ),
    ).toBe("draft");
  });

  it("PI3: an unterminated envelope is a candidate, by the ordinary rule", function* () {
    // Never closed, so nothing is removed and the leading `---` is read as the
    // thematic break it is — which is not a heading.
    expect(classifyPlanResponse("---\nprops:\n  type: object\n\n# Titled\n")).toBe("information");
  });

  it("PI3: anything before the heading makes it a candidate", function* () {
    for (const source of [
      "Here is the plan you asked for:\n\n# Titled\n",
      '<Syntax names={["File"]} />\n\n# Titled\n',
      "```markdown\n# Titled\n```\n",
    ]) {
      expect(classifyPlanResponse(source)).toBe("information");
    }
  });

  it("PI3: a heading that is not level one, or carries no title, is a candidate", function* () {
    for (const source of ["## Titled\n\nbody\n", "#\n\nbody\n", "#   \n\nbody\n"]) {
      expect(classifyPlanResponse(source)).toBe("information");
    }
  });

  it("PI3: an ordinary information request is a candidate", function* () {
    expect(classifyPlanResponse(REQUEST)).toBe("information");
    expect(classifyPlanResponse("")).toBe("information");
  });

  it("PI3: the response bytes are not modified", function* () {
    const source = "---\nprops: [unclosed\n---\n\n# Titled\n\nbody\n";
    const before = `${source}`;
    classifyPlanResponse(source);
    expect(source).toBe(before);
  });
});
