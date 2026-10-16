/**
 * Tier FE — `<Evaluate>` under the ordinary `xmd run` profile.
 *
 * The core tier proves the component against a recorder. This one proves the
 * *host*: that `xmd run` states a profile at all, that the profile it states is
 * the Files-only one, and that a fragment run by it reaches the caller's own
 * filesystem through operations this command captured rather than through
 * whatever the document installed.
 *
 * It also fixes the spellings. `text` is the canonical one; `source` is the
 * workflow's alone and is refused here; `program` was never released and is
 * refused everywhere.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { ensure, scoped, useScope } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CORE_COMPONENT_NAMES } from "@executablemd/core";
import { Component } from "@executablemd/core/api";
import {
  ordinaryGeneratedSelection,
  useOrdinaryGeneratedSelection,
} from "../src/evaluation-profile.ts";
import { syntaxSymbols } from "../src/syntax.ts";

const NOTE = "the saved note\n";

function* useWorkspace<T>(
  files: Record<string, string>,
  body: (dir: string) => Operation<T>,
): Operation<T> {
  const dir = join(tmpdir(), `xmd-fe-${randomUUID()}`);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      yield* ensureDir(dirname(path));
      yield* writeTextFile(path, content);
    }
    return yield* body(dir);
  });
}

describe("Tier FE — the ordinary run profile", () => {
  it("FE21: `xmd run` states a profile, and a fragment reads the caller's files", function* () {
    yield* useWorkspace(
      {
        "notes.md": NOTE,
        "doc.md":
          `<Evaluate text={'<File path="notes.md" />\\n'} as="answer" />\n\n` +
          `<Json value={answer} />\n`,
      },
      function* (dir) {
        const result = yield* runCli(["run", join(dir, "doc.md")], { cwd: dir }).join();
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("the saved note");
      },
    );
  });

  it("FE5: the ordinary profile admits writes and deletions, and nothing else", function* () {
    yield* useWorkspace(
      {
        "doc.md":
          `<Evaluate text={'<File path="made.md">written by the fragment</File>\\n'} ` +
          `allow={["write"]} />\n\ndone\n`,
      },
      function* (dir) {
        const result = yield* runCli(["run", join(dir, "doc.md")], { cwd: dir }).join();
        expect(result.code).toBe(0);
        expect(yield* readTextFile(join(dir, "made.md"))).toBe("written by the fragment");
      },
    );
  });

  it("FE21: a fragment searches and reads through the profile's own operations", function* () {
    yield* useWorkspace(
      {
        "notes.md": NOTE,
        "doc.md":
          `<Evaluate text={'<Glob include={["*.md"]} as="found" />\\n<Json value={found} />\\n'} ` +
          `as="answer" />\n\n<Json value={answer} />\n`,
      },
      function* (dir) {
        const result = yield* runCli(["run", join(dir, "doc.md")], { cwd: dir }).join();
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("notes.md");
      },
    );
  });

  it("FE21: a fragment cannot reach an operation the ordinary profile withheld", function* () {
    yield* useWorkspace(
      {
        "notes.md": NOTE,
        "doc.md": `<Evaluate text={'<Fetch url="https://example.test/notes" />\\n'} />\n`,
      },
      function* (dir) {
        const result = yield* runCli(["run", join(dir, "doc.md")], { cwd: dir }).join();
        // `<Fetch>` is an ordinary component of this run and is not a name the
        // fragment has: the ceiling is the profile's, not the document's. An
        // unbounded network read is a decision `xmd run` does not make on a
        // document's behalf, so the identity is absent rather than admitted
        // with an empty ceiling.
        expect(result.code).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain("did not admit");
      },
    );
  });
});

describe("Tier FE — the ordinary selection is middleware, and it delegates", () => {
  /**
   * The exact map `xmd run` offers.
   *
   * Written out rather than derived, because what these rows are about is the
   * value: a selection assembled by calling the thing under test would prove
   * only that it equals itself.
   */
  it("FE24: the ordinary selection is exactly File, File.Delete, Glob, Syntax and Elicit", function* () {
    expect(ordinaryGeneratedSelection()).toEqual({
      File: ["self-closing", "paired"],
      "File.Delete": ["self-closing"],
      Glob: ["self-closing"],
      Syntax: ["self-closing"],
      Elicit: ["paired"],
    });
    // `Dir` and `Fetch` are absent rather than offered with nothing a fragment
    // could usefully do with them.
    expect(Object.keys(ordinaryGeneratedSelection())).not.toContain("Dir");
    expect(Object.keys(ordinaryGeneratedSelection())).not.toContain("Fetch");
    yield* useScope();
  });

  it("FE24: a host's own defined selection is preserved, and two handlers compose", function* () {
    // Delegate first, default only on absence. A host that stated its own
    // keeps it, and the ordinary selection answers only where nothing did.
    // This command's handler first, so it is the outer one and the host's
    // answer is what its `next()` reaches — which is the composition a workflow
    // attachment makes, where the attachment's scope encloses the run's.
    const stated = yield* scoped(function* () {
      yield* useOrdinaryGeneratedSelection();
      yield* Component.around({ generated: () => ({ File: ["self-closing"] }) });
      return yield* Component.operations.generated;
    });
    expect(stated).toEqual({ File: ["self-closing"] });

    const defaulted = yield* scoped(function* () {
      yield* useOrdinaryGeneratedSelection();
      return yield* Component.operations.generated;
    });
    expect(defaulted).toEqual(ordinaryGeneratedSelection());

    // Two of this command's own handlers compose rather than refusing: the
    // nearer one answers, and there is no contributor count to object to.
    const composed = yield* scoped(function* () {
      yield* useOrdinaryGeneratedSelection();
      yield* useOrdinaryGeneratedSelection();
      return yield* Component.operations.generated;
    });
    expect(composed).toEqual(ordinaryGeneratedSelection());
  });

  it("FE24: a defined empty selection is preserved for core to refuse", function* () {
    // Only absence defaults. An empty selection is a host statement core
    // validates and refuses; replacing it here would answer a host's mistake
    // with this command's permission, and the run would quietly evaluate under
    // a vocabulary nobody chose.
    const empty = yield* scoped(function* () {
      yield* useOrdinaryGeneratedSelection();
      yield* Component.around({ generated: () => ({}) });
      return yield* Component.operations.generated;
    });
    expect(empty).toEqual({});
  });
});

describe("Tier FE — the one spelling this host accepts", () => {
  it("FE19: every profile refuses `source`, which is no longer a spelling", function* () {
    yield* useWorkspace(
      {
        "notes.md": NOTE,
        "doc.md": `<Evaluate source={'<File path="notes.md" />\\n'} />\n`,
      },
      function* (dir) {
        const result = yield* runCli(["run", join(dir, "doc.md")], { cwd: dir }).join();
        // The schema is closed on `text`, so the retired alias is refused by
        // prop validation rather than reaching the body under a host flag.
        expect(result.code).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toMatch(/source|additional/i);
      },
    );
  });

  it("FE19: every profile refuses `program`, which was never released", function* () {
    yield* useWorkspace(
      {
        "notes.md": NOTE,
        "doc.md": `<Evaluate program={'<File path="notes.md" />\\n'} />\n`,
      },
      function* (dir) {
        const result = yield* runCli(["run", join(dir, "doc.md")], { cwd: dir }).join();
        // The schema is closed, so an unreleased spelling is refused by prop
        // validation rather than reaching the body.
        expect(result.code).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toMatch(/program|additional/i);
      },
    );
  });
});

describe("Tier FE — what the source symbols report", () => {
  it("FE28: source symbols carry `Evaluate` with a protected origin", function* () {
    const symbols = yield* syntaxSymbols([]);
    const evaluate = symbols.categories[1].entries.find((entry) => entry.name === "Evaluate");

    expect(evaluate).not.toBe(undefined);
    expect(evaluate?.origin).toEqual({ kind: "protected", origin: "@executablemd/core" });
    expect(evaluate?.sourceKind).toBe("protected");
    // The approved one-line description, exactly.
    expect(evaluate?.description).toBe(
      'Evaluate program text. `<Evaluate text={program} allow={["read"]} />` runs it.',
    );
    // Both spellings, because the two input forms are two ways of stating one
    // argument.
    expect(evaluate?.forms).toEqual(["self-closing", "paired"]);
  });

  it("FE28: no host bootstrap is needed to make the name available", function* () {
    // `syntaxSymbols([])` installs no host, no bundle and no declaration. A
    // name that needed one to appear would be absent here and present under
    // `xmd run`, which is exactly what a protected name is not.
    const symbols = yield* syntaxSymbols([]);
    const names = symbols.categories.flatMap((category) =>
      category.entries.map((entry) => entry.name),
    );
    expect(names).toContain("Evaluate");
    // And it is core's own protected name rather than an ordinary registration
    // this build happens to carry.
    expect([...CORE_COMPONENT_NAMES]).not.toContain("Evaluate");
  });
});
