/**
 * The packaged `<Plan>` Component, as the compiled binary reports it.
 *
 * A compiled `xmd` has no checkout to read from and no module graph to lose an
 * asset out of — it has whatever `deno compile --include` embedded. `<Plan>` is
 * packaged Markdown rather than a module, so a build that forgot the include
 * ships a binary that resolves the name and then cannot find the program behind
 * it, at a person's first `xmd plan` rather than here.
 *
 * So this asks the binary what it would let a document write, from a directory
 * that is not the checkout: the origin names the asset, the digest names the
 * bytes, and a build carrying different ones answers differently. Nothing here
 * starts an agent, opens a browser or reaches the network — describing an
 * environment costs nothing, which is exactly why it is the right probe.
 *
 * It runs against `dist/xmd`, so `deno task build` has to have happened. A
 * missing binary is reported as the setup it is rather than as a failure of the
 * claim.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, until } from "effection";
import { exists, readTextFile, rm } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import type { ProcessResult } from "@effectionx/process";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINARY = path.join(ROOT, "dist", "xmd");
const COMPONENT = path.join(ROOT, "packages/cli/src/documents/Plan.md");
const TIMEOUT = 60_000;

describe("compiled xmd", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("carries the same <Plan> Component the source tree ships", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }

    const source = yield* readTextFile(COMPONENT);
    const digest = createHash("sha256").update(source, "utf8").digest("hex");

    // Somewhere that is not the checkout, with an include of its own: a lookup
    // that reached for the working directory or the component search path would
    // find nothing here, and neither may decide which Component this build runs.
    const elsewhere = yield* until(mkdtemp(path.join(tmpdir(), "xmd-compiled-plan-")));
    yield* ensure(() => rm(elsewhere, { recursive: true, force: true }));

    const attempt = yield* timebox<ProcessResult>(TIMEOUT, function* () {
      return yield* exec(BINARY, {
        arguments: ["syntax", "--json", "--include", elsewhere],
        cwd: elsewhere,
      }).join();
    });
    if (attempt.timeout) {
      throw new Error("the compiled binary timed out describing its syntax");
    }
    const run = attempt.value;
    if (run.code !== 0) {
      throw new Error(`the compiled binary exited ${run.code}\n${run.stderr}`);
    }

    const catalog = JSON.parse(run.stdout);
    const entries = catalog.categories.flatMap(
      (category: { entries: unknown[] }) => category.entries,
    );
    const plan = entries.find((entry: { name?: string }) => entry?.name === "Plan");

    expect(plan).toBeDefined();
    expect(plan.sourceKind).toBe("declared-markdown");
    // The identity, whole: a build that embedded different bytes under this
    // name reports a different digest, and one that embedded none reports no
    // entry at all.
    expect(plan.origin).toEqual({
      kind: "declared-markdown",
      origin: "@executablemd/cli/Plan.md",
      digest,
    });
    expect(plan.forms).toEqual(["paired"]);
    // A text component: what it renders is the approved program source, so a
    // build still reporting a declared return is one that embedded the bytes
    // from before this stack.
    expect(plan.returnMode).toBe("text");

    // And the private capabilities are not syntax any build lets a document
    // write.
    const names = entries.map((entry: { name?: string }) => entry?.name);
    for (const name of [
      "Syntax",
      "PlanInputs",
      "PlanAuthorship",
      "PlanProgress",
      "CheckDraft",
      "AdmitPlan",
    ]) {
      expect(names).not.toContain(name);
    }

    // The command surface those bytes belong to is source-only in this build
    // too: help describes both explicit compositions and names no option that
    // would run the approved program.
    const helped = yield* timebox<ProcessResult>(TIMEOUT, function* () {
      return yield* exec(BINARY, { arguments: ["plan", "--help"], cwd: elsewhere }).join();
    });
    if (helped.timeout) {
      throw new Error("the compiled binary timed out describing xmd plan");
    }
    expect(helped.value.code).toBe(0);
    expect(helped.value.stdout).toContain("Planning never runs the approved program.");
    expect(helped.value.stdout).toContain('xmd plan "Prepare the release program." | xmd run -');
    expect(helped.value.stdout).toContain(
      'xmd plan "Prepare the release program." --output release.md && xmd run release.md',
    );
    // The two options that observe this command's own authorship travel with
    // those bytes too, in full, and so does what a journal costs.
    expect(helped.value.stdout).toContain(
      "--verbose                 show generated drafts and XMD check diagnostics on stderr",
    );
    expect(helped.value.stdout).toContain(
      "--journal [JOURNAL]       record the planning process as diagnostic JSONL " +
        "(path must not exist)",
    );
    expect(helped.value.stdout).toContain(
      "Secret detection checks journal entries before they are recorded",
    );
    // And nothing that would run the approved program. Matched as whole tokens,
    // because `-j` is a substring of the `--journal` this command does define.
    for (const option of ["--run", "--props", "--raw", "--deny-all", "-V", "-j"]) {
      expect(`${option}: ${new RegExp(`(^|\\s)${option}\\b`, "m").test(helped.value.stdout)}`).toBe(
        `${option}: false`,
      );
    }
  });
});
