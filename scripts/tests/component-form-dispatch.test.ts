/**
 * The compiled binary's two copies of core agree about a component's form.
 *
 * `deno compile` embeds one copy of core. A repository component directory can
 * hold a same-named `.ts` file — `packages/core/src/components/File.ts` is one,
 * and `xmd test <directory>` puts a document's own directory first in the
 * search path — so the binary can load a *second* copy of that implementation
 * from disk while the invocation was minted by the embedded one.
 *
 * That is the case an authenticated reader inside the component cannot serve:
 * private fields and WeakMaps are exact-object mechanisms within one loaded
 * copy. Canonical construction builds the form dispatcher in the copy
 * performing the execution instead, so the loaded implementation is wrapped by
 * the copy that minted the invocation, and both routes reach the same body.
 *
 * Only the compiled binary shows it. Under `deno run` the on-disk path resolves
 * to the module already in the graph, so there is one copy and nothing to
 * disagree.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exec } from "@effectionx/process";
import { ensureDir, exists, writeTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useTempDirectory } from "../lib/temp-directory.ts";

const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
const BINARY = join(REPOSITORY, "dist/xmd");

/** The component sources the binary also embeds, as a search path. */
const SHADOWING = "packages/core/src/components";

interface Run {
  readonly code: number;
  readonly output: string;
}

function* run(cwd: string, args: string[]): Operation<Run> {
  const settled = yield* exec(BINARY, { arguments: args, cwd }).join();
  return { code: settled.code ?? 1, output: `${settled.stdout}${settled.stderr}` };
}

describe("compiled form dispatch across loaded copies", () => {
  it("reads the same way with the embedded default and with a second copy", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this suite`);
    }

    const directory = yield* useTempDirectory("xmd-form-dispatch-");
    yield* writeTextFile(join(directory, "probe.txt"), "the authored bytes");

    // The embedded default, and then the same element with core's own component
    // sources on the search path — which resolves `<File>` to a repository
    // component loaded from disk, a second copy of the implementation.
    const embedded = yield* run(directory, ["-e", '<File path="probe.txt" />', "--raw"]);
    const loaded = yield* run(directory, [
      "-e",
      '<File path="probe.txt" />',
      "--component-dir",
      join(REPOSITORY, SHADOWING),
      "--raw",
    ]);

    expect(embedded.code).toEqual(0);
    expect(embedded.output).toContain("the authored bytes");
    // The whole claim: the second copy reaches the same read.
    expect(loaded.code).toEqual(embedded.code);
    expect(loaded.output).toContain("the authored bytes");
    expect(loaded.output).not.toContain("without the invocation the engine issued");
  });

  it("keeps each form's contract when the implementation is a second copy", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error(`${BINARY} is missing — run \`deno task build\` before this suite`);
    }

    const directory = yield* useTempDirectory("xmd-form-dispatch-");
    yield* ensureDir(directory);
    yield* writeTextFile(join(directory, "doomed.md"), "obsolete");
    yield* writeTextFile(join(directory, "kept.md"), "kept");
    const search = join(REPOSITORY, SHADOWING);

    // A paired `<File>` still writes through the loaded copy.
    const wrote = yield* run(directory, [
      "-e",
      '<File path="written.md">from the second copy</File>',
      "--component-dir",
      search,
      "--raw",
    ]);
    expect(wrote.code).toEqual(0);
    expect(yield* exists(join(directory, "written.md"))).toBe(true);

    // Self-closing `<File.Delete>` still deletes through it.
    const deleted = yield* run(directory, [
      "-e",
      '<File.Delete path="doomed.md" />',
      "--component-dir",
      search,
      "--raw",
    ]);
    expect(deleted.code).toEqual(0);
    expect(yield* exists(join(directory, "doomed.md"))).toBe(false);

    // And the form it does not run is still refused, rather than deleting.
    const paired = yield* run(directory, [
      "-e",
      '<File.Delete path="kept.md">paired</File.Delete>',
      "--component-dir",
      search,
      "--raw",
    ]);
    expect(paired.output).toContain("<File.Delete> is self-closing");
    expect(yield* exists(join(directory, "kept.md"))).toBe(true);
  });
});
