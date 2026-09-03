/**
 * Tier PH — the acts `xmd plan` performs as the host
 * (specs/plan-command-spec.md §The authorship profile,
 * specs/acp-client-spec.md §The `xmd plan` authorship profile).
 *
 * The profile refuses the command document a command, and two of the things the
 * command itself does run one: it installs this build's ACP adapter, and it opens
 * the review form in a browser. Neither is the document's act, and both were
 * refused as though they were — the second one visibly, as
 * `could not open a browser automatically (xmd plan asked for a command, …)`
 * printed beside the URL a person then had to open by hand.
 *
 * These drive the real command with the real profile. What stands in for the
 * outside world is the command itself: an `API.Process` recorder answers instead
 * of spawning, installed at `min` so the profile's own refusal still outranks it
 * wherever it applies — a recorder at full strength would answer for a refused
 * call too, and these cases would pass against the defect.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { join } from "node:path";
import { API } from "@executablemd/runtime";
import { FormOpener } from "@executablemd/web";
import type { Operation } from "effection";

import { runPlan } from "../src/plan.ts";
import type { PlanCommand } from "../src/plan.ts";
import type { AuthorshipStack } from "../src/agent-stack.ts";
import { ADAPTERS, AGENT, createPlanHarness, useWorkingDirectory } from "./support/plan-harness.ts";
import type { PlanHarness } from "./support/plan-harness.ts";

const REQUEST = "write a greeting";

/** A Plan the host's validator accepts. */
const PLAN = ['<File path="drafted.txt">the draft ran</File>', ""].join("\n");

const STACK: AuthorshipStack = {
  provider: "acpx",
  defaultAgent: AGENT,
  adapters: ADAPTERS,
};

function writing(dir: string, output: string): PlanCommand {
  return { request: REQUEST, include: [dir], output, verbose: false, stack: STACK };
}

/** Every command this invocation reached, answered rather than spawned. */
function* recordCommands(commands: string[][]): Operation<void> {
  yield* API.Process.around(
    {
      // deno-lint-ignore require-yield
      *exec([options]) {
        commands.push([...options.command]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    { at: "min" },
  );
}

/**
 * A harness whose review opens a form first, the way the CLI's own does.
 *
 * `installWebElicitation` announces the URL and asks `FormOpener` to open it
 * before it waits for an answer; this is that one act, without a port, a page or
 * a browser.
 */
function openingHarness(harness: PlanHarness, url: string): PlanHarness {
  const scripted = harness.deps.installElicitation;
  harness.deps.installElicitation = function* (): Operation<void> {
    yield* FormOpener.operations.open(url);
    yield* scripted();
  };
  return harness;
}

describe("Tier PH — the acts xmd plan performs as the host", () => {
  it("PH1: opening the review form reaches a command the document cannot", function* () {
    yield* useWorkingDirectory(function* (dir, authorshipRoot) {
      const commands: string[][] = [];
      yield* recordCommands(commands);

      const url = "http://127.0.0.1:0/f/token/";
      const harness = openingHarness(createPlanHarness({ authorshipRoot }), url);
      harness.fake.script({ reply: PLAN });
      harness.script({ decision: "Approve" });

      const code = yield* runPlan(writing(dir, join(dir, "plan.md")), harness.deps);

      // The command that opens a browser on this platform, whichever it is, with
      // the URL the form is being served at.
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain(url);
      expect(code).toBe(0);
      expect(harness.reviews).toHaveLength(1);
    });
  });
});
