/**
 * Selecting a Plugin from the compiled binary.
 *
 * A compiled `xmd` has no checkout, no `node_modules` and no module graph to
 * add to — it has whatever `deno compile` embedded. So the question this asks
 * is the one nothing else can: can a binary with none of that still load a
 * module an operator named on the command line, and run it?
 *
 * The fixture imports nothing, because that is the portable contract. An
 * external Plugin that reached for a package would be asking the binary to
 * resolve a specifier in an environment it does not have, and a row that
 * depended on it would be testing this machine rather than the product.
 *
 * It runs against `dist/xmd`, so `deno task build` has to have happened. A
 * missing binary is reported as the setup it is rather than as a failure of the
 * claim.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import type { ProcessResult } from "@effectionx/process";
import type { Operation } from "effection";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINARY = path.join(ROOT, "dist", "xmd");
const FIXTURE = path.join(ROOT, "packages/cli/tests/fixtures/plugins/external.mjs");
const TIMEOUT = 120_000;

/** Run the compiled binary somewhere that is not the checkout. */
function* runBinary(args: readonly string[], cwd: string): Operation<ProcessResult> {
  const attempt = yield* timebox<ProcessResult>(TIMEOUT, function* () {
    return yield* exec(BINARY, { arguments: [...args], cwd }).join();
  });
  if (attempt.timeout) {
    throw new Error(`the compiled binary timed out running ${args.join(" ")}`);
  }
  return attempt.value;
}

/** Every component name a symbols payload describes. */
function describedNames(stdout: string): string[] {
  const catalog = JSON.parse(stdout);
  return catalog.categories.flatMap((category: { entries: { name?: string }[] }) =>
    category.entries.map((entry) => entry.name),
  );
}

/** A directory that is not the checkout, holding one trivial document. */
function* useElsewhere(body: (dir: string) => Operation<void>): Operation<void> {
  const dir = yield* until(mkdtemp(path.join(tmpdir(), "xmd-compiled-plugin-")));
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  yield* writeTextFile(path.join(dir, "doc.md"), "document body\n");
  yield* body(dir);
}

describe("compiled xmd", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("loads and installs an external Plugin module named by path", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }
    yield* useElsewhere(function* (dir) {
      const run = yield* runBinary(["run", `--plugin=${FIXTURE}`, "doc.md"], dir);
      if (run.code !== 0) {
        throw new Error(`the compiled binary exited ${run.code}\n${run.stderr}`);
      }
      // Loading is running: the module's top level executed before anything
      // could look at what it exported.
      expect(run.stderr).toContain("external-fixture: loaded");
      // And the install ran, and was told which command it was installing for.
      expect(run.stderr).toContain("external-fixture: installed for run");
      // The original argv, with the selection still in it.
      expect(run.stderr).toContain(`"--plugin=${FIXTURE}"`);
      expect(run.stdout).toContain("document body");
    });
  });

  it("describes only the engine's own language when nothing was selected", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }
    // The binary bundles no Plugin and embeds no Plugin's assets. What it
    // describes with no `--plugin` is the language `xmd` itself is — which is
    // also what makes the row below a claim about selection rather than about
    // what happened to be compiled in.
    yield* useElsewhere(function* (dir) {
      const run = yield* runBinary(["syntax", "--json", "--include", dir], dir);
      if (run.code !== 0) {
        throw new Error(`the compiled binary exited ${run.code}\n${run.stderr}`);
      }
      const names = describedNames(run.stdout);
      expect(names).toContain("Syntax");
      expect(names).not.toContain("Finding");
      expect(names).not.toContain("ReviewContext");
    });
  });

  it("gains the review graph from a Plugin the operator named by path", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }
    // No `node_modules` here and nothing embedded, so the package is reached
    // the way the accepted contract says it is: an explicit filesystem path.
    // The binary carries its own copy of core and the package resolves the
    // checkout's, which is the loaded-copy case under real conditions.
    yield* useElsewhere(function* (dir) {
      const review = path.join(ROOT, "packages/code-review-agent/mod.ts");
      const run = yield* runBinary(
        ["syntax", "--json", `--plugin=${review}`, "--include", dir],
        dir,
      );
      if (run.code !== 0) {
        throw new Error(`the compiled binary exited ${run.code}\n${run.stderr}`);
      }
      const names = describedNames(run.stdout);
      expect(names).toContain("Finding");
      expect(names).toContain("ReviewContext");
    });
  });

  it("is not intercepted by a second copy's Api built under the bare name", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }
    // The same two copies as the row above, and the other half of the claim.
    // This fixture builds an Api called `Document` — the public name, not the
    // key canonical core publishes — and composes middleware that never
    // delegates. If the key were the bare name, the binary's own run would
    // render `INTERCEPTED` and the document would be gone.
    yield* useElsewhere(function* (dir) {
      const impostor = path.join(ROOT, "packages/cli/tests/fixtures/plugins/impostor.mjs");
      const wrapper = path.join(ROOT, "packages/cli/tests/fixtures/plugins/wrapper-one.mjs");
      const run = yield* runBinary(
        ["run", `--plugin=${impostor}`, `--plugin=${wrapper}`, "doc.md"],
        dir,
      );
      if (run.code !== 0) {
        throw new Error(`the compiled binary exited ${run.code}\n${run.stderr}`);
      }
      expect(run.stdout).not.toContain("INTERCEPTED");
      // And the Plugin that reached the canonical key still composes.
      expect(run.stdout).toContain("one open");
      expect(run.stdout).toContain("document body");
    });
  });

  it("refuses a module that exports no Plugin, and reads no document", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }
    yield* useElsewhere(function* (dir) {
      const missing = path.join(dir, "absent.mjs");
      const run = yield* runBinary(["run", `--plugin=${missing}`, "doc.md"], dir);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("could not be loaded");
      expect(run.stdout).not.toContain("document body");
    });
  });
});

/**
 * The compiled binary starting and resuming a file outside any repository.
 *
 * The behaviour #443 exists for, through the artifact that ships. The compiled
 * host is Deno too, so what this proves is not a second implementation — it is
 * that nothing the compile step does to module resolution, to the bundled
 * SQLite, or to the Git capability's absence stops a run whose source is its
 * own bytes.
 *
 * Deliberately not in the checkout and deliberately not a repository: the
 * temporary directory has no `.git` anywhere above it that this run may use,
 * and the document is removed before the resume so nothing on disk could
 * answer for it.
 */
describe(
  "compiled workflow source bundles",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("starts and resumes a document outside any repository", function* () {
      if (!(yield* exists(BINARY))) {
        throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
      }

      yield* scoped(function* () {
        const dir = yield* until(mkdtemp(path.join(tmpdir(), "xmd-compiled-bundle-")));
        yield* ensure(() => rm(dir, { recursive: true, force: true }));

        const runs = path.join(dir, "runs");
        const home = path.join(dir, "home");
        yield* ensureDir(runs);
        yield* ensureDir(home);

        const document = path.join(dir, "release.md");
        yield* writeTextFile(document, "# Release\n\nretained by the run\n");

        const environment = { HOME: home, XMD_WORKFLOW_RUNS: runs };
        const started = yield* timebox<ProcessResult>(TIMEOUT, function* () {
          return yield* exec(BINARY, {
            arguments: ["workflow", "start", "--id=compiled-1", document],
            cwd: dir,
            env: environment,
          }).join();
        });
        if (started.timeout) {
          throw new Error("the compiled binary timed out starting a source-bundle run");
        }
        expect(started.value.code).toBe(0);
        expect(started.value.stdout).toContain("retained by the run");

        // The document is gone. The run is not.
        yield* rm(document, { force: true });

        const resumed = yield* timebox<ProcessResult>(TIMEOUT, function* () {
          return yield* exec(BINARY, {
            arguments: ["workflow", "resume", "compiled-1"],
            cwd: dir,
            env: environment,
          }).join();
        });
        if (resumed.timeout) {
          throw new Error("the compiled binary timed out resuming a source-bundle run");
        }
        expect(resumed.value.code).toBe(0);
        expect(resumed.value.stdout).toContain("retained by the run");
      });
    });
  },
);
