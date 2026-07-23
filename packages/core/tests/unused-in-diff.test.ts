import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";

interface AddedLine {
  file: string;
  lineNumber: number;
  content: string;
}

function added(file: string, lineNumber: number, content: string): AddedLine {
  return { file, lineNumber, content };
}

const WHY = "referenced ≤1× within the added diff";

function doc(lines: AddedLine[], construct: string): string {
  return [
    "```js eval",
    `const pr = ${JSON.stringify({ added: lines })};`,
    "```",
    "",
    `<UnusedInDiff pr={pr} construct="${construct}"`,
    `  message="{count} with no consumers: {names}." />`,
  ].join("\n");
}

// The real components are read before useStubFs replaces the filesystem, so
// the tests exercise the shipped .reviews sources rather than a copy.
function* render(lines: AddedLine[], construct: string): Operation<string> {
  const unusedInDiff = yield* readTextFile(".reviews/components/UnusedInDiff.md");
  const show = yield* readTextFile(".reviews/components/Show.md");

  yield* useStubFs({
    "components/UnusedInDiff.md": unusedInDiff,
    "components/Show.md": show,
    "doc.md": doc(lines, construct),
  });

  return yield* collect(yield* execute({ docPath: "doc.md", stream: new InMemoryStream() }));
}

describe("UnusedInDiff", () => {
  it("renders the disclosure with symbol, location, count and reason", function* () {
    const output = yield* render([added("core/src/a.ts", 24, "type Orphan = string;")], "type");

    expect(output).toContain("<details>");
    expect(output).toContain("<summary>🟡 1 with no consumers: Orphan.</summary>");
    expect(output).toContain("| `Orphan` | `core/src/a.ts:24` | 1 |");
    expect(output).toContain(WHY);
    expect(output).not.toContain("ERROR");
  });

  it("does not flag a type named only by an import specifier", function* () {
    const output = yield* render(
      [added("core/src/a.ts", 1, 'import { type Mods } from "./mods.ts";')],
      "type",
    );

    expect(output).not.toContain("Mods");
    expect(output).not.toContain("<details>");
    expect(output.trim()).toBe("");
  });

  it("excludes a declaration referenced again within the added diff", function* () {
    const output = yield* render(
      [
        added("core/src/a.ts", 30, "export type Used = string;"),
        added("core/src/a.ts", 31, 'const value: Used = "x";'),
      ],
      "type",
    );

    expect(output).not.toContain("<details>");
    expect(output.trim()).toBe("");
  });

  it("renders nothing when there are no findings", function* () {
    const output = yield* render([added("core/src/a.ts", 5, "const plain = 1;")], "type");

    expect(output.trim()).toBe("");
  });

  it("detects exported, declared and default interface declarations", function* () {
    const output = yield* render(
      [
        added("core/src/a.ts", 1, "export interface Alpha {"),
        added("core/src/a.ts", 5, "export declare interface Beta {"),
        added("core/src/a.ts", 9, "export default interface Gamma {"),
      ],
      "interface",
    );

    expect(output).toContain("| `Alpha` | `core/src/a.ts:1` | 1 |");
    expect(output).toContain("| `Beta` | `core/src/a.ts:5` | 1 |");
    expect(output).toContain("| `Gamma` | `core/src/a.ts:9` | 1 |");
    expect(output).not.toContain("ERROR");
  });

  it("detects an exported declared type alias", function* () {
    const output = yield* render(
      [added("core/src/a.ts", 12, "export declare type Delta = string;")],
      "type",
    );

    expect(output).toContain("| `Delta` | `core/src/a.ts:12` | 1 |");
    expect(output).not.toContain("ERROR");
  });
});
