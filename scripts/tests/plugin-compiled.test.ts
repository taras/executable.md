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
import { ensure, until } from "effection";
import { exists, rm, writeTextFile } from "@effectionx/fs";
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

  it("still carries its bundled review graph beside a selected Plugin", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }
    yield* useElsewhere(function* (dir) {
      const run = yield* runBinary(
        ["syntax", "--json", `--plugin=${FIXTURE}`, "--include", dir],
        dir,
      );
      if (run.code !== 0) {
        throw new Error(`the compiled binary exited ${run.code}\n${run.stderr}`);
      }
      expect(run.stderr).toContain("external-fixture: installed for syntax");
      const catalog = JSON.parse(run.stdout);
      const names = catalog.categories.flatMap((category: { entries: { name?: string }[] }) =>
        category.entries.map((entry) => entry.name),
      );
      // The embedded assets the bundled Plugin declares are still there: a
      // build that shipped the code without them would resolve the name and
      // find nothing behind it.
      expect(names).toContain("Finding");
    });
  });

  it("composes with a Plugin that loaded its own copy of core", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
    }
    // The binary carries its own copy of `@executablemd/core`; this fixture
    // resolves the checkout's, so the `Document` Api the Plugin composes and
    // the one canonical execution reads are two module instances. They compose
    // because the Api's name is stable and the values are plain structural
    // data — a brand, a symbol or an `instanceof` check here would silently
    // drop everything the Plugin installed, and the run would render the
    // document with no wrapper at all rather than failing.
    yield* useElsewhere(function* (dir) {
      const wrapper = path.join(ROOT, "packages/cli/tests/fixtures/plugins/wrapper-one.mjs");
      const run = yield* runBinary(["run", `--plugin=${wrapper}`, "doc.md"], dir);
      if (run.code !== 0) {
        throw new Error(`the compiled binary exited ${run.code}\n${run.stderr}`);
      }
      expect(run.stdout).toContain("one open");
      expect(run.stdout).toContain("document body");
      expect(run.stdout).toContain("one close");
      expect(run.stdout.indexOf("one open")).toBeLessThan(run.stdout.indexOf("document body"));
      expect(run.stdout.indexOf("document body")).toBeLessThan(run.stdout.indexOf("one close"));
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
