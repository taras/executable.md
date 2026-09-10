/**
 * The packaged component documentation, through the compiled binary.
 *
 * Every `components.md` is located from its own module's URL, so a compiled
 * `xmd` has whatever `--include` embedded and no checkout to fall back on. A
 * build that dropped one still lists every component and still prints each
 * one's metadata from the registry — what it cannot do is document any of them,
 * and it says so with an error naming a path inside a binary. That was the
 * state of every published release before the compile inputs were made
 * canonical, which is why this runs before a release attests anything.
 *
 * The typo is the half that makes it evidence. A binary missing its assets
 * fails *both* lookups the same way, so a passing `xmd syntax TempDir` alone
 * would not distinguish a working build from one whose error happened to
 * contain the word. Asking for a name that does not exist and getting the
 * ordinary refusal is what proves the documentation was read rather than
 * skipped.
 *
 * Usage:
 *   deno run --allow-all --frozen scripts/smoke-documentation.ts [binary]
 */

import { main } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { ensureDir, exists, writeTextFile } from "@effectionx/fs";
import * as path from "node:path";

import { useTempDirectory } from "./lib/temp-directory.ts";

/** What a build with no packaged documentation says instead of documenting. */
const MISSING_ASSET = "packaged component documentation is missing";

function fail(claim: string): never {
  console.error(`documentation smoke: ${claim}`);
  Deno.exit(1);
}

function* ask(binary: string, args: string[], cwd: string): Operation<ProcessResult> {
  return yield* exec(binary, { arguments: args, cwd }).join();
}

/** Every phrase `text` does not contain, so one run reports all of them. */
function absent(text: string, expected: string[]): string[] {
  return expected.filter((phrase) => !text.includes(phrase));
}

await main(function* (args) {
  const binary = path.resolve(args[0] ?? path.join(Deno.cwd(), "dist", "xmd"));
  if (!(yield* exists(binary))) {
    fail(`no compiled binary at ${binary} — run \`deno task build\` first`);
  }

  // Somewhere that is not the checkout, with a search path of its own: neither
  // the working directory nor `--include` may decide what this product's own
  // components are documented as, and a lookup that reached for either would
  // find nothing here.
  const elsewhere = yield* useTempDirectory("xmd-smoke-documentation-");
  const include = path.join(elsewhere, "components");
  yield* ensureDir(include);
  yield* writeTextFile(path.join(include, "Badge.md"), "verified\n");

  const documented = yield* ask(binary, ["syntax", "TempDir", "--include", include], elsewhere);
  if (documented.code !== 0) {
    fail(
      documented.stderr.includes(MISSING_ASSET)
        ? `the binary carries no packaged documentation: ${documented.stderr.trim()}`
        : `xmd syntax TempDir exited ${documented.code}: ${documented.stderr.trim()}`,
    );
  }
  // The metadata comes from the registry and the prose comes from the packaged
  // asset, so both halves are named: a binary that shipped the module graph and
  // none of its documents renders the first and not the second.
  const missing = absent(documented.stdout, [
    "### `<TempDir>`",
    "**Forms:** `<TempDir />`, `<TempDir>…</TempDir>`",
    "**Origin:** `@executablemd/core`",
    "Runs work in a temporary working directory.",
    '<TempDir as="workspace" />',
  ]);
  if (missing.length > 0) {
    fail(`xmd syntax TempDir rendered no ${JSON.stringify(missing)}`);
  }

  const typo = yield* ask(binary, ["syntax", "TemdDir", "--include", include], elsewhere);
  if (typo.code === 0) {
    fail("xmd syntax TemdDir succeeded, so the name lookup admits anything");
  }
  if (typo.stderr.includes(MISSING_ASSET)) {
    fail(`an unknown name reported a missing asset instead of refusing: ${typo.stderr.trim()}`);
  }
  if (!typo.stderr.includes("is not a component available here")) {
    fail(`xmd syntax TemdDir did not make the ordinary refusal: ${typo.stderr.trim()}`);
  }
  // A refusal that printed a healthy subset would read as a complete answer.
  if (typo.stdout !== "") {
    fail(`xmd syntax TemdDir wrote to stdout: ${JSON.stringify(typo.stdout)}`);
  }

  const rendered = yield* ask(
    binary,
    ["-e", '<Syntax names={["Elicit", "File"]} />', "--include", include, "--raw"],
    elsewhere,
  );
  if (rendered.code !== 0) {
    fail(`<Syntax names={…} /> exited ${rendered.code}: ${rendered.stderr.trim()}`);
  }
  const unrendered = absent(rendered.stdout, [
    "### `<Elicit>`",
    "Asks a person a structured question and returns their answer.",
    "### `<File>`",
    "Reads or writes a file, relative to the working directory.",
  ]);
  if (unrendered.length > 0) {
    fail(`<Syntax names={…} /> rendered no ${JSON.stringify(unrendered)}`);
  }

  console.log(
    "documentation smoke: one component documented, an unknown one refused, two rendered " +
      "from a directory that is not the checkout",
  );
});
