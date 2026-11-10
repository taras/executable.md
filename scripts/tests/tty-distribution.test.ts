/**
 * The prepared terminal runtime reaches the JSR package and the binary (#1216).
 *
 * The CLI imports its terminal engine from the ignored `generated/tty/`, which
 * setup builds from pinned source and a local cache patch. A distribution that
 * dropped those modules, their declarations or their notice would build and
 * then fail at a person's first REPL — and one that carried the producer's
 * inputs would ship sources and patches no runtime reads. The npm artifact is
 * asserted in `cli-npm-bin.test.ts`, beside its one build.
 *
 * Deno only (`scripts/runtime-test-exclusions.ts`): both distributions here are
 * Deno's own build outputs.
 */
import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { shellQuote } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { scoped, sleep, until } from "effection";
import type { Operation } from "effection";
import { copyFile, ensureDir, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { exec, Stdio } from "@effectionx/process";
import { Buffer } from "node:buffer";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { copyPreparedCandidate } from "./candidate-copy.ts";
import { compileArguments, PREPARED_NOTICES } from "../lib/compile.ts";
import { allocate, settledEntry, showing } from "../../packages/cli/tests/support/pty.ts";
import {
  click,
  ended,
  printedLocation,
} from "../../packages/cli/tests/support/repl-issues-journey.ts";

const REPO = new URL("../../", import.meta.url);
const RUNTIME = "packages/cli/generated/tty";
const SHORT = "synthetic sample synthetic sample synthetic sample 022aa2";
const LONG =
  "synthetic sample synthetic sample synthetic sample synthetic sample synthetic sample 01fda4";
/** Bytes only the producer's inputs hold: the local patch and the recipe. */
const PRODUCER_MARKERS = ["clayterm_copy_text_key", "codeload.github.com/bombshell-dev/tty"];

function* quietly<T>(body: () => Operation<T>): Operation<T> {
  return yield* scoped(function* () {
    yield* Stdio.around({ *stdout() {}, *stderr() {} });
    return yield* body();
  });
}

/** The files `deno publish` selects for the CLI, from its own dry-run inventory. */
function cliInventory(output: string, source: URL): URL[] {
  const section = stripVTControlCharacters(output)
    .split("Simulating publish of @executablemd/cli@")[1]
    ?.split("Simulating publish of ")[0];
  if (!section) {
    throw new Error("No actual CLI publish inventory");
  }
  const urls = [...section.matchAll(/file:\/\/[^\n]+?(?= \()/g)].map((match) => new URL(match[0]));
  for (const url of urls) {
    if (!url.href.startsWith(source.href)) {
      throw new Error(`CLI publish inventory escapes its candidate: ${url.href}`);
    }
  }
  return urls;
}

describe("the prepared terminal runtime in the JSR package", () => {
  it("selects the runtime and its notice, no producer input, and the selected graph runs", function* () {
    const candidate = yield* until(realpath(yield* useTempDirectory("xmd-tty-jsr-candidate-")));
    yield* copyPreparedCandidate(candidate);
    const config = JSON.parse(yield* readTextFile(join(candidate, "deno.json")));
    // Deno 2.9.5 publish takes dependency modes from config, not command flags.
    yield* writeTextFile(
      join(candidate, "deno.json"),
      JSON.stringify({ ...config, nodeModulesDir: "manual", lock: { frozen: true } }),
    );
    const published = yield* quietly(() =>
      exec(Deno.execPath(), {
        arguments: ["publish", "--dry-run", "--allow-dirty"],
        cwd: candidate,
      }).join(),
    );
    expect({ code: published.code, stderr: published.code === 0 ? "" : published.stderr }).toEqual({
      code: 0,
      stderr: "",
    });
    const source = pathToFileURL(`${candidate}/packages/cli/`);
    const urls = cliInventory(published.stdout + published.stderr, source);
    const selected = urls.map((url) => decodeURIComponent(url.href.slice(source.href.length)));
    const runtime = (yield* readdir(new URL(`${RUNTIME}/`, REPO))).sort();
    expect(runtime.length).toBe(21);
    expect(selected.filter((path) => path.startsWith("generated/tty/")).sort()).toEqual(
      runtime.map((name) => `generated/tty/${name}`),
    );
    expect(selected.filter((path) => path.startsWith("vendor/"))).toEqual([]);

    // Exactly the selected files, outside any workspace, measure the pair the
    // published engine conflated.
    const root = yield* useTempDirectory("xmd-tty-jsr-selected-");
    for (const [index, path] of selected.entries()) {
      yield* ensureDir(dirname(join(root, path)));
      yield* copyFile(urls[index]!, join(root, path));
    }
    yield* writeTextFile(
      join(root, "smoke.ts"),
      [
        'import { close, createTerm, fit, open, text } from "./generated/tty/mod.js";',
        "const term = await createTerm({ width: 186, height: 40 });",
        "const natural = { layout: { width: fit(), height: fit() } };",
        `const result = term.render([open("root", { layout: { width: fit(), height: fit(), direction: "ttb" } }), open("short", natural), text(${JSON.stringify(SHORT)}), close(), open("long", natural), text(${JSON.stringify(LONG)}), close(), close()]);`,
        'console.log(JSON.stringify([result.info.get("short")?.bounds.width, result.info.get("long")?.bounds.width]));',
        "",
      ].join("\n"),
    );
    const smoke = yield* quietly(() =>
      exec(Deno.execPath(), {
        arguments: ["run", "--no-config", "--no-lock", "--allow-read", "smoke.ts"],
        cwd: root,
      }).join(),
    );
    expect({ code: smoke.code, stderr: smoke.stderr, widths: smoke.stdout.trim() }).toEqual({
      code: 0,
      stderr: "",
      widths: "[57,91]",
    });
  });
});

describe("the prepared terminal runtime in the canonical host binary", () => {
  let binary = "";

  // One compile answers every case, from the same argv a release uses.
  beforeAll(function* () {
    const output = join(yield* useTempDirectory("xmd-tty-binary-"), "xmd");
    const compiled = yield* quietly(() =>
      exec(Deno.execPath(), {
        arguments: compileArguments({ output }),
        cwd: fileURLToPath(REPO),
      }).join(),
    );
    if (compiled.code !== 0) {
      throw new Error(`deno compile exited ${compiled.code}\n${compiled.stderr}`);
    }
    binary = output;
  });

  it("embeds the notice and no producer input", function* () {
    expect(PREPARED_NOTICES).toEqual([`${RUNTIME}/NOTICE.txt`]);
    const bytes = new Uint8Array(yield* until(readFile(binary)));
    const notice = yield* readTextFile(new URL(`${RUNTIME}/NOTICE.txt`, REPO));
    const contains = (text: string): boolean =>
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(text);
    expect(contains(notice)).toBe(true);
    for (const marker of PRODUCER_MARKERS) {
      expect([marker, contains(marker)]).toEqual([marker, false]);
    }
  });

  it("reopens a settled entry whose texts once shared one width, exactly", function* () {
    const home = yield* useTempDirectory("xmd-tty-binary-pty-");
    const repl = (args: readonly string[]): string =>
      [
        `cd ${shellQuote(home)}`,
        [binary, "repl", "--deny-all", ...args].map(shellQuote).join(" "),
      ].join("; ");
    const first = yield* allocate(repl([]), home);
    yield* showing(first, "[exit]", 180_000);
    yield* first.type(`${SHORT}\n\n${LONG}`);
    yield* sleep(500);
    yield* first.type("\r");
    yield* settledEntry(first, 1, "ok", 60_000);
    yield* showing(first, "01fda4", 60_000);
    yield* click(first, "[exit]");
    expect(yield* ended(first)).toBe(0);
    const location = printedLocation((yield* first.shows()).join("\n"));

    const second = yield* allocate(repl([location]), home);
    yield* showing(second, "[exit]", 180_000);
    yield* showing(second, "022aa2", 60_000);
    yield* showing(second, "01fda4", 60_000);
    yield* click(second, "[exit]");
    expect(yield* ended(second)).toBe(0);
  });
});
