/**
 * Tier TC — the temp-file compiler's generated file.
 *
 * What these assert is ownership rather than compilation: the file
 * `compileTempFile` generates belongs to one private scope, and that scope has
 * finished with it before compilation settles — on success, on a failing
 * import, and on cancellation.
 *
 * `@effectionx/fs` is a contextual Api, so `FsApi.around()` observes the real
 * write and the real removal as they happen. The recorded log is what makes
 * "before it returned" falsifiable: a removal launched and left running is
 * absent from it at the moment the assertion reads it.
 *
 * `.xmd-eval` is shared, and other tests compile into it concurrently, so every
 * assertion here names the one file this compilation generated.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { FsApi, exists, rm, toPath } from "@effectionx/fs";
import { basename, dirname } from "node:path";
import { compileTempFile } from "../src/temp-file-compiler.ts";

const GENERATED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ts$/;

/** The name of a generated eval module, or nothing for any other path. */
function generated(pathOrUrl: string | URL): string | undefined {
  const path = toPath(pathOrUrl);
  if (basename(dirname(path)) !== ".xmd-eval") {
    return undefined;
  }
  return basename(path);
}

interface Recorder {
  /** `write`/`wrote` and `remove`/`removed`, in the order they happened. */
  readonly log: string[];
  /** Every generated file this test caused, for the safety cleanup. */
  readonly written: string[];
}

/**
 * Observe the generated files of the compilations that run inside this scope.
 *
 * The removal that guards against a leak is registered before the observer, so
 * a run that fails its assertions — or a mutant that never removes anything —
 * still leaves `.xmd-eval` as it found it.
 */
function* useRecorder(): Operation<Recorder> {
  const log: string[] = [];
  const written: string[] = [];

  yield* ensure(function* () {
    for (const path of written) {
      yield* rm(path, { force: true });
    }
  });

  yield* FsApi.around({
    *writeTextFile([path, content], next) {
      const name = generated(path);
      if (name === undefined) {
        return yield* next(path, content);
      }
      written.push(toPath(path));
      log.push(`write ${name}`);
      yield* next(path, content);
      log.push(`wrote ${name}`);
    },
    *rm([path, options], next) {
      const name = generated(path);
      if (name === undefined) {
        return yield* next(path, options);
      }
      log.push(`remove ${name}`);
      yield* next(path, options);
      log.push(`removed ${name}`);
    },
  });

  return { log, written };
}

/** The one generated file a log describes, refusing a log about several. */
function only(log: string[]): string {
  const names = new Set(log.map((entry) => entry.split(" ")[1]));
  expect([...names].length).toBe(1);
  const [name] = names;
  expect(name).toMatch(GENERATED);
  return name ?? "";
}

describe("Tier TC — temp-file compiler lifecycle", () => {
  // TC1: the ordinary path. The write and the removal name the same generated
  // file, and the removal has completed by the time a block comes back.
  it("TC1: a successful compilation removes its generated file before it returns", function* () {
    const recorder = yield* useRecorder();

    const block = yield* compileTempFile("env.compiled = true;");
    const log = [...recorder.log];

    const name = only(log);
    expect(log).toEqual([`write ${name}`, `wrote ${name}`, `remove ${name}`, `removed ${name}`]);
    expect(recorder.written.length).toBe(1);
    expect(yield* exists(recorder.written[0] ?? "")).toBe(false);

    // The block that came back is the compiled one, not a leftover.
    const env: Record<string, unknown> = {};
    yield* block(env);
    expect(env["compiled"]).toBe(true);
  });

  // TC2: a failing import still propagates, and it arrives at the caller after
  // the file is gone rather than instead of removing it.
  it("TC2: a failing import propagates with the generated file already removed", function* () {
    const recorder = yield* useRecorder();

    let outcome: unknown = "never settled";
    try {
      yield* compileTempFile("const broken = ;");
      outcome = "returned a block";
    } catch (error) {
      outcome = error;
    }
    const log = [...recorder.log];

    expect(outcome).not.toBe("never settled");
    expect(outcome).not.toBe("returned a block");

    const name = only(log);
    expect(log).toEqual([`write ${name}`, `wrote ${name}`, `remove ${name}`, `removed ${name}`]);
    expect(yield* exists(recorder.written[0] ?? "")).toBe(false);
  });

  // TC3: cancellation, waited for rather than timed. The write delegates so the
  // real file exists, tells the test so, and then suspends where a halt lands
  // between creating the file and doing anything else with it.
  it("TC3: halting a compilation removes its generated file before the halt settles", function* () {
    const recorder = yield* useRecorder();
    const created = withResolvers<string>();

    yield* scoped(function* () {
      yield* FsApi.around({
        *writeTextFile([path, content], next) {
          yield* next(path, content);
          created.resolve(toPath(path));
          yield* suspend();
        },
      });

      const compilation = yield* spawn(() => compileTempFile("env.unreachable = true;"));
      const path = yield* created.operation;

      expect(generated(path)).toMatch(GENERATED);
      expect(yield* exists(path)).toBe(true);

      yield* compilation.halt();
      expect(yield* exists(path)).toBe(false);
    });

    expect(recorder.written.length).toBe(1);
  });

  // TC4: the removal is not best-effort. A cleanup that fails for any reason
  // other than the file already being absent decides the compilation, so a
  // caller cannot be handed a block whose scratch state is still on disk.
  it("TC4: a failing removal fails the compilation instead of being discarded", function* () {
    const recorder = yield* useRecorder();
    const refused = new Error("TC4 sentinel: removal refused");
    let outcome: unknown = "never settled";

    // The interceptor lives inside this scope so the safety cleanup registered
    // by the recorder — which runs outside it — can still remove what it must.
    yield* scoped(function* () {
      yield* FsApi.around({
        *rm([path, options], next) {
          if (generated(path) === undefined) {
            return yield* next(path, options);
          }
          yield* next(path, options);
          throw refused;
        },
      });

      try {
        yield* compileTempFile("env.compiled = true;");
        outcome = "returned a block";
      } catch (error) {
        outcome = error;
      }
    });

    // The exact error, neither swallowed nor replaced with one of its own.
    expect(outcome).toBe(refused);
    expect(recorder.written.length).toBe(1);
    expect(yield* exists(recorder.written[0] ?? "")).toBe(false);
  });
});
