/**
 * The installed terminal syntax, as the compiled binary carries it.
 *
 * A compiled `xmd` has no checkout to read from: it has whatever the build
 * embedded and whatever its entrypoint assembled. The grid's syntax is no
 * longer core's, so a binary whose compiled entrypoint forgot to install
 * `@executablemd/terminal/xmd` resolves the name to nothing — and it would say
 * so at a person's first grid rather than here.
 *
 * So this asks the binary two questions from a directory that is not the
 * checkout: which syntax it would let a document write, and what a valid grid
 * does. Describing an environment opens no terminal, and a grid on a build with
 * no provider stops at the provider boundary — so nothing here starts a shell.
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
import type { Operation } from "effection";
import type { ProcessResult } from "@effectionx/process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINARY = path.join(ROOT, "dist", "xmd");
const TIMEOUT = 60_000;

const GRID = [
  "<Terminal.Grid columns={2}>",
  '<Terminal title="Agent">Instructions.</Terminal>',
  '<Terminal title="Shell" />',
  "</Terminal.Grid>",
  "",
].join("\n");

function* elsewhere(): Operation<string> {
  const directory = yield* until(mkdtemp(path.join(tmpdir(), "xmd-compiled-grid-")));
  yield* ensure(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function* runBinary(args: readonly string[], cwd: string): Operation<ProcessResult> {
  const result = yield* timebox(TIMEOUT, function* () {
    return yield* exec(BINARY, { arguments: [...args], cwd }).join();
  });
  if (result.timeout) {
    throw new Error(`${BINARY} ${args.join(" ")} did not finish within ${TIMEOUT}ms`);
  }
  return result.value;
}

function* requireBinary(): Operation<void> {
  if (!(yield* exists(BINARY))) {
    throw new Error(`${BINARY} is missing — run \`deno task build\` before this case`);
  }
}

describe("compiled xmd", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("CP1: describes the installed terminal syntax", function* () {
    yield* requireBinary();
    const cwd = yield* elsewhere();

    const described = yield* runBinary(["syntax"], cwd);

    expect(described.stdout).toContain("### `<Terminal.Grid>`");
    expect(described.stdout).toContain("### `<Terminal>`");
    // The origin is the package that installed it, not the engine.
    expect(described.stdout).toContain("@executablemd/terminal/xmd");
  });

  it("CP1: a valid grid reaches the no-provider refusal rather than an unresolved name", function* () {
    yield* requireBinary();
    const cwd = yield* elsewhere();
    const document = path.join(cwd, "grid.md");
    yield* writeTextFile(document, GRID);

    const run = yield* runBinary(["run", document], cwd);

    // The name resolved as installed syntax and the layout was derived. A build
    // that shipped no installation would have said it could not resolve the
    // component at all, which is the failure this case exists to catch.
    expect(run.code).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain("no terminal provider opened this grid");
    expect(`${run.stdout}${run.stderr}`).not.toContain("Cannot resolve component");
  });

  it("CP1: `xmd test` does not gain the syntax at its own root", function* () {
    yield* requireBinary();
    const cwd = yield* elsewhere();
    const document = path.join(cwd, "grid.test.md");
    yield* writeTextFile(document, GRID);

    const tested = yield* runBinary(["test", document], cwd);

    // The test root is a different profile, and it installs none of it.
    expect(`${tested.stdout}${tested.stderr}`).toContain("Cannot resolve component: Terminal.Grid");
  });
});
