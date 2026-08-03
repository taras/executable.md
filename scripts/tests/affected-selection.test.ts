import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import { denoProbe, ProbeError, select } from "../lib/affected.ts";
import type { Probe, Selection } from "../lib/affected.ts";
import { changeSet } from "../lib/git-changes.ts";
import { scratchRepo } from "./scratch-repo.ts";
import type { ScratchRepo } from "./scratch-repo.ts";

/**
 * A workspace shaped like this repository's, small enough to interrogate.
 *
 * The paths matter as much as the modules: classification reads
 * `packages/<member>/tests/**` and `specs/**` by shape, so a fixture that
 * flattened the layout would exercise a table nobody ships.
 */
const SOURCES: Record<string, string> = {
  "deno.json": "{}\n",
  "packages/core/src/core.ts": "export function core(): number {\n  return 1;\n}\n",
  "packages/core/src/types.ts": "export interface Shape {\n  kind: string;\n}\n",
  "packages/core/src/dynamic.ts":
    "export function load(name: string): Promise<unknown> {\n  return import(name);\n}\n",
  "packages/core/src/loaded.ts": "export const loaded = 1;\n",
  "packages/core/tests/direct.test.ts": [
    'import { core } from "../src/core.ts";',
    'Deno.test("direct", () => {',
    "  if (core() < 0) {",
    '    throw new Error("unreachable");',
    "  }",
    "});",
    "",
  ].join("\n"),
  "packages/core/tests/typeonly.test.ts": [
    'import type { Shape } from "../src/types.ts";',
    'const shape: Shape = { kind: "x" };',
    'Deno.test("typeonly", () => {',
    '  if (shape.kind === "") {',
    '    throw new Error("unreachable");',
    "  }",
    "});",
    "",
  ].join("\n"),
  "packages/core/tests/dynamic.test.ts": [
    'import { load } from "../src/dynamic.ts";',
    'Deno.test("dynamic", () => {',
    '  if (typeof load !== "function") {',
    '    throw new Error("unreachable");',
    "  }",
    "});",
    "",
  ].join("\n"),
  "packages/core/tests/independent.test.ts": 'Deno.test("independent", () => {});\n',
  "packages/core/tests/fixtures/data.md": "# fixture\n",
  "specs/example-spec.md": "# spec\n",
};

const CORPUS = [
  "packages/core/tests/direct.test.ts",
  "packages/core/tests/dynamic.test.ts",
  "packages/core/tests/independent.test.ts",
  "packages/core/tests/typeonly.test.ts",
];

function* workspace(): Operation<ScratchRepo> {
  const repo = yield* scratchRepo("affected-selection");
  for (const [file, contents] of Object.entries(SOURCES)) {
    yield* repo.write(file, contents);
  }
  yield* repo.commit("base");
  yield* repo.git("branch", "base");
  return repo;
}

/** What the command does: read the change set, then ask Deno about it. */
function* selectionOf(repo: ScratchRepo, corpus = CORPUS): Operation<Selection> {
  const found = yield* changeSet(repo.root, "base");
  return yield* select({
    probe: denoProbe(Deno.execPath(), repo.root, found.mergeBase),
    corpus,
    changes: found.changes,
    concurrency: 4,
  });
}

describe("select", () => {
  it("selects the tests that import a changed module, and nothing else", function* () {
    const repo = yield* workspace();
    yield* repo.write(
      "packages/core/src/core.ts",
      "export function core(): number {\n  return 2;\n}\n",
    );

    const selection = yield* selectionOf(repo);
    expect(selection.everything).toBe(false);
    expect(selection.files).toEqual(["packages/core/tests/direct.test.ts"]);
  });

  it("sees a staged change the same way as an unstaged one", function* () {
    const repo = yield* workspace();
    yield* repo.write(
      "packages/core/src/core.ts",
      "export function core(): number {\n  return 3;\n}\n",
    );
    yield* repo.git("add", "packages/core/src/core.ts");

    expect((yield* selectionOf(repo)).files).toEqual(["packages/core/tests/direct.test.ts"]);
  });

  it("sees a change committed on the branch", function* () {
    const repo = yield* workspace();
    yield* repo.write(
      "packages/core/src/core.ts",
      "export function core(): number {\n  return 4;\n}\n",
    );
    yield* repo.commit("branch work");

    expect((yield* selectionOf(repo)).files).toEqual(["packages/core/tests/direct.test.ts"]);
  });

  /**
   * The case `--no-check` loses. A type-only import is in the affected graph
   * only while type-checking is on, and the sweep that dropped it returned
   * three fewer files on the real corpus.
   */
  it("selects a test that reaches the change only through `import type`", function* () {
    const repo = yield* workspace();
    yield* repo.write(
      "packages/core/src/types.ts",
      "export interface Shape {\n  kind: string;\n  size?: number;\n}\n",
    );

    expect((yield* selectionOf(repo)).files).toEqual(["packages/core/tests/typeonly.test.ts"]);
  });

  it("runs a new untracked test file", function* () {
    const repo = yield* workspace();
    yield* repo.write("packages/core/tests/added.test.ts", 'Deno.test("added", () => {});\n');

    const corpus = [...CORPUS, "packages/core/tests/added.test.ts"].sort();
    const selection = yield* selectionOf(repo, corpus);
    expect(selection.files).toEqual(["packages/core/tests/added.test.ts"]);
  });

  it("succeeds with nothing selected when nothing changed", function* () {
    const repo = yield* workspace();

    const selection = yield* selectionOf(repo);
    expect(selection.everything).toBe(false);
    expect(selection.files).toEqual([]);
    expect(selection.escalations).toEqual([]);
  });

  it("runs everything when a changed module is in no test's graph", function* () {
    const repo = yield* workspace();
    yield* repo.write("packages/core/src/loaded.ts", "export const loaded = 2;\n");

    const selection = yield* selectionOf(repo);
    expect(selection.everything).toBe(true);
    expect(selection.files).toEqual(CORPUS);
    expect(selection.escalations).toEqual([
      {
        cause: "unreachable",
        path: "packages/core/src/loaded.ts",
        detail: "no test statically depends on it, so a selection result would prove nothing",
      },
    ]);
  });

  it("runs everything for a deletion, which selects nothing on its own", function* () {
    const repo = yield* workspace();
    yield* repo.remove("packages/core/src/core.ts");

    const selection = yield* selectionOf(repo);
    expect(selection.everything).toBe(true);
    expect(selection.escalations.map((escalation) => escalation.cause)).toEqual(["trigger"]);
    expect(selection.escalations[0]!.path).toEqual("packages/core/src/core.ts");
  });

  it("runs everything for both sides of a rename", function* () {
    const repo = yield* workspace();
    yield* repo.git("mv", "packages/core/src/core.ts", "packages/core/src/renamed.ts");
    yield* repo.write(
      "packages/core/tests/direct.test.ts",
      SOURCES["packages/core/tests/direct.test.ts"]!.replace("../src/core.ts", "../src/renamed.ts"),
    );

    const selection = yield* selectionOf(repo);
    expect(selection.everything).toBe(true);
    expect(selection.escalations.map((escalation) => escalation.path)).toContain(
      "packages/core/src/core.ts",
    );
  });

  it("runs everything for a fixture, which no graph can see", function* () {
    const repo = yield* workspace();
    yield* repo.write("packages/core/tests/fixtures/data.md", "# fixture, edited\n");

    expect((yield* selectionOf(repo)).everything).toBe(true);
  });

  it("runs everything for a document that is executed rather than imported", function* () {
    const repo = yield* workspace();
    yield* repo.write("specs/example-spec.md", "# spec, edited\n");

    expect((yield* selectionOf(repo)).everything).toBe(true);
  });

  it("runs everything for a path it cannot classify", function* () {
    const repo = yield* workspace();
    yield* repo.write("Makefile", "all:\n\techo hello\n");

    const selection = yield* selectionOf(repo);
    expect(selection.everything).toBe(true);
    expect(selection.escalations[0]!.detail).toContain("cannot classify");
  });

  it("selects nothing extra for a path no test reads", function* () {
    const repo = yield* workspace();
    yield* repo.write(".editorconfig", "root = true\n");

    const selection = yield* selectionOf(repo);
    expect(selection.everything).toBe(false);
    expect(selection.files).toEqual([]);
  });
});

describe("select, when a probe fails", () => {
  const failing: Probe = {
    *affects(): Operation<boolean> {
      throw new ProbeError("deno test --no-run exited 1: boom");
    },
    *reaches(): Operation<boolean> {
      return true;
    },
  };

  it("runs everything and says which probe failed", function* () {
    const selection = yield* select({
      probe: failing,
      corpus: CORPUS,
      changes: [{ path: "packages/core/src/core.ts", kind: "modified" }],
      concurrency: 1,
    });

    expect(selection.everything).toBe(true);
    expect(selection.files).toEqual(CORPUS);
    expect(selection.escalations).toEqual([
      { cause: "probe-failure", path: "", detail: "deno test --no-run exited 1: boom" },
    ]);
  });
});
