/**
 * Rule tests for `local/prefer-effection-operation` (scripts/oxlint-rules).
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import path from "node:path";
import { ROOT, runOxlint, violations } from "./oxlint.ts";

const RULE = "prefer-effection-operation";

const WORKFLOW = path.join("packages", "durable-streams", "types.ts");

const DIRECTIVE = `// oxlint-disable-next-line local/${RULE}`;

function reported(fixture: string): Operation<number[]> {
  return violations(`scripts/tests/fixtures/${fixture}`, RULE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lintScript(source: string): string {
  const manifest: unknown = JSON.parse(source);
  const scripts = isRecord(manifest) ? manifest.scripts : undefined;
  const lint = isRecord(scripts) ? scripts.lint : undefined;

  if (typeof lint !== "string") {
    throw new Error("package.json no longer defines a lint script");
  }

  return lint;
}

/**
 * The ignores and targets the lint gate passes on oxlint's command line, taken
 * from the gate itself so this sweep covers exactly the files it covers. The
 * config is dropped because the harness supplies it.
 */
function gateArguments(script: string): string[] {
  const tokens = script.split("&&")[0].match(/'[^']*'|\S+/gu) ?? [];
  const bare = tokens.map((token) => token.replaceAll("'", ""));
  const start = bare.indexOf("oxlint");
  const config = bare.indexOf("-c");

  if (start < 0 || config < start) {
    throw new Error(`the lint script no longer invokes oxlint with a config: ${script}`);
  }

  return [...bare.slice(start + 1, config), ...bare.slice(config + 2)];
}

function reportedFiles(source: string): string[] {
  const value: unknown = JSON.parse(source);
  const diagnostics = isRecord(value) && Array.isArray(value.diagnostics) ? value.diagnostics : [];

  return diagnostics
    .filter(isRecord)
    .filter((entry) => entry.code === `local(${RULE})`)
    .map((entry) => (typeof entry.filename === "string" ? entry.filename : ""));
}

describe("local/prefer-effection-operation", () => {
  /**
   * In fixture order: a callable alias, the same shape nested inside a callable
   * an operation returns, an annotated implementation, a reference with no type
   * arguments, an `any` yield, those first three again as `AsyncGenerator`,
   * Effection's `Effect` under its own name, renamed at the import, inherited
   * through an `extends`, and in a union, the durable `Workflow` shape — whose
   * effect restates the contract instead of naming Effection — without its
   * suppression, and both `globalThis` forms.
   */
  it("reports every declaration that stands in for Effection work", function* () {
    expect(yield* reported("generator-contract.ts")).toEqual([
      27, 31, 33, 38, 40, 42, 46, 48, 52, 54, 56, 58, 60, 62, 64,
    ]);
  });

  /**
   * Operation contracts, an inferred `function*`, and — the boundary this rule
   * does not cross — ordinary generators and iterators that name what they
   * yield, concrete `Generator<number, …>` included.
   */
  it("accepts operation contracts and generators that name what they yield", function* () {
    expect(yield* reported("operation-contract.ts")).toEqual([]);
  });

  /**
   * A name is not evidence. `SoundEffect` declares none of an effect's contract
   * and comes from nowhere near Effection, so the annotated generator, the
   * callable alias, the `globalThis` form and a union of two such types all
   * pass. `Doorway` and `Threshold` sign both of the contract's member names
   * with incompatible types — an interface and a type-literal alias — and are
   * values too, because the shapes are what is checked.
   */
  it("accepts a domain type that only resembles an effect", function* () {
    expect(yield* reported("domain-effect.ts")).toEqual([]);
  });

  /** Reached through a namespace import; `effection.Scope` is still a value. */
  it("reports an effect qualified by an effection namespace, and nothing else", function* () {
    expect(yield* reported("namespaced-effect.ts")).toEqual([7]);
  });

  /**
   * A type parameter covers its own declaration and a nested interface its own
   * block, so the two contracts declared after them still name the built-in.
   */
  it("shadows lexically, so a contract outside the scope is still reported", function* () {
    expect(yield* reported("nested-shadow.ts")).toEqual([13, 25]);
  });

  it("leaves a module-level Generator alone and still reports the globalThis form", function* () {
    expect(yield* reported("shadowed-generator.ts")).toEqual([22]);
  });

  it("leaves an imported Generator alone", function* () {
    expect(yield* reported("imported-generator.ts")).toEqual([]);
  });

  it("names the operation and the iterator destinations, and says why", function* () {
    const run = yield* runOxlint(".oxlintrc.json", [
      "scripts/tests/fixtures/generator-contract.ts",
    ]);

    expect(run.stdout).toContain("Declare Effection work as Operation<T> and run it with yield*");
    expect(run.stdout).toContain("IterableIterator");
    expect(run.stdout).toContain("yields effects is Effection work");
  });

  it("reports nothing across the sources the lint gate covers", function* () {
    const gate = gateArguments(lintScript(yield* readTextFile(path.join(ROOT, "package.json"))));
    expect(gate).toContain("packages");

    const run = yield* runOxlint(".oxlintrc.json", ["--format=json", ...gate]);

    expect(reportedFiles(run.stdout)).toEqual([]);
  });

  it("suppresses the durable Workflow declaration at that line alone", function* () {
    const source = yield* readTextFile(path.join(ROOT, WORKFLOW));
    const lines = source.split("\n");
    const declaration = lines.findIndex((line) => line.startsWith("export type Workflow<T> ="));

    expect(declaration).toBeGreaterThan(0);
    expect(lines[declaration - 1]).toBe(DIRECTIVE);
    expect(lines.filter((line) => line.includes(RULE))).toEqual([DIRECTIVE]);
  });
});
