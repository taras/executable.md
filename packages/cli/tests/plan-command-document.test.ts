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
 * the workflow under test is the one the packaged Component owns, resolved against
 * first-party declarations only.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentIdentityComponents,
  collect,
  installAgentComponents,
  retainedSource,
} from "@executablemd/core";
import type { ElicitationRequest, Json } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { PLAN_COMMAND_DOCUMENT, readPackagedDocument } from "../src/packaged-document.ts";
import { PLAN_COMMAND_IDENTITY } from "../src/authorship-profile.ts";
import { AGENT, planDeclarationHarness, useWorkingDirectory } from "./support/plan-harness.ts";

/**
 * A candidate whose exact bytes are worth preserving.
 *
 * Leading and trailing blank lines, interior indentation, and a five-backtick
 * run: enough that trimming, re-fencing, or reconstructing it through the
 * presentation would all be visible in the assertion.
 *
 * A text Plan rather than a value one, because the leading blank line is the
 * point: frontmatter is only frontmatter when it is the first thing in the
 * file, so a candidate that opens with a blank line and then declares `returns`
 * declares nothing and its `<Return>` has no schema to satisfy. The structural
 * admission inside the Component says so now, where the command's own gate used to
 * be the first thing to see these bytes.
 */
const CANDIDATE = [
  "",
  "# A greeting",
  "",
  "This document explains itself before it does anything.",
  "",
  "`````markdown",
  "  <Return value={`nested fence`} />",
  "`````",
  "",
  "That fence is shown, not run.",
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

  let value: Json | undefined;
  let failure: string | undefined;

  const harness = yield* scoped(function* () {
    return yield* planDeclarationHarness({
      surface: "command",
      authorshipRoot: yield* authorshipRoot(),
      session: SESSION,
      explicitSession: true,
      syntax: "## Built-in components\n\n### `<File>`\n",
    });
  });
  harness.fake.script({ reply: CANDIDATE });
  harness.script({ decision: "Approve" });

  yield* scoped(function* () {
    // The agent words and this execution's prompt bookkeeping, as the command
    // installs them. No root provider: the ceiling the Plan is written under is
    // the one the Component installs around its own content.
    yield* installAgentComponents({ defaultAgent: AGENT, permissionMode: "deny-all" });
    try {
      value = yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource(PLAN_COMMAND_IDENTITY, source),
            stream: new InMemoryStream(),
            includes: [],
            props: {
              request: REQUEST,
              syntax: "## Built-in components\n\n### `<File>`\n",
              session: SESSION,
            },
          },
          [
            {
              components: agentIdentityComponents(),
              declarations: [harness.declaration],
            },
          ],
        ),
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  });

  return {
    validated: harness.checked,
    reviews: harness.reviews,
    prompts: harness.fake.prompts,
    value,
    failure,
  };
}

/** The request the adapter projects into `<Plan>`, and the session it names. */
const REQUEST = "ask me for my age and write the result to a file";
const SESSION = "plan-command-regression";

/** A profile root this file owns, removed when the case's scope ends. */
function* authorshipRoot(): Operation<string> {
  const root = join(tmpdir(), `xmd-plan-command-${randomUUID()}`);
  yield* ensureDir(root);
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  return root;
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

    // The checker saw the Agent's complete close value, once, unaltered.
    expect(run.validated).toEqual([CANDIDATE]);

    // The document settled with a value rather than an authored failure. Before
    // the control-flow correction this was the ten-draft exhaustion message: a
    // `<Return>` selects a value but does not end the body, so the unconditional
    // `<Fail>` after the Session ran and won over every approval.
    expect(run.failure).toBe(undefined);
    expect(run.value).toBe(CANDIDATE);
  });

  /**
   * The review this document asks has to be servable as a browser form, which
   * is how `xmd plan` asks it: `installWebElicitation` compiles the request's
   * schema before a port exists.
   *
   * Compiling for the browser extracts each conditional branch and compiles it
   * as a schema of its own, so a branch that reached `required` through its
   * parent's type is refused there while the server accepts it
   * (`packages/web/tests/compile.test.ts`, and specs/web-form-spec.md
   * §The preflight boundary). Until both branches said `object`, a real
   * `xmd plan` completed its turn and then ended at the review with
   * `<WebForm> schema could not be compiled for the browser`.
   */
  it("C9: every conditional branch of the review schema declares its own type", function* () {
    const run = yield* useWorkingDirectory(function* () {
      return yield* runDocument();
    });

    const schema = Object(run.reviews[0]?.schema);
    expect(Reflect.get(Object(Reflect.get(schema, "if")), "type")).toBe("object");
    expect(Reflect.get(Object(Reflect.get(schema, "then")), "type")).toBe("object");
  });
});
