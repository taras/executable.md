/**
 * A recording `API.Files` provider, installed the way a host installs one.
 *
 * It used to be the opposite: a stand-in for the private operations a host
 * handed an evaluation profile, deliberately never installed, so a read that
 * appeared in its log had proved the read went through the captured operation
 * because there was no other way to reach the object. That premise is gone with
 * the transport it described. An admitted fragment now runs the ordinary
 * component, which resolves `API.Files` where it runs — so what a log entry
 * here proves is that a generated operation crossed the *same* provider an
 * authored one does, which is the property that replaced it.
 *
 * It answers the real provider contract, not a convenient subset: valid
 * `FilesError` data for a refusal and a validated `FileWriteSuccess` for a
 * write. A fixture that answered `Err(new Error(...))` would be testing against
 * a provider the engine is entitled to call broken.
 *
 * It asks `Permissions` too, as the first thing each operation does. A provider
 * that performs the operation authorizes the operation, and this one stands in
 * for one that does — a fixture that skipped the question would make every
 * policy row that runs against it pass whatever the policy said.
 */

import type { Operation, Result } from "effection";
import { Err, Ok } from "effection";

import {
  API,
  FilesOperationDeniedError,
  filesFailure,
  fileWriteFailure,
  fileWriteSuccess,
  Permissions,
} from "@executablemd/runtime";
import type {
  FilePathInput,
  FilesHandler,
  FileWriteInput,
  FileWriteSuccess,
  GlobInput,
} from "@executablemd/runtime";

/** The logical directory a fixture run resolves its relative paths against. */
export const FIXTURE_ROOT = "/workspace";

/** Every operation one run performed, in order, as `verb path`. */
export interface RecordedFiles extends FilesHandler {
  readonly performed: string[];
  readonly entries: Map<string, string>;
}

/**
 * One recorder, seeded with whatever files a case says already exist.
 *
 * Keyed by the authored path rather than the resolved one, so a row asserting
 * on a recorded path is asserting on what the element asked for rather than on
 * wherever the test happened to run.
 */
export function recordedFiles(
  seed: Record<string, string> = {},
  options: {
    readonly hold?: (path: string) => Operation<void>;
    /** What a search answers with, in place of matching the seeded entries. */
    readonly found?: (input: GlobInput) => Result<string[]>;
  } = {},
): RecordedFiles {
  const entries = new Map(Object.entries(seed));
  const performed: string[] = [];
  return {
    performed,
    entries,
    // deno-lint-ignore require-yield
    *checkFilePath(input: FilePathInput): Operation<Result<void>> {
      // Pure, and deliberately unauthorized: it reaches nothing.
      performed.push(`check ${input.path}`);
      return input.path.startsWith("..")
        ? Err(
            filesFailure({
              operation: "check-file-path",
              phase: "lexical",
              reason: "lexical-escape",
            }),
          )
        : Ok(undefined);
    },
    *readTextFile(input: FilePathInput): Operation<Result<string>> {
      if (!(yield* Permissions.operations.files("read"))) {
        return Err(
          filesFailure({ operation: "read", phase: "resolution", reason: "permission-denied" }),
        );
      }
      performed.push(`read ${input.path}`);
      // A row about cancelling work already inside a fragment holds here: the
      // operation has begun and has not answered, which is the only state
      // where an admitted effect is in flight.
      if (options.hold !== undefined) {
        yield* options.hold(input.path);
      }
      const held = entries.get(input.path);
      return held === undefined
        ? Err(filesFailure({ operation: "read", phase: "target", reason: "missing" }))
        : Ok(held);
    },
    *globFiles(input: GlobInput): Operation<Result<string[]>> {
      if (!(yield* Permissions.operations.files("read"))) {
        return Err(
          filesFailure({ operation: "glob", phase: "target", reason: "permission-denied" }),
        );
      }
      performed.push(`glob ${input.include.join(",")}`);
      if (options.found !== undefined) {
        return options.found(input);
      }
      // The seeded entries a pattern selects, held to the same answer an
      // ordinary provider gives: sorted, deduplicated and relative. Matching is
      // deliberately literal — a case states the paths it means — because what
      // a row here proves is that the search crossed this provider, not that a
      // dialect was reimplemented.
      const matched = [...entries.keys()].filter(
        (path) => input.include.includes(path) && !input.exclude.includes(path),
      );
      return Ok([...new Set(matched)].sort());
    },
    *writeTextFile(input: FileWriteInput): Operation<Result<FileWriteSuccess>> {
      if (!(yield* Permissions.operations.files("write"))) {
        return Err(fileWriteFailure({ phase: "resolution", reason: "permission-denied" }));
      }
      performed.push(`write ${input.path}`);
      if (input.path.startsWith("..")) {
        return Err(fileWriteFailure({ phase: "lexical", reason: "lexical-escape" }));
      }
      entries.set(input.path, input.content);
      return Ok(fileWriteSuccess("host-committed"));
    },
    *deleteFile(input: FilePathInput): Operation<Result<void>> {
      if (!(yield* Permissions.operations.files("write"))) {
        return Err(
          filesFailure({ operation: "delete", phase: "resolution", reason: "permission-denied" }),
        );
      }
      performed.push(`delete ${input.path}`);
      entries.delete(input.path);
      return Ok(undefined);
    },
    *ensureDirectory(input: FilePathInput): Operation<Result<void>> {
      if (!(yield* Permissions.operations.files("write"))) {
        return Err(
          filesFailure({
            operation: "ensure-directory",
            phase: "resolution",
            reason: "permission-denied",
          }),
        );
      }
      performed.push(`ensure ${input.path}`);
      return Ok(undefined);
    },
    /**
     * Refused, and refused the way a provider refuses an operation it does not
     * offer.
     *
     * The recorder has no temporary directories to hand out, and answering one
     * with a host path would put a real directory behind a fixture nothing
     * cleans up. A provider is entitled to deny this one operation, and the
     * documented denial is how it says so.
     */
    // deno-lint-ignore require-yield
    *temporaryDirectory(): Operation<Result<string>> {
      throw new FilesOperationDeniedError("temporary-directory");
    },
  };
}

/**
 * Install one recorder as this execution's document filesystem.
 *
 * Beneath ordinary middleware, like every host provider, and beside a
 * contextual working directory of its own: the authored paths a case writes are
 * relative, and resolving them against the directory the test process happens
 * to be in would make a recorded path depend on where the suite ran.
 */
export function* useRecordedFiles(files: RecordedFiles): Operation<void> {
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd(): Operation<string> {
        return FIXTURE_ROOT;
      },
    },
    { at: "min" },
  );
  yield* API.Files.around(
    {
      *checkFilePath([input]) {
        return yield* files.checkFilePath(input);
      },
      *readTextFile([input]) {
        return yield* files.readTextFile(input);
      },
      *writeTextFile([input]) {
        return yield* files.writeTextFile(input);
      },
      *deleteFile([input]) {
        return yield* files.deleteFile(input);
      },
      *ensureDirectory([input]) {
        return yield* files.ensureDirectory(input);
      },
      *globFiles([input]) {
        return yield* files.globFiles(input);
      },
      *temporaryDirectory() {
        return yield* files.temporaryDirectory();
      },
    },
    { at: "min" },
  );
}
