/**
 * The packaged plan command document, executed as itself.
 *
 * This runs the exact Markdown the CLI ships — read through the packaged
 * loader, not copied into a fixture — so what it proves is what a release does.
 * The seams around it are deterministic: a scriptable ACP runtime for the one
 * Agent turn, a scripted Elicitation answer for the review, and a test-only
 * validator in the place the authorship profile declares the production one.
 *
 * The include list is empty on purpose. Repository component search must not be
 * able to supply `Loop`, `If`, `Return`, `Fail`, `CodeBlock` or the validator:
 * the policy under test is the one in the packaged document, resolved against
 * first-party declarations only.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import {
  agentIdentityComponents,
  collect,
  Elicitation,
  installAgentComponents,
  registerAgentProvider,
  retainedSource,
} from "@executablemd/core";
import type { ElicitationRequest, Json } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { createAcpxProvider } from "@executablemd/acp";

import { PLAN_COMMAND_DOCUMENT, readPackagedDocument } from "../src/packaged-document.ts";
import { PLAN_COMMAND_IDENTITY } from "../src/authorship-profile.ts";
import { AGENT, useWorkingDirectory } from "./support/plan-harness.ts";
import { createFakeAcp, makeRegistry, makeStore } from "./support/fake-acp.ts";

/**
 * A candidate whose exact bytes are worth preserving.
 *
 * Leading and trailing blank lines, interior indentation, and a five-backtick
 * run: enough that trimming, re-fencing, or reconstructing it through the
 * presentation would all be visible in the assertion.
 */
const CANDIDATE = [
  "",
  "---",
  "returns: { type: string }",
  "---",
  "",
  "# A greeting",
  "",
  "This document explains itself before it does anything.",
  "",
  "`````markdown",
  "  <Return value={`nested fence`} />",
  "`````",
  "",
  '<Return value="hello" />',
  "",
].join("\n");

/** What the command document asked the validator about, in order. */
interface CommandRun {
  validated: string[];
  reviews: ElicitationRequest[];
  prompts: string[];
  value: Json | undefined;
  failure: string | undefined;
}

function* runDocument(): Operation<CommandRun> {
  const source = yield* readPackagedDocument(PLAN_COMMAND_DOCUMENT);
  const fake = createFakeAcp();
  fake.script({ reply: CANDIDATE });

  const validated: string[] = [];
  const reviews: ElicitationRequest[] = [];
  let value: Json | undefined;
  let failure: string | undefined;

  yield* scoped(function* () {
    const acpx = createAcpxProvider({
      createRuntime: fake.create,
      sessionStore: makeStore(),
      agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
    });
    yield* registerAgentProvider("acpx", acpx);
    yield* installAgentComponents({
      defaultAgent: AGENT,
      permissionMode: "deny-all",
      rootProvider: { factory: acpx, options: { defaultAgent: AGENT, permissionMode: "deny-all" } },
    });

    yield* Elicitation.around(
      {
        // deno-lint-ignore require-yield
        *elicit([request], _next) {
          reviews.push(request);
          return { decision: "Approve" };
        },
      },
      { at: "min" },
    );

    try {
      value = yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource(PLAN_COMMAND_IDENTITY, source),
            stream: new InMemoryStream(),
            includes: [],
            props: {
              request: "ask me for my age and write the result to a file",
              syntax: "## Built-in components\n\n### `<File>`\n",
              session: "plan-command-regression",
            },
          },
          [
            {
              components: [
                ...agentIdentityComponents(),
                {
                  name: "CheckDraft",
                  origin: "test",
                  forms: ["self-closing"] as const,
                  props: {
                    type: "object",
                    properties: { source: { type: "string" } },
                    required: ["source"],
                    additionalProperties: false,
                  },
                  returns: {
                    type: "object",
                    properties: {
                      valid: { type: "boolean" },
                      diagnostics: { type: "object" },
                    },
                    required: ["valid", "diagnostics"],
                    additionalProperties: false,
                  },
                  // The deterministic seam only, standing where the command
                  // declares its own validator. It records what it was asked
                  // about and says yes, so what this case observes is the
                  // program's control flow rather than validation's answers.
                  factory: () =>
                    // deno-lint-ignore require-yield
                    function* checkDraft(props: Record<string, Json>) {
                      validated.push(String(props.source));
                      return { valid: true, diagnostics: {} };
                    },
                },
              ],
            },
          ],
        ),
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  });

  return { validated, reviews, prompts: fake.prompts, value, failure };
}

describe("the packaged plan command document", () => {
  it("C2: returns the approved candidate's exact bytes and never reaches exhaustion", function* () {
    const run = yield* useWorkingDirectory(function* () {
      return yield* runDocument();
    });

    // The root this document ran under is the internal one the host declares:
    // no path selects it, and a position naming it says the source is the
    // CLI's own.
    expect(PLAN_COMMAND_IDENTITY).toBe("<plan-command>");

    // Approving the first valid candidate is one turn and one question. A
    // repair or revision turn here would mean the loops ran when they had
    // nothing to fix.
    expect(run.prompts).toHaveLength(1);
    expect(run.reviews).toHaveLength(1);

    // The validator saw the Agent's complete close value, once, unaltered.
    expect(run.validated).toEqual([CANDIDATE]);

    // The document settled with a value rather than an authored failure. Before
    // the control-flow correction this was the ten-draft exhaustion message: a
    // `<Return>` selects a value but does not end the body, so the unconditional
    // `<Fail>` after the Session ran and won over every approval.
    expect(run.failure).toBe(undefined);
    expect(run.value).toBe(CANDIDATE);
  });
});
