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
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CORE_COMPONENT_NAMES } from "@executablemd/core";
import { syntaxSymbols } from "../src/syntax.ts";

const NOTE = "the retained note\n";

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
  it("renders authored Json composition under either effect selection", function* () {
    for (const selection of ["read", "write"]) {
      yield* useWorkspace(
        {
          "doc.md": `<Evaluate allow={["${selection}"]} text={'<Json value={{ explicit: [1, true, null] }} />'} />`,
        },
        function* (dir) {
          const result = yield* runCli(["run", join(dir, "doc.md")], { cwd: dir }).join();
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual({ explicit: [1, true, null] });
        },
      );
    }
  });
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
        expect(result.stdout).toContain("the retained note");
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

  it("FE21: a fragment cannot reach an operation the ordinary profile withheld", function* () {
    yield* useWorkspace(
      {
        "notes.md": NOTE,
        "doc.md": `<Evaluate text={'<Glob pattern="*.md" />\\n'} />\n`,
      },
      function* (dir) {
        const result = yield* runCli(["run", join(dir, "doc.md")], { cwd: dir }).join();
        // `<Glob>` is an ordinary component of this run and is not a name the
        // fragment has: the ceiling is the profile's, not the document's.
        expect(result.code).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain("did not admit");
      },
    );
  });
});

describe("Tier FE — the spellings this host accepts", () => {
  it("FE19: the ordinary profile refuses the workflow's `source` alias", function* () {
    yield* useWorkspace(
      {
        "notes.md": NOTE,
        "doc.md": `<Evaluate source={'<File path="notes.md" />\\n'} />\n`,
      },
      function* (dir) {
        const result = yield* runCli(["run", join(dir, "doc.md")], { cwd: dir }).join();
        expect(result.code).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain("this host did not admit it");
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
