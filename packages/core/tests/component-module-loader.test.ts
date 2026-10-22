import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { useComponentModuleLoader } from "@executablemd/test-support/component-modules";
import { cliRuntime } from "@executablemd/test-support/launch";
import { readTextFile, readdir, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { createContext, ensure, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import * as moduleApi from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collect, Component, execute, registerComponents, useNormalizedOutput } from "../mod.ts";
import { ComponentModuleLoader, Execution } from "../api.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { loadHookModule } from "../component-modules/hooks.ts";

const ABSENT =
  "TypeScript component module loader is not installed — bind ComponentModuleLoader for this host before loading TypeScript components.";
const SOURCE =
  'export const generated = { "self-closing": { identity: "https://executable.md/tests/module/typed", effect: "read" } };\nexport default function*() { const answer: string = "typed-module"; return answer; }';
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function render(directory: string, source = "<Typed />"): Operation<unknown> {
  return scoped(function* () {
    yield* useNormalizedOutput();
    return yield* collect(
      yield* execute({
        source,
        path: "<eval>",
        includes: [directory],
        stream: new InMemoryStream(),
      }),
    );
  });
}

describe("ComponentModuleLoader", () => {
  it("L1: requires explicit installation independently of eval, Markdown and registrations", function* () {
    const directory = yield* useTempDirectory("component-loader-install-");
    const entered = `loader-absent-${directory}`;
    yield* writeTextFile(
      join(directory, "Typed.ts"),
      `Reflect.set(globalThis, ${JSON.stringify(entered)}, true);\n${SOURCE}`,
    );
    yield* ComponentModuleLoader.set(undefined);
    for (const evalCompiler of [false, true]) {
      yield* scoped(function* () {
        if (evalCompiler) {
          yield* useTempFileCompiler();
        }
        let diagnostic = "";
        try {
          yield* render(directory);
        } catch (error) {
          diagnostic = error instanceof Error ? error.message : String(error);
        }
        expect(diagnostic).toContain(ABSENT);
        expect(Reflect.has(globalThis, entered)).toBe(false);
        expect((yield* readdir(directory)).sort()).toEqual(["Typed.ts"]);
      });
    }
    expect(yield* render(directory, "Markdown alone")).toContain("Markdown alone");
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
    expect(yield* render(directory, "<Registered />")).toContain("registered");
    yield* ensure(function* () {
      Reflect.deleteProperty(globalThis, entered);
    });
    yield* useComponentModuleLoader();
    expect(yield* render(directory)).toContain("typed-module");
    expect(Reflect.get(globalThis, entered)).toBe(true);
  });

  it("L2: captures one bound selection for profile and durable loading across later rebinding", function* () {
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
    yield* scoped(function* () {
      yield* Component.around({ generated: () => ({ Typed: ["self-closing"] }) });
      yield* Execution.around({
        *execute([request], next) {
          yield* ComponentModuleLoader.set(B);
          yield* next(request);
        },
      });
      expect(yield* render(directory, '<Typed />\n<Evaluate text="<Typed />" />')).toContain(
        "typed-module",
      );
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(
      calls.every(
        (call) => call.provider === "A" && call.source === SOURCE && call.origin === origin,
      ),
    ).toBe(true);
    calls.length = 0;
    yield* copy.set(B);
    expect(yield* render(directory)).toContain("typed-module");
    expect(calls).toEqual([{ provider: "B", source: SOURCE, origin }]);
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

  it("P1: loads under the preserved read-only envelope and retains authored write denial", function* () {
    const directory = yield* useTempDirectory("component-loader-readonly-");
    const direct = join(directory, "ReadOnly.ts");
    yield* writeTextFile(
      direct,
      'export default function*() { const value: string = "ordinary-read-only-component"; return value; }',
    );
    const before = yield* readTextFile(direct);
    const fixture = join(ROOT, "packages/core/tests/fixtures/component-module-readonly.ts");
    for (const mode of ["read", "write"]) {
      const result = yield* exec("deno", {
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
          fixture,
          directory,
          mode,
        ],
      }).join();
      expect({ mode, code: result.code, stderr: result.stderr }).toEqual({
        mode,
        code: 0,
        stderr: "",
      });
      expect(result.stdout.trim()).toBe(
        mode === "read" ? "ordinary-read-only-component" : "authored-write-denied",
      );
    }
    expect(yield* readTextFile(direct)).toBe(before);
    expect((yield* readdir(directory)).sort()).toEqual(["ReadOnly.ts"]);
  });
});
