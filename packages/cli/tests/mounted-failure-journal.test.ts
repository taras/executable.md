/**
 * A mounted REPL case that fails keeps the histories its host wrote.
 *
 * The mounted host stores its paired entry and Sidekick histories as real files
 * in a directory it removes when the case's scope ends. These rows run the
 * synthetic cases in `fixtures/mounted-failure-journal.ts` as a child test file
 * under this runtime, join it, and compare each saved journal with the copy the
 * child took of what the command actually wrote: a passing case uploads
 * nothing; an assertion after a successful run keeps its pair and none of the
 * execution's authored files; a case deadline that cancels a turn in flight
 * keeps what that turn wrote; an append still held when its case fails is
 * written before the histories are read and the root is removed; and a case
 * with a nested and a supplied root under nested attribution keeps each root
 * apart, with every session and legacy history the supplied root held.
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

function* readJson(path: string): Operation<unknown> {
  return JSON.parse(yield* readTextFile(path));
}

/** What the child recorded once a case's whole teardown had run. */
function* teardown(witness: string): Operation<{ root: string; exists: boolean }[]> {
  const recorded = yield* readJson(join(witness, "teardown.json"));
  if (
    recorded === null ||
    typeof recorded !== "object" ||
    !("roots" in recorded) ||
    !Array.isArray(recorded.roots)
  ) {
    throw new Error(`The child recorded no teardown: ${JSON.stringify(recorded)}`);
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

/** The one invocation directory a failed case saved into. */
function* invocation(artifacts: string, name: string): Operation<string> {
  const invocations = yield* readdir(join(artifacts, name));
  expect(invocations).toHaveLength(1);
  return join(artifacts, name, invocations[0]);
}

/** The paired entry and Sidekick paths among a saved root's files. */
function pairs(files: readonly string[]): { entries: string; sidekick: string }[] {
  return files
    .filter((path) => /^v1\/[0-9a-f]+\/entries\.jsonl$/.test(path))
    .map((entries) => ({
      entries,
      sidekick: entries.replace(/entries\.jsonl$/, "sidekick.jsonl"),
    }));
}

/**
 * One saved mounted root: its files equal the child's witness copy, its
 * metadata names this case and the root, and the run reported the save.
 */
function* savedRoot(
  directory: string,
  ordinal: number,
  witness: string,
  copy: number,
  identity: { name: string; suite: string; source: string },
  output: string,
): Operation<Record<string, string>> {
  const saved = yield* contents(join(directory, `root-${ordinal}`));
  expect(saved).toEqual(yield* contents(join(witness, `root-${copy}`)));
  expect(yield* readJson(join(directory, `root-${ordinal}.case.json`))).toEqual({
    owner: OWNER,
    ...identity,
    kind: "root",
    ordinal,
    files: Object.keys(saved).sort(),
  });
  expect(output).toContain(
    `journal saved: ${join(directory, `root-${ordinal}`)} (root ${ordinal} ${identity.source})`,
  );
  return saved;
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
    expect(output).toContain("deliberate held append cancellation");
    expect(output).toContain('Expected: "deliberate multiple-root assertion"');

    // A passing case unwound the same way and created nothing to upload.
    expect(yield* exists(join(artifacts, "passing page"))).toBe(false);
    expect((yield* teardown(join(witnesses, "passing page"))).map((one) => one.exists)).toEqual([
      false,
    ]);

    for (const [name, word] of [
      ["late assertion", "ASSERTED"],
      ["deadline", "STARTED"],
    ] as const) {
      const witness = join(witnesses, name);
      const [root] = yield* teardown(witness);
      expect(root.exists).toBe(false);
      const directory = yield* invocation(artifacts, name);
      expect((yield* readdir(directory)).sort()).toEqual(["root-1", "root-1.case.json"]);
      const saved = yield* savedRoot(
        directory,
        1,
        witness,
        1,
        { name, suite: "mounted journal " + name, source: root.root },
        output,
      );
      // Only the pair: an execution's authored assets and components stay behind.
      const [pair] = pairs(Object.keys(saved));
      expect(Object.keys(saved).sort()).toEqual([pair.entries, pair.sidekick]);
      expect(saved[pair.entries]).toContain(`entry ${word}`);
      expect(saved[pair.sidekick]).toContain(`reply ${word.toLowerCase()}`);
    }

    // The held append was still waiting when its case failed: the host's
    // teardown waited for it, then read the histories, then removed the root.
    {
      const name = "held append";
      const witness = join(witnesses, name);
      const [root] = yield* teardown(witness);
      expect(root.exists).toBe(false);
      const held = yield* readJson(join(witness, "held.json"));
      expect(held).toMatchObject({
        rootWhileHeld: true,
        closedWhileHeld: false,
        rootAfterClose: false,
      });
      if (
        held === null ||
        typeof held !== "object" ||
        !("record" in held) ||
        typeof held.record !== "string"
      ) {
        throw new Error(`The child recorded no held record: ${JSON.stringify(held)}`);
      }
      const directory = yield* invocation(artifacts, name);
      expect((yield* readdir(directory)).sort()).toEqual(["root-1", "root-1.case.json"]);
      const saved = yield* contents(join(directory, "root-1"));
      const [pair] = pairs(Object.keys(saved));
      expect(Object.keys(saved).sort()).toEqual([pair.entries, pair.sidekick]);
      expect(saved[pair.entries]).toContain("entry BEFORE");
      expect(saved[pair.sidekick]).toContain("reply before");
      expect(saved[pair.sidekick].endsWith(held.record)).toBe(true);
      expect(yield* readJson(join(directory, "root-1.case.json"))).toEqual({
        owner: OWNER,
        name,
        suite: "mounted journal " + name,
        kind: "root",
        ordinal: 1,
        source: root.root,
        files: [pair.entries, pair.sidekick],
      });
    }

    // An in-memory root, a nested mounted root released before the assertion
    // and a supplied root, each saved apart under the case that opened them.
    {
      const name = "multiple roots";
      const suite = "mounted journal multiple roots > nested setup";
      const witness = join(witnesses, name);
      const roots = yield* teardown(witness);
      expect(roots.map((one) => one.exists)).toEqual([false, false]);
      const directory = yield* invocation(artifacts, name);
      expect((yield* readdir(directory)).sort()).toEqual([
        "root-1.case.json",
        "root-1.jsonl",
        "root-2",
        "root-2.case.json",
        "root-3",
        "root-3.case.json",
      ]);
      expect(yield* readJson(join(directory, "root-1.case.json"))).toEqual({
        owner: OWNER,
        name,
        suite,
        kind: "root",
        ordinal: 1,
        source: "synthetic/in-memory.md",
      });
      expect(
        parseDurableEvent((yield* readTextFile(join(directory, "root-1.jsonl"))).trimEnd()),
      ).toMatchObject({ ok: true, value: { type: "close", coroutineId: "root" } });

      const nested = yield* savedRoot(
        directory,
        2,
        witness,
        1,
        { name, suite, source: roots[0].root },
        output,
      );
      const [nestedPair] = pairs(Object.keys(nested));
      expect(Object.keys(nested).sort()).toEqual([nestedPair.entries, nestedPair.sidekick]);
      expect(nested[nestedPair.entries]).toContain("entry NESTED");

      const supplied = yield* savedRoot(
        directory,
        3,
        witness,
        2,
        { name, suite, source: roots[1].root },
        output,
      );
      const [outerPair] = pairs(Object.keys(supplied));
      expect(Object.keys(supplied).sort()).toEqual(
        [
          "Legacy-Run_2.jsonl",
          outerPair.entries,
          outerPair.sidekick,
          "v1/Second_session-1/entries.jsonl",
          "v1/Second_session-1/sidekick.jsonl",
        ].sort(),
      );
      expect(supplied[outerPair.entries]).toContain("entry OUTER");
      expect(nestedPair.entries).not.toBe(outerPair.entries);
      // Non-ASCII text and an unfinished final record, kept as the UTF-8 they were.
      const legacy = supplied["Legacy-Run_2.jsonl"];
      expect(legacy).toContain("é☃");
      expect(legacy.endsWith('"partial":"naïve ☃')).toBe(true);
      expect(new TextEncoder().encode(legacy)).toEqual(
        new TextEncoder().encode(
          yield* readTextFile(join(witness, "root-2", "Legacy-Run_2.jsonl")),
        ),
      );
    }
  });
});
