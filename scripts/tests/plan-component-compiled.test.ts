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
import { fileURLToPath as fromFileUrl } from "node:url";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINARY = path.join(ROOT, "dist", "xmd");
const COMPONENT = path.join(ROOT, "packages/cli/src/documents/Plan.md");
const TIMEOUT = 60_000;

/** The CLI as this checkout runs it, for the source half of the journey. */
const SOURCE_ENTRY = "packages/cli/src/deno.ts";
/** The scripted journey both installations run, relative to the checkout. */
const SMOKE = "smoke-test/plan-information/README.md";
/** A journey spawns an agent worker of its own, so it is not a syntax lookup. */
const JOURNEY_TIMEOUT = 300_000;

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
      "PlanInputs",
      "PlanAuthorship",
      "PlanProgress",
      "CheckDraft",
      "AdmitPlan",
      "ClassifyPlanResponse",
      "PlanInformation",
    ]) {
      expect(names).not.toContain(name);
    }

    // `<Syntax />` is public, and the compiled binary describes it exactly once
    // from the canonical origin. The protected tier ships inside the binary
    // rather than being assembled by whoever installs the profile, so a build
    // that lost it would describe no catalog component at all.
    const syntax = entries.filter((entry: { name?: string }) => entry?.name === "Syntax");
    expect(syntax).toHaveLength(1);
    expect(syntax[0].origin).toEqual({ kind: "protected", origin: "@executablemd/core" });
    expect(syntax[0].sourceKind).toBe("protected");
    expect(syntax[0].forms).toEqual(["self-closing"]);
    expect(syntax[0].returnMode).toBe("text");
    expect(syntax[0].description).toBe(
      "Inspect available components and control-flow constructs. `<Syntax />` lists the " +
        'symbols available here; `<Syntax names={["Elicit"]} />` renders selected documentation.',
    );

    // FE28, at the compiled boundary. `<Evaluate>` is the tier's second member
    // and ships inside the binary for the same reason: a build that carried the
    // protected tier without it would let a document write the name with no
    // implementation able to answer it, at a person's first `<Evaluate>` rather
    // than here. This boundary is asserted explicitly because `--changed`
    // cannot see it — nothing in `dist/xmd` shares a path with the core sources
    // the name is defined in, and no test shard builds the binary at all.
    const evaluate = entries.filter((entry: { name?: string }) => entry?.name === "Evaluate");
    expect(evaluate).toHaveLength(1);
    expect(evaluate[0].origin).toEqual({ kind: "protected", origin: "@executablemd/core" });
    expect(evaluate[0].sourceKind).toBe("protected");
    // Both spellings, because the two input forms are two ways of stating one
    // argument.
    expect(evaluate[0].forms).toEqual(["self-closing", "paired"]);
    expect(evaluate[0].description).toBe(
      'Evaluate program text. `<Evaluate text={program} allow={["read"]} />` runs it.',
    );
    // And the closed schema travels with it: a build that shipped a widened one
    // would let a fragment-bearing prop nobody validated reach the body.
    expect(evaluate[0].props.additionalProperties).toBe(false);
    expect(Object.keys(evaluate[0].props.properties)).toEqual(["text", "source", "allow"]);

    // The documentation asset travels with the binary, not with a checkout. A
    // build that forgot `--include` would still list the component and still
    // print its metadata, and would silently have no prose to attach — so the
    // probe is the documentation itself, asked for from a directory that is not
    // the checkout.
    const lookup = yield* timebox<ProcessResult>(TIMEOUT, function* () {
      return yield* exec(BINARY, {
        arguments: ["syntax", "Elicit", "--include", elsewhere],
        cwd: elsewhere,
      }).join();
    });
    if (lookup.timeout) {
      throw new Error("the compiled binary timed out documenting one component");
    }
    expect(lookup.value.code).toBe(0);
    expect(lookup.value.stdout).toContain("### `<Elicit>`");
    expect(lookup.value.stdout).toContain("Asks a person a structured question");
    expect(lookup.value.stdout).toContain("**Available in this evaluation:** yes");

    // A component from a boundary *outside* core's own documentation file, so
    // the probe exercises a second copied asset path rather than proving only
    // that the first one shipped.
    const outside = yield* timebox<ProcessResult>(TIMEOUT, function* () {
      return yield* exec(BINARY, {
        arguments: ["syntax", "Git.Commit", "--include", elsewhere],
        cwd: elsewhere,
      }).join();
    });
    if (outside.timeout) {
      throw new Error("the compiled binary timed out documenting a composition component");
    }
    expect(outside.value.code).toBe(0);
    expect(outside.value.stdout).toContain("### `<Git.Commit>`");
    expect(outside.value.stdout).toContain("Commits what is staged");

    // And the compiled answer is the source answer, byte for byte.
    const fromSource = yield* timebox<ProcessResult>(TIMEOUT, function* () {
      return yield* exec("deno", {
        arguments: [
          "run",
          "--allow-all",
          fromFileUrl(new URL("../../packages/cli/src/deno.ts", import.meta.url)),
          "syntax",
          "Git.Commit",
          "--include",
          elsewhere,
        ],
        cwd: elsewhere,
      }).join();
    });
    if (fromSource.timeout) {
      throw new Error("the source CLI timed out documenting a composition component");
    }
    expect(fromSource.value.stdout).toBe(outside.value.stdout);

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

  /**
   * PI9 — one scripted request-to-approved-Plan journey, run twice.
   *
   * The catalog case above asks what a build *says*. This asks it to do the
   * thing: a coding agent answers the drafting turn with a read-only XMD
   * program, `<Plan>` evaluates it under the ceiling this build ships, and the
   * findings come back as the next turn's context.
   *
   * Which is a distribution question three times over. `<Syntax>` documentation
   * is answered from packaged assets, the protected tier that implements
   * `<Evaluate>` ships inside the binary, and `Plan.md` is Markdown rather than
   * a module. A build that lost any of them resolves every name in the document
   * and then fails, and the smoke document's own agent is what notices: its
   * second `<WhenPrompt>` answers only a prompt carrying the selected
   * documentation.
   *
   * Both installations run the same file, so a divergence is a build's and not
   * a fixture's.
   */
  it("answers an information request and approves a Plan, compiled and from source", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }

    for (const [label, command, args] of [
      ["compiled", BINARY, [] as string[]],
      ["source", Deno.execPath(), ["run", "--allow-all", path.join(ROOT, SOURCE_ENTRY)]],
    ] as const) {
      const attempt = yield* timebox<ProcessResult>(JOURNEY_TIMEOUT, function* () {
        return yield* exec(command, {
          arguments: [...args, "test", SMOKE, "--raw"],
          cwd: ROOT,
          env: Deno.env.toObject(),
        }).join();
      });
      if (attempt.timeout) {
        throw new Error(`the ${label} installation timed out writing a Plan`);
      }
      const run = attempt.value;
      expect(`${label}: ${run.code}`).toBe(`${label}: 0`);
      // The approved program reached the document that asked for it, whole.
      expect(`${label}: ${run.stdout.includes("# Approved program")}`).toBe(`${label}: true`);
      expect(`${label}: ${run.stdout.includes("the approved Plan ran")}`).toBe(`${label}: true`);
      // And nothing ran it: `<Plan>` renders program text, so the file that
      // program names is still nobody's.
      expect(`${label}: ${yield* exists(path.join(ROOT, "planned.txt"))}`).toBe(`${label}: false`);
    }
  });

  /**
   * The command document itself is embedded, not only the Component it declares.
   *
   * `plan-command.md` is the second packaged asset on this path and has no
   * catalog entry, so the digest case above cannot see it. This runs the command
   * far enough to prove the bytes are there and then stops on the one dependency
   * a build cannot supply: an agent name that resolves to nothing.
   *
   * The phases are the evidence. A binary that shipped no command document
   * fails before the first of them — there is no program to announce anything —
   * while this one announces Preparing, builds the catalog through the protected
   * `<Syntax />` it also embeds, and only then cannot find an agent.
   *
   * `HOME` is a directory this case made, so the session placement the command
   * derives is under it and never the developer's own tree.
   */
  it("embeds the command document, not just the Component it declares", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }

    const home = yield* until(mkdtemp(path.join(tmpdir(), "xmd-compiled-plan-home-")));
    yield* ensure(() => rm(home, { recursive: true, force: true }));
    const elsewhere = yield* until(mkdtemp(path.join(tmpdir(), "xmd-compiled-plan-cwd-")));
    yield* ensure(() => rm(elsewhere, { recursive: true, force: true }));

    const attempt = yield* timebox<ProcessResult>(JOURNEY_TIMEOUT, function* () {
      return yield* exec(BINARY, {
        arguments: ["plan", "write a greeting", "--default-agent", "no-such-agent-here"],
        cwd: elsewhere,
        env: { HOME: home },
      }).join();
    });
    if (attempt.timeout) {
      throw new Error("the compiled binary timed out preparing a Plan");
    }
    const run = attempt.value;

    // It got as far as an agent, which means every packaged byte before that
    // resolved: the command document, the `<Plan>` declaration it writes, and
    // the protected tier its catalog phase reaches.
    expect(run.stderr).toContain("Preparing the Plan");
    expect(run.stderr).toContain("Getting the available XMD components");
    expect(run.stderr).toContain("no-such-agent-here");
    // And it is the agent that was missing, not a program.
    expect(run.stderr).not.toContain("Cannot resolve component");
    expect(run.stderr).not.toContain("could not read");
    expect(run.code).not.toBe(0);
    // Nothing was delivered and nothing reached the caller's directory.
    expect(run.stdout).toBe("");
    expect((yield* until(readdir(elsewhere))).length).toBe(0);
  });
});
