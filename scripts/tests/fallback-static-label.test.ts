import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { runShell, cliShellCommand } from "@executablemd/test-support/launch";
import { race, sleep } from "effection";
import type { Operation } from "effection";
import { exists, ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";

const fixtures = fileURLToPath(new URL("./fixtures/failure-attribution-plugin/", import.meta.url));
const healthy =
  '<Operands as="operands" />\n<AssertStrictEquals actual={operands.reference()} expected={operands.reference()} />\n<Project>\n<AssertEquals actual={operands.actual()} expected={operands.expected()+1} />\n<AssertStringIncludes actual="alpha" expected="ph" />\n</Project>\n';
const equality =
  '<Operands as="operands" />\n<AssertStrictEquals actual={operands.reference()} expected={operands.reference()} />\n<Project>\n<AssertEquals actual={operands.actual()} expected={operands.expected()} />\n</Project>\n';
const includes =
  '<Operands as="operands" />\n<AssertStrictEquals actual={operands.reference()} expected={operands.reference()} />\n<Project>\n<AssertStringIncludes actual={"prefix" + operands.actual()} expected={"absent" + operands.expected()} />\n</Project>\n';
function bounded<T>(body: Operation<T>): Operation<T> {
  return race([
    body,
    (function* (): Operation<never> {
      yield* sleep(10000);
      throw new Error("Static label control exceeded 10s");
    })(),
  ]);
}
function labelled(source: string, sites: { line: number; element: string }[]) {
  const lines = source.split("\n");
  const spans = sites.map(({ line, element }) => {
    const original = lines[line - 1];
    expect(original.startsWith(`<${element} `)).toBe(true);
    expect(original.endsWith(" />")).toBe(true);
    const literal = `XMD-LABEL-CONTROL:v1:Case.md:L${String(line).padStart(4, "0")}:${element}`;
    const attribute = ` msg="${literal}"`;
    lines[line - 1] = original.slice(0, -3) + attribute + " />";
    return { line, element, literal, attribute };
  });
  const text = lines.join("\n");
  let restored = text;
  for (const span of spans) {
    restored = restored.replace(span.attribute, "");
  }
  expect(restored).toBe(source);
  return { text, spans };
}
function* retain(value: unknown) {
  const destination = process.env.XMD_TEST_ARTIFACTS;
  if (destination) {
    yield* ensureDir(destination);
    yield* writeTextFile(
      join(destination, crypto.randomUUID() + ".json"),
      JSON.stringify(value, undefined, 2),
    );
  }
}
function* workspace() {
  const directory = yield* useTempDirectory("static-label-");
  return { directory, counter: join(directory, "counts.json") };
}
function* launch(directory: string, counter: string, path: string, source: string) {
  yield* writeTextFile(join(directory, path), source);
  const argv = ["run", path, "--raw", "--include", fixtures];
  const line = "env -u XMD_TEST_ARTIFACTS " + cliShellCommand(argv);
  const result = yield* runShell(line, {
    cwd: directory,
    timeout: 5000,
    env: { XMD_COUNTER_PATH: counter },
  }).join();
  const counts = (yield* exists(counter))
    ? JSON.parse(yield* readTextFile(counter))
    : { unavailable: "no joined counter" };
  yield* retain({
    argv,
    shell: line,
    cwd: directory,
    source,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    artifactEnvironment: "env -u XMD_TEST_ARTIFACTS before CLI",
    result,
    counts,
  });
  expect(counts).toEqual({ actual: 1, expected: 1, references: 2 });
  return result;
}
function* pair(source: string, sites: { line: number; element: string }[], code: number) {
  const { directory, counter } = yield* workspace();
  const copy = labelled(source, sites);
  yield* retain({ original: source, labelled: copy.text, map: copy.spans });
  const control = yield* launch(directory, counter, "Case.md", source);
  const observed = yield* launch(directory, counter, "Case.md", copy.text);
  expect(control.code).toBe(code);
  expect(observed.code).toBe(code);
  expect(observed.stdout).toBe(control.stdout);
  return { control, observed, copy };
}

function equalityReports(control: string, literal: string) {
  const heading = "Expected values to be strictly deep-equal:";
  expect(control.startsWith(heading)).toBe(true);
  expect(control.split(heading)).toHaveLength(2);
  return [
    { format: "literal-only", report: literal + "\n" },
    { format: "retained-control-diff", report: literal + control.slice(heading.length) },
  ];
}

describe("static literal fallback labels", () => {
  it("G1 preserves healthy raw output and live reference/operand evaluation for both kinds", () =>
    bounded(
      (function* () {
        const run = yield* pair(
          healthy,
          [
            { line: 4, element: "AssertEquals" },
            { line: 5, element: "AssertStringIncludes" },
          ],
          0,
        );
        expect(run.observed.stderr).toBe(run.control.stderr);
        expect(run.observed.stderr).toBe("");
      })(),
    ));
  it("G2 carries the exact equality leaf literal through real Markdown projection", () =>
    bounded(
      (function* () {
        const run = yield* pair(equality, [{ line: 4, element: "AssertEquals" }], 1);
        expect(run.control.stderr).toBe(
          "Expected values to be strictly deep-equal:\n\n2 !== 1\n\n",
        );
        const reports = equalityReports(run.control.stderr, run.copy.spans[0].literal);
        const actual = reports.find((wire) => wire.report === run.observed.stderr);
        expect(actual).toBeDefined();
        expect(run.observed.stderr.split(run.copy.spans[0].literal)).toHaveLength(2);
        yield* retain({
          gate: "G2",
          actualWireFormat: actual?.format,
          reports,
          actualStderr: run.observed.stderr,
        });
      })(),
    ));
  it("G3 carries the distinct string-includes literal through fail(msg)", () =>
    bounded(
      (function* () {
        const run = yield* pair(includes, [{ line: 4, element: "AssertStringIncludes" }], 1);
        expect(run.control.stderr).toBe("Expected actual to contain expected\n");
        expect(run.observed.stderr).toBe(run.copy.spans[0].literal + "\n");
      })(),
    ));
  it("G4 retains exactly one inner message substitution through outer raw CLI/bash/Fail", () =>
    bounded(
      (function* () {
        const { directory, counter } = yield* workspace();
        const copy = labelled(equality, [{ line: 4, element: "AssertEquals" }]);
        yield* retain({ original: equality, labelled: copy.text, map: copy.spans });
        const inner = yield* launch(directory, counter, "Case.md", equality);
        expect(inner.code).toBe(1);
        expect(inner.stderr).toBe("Expected values to be strictly deep-equal:\n\n2 !== 1\n\n");
        const command = cliShellCommand(["run", "Case.md", "--raw", "--include", fixtures]);
        const outer =
          '```bash exec as="child"\n' +
          command +
          ";\n```\n<If condition={child.exitCode !== 0}><Fail message={child.stderr + child.stdout} /></If>\n";
        const control = yield* launch(directory, counter, "Outer.md", outer);
        yield* writeTextFile(join(directory, "Case.md"), copy.text);
        const observed = yield* launch(directory, counter, "Outer.md", outer);
        expect(control.code).toBe(1);
        expect(observed.code).toBe(1);
        expect(observed.stdout).toBe(control.stdout);
        const parts = control.stderr.split(inner.stderr);
        expect(parts).toHaveLength(2);
        const reports = equalityReports(inner.stderr, copy.spans[0].literal);
        const actual = reports.find(
          (wire) => observed.stderr === parts[0] + wire.report + parts[1],
        );
        expect(actual).toBeDefined();
        yield* retain({
          gate: "G4",
          actualWireFormat: actual?.format,
          reports,
          innerControl: inner.stderr,
          outerControl: control.stderr,
          outerLabelled: observed.stderr,
          fullInnerOccurrences: parts.length - 1,
        });
        expect(observed.stderr.split(copy.spans[0].literal)).toHaveLength(2);
      })(),
    ));
});
