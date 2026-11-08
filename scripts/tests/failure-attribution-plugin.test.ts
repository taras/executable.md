import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { runCli, cliShellCommand } from "@executablemd/test-support/launch";
import { race, sleep, spawn } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, readdir, writeTextFile, exists } from "@effectionx/fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";
import { z } from "zod";

const root = fileURLToPath(new URL("../../", import.meta.url));
const plugin = join(root, "packages/cli/tests/fixtures/failure-attribution-plugin.mjs");
const fixtures = join(root, "scripts/tests/fixtures/failure-attribution-plugin");
const relative = "examples/adversarial-implementation/tests/components/Fixture/Fallback.md";
function bounded<T>(operation: Operation<T>, ms = 10000): Operation<T> {
  return race([
    operation,
    (function* (): Operation<never> {
      yield* sleep(ms);
      throw new Error(`Plugin feasibility exceeded ${ms}ms`);
    })(),
  ]);
}
const payload = z
  .object({
    pid: z.number(),
    classification: z.string(),
    observed: z.number(),
    overflow: z.number(),
    limits: z.object({ candidates: z.number(), metadataBytes: z.number() }).passthrough(),
    candidates: z.array(
      z
        .object({
          observation: z.number(),
          classification: z.string(),
          name: z.string(),
          scenario: z.union([z.string(), z.object({ availability: z.string() })]),
          position: z.object({
            path: z.string(),
            offset: z.number(),
            line: z.number(),
            column: z.number(),
          }),
          source: z.object({ sha256: z.string(), elementAtOffset: z.boolean() }),
          message: z.unknown(),
          detail: z.object({ actual: z.unknown(), expected: z.unknown() }),
          repeatedCount: z.number().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
function* workspace(source: string) {
  const directory = yield* useTempDirectory("host-plugin-");
  yield* ensureDir(dirname(join(directory, relative)));
  yield* writeTextFile(join(directory, relative), source);
  return {
    directory,
    destination: join(directory, "evidence"),
    args: ["run", relative, "--raw", "--include", fixtures],
  };
}
function* retain(label: string, value: unknown) {
  const destination = process.env.XMD_TEST_ARTIFACTS;
  if (destination) {
    yield* ensureDir(destination);
    yield* writeTextFile(
      join(destination, label + "-" + crypto.randomUUID() + ".json"),
      JSON.stringify(value, undefined, 2),
    );
  }
}
function* records(destination: string) {
  const directory = join(destination, "failure-attribution");
  if (!(yield* exists(directory))) {
    return [];
  }
  const result: z.infer<typeof payload>[] = [];
  for (const name of yield* readdir(directory)) {
    const text = yield* readTextFile(join(directory, name));
    yield* retain("record", { name, text });
    const record = payload.parse(JSON.parse(text));
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(record.limits.metadataBytes);
    expect(record.candidates.length).toBeLessThanOrEqual(record.limits.candidates);
    expect(record.classification).toContain("not proof of terminal");
    result.push(record);
  }
  return result;
}
function same(
  control: { code?: number; stdout: string; stderr: string },
  observed: { code?: number; stdout: string; stderr: string },
  code: number,
) {
  expect(observed.code).toBe(code);
  expect(observed.code).toBe(control.code);
  expect(observed.stdout).toBe(control.stdout);
  expect(observed.stderr).toBe(control.stderr);
}
function* compared(source: string, label: string) {
  const setup = yield* workspace(source);
  const counts = join(setup.directory, "counts.json");
  const control = yield* runCli(setup.args, {
    cwd: setup.directory,
    timeout: 5000,
    env: { XMD_TEST_ARTIFACTS: "", XMD_COUNTER_PATH: counts },
  }).join();
  const before = (yield* exists(counts)) ? yield* readTextFile(counts) : undefined;
  const observed = yield* runCli([...setup.args, "--plugin", plugin], {
    cwd: setup.directory,
    timeout: 5000,
    env: { XMD_TEST_ARTIFACTS: setup.destination, XMD_COUNTER_PATH: counts },
  }).join();
  yield* retain(label, { control, observed, source, ...setup });
  if (before !== undefined) {
    expect(yield* readTextFile(counts)).toBe(before);
  }
  return { ...setup, control, observed, counts };
}
function locator(
  candidate: z.infer<typeof payload>["candidates"][number],
  source: string,
  directory: string,
  name: string,
  offset = source.indexOf(`<${name}`),
) {
  expect(resolve(directory, candidate.position.path)).toBe(join(directory, relative));
  expect(candidate.position.offset).toBe(offset);
  expect(candidate.position.line).toBe(source.slice(0, offset).split("\n").length);
  expect(candidate.position.column).toBe(offset - source.lastIndexOf("\n", offset - 1));
  expect(candidate.source.sha256).toBe(createHash("sha256").update(source).digest("hex"));
  expect(candidate.source.elementAtOffset).toBe(true);
  expect(candidate.classification).toBe("observed");
}

describe("command-scope failure attribution plugin", () => {
  it("keeps original scalar detail/locator/hash, optional scenario, once-only operands and repeated commands", () =>
    bounded(
      (function* () {
        const source =
          '<Operands as="operands" />\n<AssertStrictEquals actual={operands.reference()} expected={operands.reference()} />\n<Each in={["s1"]} let="scenario">\n<Project>\n<AssertEquals actual={operands.actual()} expected={operands.expected()} />\n</Project>\n</Each>\n';
        const run = yield* compared(source, "scalar");
        same(run.control, run.observed, 1);
        expect(run.observed.stderr).toContain("2 !== 1");
        expect(JSON.parse(yield* readTextFile(run.counts))).toEqual({
          actual: 1,
          expected: 1,
          references: 2,
        });
        const first = yield* records(run.destination);
        expect(first).toHaveLength(1);
        const leaf = first[0].candidates.find((candidate) => candidate.name === "AssertEquals");
        expect(leaf).toBeDefined();
        if (!leaf) {
          throw new Error("Missing authored assertion");
        }
        locator(leaf, source, run.directory, "AssertEquals");
        expect(leaf.detail).toEqual({ actual: "2", expected: "1" });
        expect(leaf.message).toContain("2 !== 1");
        const again = yield* runCli([...run.args, "--plugin", plugin], {
          cwd: run.directory,
          timeout: 5000,
          env: { XMD_TEST_ARTIFACTS: run.destination, XMD_COUNTER_PATH: run.counts },
        }).join();
        same(run.observed, again, 1);
        const both = yield* records(run.destination);
        expect(both).toHaveLength(2);
        expect(new Set(both.map((record) => record.pid)).size).toBe(2);
        for (const record of both) {
          for (const candidate of record.candidates) {
            if (candidate.repeatedCount !== undefined) {
              expect(candidate.repeatedCount).toBeGreaterThan(0);
            }
          }
        }
      })(),
    ));

  it("prioritizes the true source assertion after a bounded recovered negative prelude", () =>
    bounded(
      (function* () {
        const source =
          '<PrintErrors><Each in={Array.from({length:20},(_,i)=>i)} let="expected"><Fail message={"expected-" + expected} /><AssertEquals actual={expected} expected={-1} /></Each></PrintErrors>\n<Each in={["s1"]} let="scenario"><Project><AssertEquals actual={2} expected={1} /></Project></Each>\n';
        const run = yield* compared(source, "negative-prelude");
        same(run.control, run.observed, 1);
        const [record] = yield* records(run.destination);
        expect(record.observed).toBeGreaterThan(16);
        expect(record.overflow).toBeGreaterThan(0);
        const leaf = record.candidates.find(
          (candidate) =>
            candidate.name === "AssertEquals" &&
            candidate.position.offset === source.lastIndexOf("<AssertEquals"),
        );
        if (!leaf) {
          throw new Error("Recovered prelude crowded out true source assertion");
        }
        locator(leaf, source, run.directory, "AssertEquals", source.lastIndexOf("<AssertEquals"));
        expect(leaf.detail).toEqual({ actual: "2", expected: "1" });
        expect(
          record.candidates.filter((candidate) => candidate.name === "AssertEquals").length,
        ).toBeGreaterThan(0);
      })(),
    ));

  it("reports nonassert Fail at its own source without manufacturing assertion detail", () =>
    bounded(
      (function* () {
        const source =
          '<Each in={["failure"]} let="scenario"><Project>\n<Fail message="owned failure" />\n</Project></Each>\n';
        const run = yield* compared(source, "nonassert");
        same(run.control, run.observed, 1);
        const [record] = yield* records(run.destination);
        const leaf = record.candidates.find((candidate) => candidate.name === "Fail");
        if (!leaf) {
          throw new Error("Missing Fail");
        }
        locator(leaf, source, run.directory, "Fail");
        expect(leaf.message).toContain("owned failure");
        expect(leaf.detail.actual).toEqual({ availability: "not-own-string-data" });
      })(),
    ));

  it("failure-free command has zero diagnostic filesystem calls and no artifact; no-env failure stays unchanged", () =>
    bounded(
      (function* () {
        const source = "healthy output\n<AssertEquals actual={1} expected={1} />\n";
        const run = yield* workspace(source);
        const audit = join(run.directory, "audit.json");
        const env = { XMD_TEST_ARTIFACTS: run.destination, XMD_AUDIT_PATH: audit };
        const control = yield* runCli(run.args, { cwd: run.directory, timeout: 5000, env }).join();
        const observed = yield* runCli(
          [...run.args, "--plugin", join(fixtures, "audit.mjs"), "--plugin", plugin],
          { cwd: run.directory, timeout: 5000, env },
        ).join();
        same(control, observed, 0);
        expect(JSON.parse(yield* readTextFile(audit))).toEqual([]);
        expect(yield* exists(run.destination)).toBe(false);
        yield* retain("healthy-audit", {
          control,
          observed,
          calls: JSON.parse(yield* readTextFile(audit)),
        });
        const failure = yield* workspace('<Fail message="no-env" />');
        const plain = yield* runCli(failure.args, {
          cwd: failure.directory,
          timeout: 5000,
          env: { XMD_TEST_ARTIFACTS: "" },
        }).join();
        const absent = yield* runCli([...failure.args, "--plugin", plugin], {
          cwd: failure.directory,
          timeout: 5000,
          env: { XMD_TEST_ARTIFACTS: "" },
        }).join();
        same(plain, absent, 1);
        expect(yield* exists(failure.destination)).toBe(false);
      })(),
    ));

  it("joins held command cleanup before the single owned failure flush", () =>
    bounded(
      (function* () {
        const source = "<Held />\n<Project><AssertEquals actual={2} expected={1} /></Project>\n";
        const run = yield* workspace(source);
        const gate = join(run.directory, "gate");
        yield* ensureDir(gate);
        const child = yield* spawn(() =>
          runCli([...run.args, "--plugin", plugin], {
            cwd: run.directory,
            timeout: 5000,
            env: { XMD_TEST_ARTIFACTS: run.destination, XMD_GATE_PATH: gate },
          }).join(),
        );
        try {
          yield* bounded(
            (function* () {
              while (!(yield* exists(join(gate, "cleanup-started")))) {
                yield* sleep(5);
              }
            })(),
            5000,
          );
          expect(yield* exists(join(gate, "ready"))).toBe(true);
          expect(yield* exists(join(run.destination, "failure-attribution"))).toBe(false);
          expect(yield* exists(join(gate, "cleaned"))).toBe(false);
          yield* writeTextFile(join(gate, "release"), "release");
          const result = yield* child;
          expect(result.code).toBe(1);
          expect(yield* readTextFile(join(gate, "cleaned"))).toBe("joined");
          expect(yield* records(run.destination)).toHaveLength(1);
          yield* retain("joined-cleanup", result);
        } finally {
          yield* writeTextFile(join(gate, "release"), "release");
        }
      })(),
    ));

  it("inherits evidence environment into the real nested CLI with props-record and includes", () =>
    bounded(
      (function* () {
        const source =
          '---\nprops:\n  type: object\n  properties:\n    record: {type: string}\n  required: [record]\n---\n<Record path={props.record} as="input" />\n<Each in={["inner"]} let="scenario"><Project><AssertEquals actual={input.token} expected={1} /></Project></Each>\n';
        const run = yield* workspace(source);
        yield* writeTextFile(join(run.directory, "input.json"), '{"token":2}');
        const args = [...run.args, "--props-record", "input.json"];
        function outer(withPlugin: boolean) {
          const command = cliShellCommand(withPlugin ? [...args, "--plugin", plugin] : args);
          return (
            '```bash exec as="child"\n' +
            command +
            ";\n```\n<If condition={child.exitCode !== 0}><Fail message={child.stderr + child.stdout} /></If>\n"
          );
        }
        yield* writeTextFile(join(run.directory, "outer-control.md"), outer(false));
        yield* writeTextFile(join(run.directory, "outer.md"), outer(true));
        const env = { XMD_TEST_ARTIFACTS: run.destination };
        const plain = yield* runCli(["run", "outer-control.md", "--raw"], {
          cwd: run.directory,
          timeout: 5000,
          env,
        }).join();
        const observed = yield* runCli(["run", "outer.md", "--raw"], {
          cwd: run.directory,
          timeout: 5000,
          env,
        }).join();
        same(plain, observed, 1);
        const [record] = yield* records(run.destination);
        expect(record.pid).not.toBe(process.pid);
        const leaf = record.candidates.find((candidate) => candidate.name === "AssertEquals");
        if (!leaf) {
          throw new Error("Inner CLI did not retain assertion");
        }
        locator(leaf, source, run.directory, "AssertEquals");
        expect(leaf.detail).toEqual({ actual: "2", expected: "1" });
        yield* retain("nested-process", { plain, observed });
      })(),
    ));
});
