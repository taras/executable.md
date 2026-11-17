import { captureTestJournal } from "@executablemd/test-support/failure-journal";
import { API } from "@executablemd/runtime";
import {
  checkSubprocessJournals,
  parseSubprocessJournal,
  readSubprocessSnapshot,
} from "../../test-support/subprocess-journal.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { useComponentModuleLoader } from "@executablemd/test-support/host";
import { cliRuntime } from "@executablemd/test-support/launch";
import { exists, readTextFile, readdir, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { createContext, ensure, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import * as moduleApi from "node:module";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { InMemoryStream } from "@executablemd/durable-streams";
import { collect, Component, execute, registerComponents, useNormalizedOutput } from "../mod.ts";
import { ComponentModuleLoader, Execution } from "../api.ts";
import { useComponentModules } from "../src/typescript-module.ts";
import type { LoadComponentModule } from "../src/typescript-module.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { loadHookModule } from "../component-modules/hooks.ts";

const ABSENT =
  "TypeScript component module loader is not installed — bind ComponentModuleLoader for this host before loading TypeScript components.";
const SOURCE =
  'export const generated = { "self-closing": { identity: "https://executable.md/tests/module/typed", effect: "read" } };\nexport default function*() { const answer: string = "typed-module"; return answer; }';
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function render(
  directory: string,
  stream: InMemoryStream,
  source = "<Typed />",
): Operation<unknown> {
  return scoped(function* () {
    yield* useNormalizedOutput();
    return yield* collect(
      yield* execute({
        source,
        path: "<eval>",
        includes: [directory],
        stream,
      }),
    );
  });
}

const OWNER = "packages/core/tests/component-module-loader.test.ts";

function captureLoad(name: string, body: (stream: InMemoryStream) => Operation<void>) {
  return captureTestJournal({ owner: OWNER, name }, "<eval>", body);
}

describe("ComponentModuleLoader", () => {
  const requiresLoader =
    "L1: requires explicit installation independently of eval, Markdown and registrations";
  it(requiresLoader, function* () {
    const directory = yield* useTempDirectory("component-loader-install-");
    const entered = `loader-absent-${directory}`;
    yield* writeTextFile(
      join(directory, "Typed.ts"),
      `Reflect.set(globalThis, ${JSON.stringify(entered)}, true);\n${SOURCE}`,
    );
    yield* ComponentModuleLoader.set(undefined);
    for (const evalCompiler of [false, true]) {
      yield* captureLoad(requiresLoader, function* (stream) {
        if (evalCompiler) {
          yield* useTempFileCompiler();
        }
        let diagnostic = "";
        try {
          yield* render(directory, stream);
        } catch (error) {
          diagnostic = error instanceof Error ? error.message : String(error);
        }
        expect(diagnostic).toContain(ABSENT);
        expect(Reflect.has(globalThis, entered)).toBe(false);
        expect((yield* readdir(directory)).sort()).toEqual(["Typed.ts"]);
      });
    }
    yield* captureLoad(requiresLoader, function* (stream) {
      expect(yield* render(directory, stream, "Markdown alone")).toContain("Markdown alone");
    });
    yield* registerComponents([
      {
        name: "Registered",
        origin: "test://registered",
        props: { type: "object" },
        fn: function* () {
          return "registered";
        },
      },
    ]);
    yield* captureLoad(requiresLoader, function* (stream) {
      expect(yield* render(directory, stream, "<Registered />")).toContain("registered");
    });
    yield* ensure(function* () {
      Reflect.deleteProperty(globalThis, entered);
    });
    yield* useComponentModuleLoader();
    yield* captureLoad(requiresLoader, function* (stream) {
      expect(yield* render(directory, stream)).toContain("typed-module");
      expect(Reflect.get(globalThis, entered)).toBe(true);
    });
  });

  const fixedSelection =
    "L2: captures one bound selection for profile and durable loading across later rebinding";
  it(fixedSelection, function* () {
    yield* useComponentModuleLoader();
    const native = yield* ComponentModuleLoader.expect();
    if (native === undefined) {
      throw new Error("fixture installer selected no loader");
    }
    const directory = yield* useTempDirectory("component-loader-capture-");
    const origin = pathToFileURL(join(directory, "Typed.ts")).href;
    yield* writeTextFile(join(directory, "Typed.ts"), SOURCE);
    const loadNative = native.load.bind(native);
    const calls: Array<{ provider: string; source: string; origin: string }> = [];
    function provider(label: string): ComponentModuleLoader {
      return {
        *load(source, origin) {
          expect(this).toBe(selected.get(label));
          calls.push({ provider: label, source, origin });
          return yield* loadNative(source, origin);
        },
      };
    }
    const selected = new Map<string, ComponentModuleLoader>();
    selected.set("A", provider("A"));
    selected.set("B", provider("B"));
    const A = selected.get("A");
    const B = selected.get("B");
    const copy = createContext<ComponentModuleLoader | undefined>(
      "@executablemd/core/ComponentModuleLoader",
      undefined,
    );
    yield* copy.set(A);
    expect(yield* ComponentModuleLoader.get()).toBe(A);
    yield* captureLoad(fixedSelection, function* (stream) {
      yield* scoped(function* () {
        yield* Component.around({ generated: () => ({ Typed: ["self-closing"] }) });
        yield* Execution.around({
          *execute([request], next) {
            yield* ComponentModuleLoader.set(B);
            yield* next(request);
          },
        });
        expect(
          yield* render(directory, stream, '<Typed />\n<Evaluate text="<Typed />" />'),
        ).toContain("typed-module");
      });
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(
        calls.every(
          (call) => call.provider === "A" && call.source === SOURCE && call.origin === origin,
        ),
      ).toBe(true);
      calls.length = 0;
      yield* copy.set(B);
      yield* captureLoad(fixedSelection, function* (secondStream) {
        expect(yield* render(directory, secondStream)).toContain("typed-module");
        expect(calls).toEqual([{ provider: "B", source: SOURCE, origin }]);
      });
    });
  });

  it("L3: joins native loading before releasing its owned hook or Blob", function* () {
    yield* useComponentModuleLoader();
    const native = yield* ComponentModuleLoader.get();
    if (native === undefined) {
      throw new Error("fixture installer selected no loader");
    }
    const directory = yield* useTempDirectory("component-loader-lifetime-");
    const origin = pathToFileURL(join(directory, "Lifetime.ts")).href;
    yield* writeTextFile(join(directory, "late.mjs"), 'export const value = "late-native";');
    const entered = withResolvers<void>();
    const stopped = withResolvers<void>();
    const gate = `component-loader-native-${directory}`;
    let release: () => void = () => {
      throw new Error("native module has not entered");
    };
    let removed = 0;
    let installed = 0;
    const source = `await new Promise<void>(resolve => Reflect.get(globalThis, ${JSON.stringify(gate)})(resolve));\nexport const later = () => import("./late.mjs");`;
    Reflect.set(globalThis, gate, (resolve: () => void) => {
      release = resolve;
      entered.resolve();
    });
    yield* ensure(function* () {
      Reflect.deleteProperty(globalThis, gate);
    });
    let loader = native.load.bind(native);
    if (cliRuntime() === "bun") {
      const create = URL.createObjectURL;
      const revoke = URL.revokeObjectURL;
      yield* ensure(function* () {
        URL.createObjectURL = create;
        URL.revokeObjectURL = revoke;
      });
      URL.createObjectURL = (blob) => {
        installed++;
        return create(blob);
      };
      URL.revokeObjectURL = (url) => {
        removed++;
        revoke(url);
      };
    } else {
      loader = (source, origin) =>
        loadHookModule(source, origin, (options) => {
          const handle = moduleApi.registerHooks(options);
          installed++;
          const deregister = handle.deregister.bind(handle);
          return new Proxy(handle, {
            get(target, property, receiver) {
              return property === "deregister"
                ? () => {
                    removed++;
                    deregister();
                  }
                : Reflect.get(target, property, receiver);
            },
          });
        });
    }
    const owner = yield* spawn(function* () {
      yield* loader(source, origin);
      yield* suspend();
    });
    yield* entered.operation;
    const halt = yield* spawn(function* () {
      yield* owner.halt();
      stopped.resolve();
    });
    expect(installed).toBe(1);
    expect(removed).toBe(0);
    release();
    yield* stopped.operation;
    yield* halt;
    expect(removed).toBe(1);
    const result = yield* scoped(function* () {
      const module = yield* loader('export const later = () => import("./late.mjs");', origin);
      if (
        typeof module !== "object" ||
        module === null ||
        !("later" in module) ||
        typeof module.later !== "function"
      ) {
        throw new Error("native module lost its export");
      }
      expect(removed).toBe(1);
      return yield* until(module.later());
    });
    expect(result).toMatchObject({ value: "late-native" });
    expect(installed).toBe(2);
    expect(removed).toBe(2);
    expect(yield* until(import(pathToFileURL(join(directory, "late.mjs")).href))).toMatchObject({
      value: "late-native",
    });
  });

  it("L3: canonical per-load evaluation keeps independent loads parallel and joins a cancelled waiter", function* () {
    yield* useComponentModuleLoader();
    const native = yield* ComponentModuleLoader.get();
    if (native === undefined) {
      throw new Error("fixture installer selected no loader");
    }
    let installed = 0;
    let removed = 0;
    let load = native.load.bind(native);
    if (cliRuntime() === "bun") {
      const create = URL.createObjectURL;
      const revoke = URL.revokeObjectURL;
      yield* ensure(function* () {
        URL.createObjectURL = create;
        URL.revokeObjectURL = revoke;
      });
      URL.createObjectURL = (blob) => {
        installed++;
        return create(blob);
      };
      URL.revokeObjectURL = (url) => {
        removed++;
        revoke(url);
      };
    } else {
      load = (source, origin) =>
        loadHookModule(source, origin, (options) => {
          const handle = moduleApi.registerHooks(options);
          installed++;
          const deregister = handle.deregister.bind(handle);
          return new Proxy(handle, {
            get(target, property, receiver) {
              return property === "deregister"
                ? () => {
                    removed++;
                    deregister();
                  }
                : Reflect.get(target, property, receiver);
            },
          });
        });
    }
    yield* ComponentModuleLoader.set({ load });
    const directory = yield* useTempDirectory("component-loader-canonical-");
    yield* writeTextFile(
      join(directory, "late.mjs"),
      'export const value = "independent-late-module";',
    );
    const gate = `canonical-module-${directory}`;
    const entered = withResolvers<void>();
    let release: () => void = () => {
      throw new Error("native load has not entered");
    };
    yield* ensure(function* () {
      Reflect.deleteProperty(globalThis, gate);
    });
    Reflect.set(globalThis, gate, (resolve: () => void) => {
      release = resolve;
      entered.resolve();
    });
    const ready = withResolvers<LoadComponentModule>();
    const canonical = yield* spawn(function* () {
      ready.resolve(yield* useComponentModules());
      yield* suspend();
    });
    const captured = yield* ready.operation;
    let firstReturned = false;
    const first = yield* spawn(function* () {
      yield* captured(
        `await new Promise<void>(resolve => Reflect.get(globalThis, ${JSON.stringify(gate)})(resolve));\nexport const value = "held";`,
        pathToFileURL(join(directory, "Held.ts")).href,
      );
      firstReturned = true;
    });
    yield* entered.operation;
    const second = yield* captured(
      'export const later = () => import("./late.mjs");',
      pathToFileURL(join(directory, "Independent.ts")).href,
    );
    if (
      typeof second !== "object" ||
      second === null ||
      !("later" in second) ||
      typeof second.later !== "function"
    ) {
      throw new Error("independent module lost its late export");
    }
    expect(yield* until(second.later())).toMatchObject({ value: "independent-late-module" });
    expect(installed).toBe(2);
    expect(removed).toBe(0);
    let halted = false;
    const stopping = yield* spawn(function* () {
      yield* first.halt();
      halted = true;
    });
    expect(halted).toBe(false);
    expect(removed).toBe(0);
    release();
    yield* stopping;
    expect(halted).toBe(true);
    expect(firstReturned).toBe(false);
    expect(removed).toBe(1);
    expect(yield* until(second.later())).toMatchObject({ value: "independent-late-module" });
    yield* canonical.halt();
    expect(removed).toBe(2);
  });

  if (cliRuntime() === "deno") {
    const readOnlyCase =
      "P1: Deno loads under the preserved read-only envelope and retains authored write denial";
    const expected = "ordinary-read-only-component";

    function runFixture(directory: string, mode: "read" | "write", capture = false) {
      return exec(execPath, {
        arguments: [
          "run",
          "--config",
          join(ROOT, "deno.json"),
          "--node-modules-dir=manual",
          "--allow-read",
          "--allow-env",
          "--allow-import",
          "--deny-write",
          "--no-prompt",
          "--cached-only",
          "--frozen",
          join(ROOT, "packages/core/tests/fixtures/component-module-readonly.ts"),
          directory,
          mode,
          ...(capture ? ["--capture-journal"] : []),
        ],
      }).join();
    }

    function* useReadOnlyFixture() {
      const directory = yield* useTempDirectory("component-loader-readonly-");
      const direct = join(directory, "ReadOnly.ts");
      yield* writeTextFile(
        direct,
        'export default function*() { const value: string = "ordinary-read-only-component"; return value; }',
      );
      return { directory, direct, before: yield* readTextFile(direct) };
    }

    function* checkCapturedRead(
      directory: string,
      name: string,
      check: (
        output: string,
        snapshot: ReturnType<typeof readSubprocessSnapshot>,
      ) => Operation<void>,
    ) {
      const result = yield* runFixture(directory, "read", true);
      let data: unknown;
      try {
        data = JSON.parse(result.stdout);
      } catch {
        data = undefined;
      }
      const snapshot = readSubprocessSnapshot(
        data && typeof data === "object" && "journals" in data ? data.journals : undefined,
        0,
      );
      yield* checkSubprocessJournals(
        { owner: OWNER, name },
        [{ source: "<eval>", snapshot }],
        function* () {
          expect({ mode: "read", code: result.code, stderr: result.stderr }).toEqual({
            mode: "read",
            code: 0,
            stderr: "",
          });
          const output =
            data && typeof data === "object" && "output" in data && typeof data.output === "string"
              ? data.output.trim()
              : "";
          yield* check(output, snapshot);
        },
      );
    }

    it(readOnlyCase, function* () {
      const { directory, direct, before } = yield* useReadOnlyFixture();
      yield* checkCapturedRead(directory, readOnlyCase, function* (output) {
        expect(output).toBe(expected);
        const mode = "write";
        const result = yield* runFixture(directory, mode);
        expect({ mode, code: result.code, stderr: result.stderr }).toEqual({
          mode,
          code: 0,
          stderr: "",
        });
        expect(result.stdout.trim()).toBe("authored-write-denied");
        expect(yield* readTextFile(direct)).toBe(before);
        expect((yield* readdir(directory)).sort()).toEqual(["ReadOnly.ts"]);
      });
    });

    const witness =
      "P1: attributes a read-only child journal when the joined parent's assertion fails";
    it(witness, function* () {
      const { directory } = yield* useReadOnlyFixture();
      const raw = yield* runFixture(directory, "read");
      expect({ code: raw.code, stderr: raw.stderr, stdout: raw.stdout.trim() }).toEqual({
        code: 0,
        stderr: "",
        stdout: expected,
      });
      const artifacts = join(yield* useTempDirectory("readonly-journal-"), "test-artifacts");
      yield* API.Env.around({
        *env([name], next) {
          return name === "XMD_TEST_ARTIFACTS" ? artifacts : yield* next(name);
        },
      });
      // deno-lint-ignore require-yield
      yield* checkCapturedRead(directory, witness, function* (output, snapshot) {
        expect(output).toBe(expected);
        expect(snapshot).toBeInstanceOf(Array);
      });
      expect(yield* exists(artifacts)).toBe(false);

      let assertion: unknown;
      let caught: unknown;
      let received: ReturnType<typeof readSubprocessSnapshot> = "snapshot absent";
      try {
        // deno-lint-ignore require-yield
        yield* checkCapturedRead(directory, witness, function* (output, snapshot) {
          received = snapshot;
          try {
            expect(output).toBe("missing result");
          } catch (error) {
            assertion = error;
            throw error;
          }
        });
      } catch (error) {
        caught = error;
      }
      expect(assertion).toBeInstanceOf(Error);
      expect(caught).toBe(assertion);

      const invocations = yield* readdir(artifacts);
      expect(invocations).toHaveLength(1);
      const saved = join(artifacts, invocations[0]!);
      expect((yield* readdir(saved)).sort()).toEqual(["child-1.case.json", "child-1.jsonl"]);
      expect(JSON.parse(yield* readTextFile(join(saved, "child-1.case.json")))).toEqual({
        owner: OWNER,
        name: witness,
        kind: "child",
        ordinal: 1,
        source: "<eval>",
      });
      const lines = (yield* readTextFile(join(saved, "child-1.jsonl"))).trimEnd().split("\n");
      const replay = parseSubprocessJournal(lines);
      expect(replay).toEqual(received);
      expect(replay.at(-1)).toMatchObject({ type: "close", coroutineId: "root" });
    });
  }
});
