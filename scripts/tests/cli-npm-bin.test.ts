/**
 * Build packages/cli and run the emitted bin under Node. The test-agent smoke
 * document drives a full session/prompt path, so the Node parent must relaunch
 * itself as `xmd test-agent` to pass — the bare `Deno.*` global that kept
 * `@executablemd/cli@0.5.0` off npm compiles fine under Deno and fails only
 * here.
 *
 * The build runs with `DNT_LOCAL_SIBLINGS=1`, so packages/cli and every
 * @executablemd sibling it depends on are built from this branch's sources. A
 * release build resolves those siblings from npm instead, which type-checks the
 * branch against the *previous* release — green until a branch changes a shared
 * API, then red for a reason the branch cannot fix. This is also the only
 * coverage of the local-sibling build mode.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runShell, shellQuote } from "@executablemd/test-support/launch";
import { ensure, until } from "effection";
import { readTextFile, rm } from "@effectionx/fs";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Operation } from "effection";
import { exec, Stdio } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import { removeNpmOutput } from "./npm-output.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PKG_DIR = "packages/cli";
const OUT_DIR = path.join(ROOT, PKG_DIR, "npm");
const BIN = path.join(OUT_DIR, "esm/src/node.js");
const DOC = path.join(ROOT, "smoke-test/test-agent/README.md");

/** npm install and a full dnt type-check dominate this; the run itself is quick. */
const TIMEOUT = 600_000;

interface Manifest {
  version?: string;
  dependencies?: Record<string, string>;
}

function* readManifest(...segments: string[]): Operation<Manifest> {
  return JSON.parse(yield* readTextFile(path.join(ROOT, ...segments)));
}

function* buildCliPackage(version: string): Operation<ProcessResult> {
  // The builder narrates every file it emits; only its exit code matters here.
  yield* Stdio.around({
    *stdout() {},
    *stderr() {},
  });

  return yield* exec(Deno.execPath(), {
    arguments: ["run", "-A", "scripts/build-npm.ts", PKG_DIR, version],
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      // @effectionx/* peer-depend on effection `^3 || ^4`, which npm will not
      // match against the pinned 4.x prerelease — the same allowance
      // publish-one.yml makes.
      NPM_CONFIG_LEGACY_PEER_DEPS: "true",
      // Build the siblings from this branch rather than resolving the last
      // published versions of them.
      DNT_LOCAL_SIBLINGS: "1",
    },
  }).join();
}

/** The manifest dnt emitted for the published package. */
function* readEmittedManifest(): Operation<Manifest> {
  return JSON.parse(yield* readTextFile(path.join(OUT_DIR, "package.json")));
}

/** Run the built bin under Node, the way an `npm i -g @executablemd/cli` user would. */
function runEmittedBin(args: string[]): Operation<ProcessResult> {
  return runEmittedBinIn(ROOT, args);
}

/** The same, from a working directory the caller chooses. */
function* runEmittedBinIn(cwd: string, args: string[]): Operation<ProcessResult> {
  const result = yield* timebox<ProcessResult>(TIMEOUT, function* () {
    return yield* exec("node", {
      arguments: [BIN, ...args],
      cwd,
      env: Deno.env.toObject(),
    }).join();
  });
  if (result.timeout) {
    throw new Error("the emitted npm bin timed out");
  }
  return result.value;
}

describe("npm CLI package", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("relaunches its test-agent worker under Node", function* () {
    yield* ensure(removeNpmOutput);
    const { version } = yield* readManifest(PKG_DIR, "deno.json");

    const built = yield* buildCliPackage(version ?? "0.0.0-dev");
    if (built.code !== 0) {
      throw new Error(`build-npm.ts exited ${built.code}\n${built.stderr}`);
    }

    const run = yield* runEmittedBin(["test", DOC]);
    if (run.code !== 0) {
      throw new Error(`the emitted npm bin exited ${run.code}\n${run.stderr}`);
    }

    expect(run.stdout).toContain("The review of **packages/core** at `abc123` passed.");
    expect(run.stdout).toContain("The review of **packages/core** passed.");
    // The nested `host="run"` child's own return. It reached a scripted agent
    // and a declared answer through a worker this package relaunched, which is
    // the whole of what a built npm bin has to get right for one.
    expect(run.stdout).toContain("You chose to approve the review.");
    expect(run.stdout).not.toContain("ERROR");

    // The Markdown this package executes itself ships beside the module that
    // reads it. dnt emits the module graph only, so an asset nothing imports is
    // absent from the package unless the build copies it — and the command
    // would then find no program to run, on Node and Bun while Deno stayed
    // green.
    for (const asset of ["plan-command.md", "Plan.md"]) {
      expect(yield* readTextFile(path.join(OUT_DIR, "esm/src/documents", asset))).toBe(
        yield* readTextFile(path.join(ROOT, PKG_DIR, "src/documents", asset)),
      );
    }
  });

  /**
   * A program piped into the emitted bin, through a pipe that really closes.
   *
   * `xmd run -` reads standard input to end of file, and end of file is what a
   * distribution can get wrong while every other test stays green: the shared
   * CLI asks the host for the read, and each runtime entrypoint answers with
   * its own stdin. This is the emitted Node entrypoint's answer, exercised the
   * way a caller composes it rather than through argv.
   */
  it("runs a complete program piped into the emitted bin", function* () {
    yield* ensure(removeNpmOutput);
    const { version } = yield* readManifest(PKG_DIR, "deno.json");
    const built = yield* buildCliPackage(version ?? "0.0.0-dev");
    if (built.code !== 0) {
      throw new Error(`build-npm.ts exited ${built.code}\n${built.stderr}`);
    }

    // Run from a directory that is not the package, so nothing the program
    // renders could have come from a file beside the bin.
    const elsewhere = yield* until(mkdtemp(path.join(tmpdir(), "xmd-npm-stdin-")));
    yield* ensure(() => rm(elsewhere, { recursive: true, force: true }));
    const line = `${shellQuote("node")} ${shellQuote(BIN)} run - --raw`;

    const run = yield* runShell(line, {
      cwd: elsewhere,
      inheritEnv: true,
      stdin: "# Piped\n\nNPM_STDIN_MARKER\n",
    }).join();
    if (run.code !== 0) {
      throw new Error(`the emitted npm bin exited ${run.code}\n${run.stderr}`);
    }
    expect(run.stdout).toContain("NPM_STDIN_MARKER");
    expect(run.stdout).not.toContain("ERROR");

    // The origin travels with the text: a positioned diagnostic from this
    // entrypoint names `<stdin>` rather than a path nothing could read back.
    const positioned = yield* runShell(line, {
      cwd: elsewhere,
      inheritEnv: true,
      stdin: "PREFIX\n\n<Else>stray</Else>\n",
    }).join();
    expect(positioned.code).toBe(1);
    expect(positioned.stderr).toContain("(<stdin>:3:1)");
  });

  /**
   * The packaged `<Plan>` Component, as the published package reports it.
   *
   * `<Plan>` is packaged Markdown rather than a module, so what a build ships
   * under that name is exactly the kind of thing a module-graph emitter can
   * lose. Asking the built bin what it would let a document write is what makes
   * "the same Component in every distribution" a checked claim: the origin names
   * the asset, the digest names the bytes, and a build that shipped different
   * ones — or none — answers differently here rather than at a person's first
   * `xmd plan`.
   *
   * Run from a directory that is not the package, because the lookup must be
   * beside the module and never beside the caller.
   */
  it("reports the same <Plan> Component identity the source tree ships", function* () {
    yield* ensure(removeNpmOutput);
    const { version } = yield* readManifest(PKG_DIR, "deno.json");
    const built = yield* buildCliPackage(version ?? "0.0.0-dev");
    if (built.code !== 0) {
      throw new Error(`build-npm.ts exited ${built.code}\n${built.stderr}`);
    }

    const source = yield* readTextFile(path.join(ROOT, PKG_DIR, "src/documents/Plan.md"));
    const digest = createHash("sha256").update(source, "utf8").digest("hex");

    const elsewhere = yield* until(mkdtemp(path.join(tmpdir(), "xmd-npm-plan-")));
    yield* ensure(() => rm(elsewhere, { recursive: true, force: true }));
    const run = yield* runEmittedBinIn(elsewhere, ["syntax", "--json", "--include", elsewhere]);
    if (run.code !== 0) {
      throw new Error(`the emitted npm bin exited ${run.code}\n${run.stderr}`);
    }

    const catalog = JSON.parse(run.stdout);
    const entries = catalog.categories.flatMap(
      (category: { entries: unknown[] }) => category.entries,
    );
    const plan = entries.find((entry: { name?: string }) => entry?.name === "Plan");
    expect(plan).toBeDefined();
    expect(plan.sourceKind).toBe("declared-markdown");
    expect(plan.origin).toEqual({
      kind: "declared-markdown",
      origin: "@executablemd/cli/Plan.md",
      digest,
    });
    expect(plan.forms).toEqual(["paired"]);
    // And no private capability is syntax a document may write, in any build.
    for (const name of [
      "PlanInputs",
      "PlanAuthorship",
      "PlanProgress",
      "CheckDraft",
      "AdmitPlan",
    ]) {
      expect(entries.map((entry: { name?: string }) => entry?.name)).not.toContain(name);
    }

    // `<Syntax />` is public in every build, and this one describes it exactly
    // once, from the canonical origin, with the approved description. A package
    // that lost the protected tier would either omit it or list it twice.
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

    // The documentation assets travel with the package, and the emitted binary
    // resolves them from its own tree rather than from a checkout. `Prompt`
    // lives in core's *agent* boundary rather than in its own `components.md`,
    // so this exercises a second copied asset path: a build that copied only
    // the first would still answer for core's own components and fail here.
    const documented = yield* runEmittedBinIn(elsewhere, ["syntax", "Prompt"]);
    expect(documented.code).toBe(0);
    expect(documented.stdout).toContain("### `<Prompt>`");
    expect(documented.stdout).toContain("Sends a prompt and renders the reply");
    expect(documented.stdout).toContain("**Available in this evaluation:** yes");

    // And it is the same answer the source tree gives, whole.
    const fromSource = yield* exec(Deno.execPath(), {
      arguments: ["run", "-A", path.join(ROOT, "packages/cli/src/deno.ts"), "syntax", "Prompt"],
      cwd: elsewhere,
      env: Deno.env.toObject(),
    }).join();
    expect(documented.stdout).toBe(fromSource.stdout);

    // The command's public grammar travels with those bytes. `--run` is gone,
    // and this directory has no agent to reach and no `DEFAULT_AGENT_NAME` that
    // resolves here — so a build that still accepted the switch would fail on
    // the agent instead of answering with the migration, which is what makes
    // this a check on preflight rather than on the exit status.
    const removed = yield* runEmittedBinIn(elsewhere, [
      "plan",
      "prepare the release program",
      "--run",
    ]);
    expect(removed.code).toBe(1);
    expect(removed.stdout).toBe("");
    expect(removed.stderr).toContain(
      "xmd plan --run was removed because xmd plan only produces approved source.",
    );
    expect(removed.stderr).toContain('xmd plan "..." | xmd run -');
    expect(removed.stderr).toContain('xmd plan "..." --output release.md && xmd run release.md');
    expect(removed.stderr).not.toContain("unavailable");
    // The same for the upgrade command's program. The npm build discovers the
    // directory rather than listing files, so this is the check that the
    // discovery really covered the second document too.
    expect(yield* readTextFile(path.join(OUT_DIR, "esm/src/documents/upgrade-command.md"))).toBe(
      yield* readTextFile(path.join(ROOT, PKG_DIR, "src/documents/upgrade-command.md")),
    );

    // `semver` is imported by the upgrade document's eval block, which nothing
    // in the emitted module graph references. A transitive copy that happens to
    // be installed alongside is not a dependency this package may resolve
    // through: it is declared, so npm installs it.
    expect((yield* readEmittedManifest()).dependencies?.semver).toBeDefined();

    // And on this host the command refuses before any of that matters. The
    // provenance refusal runs ahead of the block that imports semver, ahead of
    // any release lookup, and ahead of touching a file — which is what makes
    // the npm package safe to publish without the eval block ever resolving.
    const refused = yield* runEmittedBin(["upgrade", "--status"]);
    expect(refused.code).toBe(1);
    // The document is the output, so even a refused host renders its heading.
    // What matters is that the npm package answered at all: the transcript
    // arrived through the same streaming path a compiled binary uses.
    expect(refused.stdout.trim()).toBe("# Upgrade XMD");
    expect(refused.stderr).toContain(
      "npm manages this xmd installation. Run npm install -g @executablemd/cli@latest, or " +
        "replace latest with an exact package version. No release was read, and the binary was " +
        "not changed.",
    );
  });
});
