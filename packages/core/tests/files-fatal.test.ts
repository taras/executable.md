/**
 * Tier FF — Files infrastructure failure (spec §§6.9, 6.11, 6.13, 6.14).
 *
 * Every other filesystem tier asks what a document reads when something goes
 * wrong. This one asks the opposite question: when a document filesystem
 * *provider* is missing, refuses an operation, or breaks its own contract,
 * nothing is written into the document at all. The execution ends.
 *
 * The distinction matters because the two are easy to confuse from inside a
 * component. "No such file" is something the document did and can fix; "no
 * filesystem provider is installed" is not, and printing it as a comment would
 * let every sibling after it run as though the file work had happened.
 *
 * These drive the real components through `execute()` and install providers
 * that misbehave in exactly one way each.
 */

import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Err, Ok, resource, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import {
  API,
  FILES_ERROR,
  FILES_FATAL,
  FILES_WRITE_SUCCESS,
  Files,
  FilesError,
  FilesInvariantError,
  FilesOperationDeniedError,
  FilesProviderUnavailableError,
  fileWriteSuccess,
  hostFilesHandler,
  parseFileWriteFailure,
  parseFileWriteSuccess,
  parseFilesFailure,
  parseFilesFatal,
  useHostFiles,
} from "@executablemd/runtime";
import type { FilePathInput, FileWriteInput, FileWriteSuccess } from "@executablemd/runtime";
import { InMemoryStream, StaleInputError } from "@executablemd/durable-streams";
import { InvocationTeardownError } from "../src/invocation.ts";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { fatalCause, filesFatalFailure } from "../src/errors.ts";
import { invokeFiles } from "../src/files.ts";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function useFixture(): Operation<string> {
  return resource(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "ff-test-")));
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* provide(yield* until(realpath(dir)));
  });
}

interface Outcome {
  ok: boolean;
  error: unknown;
  output: string;
}

/**
 * Run `source` as a document, reporting both what it rendered and how the
 * execution ended.
 *
 * Both halves are needed here: a fatal failure is distinguished from a printed
 * error precisely by leaving nothing in the output, and by stopping what comes
 * after it.
 */
function run(dir: string, source: string, install?: () => Operation<void>): Operation<Outcome> {
  return scoped(function* () {
    yield* writeTextFile(join(dir, "doc.md"), source);
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return dir;
        },
      },
      { at: "min" },
    );
    if (install) {
      yield* install();
    }
    const chunks: string[] = [];
    const result = yield* scoped(function* () {
      const execution = yield* execute({
        path: join(dir, "doc.md"),
        stream: new InMemoryStream(),
        includes: [dir],
      });
      try {
        chunks.push(String(yield* collect(execution)));
      } catch {
        // Collection stops where the failure did; the execution's own outcome
        // below is what says why.
      }
      return yield* execution;
    });
    return {
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      output: chunks.join(""),
    };
  });
}

function invariantCategory(error: unknown): string | undefined {
  const data = parseFilesFatal(fatalCause(error));
  return data?.kind === "invariant" ? data.category : undefined;
}

/**
 * Whether anything a hostile provider planted reached the outside.
 *
 * The rendered document, the failure's own text, its cause chain, and its
 * enumerable data are the places a value could surface. Only the *outcome* is
 * inspected — never the hostile object — so nothing here runs a trap the
 * boundary was supposed to run first.
 */
function leaked(outcome: Outcome): boolean {
  const failure = outcome.error;
  const shown = [
    outcome.output,
    String(failure),
    failure instanceof Error ? String(failure.cause) : "",
    JSON.stringify(failure instanceof Error ? { ...failure } : {}),
  ].join(" ");
  return shown.includes("planted") || shown.includes("EACCES");
}

/**
 * Data as it arrives from outside the type system.
 *
 * A provider is a contextual handler: at run time it can return whatever it
 * likes, and the contract this suite exercises is precisely the one the types
 * cannot enforce. Round-tripping through JSON is how a malformed value is
 * built here without asserting a type it does not have.
 */
function fromOutside<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value));
}

/** Install a provider that answers exactly one way, and nothing else. */
function useFiles(handler: {
  checkFilePath?: (input: FilePathInput) => Operation<Result<void>>;
  readTextFile?: (input: FilePathInput) => Operation<Result<string>>;
  writeTextFile?: (input: FileWriteInput) => Operation<Result<FileWriteSuccess>>;
  deleteFile?: (input: FilePathInput) => Operation<Result<void>>;
  globFiles?: (input: {
    cwd: string;
    include: string[];
    exclude: string[];
  }) => Operation<Result<string[]>>;
  temporaryDirectory?: () => Operation<Result<string>>;
}): Operation<void> {
  return Files.around({
    ...(handler.checkFilePath === undefined
      ? {}
      : {
          *checkFilePath([input], next) {
            return yield* (handler.checkFilePath ?? next)(input);
          },
        }),
    ...(handler.readTextFile === undefined
      ? {}
      : {
          *readTextFile([input], next) {
            return yield* (handler.readTextFile ?? next)(input);
          },
        }),
    ...(handler.writeTextFile === undefined
      ? {}
      : {
          *writeTextFile([input], next) {
            return yield* (handler.writeTextFile ?? next)(input);
          },
        }),
    ...(handler.deleteFile === undefined
      ? {}
      : {
          *deleteFile([input], next) {
            return yield* (handler.deleteFile ?? next)(input);
          },
        }),
    ...(handler.globFiles === undefined
      ? {}
      : {
          *globFiles([input], next) {
            return yield* (handler.globFiles ?? next)(input);
          },
        }),
    ...(handler.temporaryDirectory === undefined
      ? {}
      : {
          *temporaryDirectory(_args, next) {
            return yield* (handler.temporaryDirectory ?? next)();
          },
        }),
  });
}

/** A `<File>` write whose child leaves a marker on disk if it ever runs. */
function writeDocument(dir: string): string {
  return [
    '<File path="out.txt">',
    "```sh exec",
    `touch ${join(dir, "child-ran.txt")}`,
    "```",
    "</File>",
    "",
    "```sh exec",
    `touch ${join(dir, "sibling-ran.txt")}`,
    "```",
  ].join("\n");
}

describe("Tier FF — Files infrastructure failure", () => {
  beforeAll(() => useTempFileCompiler());

  // FF1: no provider at all. The check a write performs before its children is
  // the first Files call the document makes, so the failure lands before the
  // children — and nothing after the component runs either.
  it("FF1: an absent provider fails the execution before children or siblings", function* () {
    const dir = yield* useFixture();
    const touched: string[] = [];

    const outcome = yield* run(dir, writeDocument(dir), function* () {
      yield* API.Fs.around({
        *writeTextFile([path, content], next) {
          touched.push(path);
          return yield* next(path, content);
        },
        *rename([from, to], next) {
          touched.push(from);
          return yield* next(from, to);
        },
      });
    });

    expect(outcome.ok).toBe(false);
    expect(parseFilesFatal(fatalCause(outcome.error))).toEqual({
      type: "executablemd.runtime.files-fatal/v1",
      kind: "provider-unavailable",
    });
    // Nothing was written into the document, and nothing ran on either side.
    expect(outcome.output).not.toContain("ERROR");
    expect(outcome.output).not.toContain("Files provider");
    expect(yield* exists(join(dir, "child-ran.txt"))).toBe(false);
    expect(yield* exists(join(dir, "sibling-ran.txt"))).toBe(false);
    // And the low-level host Api was never reached: absence does not fall back.
    expect(touched).toEqual([]);
  });

  // FF2: the same for every other form. Each stops at its first Files call.
  it("FF2: read, delete, Glob and TempDir all stop at their first provider call", function* () {
    const dir = yield* useFixture();

    for (const source of [
      '<File path="notes.md" />\n\nAFTER',
      // Deletion has no preliminary check to fail at, so its first and only
      // provider call is the one that lands here.
      '<File.Delete path="notes.md" />\n\nAFTER',
      '<Glob include={["**/*"]} as="found" />\n\nAFTER',
      "<TempDir>INSIDE</TempDir>\n\nAFTER",
      // The self-closing form acquires through `retain()`, which owns the
      // resource at the invocation site — a different path to the same call,
      // and one whose wrapper could otherwise launder the failure into an
      // ordinary one.
      '<TempDir as="workspace" />\n\nAFTER',
    ]) {
      const outcome = yield* run(dir, source);
      expect(outcome.ok).toBe(false);
      expect(parseFilesFatal(fatalCause(outcome.error))?.kind).toBe("provider-unavailable");
      expect(outcome.output).not.toContain("AFTER");
      expect(outcome.output).not.toContain("INSIDE");
    }
  });

  // FF3: a provider that exists but refuses one operation. A logical filesystem
  // owned by a transaction has no temporary directories to give, and inventing
  // one would be worse than refusing: the document would run inside somewhere
  // the run does not own.
  it("FF3: a refused operation is fatal, with its own fixed diagnostic", function* () {
    const dir = yield* useFixture();

    const outcome = yield* run(dir, "<TempDir>INSIDE</TempDir>\n\nAFTER", function* () {
      yield* useHostFiles();
      yield* useFiles({
        // deno-lint-ignore require-yield
        *temporaryDirectory(): Operation<Result<string>> {
          throw new FilesOperationDeniedError("temporary-directory");
        },
      });
    });

    expect(outcome.ok).toBe(false);
    expect(parseFilesFatal(fatalCause(outcome.error))).toEqual({
      type: "executablemd.runtime.files-fatal/v1",
      kind: "operation-denied",
      operation: "temporary-directory",
    });
    expect(String(outcome.error)).toContain("Files provider does not support temporary-directory");
    expect(outcome.output).not.toContain("INSIDE");
    expect(outcome.output).not.toContain("AFTER");
  });

  // FF4: the ordering the whole two-stage write exists for. A check that fails
  // means the children never expand and no second provider call is made — the
  // provider-level statement of FL18b and FL18c.
  it("FF4: a refused check expands no children and makes no later provider call", function* () {
    const dir = yield* useFixture();
    const calls: string[] = [];

    const outcome = yield* run(dir, writeDocument(dir), function* () {
      yield* useFiles({
        // deno-lint-ignore require-yield
        *checkFilePath(): Operation<Result<void>> {
          calls.push("checkFilePath");
          return Err(
            new FilesError(
              Object.freeze({
                type: FILES_ERROR,
                operation: "check-file-path",
                phase: "lexical",
                reason: "lexical-escape",
              }),
            ),
          );
        },
        // deno-lint-ignore require-yield
        *writeTextFile(): Operation<Result<FileWriteSuccess>> {
          calls.push("writeTextFile");
          throw new Error("the write must never be reached");
        },
      });
    });

    expect(calls).toEqual(["checkFilePath"]);
    // An ordinary refusal, so the document reads it and carries on.
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain("resolves outside the working directory");
    expect(yield* exists(join(dir, "child-ran.txt"))).toBe(false);
    expect(yield* exists(join(dir, "sibling-ran.txt"))).toBe(true);
  });

  // FF5: a write outcome nobody can read. Every sentence a component could
  // print makes a claim about whether the file was replaced, so a provider that
  // cannot describe what it did is treated as one that may not have done it.
  it("FF5: malformed write data and a malformed success are both fatal", function* () {
    const dir = yield* useFixture();

    const malformed: Array<() => Operation<Result<FileWriteSuccess>>> = [
      // A phase and a target that contradict each other.
      // deno-lint-ignore require-yield
      function* () {
        return Err(
          new FilesError(
            Object.freeze({
              type: FILES_ERROR,
              operation: "write",
              phase: "temporary",
              reason: "no-space",
              target: "committed",
            }),
          ),
        );
      },
      // A reason outside the vocabulary.
      // deno-lint-ignore require-yield
      function* () {
        return Err(
          new FilesError(
            fromOutside({
              type: FILES_ERROR,
              operation: "write",
              phase: "commit",
              reason: "the disk caught fire",
              target: "commit-unknown",
            }),
          ),
        );
      },
      // A success that does not describe a publication.
      // deno-lint-ignore require-yield
      function* () {
        return Ok(fromOutside({ type: FILES_WRITE_SUCCESS, publication: "made-up" }));
      },
    ];

    for (const writeTextFile of malformed) {
      const outcome = yield* run(dir, '<File path="out.txt">content</File>\n\nAFTER', function* () {
        yield* useHostFiles();
        yield* useFiles({ writeTextFile });
      });

      expect(outcome.ok).toBe(false);
      expect(parseFilesFatal(fatalCause(outcome.error))).toEqual({
        type: "executablemd.runtime.files-fatal/v1",
        kind: "invariant",
        category: "protocol",
      });
      expect(String(outcome.error)).toContain("Files provider invariant failed");
      // The category is control data, not text.
      expect(String(outcome.error)).not.toContain("protocol");
      expect(outcome.output).not.toContain("AFTER");
    }
  });

  // FF6: malformed data on a *non-write* failure is not fatal. Nothing about a
  // target is at stake, and the component already has a sentence for "the
  // operation failed", so the document reads that and carries on.
  it("FF6: a malformed non-write failure becomes the generic printed error", function* () {
    const dir = yield* useFixture();

    const outcome = yield* run(dir, '<File path="notes.md" />\n\nAFTER', function* () {
      yield* useFiles({
        // deno-lint-ignore require-yield
        *readTextFile(): Operation<Result<string>> {
          return Err(
            Object.assign(new Error("read failed at /planted/absolute/path"), {
              data: { type: FILES_ERROR, operation: "read", phase: "nowhere" },
            }),
          );
        },
      });
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain('cannot read "notes.md": the filesystem operation failed.');
    expect(outcome.output).not.toContain("/planted/absolute/path");
    expect(outcome.output).toContain("AFTER");
  });

  // FF7: a handler that throws something arbitrary. Nothing it produced can be
  // trusted, so it is replaced rather than wrapped — no cause, no message, no
  // errno text, and no host value survives.
  it("FF7: an arbitrary throw becomes a sanitized protocol invariant", function* () {
    const dir = yield* useFixture();
    const planted = Object.assign(new Error("EACCES: denied, at '/planted/secret.txt'"), {
      code: "EACCES",
    });

    let thrown: unknown;
    yield* scoped(function* () {
      yield* useFiles({
        // deno-lint-ignore require-yield
        *readTextFile(): Operation<Result<string>> {
          throw planted;
        },
      });
      try {
        yield* invokeFiles(Files.operations.readTextFile({ cwd: dir, path: "notes.md" }));
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(FilesInvariantError);
    expect(thrown).not.toBe(planted);
    expect(parseFilesFatal(thrown)?.kind).toBe("invariant");
    expect(thrown instanceof Error ? thrown.message : "").toBe("Files provider invariant failed");
    expect(thrown instanceof Error ? thrown.cause : "unset").toBeUndefined();
    expect(JSON.stringify(thrown instanceof Error ? { ...thrown } : {})).not.toContain("planted");
  });

  // FF8: an already-meaningful failure is preserved by identity instead. The
  // first failure is the one that describes what went wrong, and for a
  // durability failure the identity is what the shared fail-stop records.
  it("FF8: invokeFiles rethrows an existing durability or Files failure unchanged", function* () {
    const dir = yield* useFixture();

    const durability = new StaleInputError("the journal no longer describes this run");
    const files = new FilesInvariantError("authority");

    for (const planted of [durability, files]) {
      let thrown: unknown;
      yield* scoped(function* () {
        yield* useFiles({
          // deno-lint-ignore require-yield
          *readTextFile(): Operation<Result<string>> {
            // Nested, and wrapped, which is how each of them actually arrives.
            throw new AggregateError([new Error("noise"), planted], "teardown");
          },
        });
        try {
          yield* invokeFiles(Files.operations.readTextFile({ cwd: dir, path: "notes.md" }));
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toBe(planted);
    }
  });

  // FF9: precedence between the two, at the wrapper itself. A durability
  // failure wins wherever it sits, because a Files invariant raised while one
  // is already unwinding is the symptom rather than the cause.
  it("FF9: a durability failure beneath a Files failure is the one preserved", function* () {
    const dir = yield* useFixture();
    const durability = new StaleInputError("the journal no longer describes this run");

    let thrown: unknown;
    yield* scoped(function* () {
      yield* useFiles({
        // deno-lint-ignore require-yield
        *readTextFile(): Operation<Result<string>> {
          throw new AggregateError([new FilesInvariantError("teardown"), durability], "unwinding");
        },
      });
      try {
        yield* invokeFiles(Files.operations.readTextFile({ cwd: dir, path: "notes.md" }));
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBe(durability);
    expect(filesFatalFailure(thrown)).toBeUndefined();
  });

  // FF11: none of this parsing may throw. Every value it reads is a value a
  // provider handed back, and a provider is as free to return a Proxy that
  // refuses to be inspected as a plain record. These parsers run from
  // `fatalCause`, which every generic catch in expansion consults — so one of
  // them throwing would replace the failure being classified with a failure
  // about classifying it, exactly when the engine is deciding whether the
  // execution may continue.
  it("FF11: hostile shapes are not recognized, and never throw", function* () {
    const explode = () => {
      throw new Error("EACCES: refused, at '/planted/secret.txt'");
    };

    const hostile: Array<{ name: string; build: () => unknown }> = [
      {
        name: "a throwing data accessor",
        build: () =>
          Object.defineProperty(new Error("wrapper"), "data", { get: explode, configurable: true }),
      },
      {
        name: "data whose fields throw",
        build: () =>
          Object.assign(new Error("wrapper"), {
            data: new Proxy({}, { get: explode }),
          }),
      },
      {
        name: "data whose key enumeration throws",
        build: () =>
          Object.assign(new Error("wrapper"), {
            data: new Proxy(
              { type: FILES_FATAL, kind: "provider-unavailable" },
              { ownKeys: explode },
            ),
          }),
      },
      {
        name: "an unreadable prototype",
        build: () => new Proxy(new Error("wrapper"), { getPrototypeOf: explode }),
      },
      {
        name: "a throwing cause",
        build: () =>
          Object.defineProperty(new Error("wrapper"), "cause", {
            get: explode,
            configurable: true,
          }),
      },
      {
        name: "unreadable aggregate members",
        build: () =>
          Object.defineProperty(new AggregateError([], "wrapper"), "errors", {
            get: explode,
            configurable: true,
          }),
      },
      {
        name: "aggregate members that are not a list",
        build: () => Object.assign(new AggregateError([], "wrapper"), { errors: 7 }),
      },
      {
        name: "unreadable teardown causes",
        build: () =>
          Object.defineProperty(new InvocationTeardownError([]), "causes", {
            get: explode,
            configurable: true,
          }),
      },
    ];

    for (const shape of hostile) {
      const candidate = shape.build();
      // Every parser answers, and none of them recognizes the shape.
      expect(parseFilesFatal(candidate)).toBeUndefined();
      expect(parseFilesFailure(candidate)).toBeUndefined();
      expect(parseFileWriteFailure(candidate)).toBeUndefined();
      expect(parseFileWriteSuccess(candidate)).toBeUndefined();
      expect(fatalCause(candidate)).toBeUndefined();
      expect(filesFatalFailure(candidate)).toBeUndefined();

      // And a real failure underneath one is still found, so totality narrows
      // what a hostile wrapper hides rather than what discovery reaches.
      const planted = new FilesInvariantError("authority");
      expect(fatalCause(new AggregateError([candidate, planted], "mixed"))).toBe(planted);
    }
  });

  // FF12: a candidate that carries the right tag but breaks the rest of the
  // contract is not preserved. Recognition is a decision to let that exact
  // object travel onward by identity, so an Error carrying a raw platform
  // message and a cause chain would carry both past the boundary the reason
  // vocabulary exists to hold.
  it("FF12: a correctly tagged but unsafe failure is replaced, not preserved", function* () {
    const dir = yield* useFixture();

    const unsafe: Array<{ name: string; build: () => Error }> = [
      {
        name: "a raw message",
        build: () =>
          Object.assign(new Error("EACCES: denied, at '/planted/secret.txt'"), {
            data: Object.freeze({ type: FILES_FATAL, kind: "provider-unavailable" }),
          }),
      },
      {
        name: "a cause chain",
        build: () =>
          Object.assign(
            new Error("Files provider is not installed", {
              cause: new Error("ENOENT at /planted/secret.txt"),
            }),
            { data: Object.freeze({ type: FILES_FATAL, kind: "provider-unavailable" }) },
          ),
      },
      {
        name: "mutable data",
        build: () =>
          Object.assign(new Error("Files provider is not installed"), {
            data: { type: FILES_FATAL, kind: "provider-unavailable" },
          }),
      },
      {
        name: "an extra data field",
        build: () =>
          Object.assign(new Error("Files provider is not installed"), {
            data: Object.freeze({
              type: FILES_FATAL,
              kind: "provider-unavailable",
              path: "/planted/secret.txt",
            }),
          }),
      },
      {
        name: "a path-bearing name",
        build: () =>
          Object.assign(new Error("Files provider is not installed"), {
            name: `FilesProviderUnavailableError: /planted/secret.txt`,
            data: Object.freeze({ type: FILES_FATAL, kind: "provider-unavailable" }),
          }),
      },
      {
        name: "an extra Error-level path property",
        build: () =>
          Object.assign(new Error("Files provider is not installed"), {
            name: "FilesProviderUnavailableError",
            data: Object.freeze({ type: FILES_FATAL, kind: "provider-unavailable" }),
            path: "/planted/secret.txt",
          }),
      },
      {
        name: "an enumerable symbol payload",
        build: () => {
          const error = Object.assign(new Error("Files provider is not installed"), {
            name: "FilesProviderUnavailableError",
            data: Object.freeze({ type: FILES_FATAL, kind: "provider-unavailable" }),
          });
          // Enumerable, so it survives a spread and an `Object.assign` copy —
          // the two ways a consumer would carry a failure onward.
          Object.defineProperty(error, Symbol.for("planted"), {
            value: "/planted/secret.txt",
            enumerable: true,
          });
          return error;
        },
      },
      {
        name: "hostile key enumeration",
        build: () =>
          new Proxy(
            Object.assign(new Error("Files provider is not installed"), {
              name: "FilesProviderUnavailableError",
              data: Object.freeze({ type: FILES_FATAL, kind: "provider-unavailable" }),
            }),
            {
              ownKeys() {
                throw new Error("refused, at '/planted/secret.txt'");
              },
            },
          ),
      },
      {
        name: "hostile descriptor access",
        build: () =>
          new Proxy(
            Object.assign(new Error("Files provider is not installed"), {
              name: "FilesProviderUnavailableError",
              data: Object.freeze({ type: FILES_FATAL, kind: "provider-unavailable" }),
            }),
            {
              getOwnPropertyDescriptor() {
                throw new Error("refused, at '/planted/secret.txt'");
              },
            },
          ),
      },
    ];

    for (const shape of unsafe) {
      const candidate = shape.build();
      expect(filesFatalFailure(candidate)).toBeUndefined();

      let thrown: unknown;
      yield* scoped(function* () {
        yield* useFiles({
          // deno-lint-ignore require-yield
          *readTextFile(): Operation<Result<string>> {
            throw candidate;
          },
        });
        try {
          yield* invokeFiles(Files.operations.readTextFile({ cwd: dir, path: "notes.md" }));
        } catch (error) {
          thrown = error;
        }
      });

      // Replaced rather than preserved, and nothing it carried came along.
      expect(thrown).not.toBe(candidate);
      expect(thrown).toBeInstanceOf(FilesInvariantError);
      expect(parseFilesFatal(thrown)?.kind).toBe("invariant");
      expect(thrown instanceof Error ? thrown.message : "").toBe("Files provider invariant failed");
      expect(thrown instanceof Error ? thrown.cause : "unset").toBeUndefined();
      // Neither stringification nor enumerable output retains the planted value.
      expect(String(thrown)).not.toContain("planted");
      expect(JSON.stringify(thrown instanceof Error ? { ...thrown } : {})).not.toContain("planted");
      expect(
        JSON.stringify(
          Object.getOwnPropertySymbols(thrown instanceof Error ? thrown : {}).map(String),
        ),
      ).not.toContain("planted");
    }

    // And the real constructors, which have to stay recognizable: the contract
    // above is what they produce, not a stricter shape nothing satisfies.
    for (const genuine of [
      new FilesProviderUnavailableError(),
      new FilesOperationDeniedError("temporary-directory"),
      new FilesInvariantError("teardown"),
    ]) {
      expect(filesFatalFailure(genuine)).toBe(genuine);
    }
  });

  // FF13: a host cleanup that fails while cancellation is unwinding leaves the
  // scope as an infrastructure failure, and the engine's own discovery is what
  // has to find it — that is what makes it consumable by a coordinator deciding
  // what to fence.
  it("FF13: a cleanup failure during cancellation is discovered as fatal", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "notes.md"), "first");
    const suspended = withResolvers<void>();
    const files = hostFilesHandler();

    const write = yield* spawn(function* () {
      yield* scoped(function* () {
        yield* API.Fs.around({
          *writeTextFile([path, content], next) {
            yield* next(path, content);
            suspended.resolve();
            yield* suspend();
          },
          // deno-lint-ignore require-yield
          *remove() {
            throw Object.assign(new Error("EPERM: denied, at '/planted/secret.txt'"), {
              code: "EPERM",
            });
          },
        });
        yield* files.writeTextFile({ cwd: dir, path: "notes.md", content: "second" });
      });
    });

    yield* suspended.operation;
    let thrown: unknown;
    try {
      yield* write.halt();
    } catch (error) {
      thrown = error;
    }

    const selected = fatalCause(thrown);
    expect(parseFilesFatal(selected)).toEqual({
      type: "executablemd.runtime.files-fatal/v1",
      kind: "invariant",
      category: "teardown",
    });
    // Preserved by identity, which is what a shared fail-stop records.
    expect(filesFatalFailure(thrown)).toBe(selected);
    expect(String(selected)).not.toContain("planted");
    expect(yield* readTextFile(join(dir, "notes.md"))).toBe("first");
  });

  // FF14: the `Result` a provider returns is only conventionally a Result. The
  // TypeScript signature is a claim about the provider, not a guarantee, so a
  // component that read `ok`, `value`, or `error` first would be the thing that
  // ran the hostile accessor — outside anything that sanitizes.
  //
  // Every shape below is a live Proxy **around a real `Ok`/`Err`**, so it keeps
  // the declared type without a cast and, more importantly, its traps have never
  // run when the provider hands it back. The first thing to touch them is the
  // normalization boundary. Serializing one here instead would invoke the getter
  // inside the test and prove only the handler-throw path FF7 already covers.
  it("FF14: a hostile Result never reaches a component", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "notes.md"), "existing");

    /**
     * A Result whose named member is there and refuses to be read.
     *
     * The `has` trap matters as much as the `get` one: a payload-free success is
     * Effection's `Unit`, which has no `value` member at all, so a `get` trap
     * alone would never be consulted and the case would test nothing.
     */
    function throwing<T>(result: Result<T>, member: string): Result<T> {
      return new Proxy(result, {
        has(target, property) {
          return property === member ? true : Reflect.has(target, property);
        },
        get(target, property, receiver) {
          if (property === member) {
            throw new Error("EACCES: refused, at '/planted/secret.txt'");
          }
          return Reflect.get(target, property, receiver);
        },
      });
    }

    /** A Result whose named member is not there at all. */
    function absent<T>(result: Result<T>, member: string): Result<T> {
      return new Proxy(result, {
        has(target, property) {
          return property === member ? false : Reflect.has(target, property);
        },
        get(target, property, receiver) {
          return property === member ? undefined : Reflect.get(target, property, receiver);
        },
      });
    }

    /** A Result that will not say how it settled. */
    function undecided<T>(result: Result<T>): Result<T> {
      return new Proxy(result, {
        get(target, property, receiver) {
          return property === "ok" ? "yes" : Reflect.get(target, property, receiver);
        },
      });
    }

    const ordinary = new Error("EACCES: denied, at '/planted/secret.txt'");

    /**
     * Which settlement each shape actually bites.
     *
     * A trap on `value` is never consulted by a failure, and one on `error` is
     * never consulted by a success — so pairing every shape with every
     * settlement would demand a fatal outcome from combinations that
     * legitimately take the ordinary path, and the test would measure the wrong
     * thing.
     */
    const shapes: Array<{
      name: string;
      settlements: ReadonlyArray<"success" | "failure">;
      skip?: string;
      hostile: <T>(result: Result<T>) => Result<T>;
    }> = [
      {
        name: "a throwing ok",
        settlements: ["success", "failure"],
        hostile: (result) => throwing(result, "ok"),
      },
      {
        name: "an absent ok",
        settlements: ["success", "failure"],
        hostile: (result) => absent(result, "ok"),
      },
      { name: "a non-boolean ok", settlements: ["success", "failure"], hostile: undecided },
      {
        name: "a throwing value",
        settlements: ["success"],
        hostile: (result) => throwing(result, "value"),
      },
      {
        name: "an absent value",
        settlements: ["success"],
        // `checkFilePath` succeeds with no payload, and Effection spells that as
        // its shared `Unit` — `{ ok: true }`, with no `value` member at all.
        // Absence is the ordinary success there, which FF14c asserts positively.
        skip: "checkFilePath",
        hostile: (result) => absent(result, "value"),
      },
      {
        name: "a throwing error",
        settlements: ["failure"],
        hostile: (result) => throwing(result, "error"),
      },
      {
        name: "an absent error",
        settlements: ["failure"],
        hostile: (result) => absent(result, "error"),
      },
    ];

    const operations: Array<{
      name: string;
      source: string;
      method: string;
      ok: () => Result<unknown>;
    }> = [
      {
        name: "read",
        source: '<File path="notes.md" />\n\nAFTER',
        method: "readTextFile",
        ok: () => Ok("existing"),
      },
      {
        name: "write",
        source: '<File path="out.txt">content</File>\n\nAFTER',
        method: "writeTextFile",
        ok: () => Ok(fileWriteSuccess("host-committed")),
      },
      {
        name: "checkFilePath",
        source: '<File path="out.txt">content</File>\n\nAFTER',
        method: "checkFilePath",
        ok: () => Ok(undefined),
      },
      {
        name: "glob",
        source: '<Glob include={["**/*"]} as="found" />\n\nAFTER',
        method: "globFiles",
        ok: () => Ok(["notes.md"]),
      },
      {
        name: "tempdir",
        source: "<TempDir>INSIDE</TempDir>\n\nAFTER",
        method: "temporaryDirectory",
        ok: () => Ok(dir),
      },
    ];

    for (const operation of operations) {
      for (const shape of shapes) {
        if (shape.skip === operation.name) {
          continue;
        }
        for (const settlement of shape.settlements) {
          const settled = settlement === "success" ? operation.ok : () => Err(ordinary);
          const outcome = yield* run(dir, operation.source, function* () {
            yield* useHostFiles();
            yield* Files.around({
              // deno-lint-ignore require-yield
              *[operation.method]() {
                return shape.hostile(settled());
              },
            });
          });

          // A container that will not describe its own outcome is a provider
          // contract failure: the execution ends and later work stops.
          expect(outcome.ok).toBe(false);
          expect(invariantCategory(outcome.error)).toBe("protocol");
          expect(outcome.output).not.toContain("AFTER");
          expect(outcome.output).not.toContain("INSIDE");
          // No child of the write ever expanded, either.
          expect(yield* exists(join(dir, "out.txt"))).toBe(false);
          expect(leaked(outcome)).toBe(false);
        }
      }
    }
  });

  // FF14b: the array a search returns is provider-controlled all the way down —
  // its length and every element. The copy walks it by index through the same
  // total reader, so a trap that refuses becomes the same fixed invariant rather
  // than an exception escaping into expansion.
  it("FF14b: a hostile search array becomes a sanitized invariant", function* () {
    const dir = yield* useFixture();
    const explode = () => {
      throw new Error("EACCES: refused, at '/planted/secret.txt'");
    };

    const arrays: Array<{ name: string; build: () => string[] }> = [
      {
        name: "a throwing element",
        build: () =>
          new Proxy(["notes.md"], {
            get(target, property, receiver) {
              return property === "0" ? explode() : Reflect.get(target, property, receiver);
            },
          }),
      },
      {
        name: "a throwing length",
        build: () =>
          new Proxy(["notes.md"], {
            get(target, property, receiver) {
              return property === "length" ? explode() : Reflect.get(target, property, receiver);
            },
          }),
      },
      {
        name: "a refused element",
        build: () =>
          new Proxy(["notes.md"], {
            has(target, property) {
              return property === "0" ? false : Reflect.has(target, property);
            },
          }),
      },
      {
        name: "an element that is not a string",
        build: () =>
          new Proxy(["notes.md"], {
            get(target, property, receiver) {
              return property === "0" ? 7 : Reflect.get(target, property, receiver);
            },
          }),
      },
    ];

    for (const array of arrays) {
      const outcome = yield* run(
        dir,
        '<Glob include={["**/*"]} as="found" />\n\nAFTER',
        function* () {
          yield* useHostFiles();
          yield* Files.around({
            // deno-lint-ignore require-yield
            *globFiles() {
              return Ok(array.build());
            },
          });
        },
      );

      expect(outcome.ok).toBe(false);
      expect(invariantCategory(outcome.error)).toBe("protocol");
      expect(outcome.output).not.toContain("AFTER");
      expect(leaked(outcome)).toBe(false);
    }

    // A revoked Proxy is the shape that escapes everything else: recognizing it
    // as an array is itself an operation on provider-controlled data, and
    // `Array.isArray` throws on one. It is built valid, wrapped in `Ok` without
    // being inspected, and revoked before the provider returns — so the first
    // thing to touch it is the boundary, and the brand check is what it touches
    // it with.
    const revoked = yield* run(
      dir,
      '<Glob include={["**/*"]} as="found" />\n\nAFTER',
      function* () {
        yield* useHostFiles();
        yield* Files.around({
          // deno-lint-ignore require-yield
          *globFiles() {
            const { proxy, revoke } = Proxy.revocable(["notes.md"], {});
            const result = Ok(proxy);
            revoke();
            return result;
          },
        });
      },
    );

    expect(revoked.ok).toBe(false);
    expect(invariantCategory(revoked.error)).toBe("protocol");
    expect(revoked.output).not.toContain("AFTER");
    // The platform's own failure is replaced, not carried.
    const selected = fatalCause(revoked.error);
    expect(selected).not.toBeInstanceOf(TypeError);
    expect(selected instanceof Error ? selected.cause : "unset").toBeUndefined();
    const shown = [revoked.output, String(selected), String(revoked.error)].join(" ");
    expect(shown).not.toContain("IsArray");
    expect(shown).not.toContain("revoked");

    // The iterator is never consulted, because the walk is by index. A search
    // whose only hostile trap is `Symbol.iterator` therefore copies cleanly —
    // which is the derivation this kills: a `for…of` walk would have run it.
    const untouched = yield* run(
      dir,
      '<Glob include={["**/*"]} as="found" />\n\nfound: {found}',
      function* () {
        yield* useHostFiles();
        yield* Files.around({
          // deno-lint-ignore require-yield
          *globFiles() {
            return Ok(
              new Proxy(["b.md", "a.md"], {
                get(target, property, receiver) {
                  return property === Symbol.iterator
                    ? explode()
                    : Reflect.get(target, property, receiver);
                },
              }),
            );
          },
        });
      },
    );
    expect(untouched.ok).toBe(true);
    expect(untouched.output).toContain("found: b.md,a.md");

    // And what comes back is the document's own array: mutating the provider's
    // afterwards does not reach the bound value.
    const source = ["b.md", "a.md"];
    const copied = yield* run(
      dir,
      '<Glob include={["**/*"]} as="found" />\n\nfound: {found}',
      function* () {
        yield* useHostFiles();
        yield* Files.around({
          // deno-lint-ignore require-yield
          *globFiles() {
            return Ok(source);
          },
        });
      },
    );
    source.push("planted.md");
    expect(copied.ok).toBe(true);
    expect(copied.output).toContain("found: b.md,a.md");
    expect(copied.output).not.toContain("planted.md");
  });

  // FF14c: a legitimate payload-free success is still a success. Effection
  // spells one as its shared `Unit` — `{ ok: true }`, with no `value` member —
  // so requiring the member to be present would reject the very thing the host
  // adapter returns from `checkFilePath`.
  it("FF14c: a payload-free success is accepted, however it is spelled", function* () {
    const dir = yield* useFixture();

    for (const admitted of [() => Ok(undefined), () => Ok(void 0)]) {
      const outcome = yield* run(dir, '<File path="out.txt">content</File>\n\nAFTER', function* () {
        yield* useHostFiles();
        yield* Files.around({
          // deno-lint-ignore require-yield
          *checkFilePath() {
            return admitted();
          },
        });
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.output).toContain("AFTER");
      expect(yield* readTextFile(join(dir, "out.txt"))).toBe("content");
    }

    // A payload-free success that carries a payload anyway is not one. The
    // payload arrives through a Proxy, so the declared type survives without a
    // cast and the boundary is what first observes it.
    const carrying = yield* run(dir, '<File path="out.txt">content</File>\n\nAFTER', function* () {
      yield* useHostFiles();
      yield* Files.around({
        // deno-lint-ignore require-yield
        *checkFilePath() {
          return new Proxy(Ok(undefined), {
            has(target, property) {
              return property === "value" ? true : Reflect.has(target, property);
            },
            get(target, property, receiver) {
              return property === "value"
                ? "/planted/secret.txt"
                : Reflect.get(target, property, receiver);
            },
          });
        },
      });
    });
    expect(carrying.ok).toBe(false);
    expect(invariantCategory(carrying.error)).toBe("protocol");
    expect(leaked(carrying)).toBe(false);
  });

  // FF15: the one hostile shape that is *not* fatal. A non-write failure whose
  // data does not validate has no claim about a target in it, and the vocabulary
  // already has a sentence for an operation that failed for an unrecognized
  // reason — so the document reads that and carries on. What it must not read is
  // anything the provider put there.
  it("FF15: malformed non-write failure data alone stays printable", function* () {
    const dir = yield* useFixture();

    const cases: Array<{ source: string; method: string; expected: string }> = [
      {
        source: '<File path="notes.md" />\n\nAFTER',
        method: "readTextFile",
        expected: 'cannot read "notes.md": the filesystem operation failed.',
      },
      {
        source: '<Glob include={["**/*"]} as="found" />\n\nAFTER',
        method: "globFiles",
        expected: "cannot search the working directory: the filesystem operation failed.",
      },
      {
        source: "<TempDir>INSIDE</TempDir>\n\nAFTER",
        method: "temporaryDirectory",
        expected: "cannot create a temporary directory: the filesystem operation failed.",
      },
    ];

    for (const shape of cases) {
      const outcome = yield* run(dir, shape.source, function* () {
        yield* useHostFiles();
        yield* Files.around({
          // deno-lint-ignore require-yield
          *[shape.method]() {
            return Err(
              Object.assign(new Error("EACCES: denied, at '/planted/secret.txt'"), {
                data: { type: FILES_ERROR, operation: "read", phase: "nowhere" },
                path: "/planted/secret.txt",
              }),
            );
          },
        });
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.output).toContain(shape.expected);
      expect(outcome.output).not.toContain("/planted/secret.txt");
      expect(outcome.output).not.toContain("EACCES");
      // The document carried on, which is the whole difference from FF14.
      expect(outcome.output).toContain("AFTER");
    }
  });

  // FF10: an ordinary failure is still an ordinary failure. The fatal rule is
  // for a provider that is missing or wrong, not for everything that goes
  // wrong beneath one.
  it("FF10: an ordinary provider failure stays a printed error", function* () {
    const dir = yield* useFixture();

    const outcome = yield* run(dir, '<File path="absent.md" />\n\nAFTER', function* () {
      yield* useHostFiles();
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain('cannot read "absent.md": no such file.');
    expect(outcome.output).toContain("AFTER");
  });
});
