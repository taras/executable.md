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
import { ensure, Err, Ok, resource, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { exists, rm, writeTextFile } from "@effectionx/fs";
import {
  API,
  FILES_ERROR,
  FILES_WRITE_SUCCESS,
  Files,
  FilesError,
  FilesInvariantError,
  FilesOperationDeniedError,
  parseFilesFatal,
  useHostFiles,
} from "@executablemd/runtime";
import type { FilePathInput, FileWriteInput, FileWriteSuccess } from "@executablemd/runtime";
import { InMemoryStream, StaleInputError } from "@executablemd/durable-streams";
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
        componentDirs: [dir],
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
  it("FF2: read, Glob and TempDir all stop at their first provider call", function* () {
    const dir = yield* useFixture();

    for (const source of [
      '<File path="notes.md" />\n\nAFTER',
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
