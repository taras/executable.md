/**
 * Tier PR — `xmd prompt` generation, validation and review
 * (specs/prompt-command-spec.md).
 *
 * Rows P5–P12. The ACPX runtime is the scriptable fake, the review provider is a
 * scripted `Elicitation` handler, the executor records what it was handed, and
 * the contextual working directory is a temporary one. Nothing here starts an
 * agent, opens a browser or reaches a network.
 *
 * Every refusal is proven by the phases that stayed at zero — turns not sent,
 * reviews not asked, executions not handed anything — rather than by output
 * nobody produced.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { writeTextFile } from "@effectionx/fs";
import { join } from "node:path";

import { runPrompt } from "../src/prompt.ts";
import type { PromptCommand } from "../src/prompt.ts";
import { scanPromptArgs } from "../src/prompt-args.ts";
import { useGeneratorAgent } from "../src/agent-stack.ts";
import { AGENT, createPromptHarness, useWorkingDirectory } from "./support/prompt-harness.ts";
import type { PromptHarness } from "./support/prompt-harness.ts";
import { createFakeAcp, makeRegistry, makeStore } from "./support/fake-acp.ts";

const REQUEST = "write a greeting";

/** A document that validates and runs. */
const VALID = "Hello from the agent.\n";

/** A document that resolves no such component. */
const UNRESOLVED = "<NoSuchComponent />\n";

/** A root whose own source cannot be read: the frontmatter never closes. */
const BROKEN_SOURCE = ["---", "props: [", "---", "", "hi", ""].join("\n");

/** A root whose two declared properties generate one option. */
const COLLIDING = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    firstName: { type: string }",
  "    first_name: { type: string }",
  "---",
  "",
  "hi",
  "",
].join("\n");

/** A root that declares one required scalar property. */
const REQUIRES_NAME = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name: { type: string }",
  "  required: [name]",
  "  additionalProperties: false",
  "---",
  "",
  "Hello, {props.name}!",
  "",
].join("\n");

/** The same document with `name` declared a switch instead. */
const NAME_IS_BOOLEAN = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name: { type: boolean }",
  "  additionalProperties: false",
  "---",
  "",
  "Hello, {props.name}!",
  "",
].join("\n");

function command(dir: string, args: string[], save?: string): PromptCommand {
  const argv = ["prompt", ...args];
  return {
    argv,
    scan: scanPromptArgs(argv),
    include: [dir],
    ...(save === undefined ? {} : { save }),
    agent: {
      agentProvider: "acpx",
      defaultAgent: AGENT,
      approveAll: false,
      approveReads: false,
      denyAll: true,
    },
  };
}

/** Every session key the fake was asked to establish, deduplicated in order. */
function sessions(harness: PromptHarness): string[] {
  return [...new Set(harness.fake.ensured.map((input) => input.sessionKey))];
}

/** The decisions one review request offered. */
function decisions(request: { schema: Record<string, unknown> }): unknown {
  const properties = request.schema.properties;
  if (typeof properties !== "object" || properties === null) {
    return undefined;
  }
  const decision = (properties as Record<string, unknown>).decision;
  if (typeof decision !== "object" || decision === null) {
    return undefined;
  }
  return (decision as Record<string, unknown>).enum;
}

describe(
  "Tier PR — xmd prompt authorship",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("P5: candidate defects earn a repair turn; caller defects terminate", function* () {
      // A defect the agent authored: the root's own frontmatter.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.fake.script({ reply: BROKEN_SOURCE });
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(0);
        expect(harness.fake.prompts).toHaveLength(2);
        expect(harness.fake.prompts[0]).toBe(REQUEST);
        expect(harness.fake.prompts[1]).toContain("complete replacement document");
        expect(harness.fake.prompts[1]).toContain("source-invalid");
        // The whole versioned value, as data.
        expect(harness.fake.prompts[1]).toContain('"version": 1');
        expect(harness.executions).toHaveLength(1);
      });

      // A defect the agent authored: two properties generating one option.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.fake.script({ reply: COLLIDING });
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(0);
        expect(harness.fake.prompts).toHaveLength(2);
        expect(harness.fake.prompts[1]).toContain("generated-binding-collision");
        expect(harness.fake.prompts[1]).toContain("--props-first-name");
        // Carried as this command's own finding, not as a core diagnostic code.
        expect(harness.fake.prompts[1]).not.toContain("DocumentValidationCode");
      });

      // A defect the caller wrote: an option the candidate never declares.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.fake.script({ reply: VALID });

        const code = yield* runPrompt(
          command(dir, [REQUEST, "--props-nothing", "here"]),
          harness.deps,
        );

        expect(code).toBe(1);
        // One turn, no repair: the agent cannot fix a command line.
        expect(harness.fake.prompts).toHaveLength(1);
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
      });

      // A defect the caller wrote: aggregate JSON that is not JSON.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.fake.script({ reply: VALID });

        const code = yield* runPrompt(command(dir, [REQUEST, "--props", "{oops"]), harness.deps);

        expect(code).toBe(1);
        expect(harness.fake.prompts).toHaveLength(1);
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
      });

      // A defect the caller wrote: a value this candidate's schema rejects.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.fake.script({ reply: NAME_IS_BOOLEAN });

        const code = yield* runPrompt(
          command(dir, [REQUEST, "--props-name=not-a-boolean"]),
          harness.deps,
        );

        expect(code).toBe(1);
        expect(harness.fake.prompts).toHaveLength(1);
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
      });
    });

    it("P6: a revision may not change what the command line means", function* () {
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        // The first draft binds `--props-name` as a single-value option.
        harness.fake.script({ reply: REQUIRES_NAME });
        harness.script({ decision: "revise", feedback: "make it shout" });
        // The revision declares the same name as a switch.
        harness.fake.script({ reply: NAME_IS_BOOLEAN });

        const code = yield* runPrompt(command(dir, [REQUEST, "--props-name", "Ada"]), harness.deps);

        expect(code).toBe(1);
        // The change was caught before the second candidate was presented.
        expect(harness.reviews).toHaveLength(1);
        expect(harness.executions).toHaveLength(0);
        expect(harness.fake.prompts).toHaveLength(2);
      });

      // An unchanged signature re-resolves from the same unchanged sources.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.fake.script({ reply: REQUIRES_NAME });
        harness.script({ decision: "revise", feedback: "greet louder" });
        harness.fake.script({ reply: `${REQUIRES_NAME}\nLOUDER\n` });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST, "--props-name", "Ada"]), harness.deps);

        expect(code).toBe(0);
        expect(harness.executions[0]?.props).toEqual({ name: "Ada" });
      });
    });

    it("P7: one run-profile catalog becomes the fresh session's system prompt", function* () {
      yield* useWorkingDirectory(function* (dir) {
        // A repository TypeScript component, so the catalog has to state the one
        // thing it honestly cannot know without importing the module.
        yield* writeTextFile(join(dir, "Widget.ts"), "export default function Widget() {}\n");

        const harness = createPromptHarness();
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);
        expect(code).toBe(0);

        // Exactly one catalog, built with the invocation's own includes.
        expect(harness.catalogCalls).toEqual([[dir]]);

        const instructions = harness.fake.ensured[0]?.sessionOptions?.systemPrompt;
        expect(typeof instructions).toBe("string");
        const stated = typeof instructions === "string" ? instructions : "";
        expect(stated).toContain("Every answer is replacement document source and nothing else");
        expect(stated).toContain("## Built-in structural syntax");
        expect(stated).toContain("## Built-in components");
        expect(stated).toContain("### `<Agent>`");
        expect(stated).toContain("### `<Widget>`");
        // The renderer's origin-only wording, unchanged.
        expect(stated).toContain("This component is a repository TypeScript module.");
        // The instructions are the session's, not the user turn's.
        expect(harness.fake.prompts[0]).toBe(REQUEST);
        expect(harness.fake.prompts[0]).not.toContain("Built-in components");
      });
    });

    it("P8: one fresh session per invocation, contacted only by a subscribed turn", function* () {
      // Placement contacts no backend: the runtime is not even created until the
      // first turn is subscribed.
      yield* useWorkingDirectory(function* () {
        const fake = createFakeAcp();
        yield* scoped(function* (): Operation<void> {
          const provider = yield* useGeneratorAgent(
            {
              provider: "acpx",
              defaultAgent: AGENT,
              permissionMode: "deny-all",
            },
            "instructions",
            {
              createRuntime: fake.create,
              sessionStore: makeStore(),
              agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
            },
          );
          const session = yield* provider.session("xmd-prompt:placement");
          expect(session.sessionKey.startsWith("xmd:v1:")).toBe(true);
          expect(fake.ensured).toHaveLength(0);
          expect(fake.started).toBe(false);

          fake.script({ reply: VALID });
          const subscription = yield* provider.promptStream("hello", { session });
          let next = yield* subscription.next();
          while (!next.done) {
            next = yield* subscription.next();
          }
          expect(fake.ensured).toHaveLength(1);
          expect(fake.ensured[0]?.sessionKey).toBe(session.sessionKey);
        });
      });

      // Initial, repair and revision turns all land in one conversation.
      const keys: string[] = [];
      for (const _invocation of [0, 1]) {
        yield* useWorkingDirectory(function* (dir) {
          const harness = createPromptHarness();
          harness.fake.script({ reply: UNRESOLVED });
          harness.fake.script({ reply: UNRESOLVED });
          harness.script({ decision: "revise", feedback: "try again" });
          harness.fake.script({ reply: VALID });
          harness.script({ decision: "approve" });

          // The base candidate, one repair, an exhausting pair, a revision.
          harness.fake.script({ reply: VALID });
          const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);
          expect(code).toBe(0);

          expect(sessions(harness)).toHaveLength(1);
          keys.push(sessions(harness)[0]);
        });
      }
      // A second invocation places a different session: nothing is inherited.
      expect(keys[0]).not.toBe(keys[1]);
    });

    it("P9: only a completed terminal produces a candidate", function* () {
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        // A turn that streams a perfectly good document and then fails.
        harness.fake.script({ reply: VALID, stopReason: "max_tokens" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(1);
        expect(harness.fake.prompts).toHaveLength(1);
        // The partial text was discarded: nobody was asked and nothing ran.
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
      });
    });

    it("P10: the base candidate plus exactly three repairs", function* () {
      // Three repairs are available.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.fake.script({ reply: UNRESOLVED });
        harness.fake.script({ reply: UNRESOLVED });
        harness.fake.script({ reply: UNRESOLVED });
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(0);
        expect(harness.fake.prompts).toHaveLength(4);
        expect(harness.reviews).toHaveLength(1);
        expect(decisions(harness.reviews[0])).toEqual(["approve", "revise", "abort"]);
      });

      // A fourth invalid candidate is exhausted, and cannot be approved.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        for (const _draft of [0, 1, 2, 3]) {
          harness.fake.script({ reply: UNRESOLVED });
        }
        harness.script({ decision: "abort" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(1);
        expect(harness.fake.prompts).toHaveLength(4);
        expect(harness.reviews).toHaveLength(1);
        expect(decisions(harness.reviews[0])).toEqual(["revise", "abort"]);
        expect(harness.reviews[0].message).toContain("could not produce a document that validates");
        expect(harness.reviews[0].message).toContain("component-unresolved");
        expect(harness.executions).toHaveLength(0);
      });
    });

    it("P11: review offers what the candidate allows, and a revision starts over", function* () {
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        // Four invalid drafts: the exhausted review.
        for (const _draft of [0, 1, 2, 3]) {
          harness.fake.script({ reply: UNRESOLVED });
        }
        harness.script({ decision: "revise", feedback: "use plain text" });
        // The revision's own budget: four more before the next review.
        for (const _draft of [0, 1, 2, 3]) {
          harness.fake.script({ reply: UNRESOLVED });
        }
        harness.script({ decision: "abort" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(1);
        // Four, then the revision's own draft and three more repairs: the budget
        // reset rather than carrying the exhausted one forward.
        expect(harness.fake.prompts).toHaveLength(8);
        expect(harness.fake.prompts[4]).toContain("use plain text");
        expect(harness.fake.prompts[4]).toContain("complete replacement document");
        expect(harness.reviews).toHaveLength(2);
        expect(decisions(harness.reviews[0])).toEqual(["revise", "abort"]);
        expect(decisions(harness.reviews[1])).toEqual(["revise", "abort"]);
        // The revision stayed in the same conversation.
        expect(sessions(harness)).toHaveLength(1);

        // Non-empty feedback is the contract, and it is the schema's.
        const rule = harness.reviews[0].schema.then;
        expect(rule).toEqual({
          properties: { feedback: { type: "string", minLength: 1 } },
          required: ["feedback"],
        });
        expect(harness.reviews[0].schema.if).toEqual({
          properties: { decision: { const: "revise" } },
          required: ["decision"],
        });
        expect(harness.reviews[0].schema.additionalProperties).toBe(false);
      });

      // A review answer the schema rejects fails the command the way an abort
      // does: nothing is saved and nothing runs.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "revise", raw: { decision: "revise", feedback: "" } });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(1);
        expect(harness.executions).toHaveLength(0);
      });
    });

    it("P12: the exact agent bytes are shown, approved and executed", function* () {
      yield* useWorkingDirectory(function* (dir) {
        // A document that holds a fence of its own, and a run of five backticks.
        const fenced = [
          "Here is a block:",
          "",
          "```bash",
          "echo hi",
          "```",
          "",
          "and `````five````` backticks.",
          "",
        ].join("\n");

        const harness = createPromptHarness();
        harness.fake.script({ reply: fenced });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);
        expect(code).toBe(0);

        const message = harness.reviews[0].message;
        // The fence is longer than every run inside the candidate, so nothing in
        // the source can close it.
        expect(message).toContain("``````md\n");
        expect(message).toContain(`\n${fenced}\n\`\`\`\`\`\``);
        // Nothing was stripped: what runs is the close value, byte for byte.
        expect(harness.executions[0]?.root.source).toBe(fenced);
        expect(harness.executions[0]?.root.path).toBe("<prompt>");
      });

      // A reply wrapped in a fence is shown as it is, not unwrapped.
      yield* useWorkingDirectory(function* (dir) {
        const wrapped = ["```md", "Hello.", "```", ""].join("\n");
        const harness = createPromptHarness();
        harness.fake.script({ reply: wrapped });
        // Wrapped source is not a document, so it earns repairs and then a review.
        for (const _draft of [0, 1, 2]) {
          harness.fake.script({ reply: wrapped });
        }
        harness.script({ decision: "abort" });

        yield* runPrompt(command(dir, [REQUEST]), harness.deps);
        expect(harness.reviews[0].message).toContain(wrapped);
      });
    });
  },
);
