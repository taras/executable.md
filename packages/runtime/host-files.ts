/**
 * The host `API.Files` provider — document filesystem access in the caller's
 * own filesystem.
 *
 * This is what `xmd run` installs. A document's relative path is resolved
 * against the contextual working directory and used as an ordinary host path,
 * so a document can hand a file to a tool the caller already has. Everything
 * below is built on the low-level `API.Fs`, which is deliberate: a host that
 * already wraps `API.Fs` to observe or sandbox the engine's own file access
 * keeps seeing a document's access on the same terms.
 *
 * ## What containment means here
 *
 * Access is confined to the contextual directory, judged against the filesystem
 * as this adapter observes it. An empty path, an absolute path, and a lexical
 * `..` escape are refused without touching the filesystem at all; a symlink
 * leading out is refused once resolution can see it.
 *
 * That is sound **while the host pathname namespace is stable**, and every
 * guarantee here is stated on that basis. It is not a sandbox. Another process
 * can replace a directory, symlink, junction, or reparse point between the
 * moment this adapter observes a path and the moment it uses one, and nothing
 * available on the shipped runtimes closes that window without a native
 * dependency. What is contained is the document's own children — the case a
 * document controls — because resolution is deferred until after they run.
 *
 * ## Writes
 *
 * A write goes through a sibling temporary file and a rename. The rename is the
 * commit point: everything before it can fail or be cancelled with the previous
 * file untouched, and once it begins the target holds the complete old file or
 * the complete new one, never a partial write. It is a commit rather than a
 * transaction — a rename that returned is not undone by a later cancellation.
 * The temporary also closes the one hole resolution cannot: a dangling symlink
 * has nothing to resolve, and `rename` replaces the link rather than following
 * it wherever it points.
 *
 * ## What crosses the boundary
 *
 * Nothing from a caught platform error. An errno code *selects* a
 * `FilesReason`, and the reason is all the consumer receives — no message, no
 * code, no resolved path, no temporary path, and no symlink target. A platform
 * error names the path it failed on, and for a write that path can be a
 * temporary the document never chose.
 */

import { ensure, Err, Ok, resource, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FsApi, rm } from "@effectionx/fs";
import { API } from "./apis.ts";
import { fileWriteFailure, fileWriteSuccess, filesFailure, FilesInvariantError } from "./files.ts";
import type {
  FilePathInput,
  FilesHandler,
  FilesOperation,
  FilesPhase,
  FilesReason,
  FileWriteInput,
  FileWritePhase,
  FileWriteSuccess,
  GlobInput,
} from "./files.ts";

/**
 * A private step a host operation is about to take.
 *
 * Test-only. Production entrypoints install the adapter without one, so this is
 * neither global state nor a capability: an observer can watch, and the point of
 * watching is to replace part of the tree between an observation and the call
 * that follows it, which is how the stable-namespace limitation is made
 * observable rather than merely stated.
 */
export interface HostFilesEvent {
  readonly operation: "read" | "write" | "glob";
  readonly phase: "target" | "access" | "parents" | "temporary" | "commit" | "cleanup" | "read-dir";
}

/** Synchronous, so nothing can run between the observation and the call it precedes. */
export type HostFilesObserver = (event: HostFilesEvent) => void;

export interface HostFilesOptions {
  readonly observe?: HostFilesObserver;
  /**
   * The directory temporary directories are minted under, defaulting to the
   * host's temporary root. The host's root is shared by every process on the
   * machine, so a caller that censuses the minted namespace — a lifetime test
   * proving nothing survives a cancellation — points this at a directory it
   * owns, where the only entries are the ones this provider created.
   */
  readonly temporaryRoot?: string;
}

/**
 * The errno codes this adapter recognizes, and the reason each selects.
 *
 * A `Map` rather than an object literal, because a lookup on one answers for
 * inherited keys — `codes["toString"]` would hand back a function — and the code
 * is chosen by whatever implements `API.Fs`.
 */
const REASON_BY_CODE: ReadonlyMap<string, FilesReason> = new Map<string, FilesReason>([
  ["ENOENT", "missing"],
  ["ENOTDIR", "not-directory"],
  ["EISDIR", "directory"],
  ["ENOTEMPTY", "directory-not-empty"],
  ["EACCES", "permission-denied"],
  ["EPERM", "permission-denied"],
  ["EROFS", "read-only"],
  ["ELOOP", "too-many-symlinks"],
  ["ENAMETOOLONG", "path-too-long"],
  ["ENOSPC", "no-space"],
  ["EDQUOT", "quota-exhausted"],
  ["EXDEV", "cross-device"],
  ["EBUSY", "busy"],
  ["EMFILE", "too-many-open-files"],
]);

/**
 * The `errno` string a failed call carries, when it carries one.
 *
 * Read rather than asserted: `catch` gives back `unknown`, and what arrives
 * there is only conventionally an `ErrnoException`.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

/** The reason a caught platform error selects, defaulting to the generic one. */
function reasonOf(error: unknown): FilesReason {
  const code = errorCode(error);
  if (code === undefined) {
    return "operation-failed";
  }
  return REASON_BY_CODE.get(code) ?? "operation-failed";
}

/**
 * Why an authored path is inadmissible, decided from arithmetic alone.
 *
 * `resolve` normalizes `..` lexically, so this holds against the contextual
 * directory as given — canonicalizing it belongs to resolution and would only
 * move the same comparison onto a different pair of strings.
 */
function inadmissible(input: FilePathInput): FilesReason | undefined {
  if (input.path.length === 0) {
    return "empty-path";
  }
  if (isAbsolute(input.path)) {
    return "absolute-path";
  }
  if (!within(input.cwd, resolve(input.cwd, input.path))) {
    return "lexical-escape";
  }
  return undefined;
}

/**
 * Whether `path` names `base` or something inside it.
 *
 * The directory itself is contained — `.` is not an escape. That it is a
 * directory is a question about the target, which the target check answers.
 *
 * Only a complete `..` segment leaves. A name that merely starts with two dots
 * — `..notes.md` — is an ordinary file inside, and a prefix test would refuse it.
 */
function within(base: string, path: string): boolean {
  const rel = relative(base, path);
  if (isAbsolute(rel)) {
    return false;
  }
  if (rel.length === 0) {
    return true;
  }
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * `path` with every symlink in its existing prefix resolved.
 *
 * `realpath` needs the whole path to exist, and a write commonly names one that
 * does not yet, so the walk gives up one trailing segment at a time until
 * something answers and then puts the segments back. The working directory
 * always exists, so the loop terminates there at the latest.
 */
function* resolveExisting(path: string): Operation<string> {
  const trailing: string[] = [];
  let current = path;

  while (true) {
    const resolved = yield* API.Fs.operations.realpath(current);
    if (resolved !== undefined) {
      return trailing.length === 0 ? resolved : join(resolved, ...trailing);
    }
    const parent = dirname(current);
    if (parent === current) {
      return join(current, ...trailing);
    }
    trailing.unshift(basename(current));
    current = parent;
  }
}

/** What resolution produced, or why it could not. */
type Destination = { readonly path: string } | { readonly reason: FilesReason };

/**
 * The path as the filesystem currently has it.
 *
 * Resolves the part of the path that is already on disk — the file itself when
 * it is there, the deepest existing ancestor when it is not — and re-checks the
 * result, which is what catches a symlink pointing out. What comes back is that
 * resolved path, so an internal symlink is followed to the file it names rather
 * than replaced.
 *
 * Both sides of the comparison are canonical, so a working directory reached
 * through a symlink — macOS's `/var` against `/private/var` — does not read as
 * an escape.
 */
function* destination(input: FilePathInput): Operation<Destination> {
  try {
    const base = (yield* API.Fs.operations.realpath(input.cwd)) ?? input.cwd;
    const path = yield* resolveExisting(resolve(input.cwd, input.path));
    if (!within(base, path)) {
      return { reason: "resolved-escape" };
    }
    return { path };
  } catch (error) {
    return { reason: reasonOf(error) };
  }
}

function nonWriteFailure<T>(
  operation: FilesOperation,
  phase: FilesPhase,
  reason: FilesReason,
): Result<T> {
  return Err(filesFailure({ operation, phase, reason }));
}

function writeFailure(input: {
  phase: FileWritePhase;
  reason?: FilesReason;
  cleanup?: FilesReason;
}): Result<FileWriteSuccess> {
  return Err(fileWriteFailure(input));
}

function notify(observe: HostFilesObserver | undefined, event: HostFilesEvent): void {
  observe?.(event);
}

/** Code point order: what a document branches on must not depend on a locale. */
function byCodePoint(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * Build a host provider.
 *
 * Exported so a test can drive one operation directly; entrypoints install it
 * with {@link useHostFiles}.
 */
export function hostFilesHandler(options: HostFilesOptions = {}): FilesHandler {
  const observe = options.observe;

  function* checkFilePath(input: FilePathInput): Operation<Result<void>> {
    const reason = inadmissible(input);
    if (reason !== undefined) {
      return nonWriteFailure("check-file-path", "lexical", reason);
    }
    return Ok(undefined);
  }

  function* readTextFile(input: FilePathInput): Operation<Result<string>> {
    const lexical = inadmissible(input);
    if (lexical !== undefined) {
      return nonWriteFailure("read", "lexical", lexical);
    }

    const target = yield* destination(input);
    if ("reason" in target) {
      return nonWriteFailure("read", "resolution", target.reason);
    }

    notify(observe, { operation: "read", phase: "target" });
    try {
      const info = yield* API.Fs.operations.stat(target.path);
      if (!info.exists) {
        return nonWriteFailure("read", "target", "missing");
      }
      if (info.isDirectory) {
        return nonWriteFailure("read", "target", "directory");
      }
      if (!info.isFile) {
        return nonWriteFailure("read", "target", "special-file");
      }
    } catch (error) {
      return nonWriteFailure("read", "target", reasonOf(error));
    }

    notify(observe, { operation: "read", phase: "access" });
    try {
      return Ok(yield* API.Fs.operations.readTextFile(target.path));
    } catch (error) {
      return nonWriteFailure("read", "access", reasonOf(error));
    }
  }

  /**
   * Replace the target with exactly `content`.
   *
   * Admission is repeated here from the authored path and contextual directory
   * rather than carried over from `checkFilePath`. The check answers whether
   * children may expand; a child can change what a path means, and a
   * destination resolved before they ran would not be the one this write lands
   * on.
   *
   * Removal of the temporary is registered before it is written rather than
   * after. The write is where an interruption is most likely to land, and a
   * cleanup installed on the far side of it would not run for the one failure it
   * exists to handle. `remove` is forced, so registering it for a file that was
   * never created — or one the rename has already consumed — is a no-op.
   *
   * Both halves are collected rather than thrown. A destructor that threw would
   * replace the failure it is unwinding, and a write's own failure must not hide
   * the fact that a temporary was left behind.
   */
  function* writeTextFile(input: FileWriteInput): Operation<Result<FileWriteSuccess>> {
    const lexical = inadmissible(input);
    if (lexical !== undefined) {
      return writeFailure({ phase: "lexical", reason: lexical });
    }

    const target = yield* destination(input);
    if ("reason" in target) {
      return writeFailure({ phase: "resolution", reason: target.reason });
    }

    notify(observe, { operation: "write", phase: "target" });
    try {
      const info = yield* API.Fs.operations.stat(target.path);
      if (info.exists && !info.isFile) {
        return writeFailure({
          phase: "target",
          reason: info.isDirectory ? "directory" : "special-file",
        });
      }
    } catch (error) {
      return writeFailure({ phase: "target", reason: reasonOf(error) });
    }

    notify(observe, { operation: "write", phase: "parents" });
    try {
      yield* API.Fs.operations.ensureDir(dirname(target.path));
    } catch (error) {
      return writeFailure({ phase: "parents", reason: reasonOf(error) });
    }

    let failed: FilesReason | undefined;
    let cleanup: FilesReason | undefined;
    // Which step the write reached, which is what decides what may be said
    // about the target: everything before the rename leaves the previous file
    // in place, and a rename that threw may have run or not.
    let step: FileWritePhase = "temporary";
    // Whether the write reached its own end. Cleanup runs on every exit, and
    // the two exits need different answers: one has a Result to compose with
    // and the other does not.
    let settled = false;

    yield* scoped(function* () {
      const temporary = `${target.path}.xmd-${randomUUID().slice(0, 8)}.tmp`;
      yield* ensure(function* () {
        notify(observe, { operation: "write", phase: "cleanup" });
        try {
          yield* API.Fs.operations.remove(temporary, { force: true });
        } catch (error) {
          if (settled) {
            cleanup = reasonOf(error);
            return;
          }
          // Cancellation is unwinding, so there is no outcome to report this
          // beside — and manufacturing one would turn a halt into a write
          // result. It leaves the scope as an infrastructure failure instead,
          // carrying neither the platform's error nor the generated temporary's
          // name, and the engine's fatal discovery finds it there.
          throw new FilesInvariantError("teardown");
        }
      });
      try {
        notify(observe, { operation: "write", phase: "temporary" });
        yield* API.Fs.operations.writeTextFile(temporary, input.content);
        step = "commit";
        notify(observe, { operation: "write", phase: "commit" });
        yield* API.Fs.operations.rename(temporary, target.path);
      } catch (error) {
        failed = reasonOf(error);
      }
      settled = true;
    });

    if (failed !== undefined) {
      return writeFailure({ phase: step, reason: failed, cleanup });
    }
    if (cleanup !== undefined) {
      return writeFailure({ phase: "cleanup", cleanup });
    }
    return Ok(fileWriteSuccess("host-committed"));
  }

  /**
   * The regular files under `cwd` that `include` selects and `exclude` does not.
   *
   * Traversal is `API.Fs`'s: it reports directories and symbolic links too, and
   * never follows one, which is what keeps the walk inside `cwd` and free of
   * cycles. What this adds is the document-facing shape — regular files only,
   * deduplicated, and sorted, so a document that branches on a listing branches
   * the same way on every host.
   */
  function* globFiles(input: GlobInput): Operation<Result<string[]>> {
    try {
      const info = yield* API.Fs.operations.stat(input.cwd);
      if (!info.exists) {
        return nonWriteFailure("glob", "target", "missing");
      }
      if (!info.isDirectory) {
        return nonWriteFailure("glob", "target", "not-directory");
      }
    } catch (error) {
      return nonWriteFailure("glob", "target", reasonOf(error));
    }

    try {
      const matched = yield* traverse(input, observe);
      const files = matched.filter((entry) => entry.isFile).map((entry) => entry.path);
      return Ok([...new Set(files)].sort(byCodePoint));
    } catch (error) {
      // The Api compiles patterns as it starts, so an unusable one — an
      // unterminated character class — arrives as a `SyntaxError` from `RegExp`
      // rather than as an errno. It is the one failure here a document can fix
      // by editing what it wrote.
      if (error instanceof SyntaxError) {
        return nonWriteFailure("glob", "pattern", "invalid-pattern");
      }
      return nonWriteFailure("glob", "traversal", reasonOf(error));
    }
  }

  /**
   * A directory this call created, named by its canonical path.
   *
   * Creation is synchronous so that nothing can suspend between it and the
   * `ensure` that removes it. `until()` cannot cancel the promise it is waiting
   * on, so an asynchronous `mkdtemp` halted mid-flight would go on to create a
   * directory after the generator had already stopped — one nothing owns and
   * nothing removes. `mkdtemp` names and creates at once, so the directory is
   * never one an earlier run left behind.
   *
   * Everything after that is ordinary work and suspends. The path is
   * canonicalized: on macOS `tmpdir()` is a symlink (`/var/folders/…`) while a
   * child process resolves it (`/private/var/…`), and canonicalizing is what
   * makes the rendered path, the contextual directory, and a subprocess's own
   * `cwd` the same string. Cleanup is already registered by then, so a halt
   * during it still takes the directory away.
   */
  function temporaryDirectory(): Operation<Result<string>> {
    return resource(function* (provide) {
      let created: string;
      try {
        // oxlint-disable-next-line local/no-sync-filesystem
        created = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), "xmd-tempdir-"));
      } catch (error) {
        yield* provide(nonWriteFailure("temporary-directory", "acquire", reasonOf(error)));
        return;
      }
      yield* ensure(() => discard(created));

      let canonical: string;
      try {
        canonical = yield* until(realpath(created));
      } catch (error) {
        yield* provide(nonWriteFailure("temporary-directory", "acquire", reasonOf(error)));
        return;
      }
      yield* provide(Ok(canonical));
    });
  }

  return { checkFilePath, readTextFile, writeTextFile, globFiles, temporaryDirectory };
}

/**
 * Remove a temporary directory as its scope ends.
 *
 * A removal that fails during teardown is reported as an invariant rather than
 * passed along: the failure it would otherwise carry names the generated
 * directory, which the document never chose, and it can be unwinding a failure
 * of its own that must not be replaced by platform text.
 */
function* discard(directory: string): Operation<void> {
  try {
    yield* rm(directory, { recursive: true, force: true });
  } catch {
    throw new FilesInvariantError("teardown");
  }
}

/**
 * Run the traversal, announcing each directory read when an observer is watching.
 *
 * The announcement is installed as `API.Fs` middleware for the duration of this
 * one call rather than left in place, so an observer sees the reads this glob
 * performs and nothing else.
 */
function traverse(
  input: GlobInput,
  observe: HostFilesObserver | undefined,
): Operation<Array<{ path: string; isFile: boolean }>> {
  const search = { patterns: input.include, root: input.cwd, exclude: input.exclude };
  if (observe === undefined) {
    return API.Fs.operations.glob(search);
  }
  return scoped(function* () {
    yield* FsApi.around({
      *readdirDirents([directory], next) {
        observe({ operation: "glob", phase: "read-dir" });
        return yield* next(directory);
      },
    });
    return yield* API.Fs.operations.glob(search);
  });
}

/**
 * Install the host provider beneath ordinary middleware.
 *
 * `at: "min"` is what lets a host wrap document filesystem access without
 * replacing it — middleware installed later sees these operations and can
 * delegate to them.
 */
export function useHostFiles(options: HostFilesOptions = {}): Operation<void> {
  const handler = hostFilesHandler(options);
  return API.Files.around(
    {
      *checkFilePath([input]) {
        return yield* handler.checkFilePath(input);
      },
      *readTextFile([input]) {
        return yield* handler.readTextFile(input);
      },
      *writeTextFile([input]) {
        return yield* handler.writeTextFile(input);
      },
      *globFiles([input]) {
        return yield* handler.globFiles(input);
      },
      *temporaryDirectory() {
        return yield* handler.temporaryDirectory();
      },
    },
    { at: "min" },
  );
}
