/**
 * The two documented commands, run as a person runs them.
 *
 * #840 asks for one command that runs the representative journey and one that
 * prints its structural trace. A command nobody executes is a paragraph in a
 * README, so these run the real thing as a child process and read what came
 * back — which is also what catches a task that stops working for a reason the
 * unit evidence cannot see, like a flag that no longer parses.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exec } from "@effectionx/process";
import type { Operation } from "effection";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAIN = "scripts/repl-compose/main.ts";

function* run(...args: readonly string[]): Operation<string> {
  const result = yield* exec(`deno run --allow-all ${MAIN} ${args.join(" ")}`, {
    cwd: ROOT,
  }).join();
  if (result.code !== 0) {
    throw new Error(`${MAIN} ${args.join(" ")} exited ${result.code}\n${result.stderr}`);
  }
  return result.stdout;
}

describe("REPL composition: the documented commands", () => {
  it("runs the representative journey unattended", function* () {
    const output = yield* run("--journey");

    // Every moment of the journey, in order, drawn from the tree each one
    // described.
    expect(output).toContain("— the entry, no drawer —");
    expect(output).toContain("— the project drawer —");
    expect(output).toContain("— confirm stacked on it —");
    expect(output).toContain("— the top drawer closed —");
    expect(output).toContain("— a location the execution never went to —");

    // Opening a drawer asks for frames, stacking asks for another, closing
    // gives one back, and refusing gives them all back.
    expect(output).toContain("frames wanted: 0\n");
    expect(output).toContain("frames wanted: 2\n");

    // The refusal replaced the screen rather than covering it.
    const refused = output.slice(output.indexOf("never went to"));
    expect(refused).toContain("does not exist in this execution");
    expect(refused).not.toContain("owner:");

    // And the renderer is swapped under the same mounted tree at the end.
    expect(output).toContain("— the same tree, another renderer —");
    expect(output).toContain("│");
  });

  it("prints the structural trace #840 asks for", function* () {
    const output = yield* run(
      "--trace",
      "'xmd://repl/e1/transcript/entry-1/document/+project/+confirm?at=cp-10&inspect'",
    );

    for (const heading of [
      "1. decoded route",
      "2. resolved against the model",
      "3. keyed component description",
      "4. mounted Freedom tree",
      "5. action delivery",
      "6. branch teardown",
      "7. terminal output",
    ]) {
      expect(output).toContain(heading);
    }

    expect(output).toContain("xmd://repl/e1/transcript/entry-1/document/+project/+confirm");
    expect(output).toContain("identities are the model's own values");
    expect(output).toContain("drawers entry-1:project → entry-1:confirm");
    expect(output).toContain("keyboard action suspension.answer");
    expect(output).toContain("pointer action suspension.answer");
    expect(output).toContain("equivalent yes");
    expect(output).toContain("removed project, project.answer, confirm, confirm.answer");
    expect(output).toContain("frame demand 2 → 0");
  });

  it("refuses a location and says which segment", function* () {
    const output = yield* run("--trace", "'xmd://repl/e1/transcript/entry-1/plan'");

    expect(output).toContain("refused at scope[0]");
    expect(output).toContain('"plan" is not a scope of entry-1');
  });
});
