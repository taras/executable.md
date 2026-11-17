/**
 * A mounted REPL case that fails keeps the histories its host wrote.
 *
 * The mounted host stores its paired entry and Sidekick histories as real files
 * in a directory it removes when the case's scope ends. These rows run the
 * synthetic cases in `fixtures/mounted-failure-journal.ts` as a child test file
 * under this runtime, join it, and compare each saved journal with the copy the
 * child took of what the command actually wrote: a passing case uploads
 * nothing, and an assertion after a successful run, a case deadline that
 * cancels a turn in flight, and a case with a nested and an outer root each
 * leave their own attributed files after the directories are gone.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { cliRuntime, runShell, shellQuote } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { exists, readdir, readTextFile, walk } from "@effectionx/fs";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { each } from "effection";
import type { Operation } from "effection";
import { join, relative } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

const OWNER = "packages/cli/tests/fixtures/mounted-failure-journal.ts";

/** Every file beneath a directory, by its path inside it, with its text. */
function* contents(directory: string): Operation<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of yield* each(walk(directory, { includeDirs: false }))) {
    found[relative(directory, entry.path)] = yield* readTextFile(entry.path);
    yield* each.next();
  }
  return found;
}

/** What the child recorded once a case's whole teardown had run. */
function* teardown(witness: string): Operation<{ root: string; exists: boolean }[]> {
  const recorded: unknown = JSON.parse(yield* readTextFile(join(witness, "teardown.json")));
  if (
    recorded === null ||
    typeof recorded !== "object" ||
    !("joined" in recorded) ||
    recorded.joined !== true ||
    !("roots" in recorded) ||
    !Array.isArray(recorded.roots)
  ) {
    throw new Error(`The child recorded no joined teardown: ${JSON.stringify(recorded)}`);
  }
  return recorded.roots.map((one: unknown) => {
    if (
      one === null ||
      typeof one !== "object" ||
      !("root" in one) ||
      typeof one.root !== "string" ||
      !("exists" in one) ||
      typeof one.exists !== "boolean"
    ) {
      throw new Error(`The child recorded an unreadable root: ${JSON.stringify(one)}`);
    }
    return { root: one.root, exists: one.exists };
  });
}

describe("mounted REPL failure journals", () => {
  it("keeps each failed case's actual paired histories after its roots are removed", function* () {
    const artifacts = yield* useTempDirectory("xmd-mounted-journal-artifacts-");
    const witnesses = yield* useTempDirectory("xmd-mounted-journal-witness-");
    const cwd = fileURLToPath(new URL("../../../", import.meta.url));
    const runtime = cliRuntime();
    const flags = {
      deno: ["test", "--allow-all", "--frozen"],
      node: ["--import", "tsx", "--test", "--test-reporter=spec", "--test-concurrency=1"],
      bun: ["test", "--timeout=120000"],
    }[runtime];
    const command = [execPath, ...flags, "./" + OWNER].map(shellQuote).join(" ");
    const result = yield* runShell("exec " + command, {
      cwd,
      timeout: 240_000,
      env: {
        XMD_TEST_ARTIFACTS: artifacts,
        XMD_MOUNTED_WITNESS: witnesses,
        TSX_TSCONFIG_PATH: join(cwd, "tsconfig.node.json"),
        NO_COLOR: "1",
      },
    }).join();
    const output = result.stdout + result.stderr;
    if (result.code !== 1) {
      throw new Error(`Expected the fixture to exit with 1, received ${result.code}.\n${output}`);
    }
    expect(output).toMatch(/(?:✔|\(pass\)).*passing page|passing page \.\.\. ok/);
    expect(output).toContain('Expected: "deliberate mounted late assertion"');
    expect(output).toContain("deliberate mounted deadline after 500ms");
    expect(output).toContain('Expected: "deliberate multiple-root assertion"');

    // A passing case unwound the same way and created nothing to upload.
    expect(yield* exists(join(artifacts, "passing page"))).toBe(false);
    const passed = yield* teardown(join(witnesses, "passing page"));
    expect(passed.map((one) => one.exists)).toEqual([false]);

    for (const [name, words, memory] of [
      ["late assertion", ["ASSERTED"], false],
      ["deadline", ["STARTED"], false],
      ["multiple roots", ["NESTED", "OUTER"], true],
    ] as const) {
      const witness = join(witnesses, name);
      const roots = yield* teardown(witness);
      expect(roots.map((one) => one.exists)).toEqual(words.map(() => false));

      const invocations = yield* readdir(join(artifacts, name));
      expect(invocations).toHaveLength(1);
      const directory = join(artifacts, name, invocations[0]);
      // The in-memory root opened first is saved beside the mounted ones.
      const offset = memory ? 1 : 0;
      if (memory) {
        expect(JSON.parse(yield* readTextFile(join(directory, "root-1.case.json")))).toEqual({
          owner: OWNER,
          name,
          suite: "mounted journal " + name,
          kind: "root",
          ordinal: 1,
          source: "synthetic/in-memory.md",
        });
        expect(
          parseDurableEvent((yield* readTextFile(join(directory, "root-1.jsonl"))).trimEnd()),
        ).toMatchObject({ ok: true, value: { type: "close", coroutineId: "root" } });
      }

      const executions = new Set<string>();
      for (const [index, word] of words.entries()) {
        const ordinal = index + 1 + offset;
        const saved = yield* contents(join(directory, `root-${ordinal}`));
        const copied = yield* contents(join(witness, `root-${index + 1}`));
        // Byte for byte what the command wrote, and nothing it did not.
        expect(saved).toEqual(copied);
        const files = Object.keys(saved).sort();
        expect(files).toHaveLength(2);
        const [entries, sidekick] = files;
        expect(entries).toMatch(/^v1\/[0-9a-f]+\/entries\.jsonl$/);
        expect(sidekick).toBe(entries.replace(/entries\.jsonl$/, "sidekick.jsonl"));
        executions.add(entries.split("/")[1]);
        expect(saved[entries]).toContain(`entry ${word}`);
        expect(saved[sidekick]).toContain(`reply ${word.toLowerCase()}`);
        expect(
          JSON.parse(yield* readTextFile(join(directory, `root-${ordinal}.case.json`))),
        ).toEqual({
          owner: OWNER,
          name,
          suite: "mounted journal " + name,
          kind: "root",
          ordinal,
          source: roots[index].root,
          files,
        });
        expect(output).toContain(
          `journal saved: ${join(directory, `root-${ordinal}`)} (root ${ordinal} ${roots[index].root})`,
        );
      }
      expect(executions.size).toBe(words.length);
      expect((yield* readdir(directory)).sort()).toEqual(
        Array.from({ length: words.length + offset }, (_, index) => [
          `root-${index + 1}${memory && index === 0 ? ".jsonl" : ""}`,
          `root-${index + 1}.case.json`,
        ])
          .flat()
          .sort(),
      );
    }
  });
});
