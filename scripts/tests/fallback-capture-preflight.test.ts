import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { useComponentModuleLoader } from "@executablemd/test-support/host";
import { cliRuntime } from "@executablemd/test-support/launch";
import {
  createContext,
  scoped,
  race,
  sleep,
  ensure,
  spawn,
  suspend,
  withResolvers,
  until,
} from "effection";
import type { Operation } from "effection";
import {
  ensureDir,
  exists,
  readTextFile,
  writeTextFile,
  readdir,
  lstat,
  copyFile,
  FsApi,
} from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { API, cwd, useHostFiles } from "@executablemd/runtime";
import {
  Component,
  collect,
  execute,
  registerComponents,
  useNormalizedOutput,
  getExpansion,
} from "@executablemd/core";
import { installTestingComponents } from "@executablemd/testing";
import { InMemoryStream } from "@executablemd/durable-streams";
import { z } from "zod";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { captureCase } from "../../examples/adversarial-implementation/tests/components/Fixture/capture-state.ts";
import type { Capture } from "../../examples/adversarial-implementation/tests/components/Fixture/capture-state.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const helpers = join(root, "examples/adversarial-implementation/tests/components");
const fixtures = join(root, "scripts/tests/fixtures/fallback-capture");
const empty = { type: "object", properties: {}, additionalProperties: false };
const sentinel = "retained-sentinel\n";
const record = z
  .object({
    schema: z.string(),
    scenario: z.string(),
    recordId: z.string().uuid(),
    producer: z.object({ caseId: z.string().uuid(), sequence: z.number(), pid: z.number() }),
    phase: z.string().optional(),
    source: z
      .object({
        line: z.number().optional(),
        element: z.string().optional(),
        path: z.string(),
        sha256: z.string(),
      })
      .optional(),
    actual: z.unknown().optional(),
    expected: z.unknown().optional(),
    reason: z.string().optional(),
    files: z
      .array(
        z
          .object({ path: z.string(), state: z.string(), sha256: z.string().optional() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
type Record = z.infer<typeof record>;
function bounded<T>(body: Operation<T>, ms = 10000): Operation<T> {
  return race([
    body,
    (function* (): Operation<never> {
      yield* sleep(ms);
      throw new Error(`Preflight exceeded ${ms}ms`);
    })(),
  ]);
}
function* records(destination: string): Operation<Record[]> {
  const directory = join(destination, "fallback-capture/fallback/cases");
  if (!(yield* exists(directory))) {
    return [];
  }
  const result: Record[] = [];
  for (const caseId of yield* readdir(directory)) {
    for (const name of (yield* readdir(join(directory, caseId))).sort()) {
      if (/^\d+-.*\.json$/.test(name)) {
        const value = record.parse(JSON.parse(yield* readTextFile(join(directory, caseId, name))));
        expect(name).toBe(
          `${String(value.producer.sequence).padStart(6, "0")}-${value.recordId}.json`,
        );
        expect(value.producer.caseId).toBe(caseId);
        result.push(value);
      }
    }
  }
  return result;
}
interface State {
  actual: number;
  expected: number;
  refs: unknown[];
  seen: Capture[];
  roots: string[];
  removed: string[];
  contentError?: unknown;
  propagated?: unknown;
  gate?: {
    ready: ReturnType<typeof withResolvers<void>>;
    cleanup: ReturnType<typeof withResolvers<void>>;
    release: ReturnType<typeof withResolvers<void>>;
    done: boolean;
  };
}
function state(): State {
  return { actual: 0, expected: 0, refs: [], seen: [], roots: [], removed: [] };
}
function* host(destination: string, observed: State): Operation<void> {
  yield* useComponentModuleLoader();
  yield* useHostFiles();
  yield* useNormalizedOutput();
  yield* installTestingComponents();
  yield* API.Env.around({
    *env([name], next) {
      return name === "XMD_TEST_ARTIFACTS" ? destination : yield* next(name);
    },
  });
  const shared = { retained: true };
  const copy = createContext<Capture>("@executablemd/fixture/fallback-capture");
  yield* registerComponents([
    {
      name: "Setup",
      origin: "diagnostic-preflight",
      props: empty,
      *fn() {
        const directory = yield* cwd();
        observed.roots.push(directory);
        yield* ensureDir(join(directory, "work/delivery"));
        yield* writeTextFile(join(directory, "work/delivery/called.json"), sentinel);
        return { root: directory, repository: directory, directory: join(directory, "work") };
      },
    },
    {
      name: "Operands",
      origin: "diagnostic-preflight",
      props: empty,
      *fn() {
        return {
          actual() {
            observed.actual++;
            return shared;
          },
          expected() {
            observed.expected++;
            return shared;
          },
        };
      },
    },
    {
      name: "Probe",
      origin: "diagnostic-preflight",
      props: empty,
      *fn() {
        const value = yield* captureCase.get();
        expect(yield* copy.get()).toBe(value);
        if (value) {
          observed.seen.push(value);
        }
        return "";
      },
    },
    {
      name: "Gate",
      origin: "diagnostic-preflight",
      props: empty,
      *fn() {
        const gate = observed.gate;
        if (!gate) {
          throw new Error("Missing gate");
        }
        yield* ensure(function* () {
          gate.cleanup.resolve();
          yield* gate.release.operation;
          gate.done = true;
        });
        gate.ready.resolve();
        yield* suspend();
        return "";
      },
    },
  ]);
  yield* Component.around({
    *capture([name], next) {
      const value = yield* next(name);
      if (name === "actual" || name === "expected") {
        observed.refs.push(value);
      }
      return value;
    },
    *content([slot], next) {
      const expansion = yield* getExpansion();
      try {
        return yield* next(slot);
      } catch (error) {
        if (expansion.name === "Fixture.TraceAssertion") {
          observed.contentError = error;
        }
        throw error;
      }
    },
    *handleFailure([failure], next) {
      if (failure.name === "Fixture.TraceAssertion") {
        observed.propagated = failure.error;
      }
      return yield* next(failure);
    },
  });
  yield* FsApi.around({
    *rm([path, options], next) {
      let selected = String(path);
      try {
        selected = yield* until(realpath(path));
      } catch {
        /* Force-removal may already be absent. */
      }
      if (observed.roots.includes(selected)) {
        yield* archive(destination, "component-before-deletion");
        const all = yield* records(destination);
        expect(all.some((item) => item.schema === "fallback-case-close.v1")).toBe(true);
        if (observed.gate) {
          expect(observed.gate.done).toBe(true);
        }
        assertSnapshot(all, selected);
        observed.removed.push(selected);
      }
      return yield* next(path, options);
    },
  });
}
function render(source: string, destination: string, observed: State) {
  return scoped(function* () {
    yield* host(destination, observed);
    return yield* collect(
      yield* execute({
        source,
        path: "<eval>",
        includes: [helpers, fixtures],
        stream: new InMemoryStream(),
      }),
    );
  });
}
const assertion =
  '<Fixture.TraceAssertion line={700} element="AssertEquals"><AssertEquals actual={operands.actual()} expected={operands.expected()} /></Fixture.TraceAssertion>';
function caseBody(scenario: string, body: string): string {
  return `<TempDir><Setup as="fixture" /><Fixture.CaptureCase scenario="${scenario}" fixture={fixture}>${body}</Fixture.CaptureCase></TempDir>`;
}
function assertSnapshot(all: Record[], directory: string) {
  const expected = createHash("sha256").update(sentinel).digest("hex");
  const snapshots = all.filter((item) => item.schema === "fallback-snapshot.v1");
  expect(
    snapshots.some((item) =>
      item.files?.some(
        (file) =>
          file.path === join(directory, "work/delivery/called.json") &&
          file.state === "present" &&
          file.sha256 === expected,
      ),
    ),
  ).toBe(true);
}

describe("bounded diagnostic capture preflights", () => {
  it("P1 actual projected context, exactly-once operands, identity and restoration", () =>
    bounded(
      (function* () {
        const destination = yield* useTempDirectory("capture-p1-");
        const observed = state();
        const projected = `<Probe /><If condition={true}><Each in={[1]} let="item"><Dir path="."><Project>${assertion}</Project></Dir></Each></If>`;
        const source = `<Testing><Test name="preflight" timeout="10s"><Operands as="operands" />${caseBody("first", projected)}<Probe />${caseBody("second", projected)}${caseBody("outer", projected + caseBody("inner", projected) + projected)}<Probe /></Test></Testing>`;
        const output = yield* render(source, destination, observed);
        expect(observed.actual).toBe(5);
        expect(observed.expected).toBe(5);
        expect(observed.refs).toHaveLength(10);
        for (const value of observed.refs) {
          expect(value).toBe(observed.refs[0]);
        }
        expect(observed.seen.map((value) => value.scenario)).toEqual([
          "first",
          "second",
          "outer",
          "inner",
          "outer",
        ]);
        expect(observed.seen[2]).toBe(observed.seen[4]);
        expect(new Set(observed.seen).size).toBe(4);
        expect(yield* captureCase.get()).toBeUndefined();
        const all = yield* records(destination);
        expect(all.filter((item) => item.phase === "before")).toHaveLength(5);
        expect(all.filter((item) => item.phase === "passed")).toHaveLength(5);
        expect(all.filter((item) => item.schema === "fallback-case-close.v1")).toHaveLength(4);
        expect(new Set(all.map((item) => item.recordId)).size).toBe(all.length);
        for (const caseId of new Set(all.map((item) => item.producer.caseId))) {
          const own = all.filter((item) => item.producer.caseId === caseId);
          expect(own.map((item) => item.producer.sequence)).toEqual(
            own.map((_item, index) => index + 1),
          );
        }
        for (const item of all.filter((item) => item.phase)) {
          expect(item.source?.line).toBe(700);
          expect(item.source?.element).toBe("AssertEquals");
        }
        const control = source.replace(
          /<Fixture.TraceAssertion[^>]*>|<\/Fixture.TraceAssertion>|<Fixture.CaptureCase[^>]*>|<\/Fixture.CaptureCase>|<Probe \/>/g,
          "",
        );
        const controlState = state();
        // Control has no capture owner, so no before-deletion capture expectation.
        const controlOutput = yield* scoped(function* () {
          yield* useComponentModuleLoader();
          yield* useHostFiles();
          yield* useNormalizedOutput();
          yield* installTestingComponents();
          const value = { retained: true };
          yield* registerComponents([
            {
              name: "Setup",
              origin: "diagnostic-preflight",
              props: empty,
              *fn() {
                const directory = yield* cwd();
                return {
                  root: directory,
                  repository: directory,
                  directory: join(directory, "work"),
                };
              },
            },
            {
              name: "Operands",
              origin: "diagnostic-preflight",
              props: empty,
              *fn() {
                return {
                  actual() {
                    controlState.actual++;
                    return value;
                  },
                  expected() {
                    controlState.expected++;
                    return value;
                  },
                };
              },
            },
          ]);
          return yield* collect(
            yield* execute({
              source: control,
              path: "<eval>",
              includes: [fixtures],
              stream: new InMemoryStream(),
            }),
          );
        });
        expect(output).toBe(controlOutput);
        expect(String(output)).not.toContain("fallback-assertion-trace");
        expect(observed.removed).toHaveLength(4);
      })(),
    ));

  it("P2 actual scalar failure preserves rethrow and snapshots before TempDir removal", () =>
    bounded(
      (function* () {
        const destination = yield* useTempDirectory("capture-p2-fail-");
        const observed = state();
        let failure: unknown;
        try {
          yield* render(
            `<Testing><Test name="preflight" timeout="10s">${caseBody("failure", '<Fixture.TraceAssertion line={44} element="AssertEquals"><AssertEquals actual={2} expected={1} /></Fixture.TraceAssertion>')}</Test></Testing>`,
            destination,
            observed,
          );
        } catch (error) {
          failure = error;
        }
        const all = yield* records(destination);
        const before = all.filter((item) => item.phase === "before");
        expect(before).toHaveLength(1);
        expect(before[0].actual).toEqual({ type: "json", value: 2 });
        expect(before[0].expected).toEqual({ type: "json", value: 1 });
        expect(all.filter((item) => item.phase === "failed")).toHaveLength(1);
        expect(all.some((item) => item.reason === "assertion-failed")).toBe(true);
        expect(all.at(-1)?.schema).toBe("fallback-case-close.v1");
        expect(observed.contentError).toBeDefined();
        expect(observed.propagated).toBe(observed.contentError);
        expect(failure).toBeDefined();
        assertSnapshot(all, observed.roots[0]);
        expect(yield* exists(observed.roots[0])).toBe(false);
      })(),
    ));

  it("P2 cancellation holds joined cleanup and snapshots before outer deletion", () =>
    bounded(
      (function* () {
        const destination = yield* useTempDirectory("capture-p2-halt-");
        const observed = state();
        const gate = {
          ready: withResolvers<void>(),
          cleanup: withResolvers<void>(),
          release: withResolvers<void>(),
          done: false,
        };
        observed.gate = gate;
        try {
          const task = yield* spawn(() =>
            render(
              `<Testing><Test name="preflight" timeout="10s">${caseBody("cancel", "<Gate />")}</Test></Testing>`,
              destination,
              observed,
            ),
          );
          yield* gate.ready.operation;
          const halt = yield* spawn(() => task.halt());
          yield* gate.cleanup.operation;
          expect(
            (yield* records(destination)).some((item) => item.schema === "fallback-case-close.v1"),
          ).toBe(false);
          expect(yield* exists(observed.roots[0])).toBe(true);
          gate.release.resolve();
          yield* halt;
        } finally {
          gate.release.resolve();
        }
        const all = yield* records(destination);
        expect(gate.done).toBe(true);
        expect(all.at(-1)?.schema).toBe("fallback-case-close.v1");
        expect(
          all.some(
            (item) => item.phase === "passed" || item.schema === "fallback-case-completed.v1",
          ),
        ).toBe(false);
        assertSnapshot(all, observed.roots[0]);
        expect(yield* exists(observed.roots[0])).toBe(false);
      })(),
      5000,
    ));

  const deno = cliRuntime() === "deno";
  if (deno) {
    it("P3 supported local reservation refusal uses the actual launcher", () =>
      bounded(
        (function* () {
          const temporary = yield* syntheticRoot(1);
          const result = yield* launcher(temporary, "reserved").join();
          yield* archive(join(temporary, "fallback-capture"), "reservation");
          expect(result.code).toBe(1);
          expect(yield* exists(join(temporary, "fallback-capture/child-cleaned"))).toBe(false);
          const final = yield* manifest(temporary);
          expect(final.consumerExecutions).toBe(1);
          expect(final.operationalStatus).toBe(1);
        })(),
      ));
  } else {
    it("P3 reservation OS status is Deno-only (unproven under Bun)");
  }
  if (deno && process.platform === "linux") {
    for (const [variant, code, raw] of [
      ["seven", 7, 7],
      ["zero", 0, 0],
      ["fault", 1, 0],
    ] satisfies [string, number, number][]) {
      it(`P3 Linux actual ${variant} status, channels and joined finalization`, () =>
        bounded(
          (function* () {
            const temporary = yield* syntheticRoot(0);
            const result = yield* launcher(temporary, variant).join();
            yield* archive(join(temporary, "fallback-capture"), variant);
            expect(result.code).toBe(code);
            const directory = join(temporary, "fallback-capture/evidence");
            expect(yield* readTextFile(join(directory, "channels/consumer.stdout"))).toBe(
              "synthetic-out\n",
            );
            expect(yield* readTextFile(join(directory, "channels/consumer.stderr"))).toBe(
              "synthetic-err\n",
            );
            const receipt = z
              .object({ code: z.number() })
              .parse(JSON.parse(yield* readTextFile(join(directory, "consumer-status.json"))));
            expect(receipt.code).toBe(raw);
            expect(yield* readTextFile(join(temporary, "fallback-capture/child-cleaned"))).toBe(
              "joined",
            );
            const final = yield* manifest(temporary);
            expect(final.operationalStatus).toBe(code);
            expect(final.consumerExecutions).toBe(1);
            expect((yield* launcher(temporary, "reserved").join()).code).toBe(1);
          })(),
        ));
    }
    it("P3 Linux SIGTERM143 joins held child cleanup and persists partial manifest", () =>
      bounded(
        (function* () {
          const temporary = yield* syntheticRoot(0);
          const child = yield* launcher(temporary, "hold");
          yield* waitFile(join(temporary, "fallback-capture/child-ready"));
          process.kill(child.pid, "SIGTERM");
          yield* waitFile(join(temporary, "fallback-capture/cleanup-started"));
          yield* writeTextFile(join(temporary, "fallback-capture/cleanup-release"), "release");
          const result = yield* child.join();
          yield* archive(join(temporary, "fallback-capture"), "sigterm");
          expect(result.code).toBe(143);
          expect(yield* exists(join(temporary, "fallback-capture/child-cleaned"))).toBe(true);
          expect((yield* manifest(temporary)).consumerExecutions).toBe(1);
        })(),
        5000,
      ));
  } else {
    it(
      "P3 Linux setsid/timeout7/0/fault1/SIGTERM143/join boundaries UNPROVEN on this runtime/host",
    );
  }
});
function* syntheticRoot(reservation: number) {
  const temporary = yield* useTempDirectory("capture-launcher-");
  const base = join(temporary, "fallback-capture");
  yield* ensureDir(join(base, "evidence/channels"));
  yield* ensureDir(join(base, "evidence/journals"));
  yield* ensureDir(join(base, "checkout"));
  yield* ensureDir(join(base, "tmp"));
  yield* writeTextFile(
    join(base, "evidence/manifest.json"),
    JSON.stringify({ phase: "prelaunch", consumerExecutions: reservation }),
  );
  return temporary;
}
function launcher(temporary: string, variant: string) {
  return exec("deno", {
    arguments: [
      "run",
      "--allow-all",
      "--node-modules-dir=manual",
      "--cached-only",
      "--frozen",
      join(fixtures, "launcher-deno.ts"),
      variant,
    ],
    cwd: root,
    env: { ...process.env, RUNNER_TEMP: temporary },
  });
}
function* manifest(temporary: string) {
  return z
    .object({
      consumerExecutions: z.number(),
      operationalStatus: z.number().nullable(),
      operationalReason: z.string(),
    })
    .passthrough()
    .parse(
      JSON.parse(yield* readTextFile(join(temporary, "fallback-capture/evidence/manifest.json"))),
    );
}
function* waitFile(path: string): Operation<void> {
  while (!(yield* exists(path))) {
    yield* sleep(5);
  }
}

function* archive(directory: string, label: string): Operation<void> {
  const destination = process.env.XMD_TEST_ARTIFACTS;
  if (!destination) {
    return;
  }
  const target = join(destination, label, crypto.randomUUID());
  function* copy(source: string, output: string): Operation<void> {
    yield* ensureDir(output);
    for (const name of yield* readdir(source)) {
      const path = join(source, name);
      const info = yield* lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        yield* copy(path, join(output, name));
      } else if (info.isFile()) {
        yield* copyFile(path, join(output, name));
      }
    }
  }
  yield* copy(directory, target);
}
