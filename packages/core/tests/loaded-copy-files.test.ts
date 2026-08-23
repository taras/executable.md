/**
 * Tier LC — a Files failure built by a genuinely separate copy of the runtime.
 *
 * `FA27` builds a correctly tagged object by hand, which proves the parser
 * accepts the shape. It does not prove the case the shape exists for: two
 * copies of `@executablemd/runtime` evaluated in one process, where a
 * repository component reached its own dependency beside the engine's. In that
 * world `instanceof` answers false, every class identity differs, and the tag
 * is the only thing the two copies share.
 *
 * So this bundles `packages/runtime/files.ts` the way an installed dependency
 * would arrive, imports the bundle as its own module, constructs a failure with
 * *that* copy's constructor, and asks the engine's own discovery about it.
 *
 * Bundling is also the second half of a claim the smoke job makes: this module
 * has to stay reachable without the runtime's host Apis, one of which carries a
 * native addon no bundler can inline. A regression there fails here as a
 * bundling error rather than as a mysterious CI break.
 *
 * Deno-only: `deno bundle` is Deno's.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Err, resource, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { exec } from "@effectionx/process";
import { rm } from "@effectionx/fs";
import {
  FILES_ERROR,
  Files,
  FilesError,
  FilesInvariantError,
  FilesProviderUnavailableError,
  parseFilesFailure,
  parseFilesFatal,
} from "@executablemd/runtime";
import { InvocationTeardownError } from "../src/invocation.ts";
import { deleteFile } from "../src/files.ts";
import { DocumentationError, fatalCause, filesFatalFailure } from "../src/errors.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const FILES_MODULE = fileURLToPath(new URL("../../runtime/files.ts", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));

/** What a separately loaded copy of the module exposes to this test. */
interface LoadedCopy {
  FilesProviderUnavailableError: new () => Error;
  FilesInvariantError: new (category: string) => Error;
  parseFilesFatal: (error: unknown) => unknown;
  filesFailure: (input: { operation: string; phase: string; reason: string }) => Error;
}

function isLoadedCopy(value: unknown): value is LoadedCopy {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const module: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return (
    typeof module.FilesProviderUnavailableError === "function" &&
    typeof module.FilesInvariantError === "function" &&
    typeof module.parseFilesFatal === "function" &&
    typeof module.filesFailure === "function"
  );
}

/**
 * `packages/runtime/files.ts`, bundled and evaluated as its own module.
 *
 * The bundle is what makes the copy separate: importing the source path again
 * would resolve to the module this test already holds, and share every class
 * with it.
 */
function useSeparateCopy(): Operation<LoadedCopy> {
  return resource(function* (provide) {
    const directory = yield* until(mkdtemp(join(tmpdir(), "lc-files-")));
    yield* ensure(() => rm(directory, { recursive: true, force: true }));
    const bundle = join(directory, "files.js");

    // `process.execPath` under Deno is the deno binary, so the driver stays
    // typed against node:process rather than a runtime global.
    const built = yield* exec(process.execPath, {
      arguments: [
        "bundle",
        "--frozen",
        "--node-modules-dir=none",
        FILES_MODULE,
        "--output",
        bundle,
      ],
      cwd: REPOSITORY,
    }).join();
    if (built.code !== 0) {
      throw new Error(
        `could not bundle the runtime's Files module:\n${built.stdout}${built.stderr}`,
      );
    }

    const loaded: unknown = yield* until(import(`file://${bundle}`));
    if (!isLoadedCopy(loaded)) {
      throw new Error("the bundled copy does not expose the Files failure surface");
    }
    yield* provide(loaded);
  });
}

describe("Tier LC — a separately loaded runtime copy", () => {
  it("LC1: a failure built by another copy is discovered as fatal, by identity", function* () {
    const copy = yield* useSeparateCopy();
    const foreign = new copy.FilesProviderUnavailableError();

    // The premise, stated as a fact about this object rather than assumed:
    // nothing about it shares a class with the copy core imported.
    expect(foreign instanceof FilesProviderUnavailableError).toBe(false);
    expect(foreign.constructor).not.toBe(FilesProviderUnavailableError);

    // Recognized anyway, and returned as the object that was thrown.
    expect(filesFatalFailure(foreign)).toBe(foreign);
    expect(parseFilesFatal(foreign)).toEqual({
      type: "executablemd.runtime.files-fatal/v1",
      kind: "provider-unavailable",
    });

    // Through every wrapper the engine builds, and ahead of a documentation
    // failure sitting beside it.
    const documentation = new DocumentationError({ type: "error", message: "wrong" }, "throw");
    expect(fatalCause(new InvocationTeardownError([documentation, foreign]))).toBe(foreign);
    expect(fatalCause(new AggregateError([foreign, documentation], "mixed"))).toBe(foreign);
    expect(fatalCause(new Error("wrapper", { cause: foreign }))).toBe(foreign);
  });

  it("LC2: recognition crosses in both directions", function* () {
    const copy = yield* useSeparateCopy();

    // This copy's failure, recognized by the other one's parser.
    expect(copy.parseFilesFatal(new FilesInvariantError("savepoint"))).toEqual({
      type: "executablemd.runtime.files-fatal/v1",
      kind: "invariant",
      category: "savepoint",
    });

    // And the other's invariant, recognized here, category and all.
    expect(parseFilesFatal(new copy.FilesInvariantError("authority"))).toEqual({
      type: "executablemd.runtime.files-fatal/v1",
      kind: "invariant",
      category: "authority",
    });
  });

  // LC3: a deletion's whole outcome vocabulary, across the boundary. The
  // success carries nothing, so what has to compose is the *container* — and
  // the one shape a hostile or broken provider could use to smuggle a value
  // through a payload-free operation is a success that carries one.
  it("LC3: a delete outcome from another copy composes, and a malformed one is fatal", function* () {
    const copy = yield* useSeparateCopy();

    const foreign = copy.filesFailure({
      operation: "delete",
      phase: "target",
      reason: "directory",
    });
    // The premise: nothing about it shares a class with the copy core imported.
    expect(foreign instanceof FilesError).toBe(false);

    const refused = yield* answered(() => Err(foreign));
    expect(refused.ok).toBe(false);
    expect(parseFilesFailure(refused.ok ? undefined : refused.error)).toEqual({
      type: FILES_ERROR,
      operation: "delete",
      phase: "target",
      reason: "directory",
    });

    // The other copy's payload-free success, which is `{ ok: true }` with no
    // `value` member at all.
    const unit = yield* answered(() => ({ ok: true }) as Result<void>);
    expect(unit).toEqual({ ok: true, value: undefined });

    // And the two containers that describe nothing a caller may act on.
    for (const malformed of [
      () => ({ ok: true, value: "receipt-PLANTED" }) as unknown as Result<void>,
      () => ({ ok: false }) as unknown as Result<void>,
    ]) {
      let thrown: unknown;
      try {
        yield* answered(malformed);
      } catch (error) {
        thrown = error;
      }
      expect(parseFilesFatal(thrown)).toEqual({
        type: "executablemd.runtime.files-fatal/v1",
        kind: "invariant",
        category: "protocol",
      });
      expect(String(thrown)).not.toContain("PLANTED");
      expect(thrown instanceof Error ? thrown.cause : "unset").toBeUndefined();
    }
  });
});

/** One deletion, answered by a provider that returns exactly `outcome`. */
function answered(outcome: () => Result<void>): Operation<Result<void>> {
  return scoped(function* () {
    yield* Files.around({
      // deno-lint-ignore require-yield
      *deleteFile(): Operation<Result<void>> {
        return outcome();
      },
    });
    return yield* deleteFile({ cwd: "/workspace", path: "obsolete.md" });
  });
}
