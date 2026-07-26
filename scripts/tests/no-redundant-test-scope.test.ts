/**
 * Rule tests for `local/no-redundant-test-scope` (scripts/oxlint-rules).
 *
 * Runs the repository's own oxlint configuration over the fixtures in
 * `scripts/tests/fixtures/`, so the assertions cover both the rule and the
 * config wiring that enables it for test files.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { each, spawn } from "effection";
import type { Operation } from "effection";
import { exec, Stdio } from "@effectionx/process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = path.join(ROOT, "scripts", "tests", "fixtures");
const RULE = "local(no-redundant-test-scope)";

interface Diagnostic {
  code: string;
  labels: { span: { line: number } }[];
}

function* oxlint(args: string[]): Operation<string> {
  // The report is an assertion subject, not test output.
  yield* Stdio.around({
    *stdout() {},
    *stderr() {},
  });

  const proc = yield* exec("npx", {
    arguments: ["--yes", "oxlint", "-c", ".oxlintrc.json", ...args],
    cwd: ROOT,
  });

  const chunks: string[] = [];
  const reading = yield* spawn(function* () {
    for (const chunk of yield* each(proc.stdout)) {
      chunks.push(new TextDecoder().decode(chunk));
      yield* each.next();
    }
  });
  const drainStderr = yield* spawn(function* () {
    for (const _ of yield* each(proc.stderr)) {
      yield* each.next();
    }
  });

  yield* proc.join();
  yield* reading;
  yield* drainStderr;

  return chunks.join("");
}

/** Lines carrying a rule violation, in source order. */
function* violations(file: string): Operation<number[]> {
  const output = yield* oxlint(["--format=json", file]);
  const report: { diagnostics: Diagnostic[] } = JSON.parse(output);

  return report.diagnostics
    .filter((diagnostic) => diagnostic.code === RULE)
    .map((diagnostic) => diagnostic.labels[0].span.line);
}

/** The fixture as oxlint rewrites it, run to a fixed point in a temp copy. */
function* fixed(fixture: string): Operation<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-redundant-test-scope-"));
  const copy = path.join(dir, "fixture.test.ts");

  try {
    fs.copyFileSync(path.join(FIXTURES, fixture), copy);

    let previous = "";
    let current = fs.readFileSync(copy, "utf8");

    while (current !== previous) {
      yield* oxlint(["--fix", copy]);
      previous = current;
      current = fs.readFileSync(copy, "utf8");
    }

    return current;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("local/no-redundant-test-scope", () => {
  it("reports a whole-body scope in it() and it.only() callbacks", function* () {
    expect(yield* violations("scripts/tests/fixtures/whole-body.ts")).toEqual([7, 15, 21, 27]);
  });

  it("reports the outer wrapper of a doubled scope", function* () {
    expect(yield* violations("scripts/tests/fixtures/doubled.ts")).toEqual([7]);
  });

  it("resolves scoped through an aliased effection import", function* () {
    expect(yield* violations("scripts/tests/fixtures/aliased-import.ts")).toEqual([7]);
  });

  it("accepts a scope that covers part of a test", function* () {
    expect(yield* violations("scripts/tests/fixtures/partial-scope.ts")).toEqual([]);
  });

  it("accepts an unrelated function named scoped", function* () {
    expect(yield* violations("scripts/tests/fixtures/local-scoped.ts")).toEqual([]);
  });

  it("unwraps a redundant scope and keeps the body indentation", function* () {
    const source = yield* fixed("whole-body.ts");

    expect(source).toContain(
      [
        `  it("wraps the body in a scope", function* () {`,
        `    const value = 1;`,
        `    yield* sleep(0);`,
        `    expect(value).toBe(1);`,
        `  });`,
      ].join("\n"),
    );
    expect(source).toContain(
      [
        `  it("returns the delegated scope", function* () {`,
        `    expect(1).toBe(1);`,
        `  });`,
      ].join("\n"),
    );
  });

  it("unwraps a doubled scope over repeated fixes", function* () {
    const source = yield* fixed("doubled.ts");

    expect(source).toContain(
      [`  it("wraps the body twice", function* () {`, `    expect(1).toBe(1);`, `  });`].join("\n"),
    );
  });

  it("reports without fixing when unwrapping would change control flow", function* () {
    const source = yield* fixed("whole-body.ts");

    expect(source).toContain(
      [
        `  it("returns the scope operation", function* () {`,
        `    return scoped(function* () {`,
        `      expect(1).toBe(1);`,
        `    });`,
        `  });`,
      ].join("\n"),
    );
  });
});
