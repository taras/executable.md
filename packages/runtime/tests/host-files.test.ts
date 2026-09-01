/**
 * Tier HF — the host `API.Files` provider.
 *
 * These drive the provider directly rather than through a document, because
 * what they assert is the contract a component cannot see: which phase a
 * failure came from, that an ordinary condition is an `Err` and never a throw,
 * that a missing provider throws and never falls back, and where the host
 * guarantee actually stops.
 *
 * The replacement cases are the last of those. The host contract holds while
 * the pathname namespace is stable, and the adapter's test-only observer is
 * what makes "stable" falsifiable: it swaps part of the tree between the moment
 * the adapter observes a path and the moment it uses one, synchronously, with
 * no sleeping and no racing. What they prove is the documented weakness, not a
 * containment claim.
 *
 * `mkdtemp`, `realpath`, `symlink`, `lstat`, and `readdir` have no
 * `@effectionx/fs` equivalent; everything else goes through it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  ensure,
  race,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation, Result } from "effection";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, symlink } from "node:fs/promises";
import { renameSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { API } from "../apis.ts";
import { hostFilesHandler, useHostFiles } from "../host-files.ts";
import type { HostFilesEvent } from "../host-files.ts";
import {
  FILES_ERROR,
  FILES_WRITE_SUCCESS,
  Files,
  FilesProviderUnavailableError,
  parseFileWriteFailure,
  parseFileWriteSuccess,
  parseFilesFailure,
  parseFilesFatal,
} from "../files.ts";
import type { FilesHandler } from "../files.ts";

/** A workspace, and a directory beside it that is deliberately out of reach. */
interface Fixture {
  root: string;
  workspace: string;
  outside: string;
}

function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "hf-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    yield* until(mkdir(workspace));
    yield* until(mkdir(outside));
    yield* provide({ root, workspace, outside });
  });
}

/**
 * A directory symlink, spelled the way the running platform accepts one.
 *
 * A junction is what Windows gives an unprivileged process, and it is the
 * reparse point the guarantee statement names; everywhere else it is an
 * ordinary directory symlink.
 */
const DIRECTORY_LINK = process.platform === "win32" ? "junction" : "dir";

function linkDirectory(target: string, path: string): Operation<void> {
  return until(symlink(target, path, DIRECTORY_LINK));
}

function handler(observe?: (event: HostFilesEvent) => void): FilesHandler {
  return hostFilesHandler(observe === undefined ? {} : { observe });
}

function failed<T>(result: Result<T>): unknown {
  if (result.ok) {
    throw new Error("expected a failure, got a value");
  }
  return result.error;
}

function value<T>(result: Result<T>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** Everything in a directory, sorted, so an assertion names a set. */
function* entries(directory: string): Operation<string[]> {
  return (yield* until(readdir(directory))).sort();
}

/** A platform error shaped like the ones that leak: a code, and a path. */
const PLANTED = "/planted/absolute/path/secret.txt";

function planted(code: string): Error {
  return Object.assign(new Error(`${code}: operation failed, at '${PLANTED}'`), { code });
}

/**
 * The first Files infrastructure failure in a thrown graph.
 *
 * A destructor failure arrives wrapped in whatever Effection collected it with,
 * so a test that only inspected the top of the graph would assert about the
 * wrapper. Core owns the real traversal; this is the small local one a runtime
 * test can have without importing the engine.
 */
function firstFilesFatal(error: unknown, seen = new Set<unknown>()): unknown {
  if (parseFilesFatal(error) !== undefined) {
    return error;
  }
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  const causes =
    error instanceof AggregateError
      ? error.errors
      : error instanceof Error && error.cause !== undefined
        ? [error.cause]
        : [];
  for (const cause of causes) {
    const found = firstFilesFatal(cause, seen);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** Every field a failure carries, as one string, for a leak assertion. */
function inspected(error: unknown): string {
  return JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    data: error instanceof Error && "data" in error ? error.data : undefined,
  });
}

describe("Tier HF — host Files provider", () => {
  // HF1: the preliminary check is arithmetic. It has to be, because it runs
  // before a write's children and its whole job is to cost nothing.
  it("HF1: checkFilePath refuses inadmissible paths with no filesystem access", function* () {
    const fixture = yield* useFixture();
    const touched: string[] = [];

    yield* scoped(function* () {
      yield* API.Fs.around({
        *stat([path], next) {
          touched.push(path);
          return yield* next(path);
        },
        *realpath([path], next) {
          touched.push(path);
          return yield* next(path);
        },
        *readTextFile([path], next) {
          touched.push(path);
          return yield* next(path);
        },
      });
      const files = handler();

      for (const [path, reason] of [
        ["", "empty-path"],
        [join(fixture.outside, "secret.txt"), "absolute-path"],
        ["../outside/secret.txt", "lexical-escape"],
      ]) {
        const result = yield* files.checkFilePath({ cwd: fixture.workspace, path });
        expect(parseFilesFailure(failed(result))).toEqual({
          type: FILES_ERROR,
          operation: "check-file-path",
          phase: "lexical",
          reason,
        });
      }

      // And an admissible path answers with nothing usable.
      const admitted = yield* files.checkFilePath({ cwd: fixture.workspace, path: "notes.md" });
      expect(admitted).toEqual({ ok: true, value: undefined });
    });

    expect(touched).toEqual([]);
  });

  // HF2: the ordinary round trip, and the shape a success has.
  it("HF2: a write commits and reads back, reporting a validated outcome", function* () {
    const fixture = yield* useFixture();
    const files = handler();

    const written = yield* files.writeTextFile({
      cwd: fixture.workspace,
      path: "nested/notes.md",
      content: "first",
    });
    expect(parseFileWriteSuccess(value(written))).toEqual({
      type: FILES_WRITE_SUCCESS,
      publication: "host-committed",
    });

    const read = yield* files.readTextFile({ cwd: fixture.workspace, path: "nested/notes.md" });
    expect(value(read)).toBe("first");
    // The commit consumed the temporary, so nothing is left beside the file.
    expect(yield* entries(join(fixture.workspace, "nested"))).toEqual(["notes.md"]);
  });

  // HF3: the search's document-facing shape. Sorting and deduplication are the
  // provider's, so a document that branches on a listing branches the same way
  // wherever it runs.
  it("HF3: globFiles returns sorted, deduplicated regular files", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "zebra.md"), "z");
    yield* writeTextFile(join(fixture.workspace, "Beta.md"), "b");
    yield* until(mkdir(join(fixture.workspace, "one")));
    yield* writeTextFile(join(fixture.workspace, "one/middle.md"), "m");
    yield* until(symlink(join(fixture.workspace, "Beta.md"), join(fixture.workspace, "link.md")));

    const found = yield* handler().globFiles({
      cwd: fixture.workspace,
      include: ["**/*.md", "**/*.md"],
      exclude: [],
    });

    // A symbolic link is a link rather than a file, so it is not a result.
    expect(value(found)).toEqual(["Beta.md", "one/middle.md", "zebra.md"]);
  });

  // HF4: every ordinary failure is a Result. Nothing throws, and nothing the
  // platform said reaches the caller — a code that is not recognized selects
  // the generic reason rather than being carried across.
  it("HF4: platform failures become structured Errs, and leak nothing", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "existing");

    const cases: Array<{
      code: string;
      install: () => Operation<void>;
      expected: { phase: string; reason: string };
    }> = [
      {
        code: "ELOOP",
        expected: { phase: "resolution", reason: "too-many-symlinks" },
        *install() {
          yield* API.Fs.around({
            *realpath([path], next) {
              if (path.endsWith("notes.md")) {
                throw planted("ELOOP");
              }
              return yield* next(path);
            },
          });
        },
      },
      {
        code: "EACCES",
        expected: { phase: "target", reason: "permission-denied" },
        *install() {
          yield* API.Fs.around({
            *stat([path], next) {
              if (path.endsWith("notes.md")) {
                throw planted("EACCES");
              }
              return yield* next(path);
            },
          });
        },
      },
      {
        code: "ENOTAREALCODE",
        expected: { phase: "access", reason: "operation-failed" },
        *install() {
          yield* API.Fs.around({
            // deno-lint-ignore require-yield
            *readTextFile() {
              throw planted("ENOTAREALCODE");
            },
          });
        },
      },
    ];

    for (const shape of cases) {
      yield* scoped(function* () {
        yield* shape.install();
        const result = yield* handler().readTextFile({
          cwd: fixture.workspace,
          path: "notes.md",
        });
        const error = failed(result);
        expect(parseFilesFailure(error)).toEqual({
          type: FILES_ERROR,
          operation: "read",
          phase: shape.expected.phase,
          reason: shape.expected.reason,
        });
        const text = inspected(error);
        expect(text).not.toContain(PLANTED);
        expect(text).not.toContain(shape.code);
        expect(text).not.toContain(fixture.workspace);
      });
    }
  });

  // HF5: the write's phase table. Which phase a write stopped at is the only
  // thing that decides what may be said about the target, so each one is
  // produced from the outside and its whole structure checked.
  it("HF5: each write phase reports a valid, phase-consistent outcome", function* () {
    const fixture = yield* useFixture();

    const cases: Array<{
      name: string;
      install?: () => Operation<void>;
      path?: string;
      prepare?: () => Operation<void>;
      expected: Record<string, unknown>;
    }> = [
      {
        name: "lexical",
        path: "../outside/planted.txt",
        expected: { phase: "lexical", reason: "lexical-escape", target: "unchanged" },
      },
      {
        name: "target",
        path: "adirectory",
        *prepare() {
          yield* until(mkdir(join(fixture.workspace, "adirectory")));
        },
        expected: { phase: "target", reason: "directory", target: "unchanged" },
      },
      {
        name: "parents",
        expected: { phase: "parents", reason: "read-only", target: "unchanged" },
        *install() {
          yield* API.Fs.around({
            // deno-lint-ignore require-yield
            *ensureDir() {
              throw planted("EROFS");
            },
          });
        },
      },
      {
        name: "temporary",
        expected: { phase: "temporary", reason: "no-space", target: "unchanged" },
        *install() {
          yield* API.Fs.around({
            // deno-lint-ignore require-yield
            *writeTextFile() {
              throw planted("ENOSPC");
            },
          });
        },
      },
      {
        name: "commit",
        expected: { phase: "commit", reason: "cross-device", target: "commit-unknown" },
        *install() {
          yield* API.Fs.around({
            // deno-lint-ignore require-yield
            *rename() {
              throw planted("EXDEV");
            },
          });
        },
      },
      {
        name: "cleanup",
        expected: { phase: "cleanup", cleanup: "permission-denied", target: "committed" },
        *install() {
          yield* API.Fs.around({
            // deno-lint-ignore require-yield
            *remove() {
              throw planted("EPERM");
            },
          });
        },
      },
      {
        name: "commit and cleanup together",
        expected: {
          phase: "commit",
          reason: "cross-device",
          cleanup: "permission-denied",
          target: "commit-unknown",
        },
        *install() {
          yield* API.Fs.around({
            // deno-lint-ignore require-yield
            *rename() {
              throw planted("EXDEV");
            },
            // deno-lint-ignore require-yield
            *remove() {
              throw planted("EPERM");
            },
          });
        },
      },
    ];

    for (const shape of cases) {
      if (shape.prepare) {
        yield* shape.prepare();
      }
      yield* scoped(function* () {
        if (shape.install) {
          yield* shape.install();
        }
        const result = yield* handler().writeTextFile({
          cwd: fixture.workspace,
          path: shape.path ?? `${shape.name.replace(/ /g, "-")}.txt`,
          content: "replacement",
        });
        const parsed = parseFileWriteFailure(failed(result));
        expect(parsed).toEqual({
          type: FILES_ERROR,
          operation: "write",
          ...shape.expected,
        });
        expect(inspected(failed(result))).not.toContain(PLANTED);
      });
    }
  });

  // HF6: containment, judged against what the adapter can observe. A symlink
  // out is refused at resolution for both forms, and the destination is never
  // named — reporting where a link pointed would perform the escape.
  it("HF6: a symlink leaving the working directory is refused, naming nothing", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.outside, "secret.txt"), "SECRET");
    yield* until(symlink(join(fixture.outside, "secret.txt"), join(fixture.workspace, "escape")));
    const files = handler();

    const read = yield* files.readTextFile({ cwd: fixture.workspace, path: "escape" });
    expect(parseFilesFailure(failed(read))?.reason).toBe("resolved-escape");
    expect(inspected(failed(read))).not.toContain("SECRET");
    expect(inspected(failed(read))).not.toContain(fixture.outside);

    const written = yield* files.writeTextFile({
      cwd: fixture.workspace,
      path: "escape",
      content: "planted",
    });
    expect(parseFileWriteFailure(failed(written))).toEqual({
      type: FILES_ERROR,
      operation: "write",
      phase: "resolution",
      reason: "resolved-escape",
      target: "unchanged",
    });
    expect(yield* readTextFile(join(fixture.outside, "secret.txt"))).toBe("SECRET");
  });

  // HF7: an internal link is followed rather than replaced, which is what makes
  // reading back through either name agree.
  it("HF7: an internal symlink is followed for a write", function* () {
    const fixture = yield* useFixture();
    yield* until(mkdir(join(fixture.workspace, "real")));
    yield* writeTextFile(join(fixture.workspace, "real/target.txt"), "original");
    yield* until(
      symlink(join(fixture.workspace, "real/target.txt"), join(fixture.workspace, "link.txt")),
    );

    yield* handler().writeTextFile({
      cwd: fixture.workspace,
      path: "link.txt",
      content: "replaced",
    });

    expect(yield* readTextFile(join(fixture.workspace, "real/target.txt"))).toBe("replaced");
    expect((yield* until(lstat(join(fixture.workspace, "link.txt")))).isSymbolicLink()).toBe(true);
  });

  // HF8: a dangling final link is the one hole resolution cannot close — there
  // is nothing to resolve — and the temporary plus rename is what closes it.
  // The link is replaced rather than followed to wherever it pointed.
  it("HF8: a write replaces a dangling symlink instead of following it", function* () {
    const fixture = yield* useFixture();
    yield* until(symlink(join(fixture.outside, "absent.txt"), join(fixture.workspace, "dangling")));

    const written = yield* handler().writeTextFile({
      cwd: fixture.workspace,
      path: "dangling",
      content: "content",
    });

    expect(parseFileWriteSuccess(value(written))?.publication).toBe("host-committed");
    expect(yield* readTextFile(join(fixture.workspace, "dangling"))).toBe("content");
    expect((yield* until(lstat(join(fixture.workspace, "dangling")))).isSymbolicLink()).toBe(false);
    expect(yield* exists(join(fixture.outside, "absent.txt"))).toBe(false);
  });

  // HF9: the observer's own contract. Production installs no observer, so this
  // fixes what a test may rely on: the private phases, in order, once each.
  it("HF9: the observer reports each private phase in order", function* () {
    const fixture = yield* useFixture();
    const seen: string[] = [];
    const files = handler((event) => seen.push(`${event.operation}.${event.phase}`));

    yield* files.writeTextFile({ cwd: fixture.workspace, path: "a.txt", content: "a" });
    expect(seen).toEqual([
      "write.target",
      "write.parents",
      "write.temporary",
      "write.commit",
      "write.cleanup",
    ]);

    seen.length = 0;
    yield* files.readTextFile({ cwd: fixture.workspace, path: "a.txt" });
    expect(seen).toEqual(["read.target", "read.access"]);

    seen.length = 0;
    yield* files.globFiles({ cwd: fixture.workspace, include: ["**/*"], exclude: [] });
    expect(seen).toEqual(["glob.read-dir"]);

    seen.length = 0;
    yield* files.deleteFile({ cwd: fixture.workspace, path: "a.txt" });
    expect(seen).toEqual(["delete.target", "delete.access"]);
  });

  // HF10: where the host guarantee stops, made observable. The parent is
  // replaced by a link out of the workspace between the moment the adapter
  // resolved the path and the moment it creates parents — synchronously, in one
  // uninterrupted step, which is exactly what another process can do and what
  // no shipped runtime lets this adapter prevent.
  //
  // What is asserted is the documented weakness. A test that expected refusal
  // here would be asserting a containment claim `xmd run` does not make.
  it("HF10: a parent replaced after resolution is observed by the later calls", function* () {
    const fixture = yield* useFixture();
    yield* until(mkdir(join(fixture.workspace, "parent")));

    let swapped = false;
    const files = handler((event) => {
      if (swapped || event.operation !== "write" || event.phase !== "parents") {
        return;
      }
      swapped = true;
      // Synchronous, so nothing runs between the observation and the use: the
      // seam under test is the window between resolving a parent and writing
      // through it, and suspending here would widen it into a different one.
      // oxlint-disable-next-line local/no-sync-filesystem
      renameSync(join(fixture.workspace, "parent"), join(fixture.root, "moved"));
      // oxlint-disable-next-line local/no-sync-filesystem
      symlinkSync(fixture.outside, join(fixture.workspace, "parent"), DIRECTORY_LINK);
    });

    const written = yield* files.writeTextFile({
      cwd: fixture.workspace,
      path: "parent/planted.txt",
      content: "complete replacement",
    });

    expect(swapped).toBe(true);
    // The write committed — through the replacement, which is the limitation.
    expect(parseFileWriteSuccess(value(written))?.publication).toBe("host-committed");
    expect(yield* readTextFile(join(fixture.outside, "planted.txt"))).toBe("complete replacement");
    // Atomicity still holds: what landed is the whole file, never a fragment,
    // and no temporary was left beside it.
    expect(yield* entries(fixture.outside)).toEqual(["planted.txt"]);
  });

  // HF10b: the same seam on a read. A file swapped for a link out after
  // resolution is read through, and the failure that would have been reported
  // is not manufactured.
  it("HF10b: a target replaced after resolution is read through", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "inside");
    yield* writeTextFile(join(fixture.outside, "secret.txt"), "SECRET");

    let swapped = false;
    const files = handler((event) => {
      if (swapped || event.operation !== "read" || event.phase !== "access") {
        return;
      }
      swapped = true;
      // The same seam on a read, and synchronous for the same reason: the
      // replacement has to land between resolution and access, with nothing
      // else running in between.
      // oxlint-disable-next-line local/no-sync-filesystem
      unlinkSync(join(fixture.workspace, "notes.md"));
      // oxlint-disable-next-line local/no-sync-filesystem
      symlinkSync(join(fixture.outside, "secret.txt"), join(fixture.workspace, "notes.md"));
    });

    const read = yield* files.readTextFile({ cwd: fixture.workspace, path: "notes.md" });

    expect(swapped).toBe(true);
    expect(value(read)).toBe("SECRET");
  });

  // HF11: rename is reached only as the commit phase, and a middleware fault on
  // either side of it is the same event from where the adapter stands. Both
  // report `commit-unknown`, and they have to: one of the two runs did commit.
  it("HF11: a commit fault before and after next reports the same unknown outcome", function* () {
    const fixture = yield* useFixture();

    for (const side of ["before", "after"] as const) {
      yield* writeTextFile(join(fixture.workspace, `${side}.md`), "first");
      const result = yield* scoped(function* () {
        yield* API.Fs.around({
          *rename([from, to], next) {
            if (side === "after") {
              yield* next(from, to);
            }
            throw planted("EXDEV");
          },
        });
        return yield* handler().writeTextFile({
          cwd: fixture.workspace,
          path: `${side}.md`,
          content: "second",
        });
      });

      expect(parseFileWriteFailure(failed(result))).toEqual({
        type: FILES_ERROR,
        operation: "write",
        phase: "commit",
        reason: "cross-device",
        target: "commit-unknown",
      });
    }

    // The claim is honest about both: one run kept the previous file and one
    // replaced it, and the report was the same.
    expect(yield* readTextFile(join(fixture.workspace, "before.md"))).toBe("first");
    expect(yield* readTextFile(join(fixture.workspace, "after.md"))).toBe("second");
  });

  // HF12: cancellation is not a Result. It resumes the generator rather than
  // throwing, so nothing here can convert it into a write outcome — and the
  // temporary is still removed, because its cleanup was registered before the
  // step most likely to be interrupted.
  it("HF12: cancellation produces no Result and leaves no temporary", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");
    let settled: unknown = "not settled";

    yield* race([
      scoped(function* () {
        yield* API.Fs.around({
          *writeTextFile([path, content], next) {
            yield* next(path, content);
            yield* suspend();
          },
        });
        settled = yield* handler().writeTextFile({
          cwd: fixture.workspace,
          path: "notes.md",
          content: "second",
        });
      }),
      sleep(250),
    ]);

    expect(settled).toBe("not settled");
    expect(yield* readTextFile(join(fixture.workspace, "notes.md"))).toBe("first");
    expect(yield* entries(fixture.workspace)).toEqual(["notes.md"]);
  });

  // HF12b: cleanup that fails *while cancellation is unwinding* is the one exit
  // with no outcome to report beside it. Manufacturing one would turn a halt
  // into a write result, and forwarding the platform's error would name a
  // temporary the document never chose — so a fixed teardown invariant leaves
  // the scope instead, and the engine's fatal discovery finds it there.
  //
  // Deterministic rather than raced: the write suspends after the temporary is
  // created, the test waits to observe that it did, and only then halts.
  it("HF12b: a cleanup failure during cancellation escapes as a teardown invariant", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");
    const suspended = withResolvers<void>();
    let settled: unknown = "not settled";

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
            throw planted("EPERM");
          },
        });
        settled = yield* handler().writeTextFile({
          cwd: fixture.workspace,
          path: "notes.md",
          content: "second",
        });
      });
    });

    yield* suspended.operation;
    let thrown: unknown;
    try {
      yield* write.halt();
    } catch (error) {
      thrown = error;
    }

    // No Result was produced: the halt is not a write outcome.
    expect(settled).toBe("not settled");
    // And the failure that did leave is the fixed infrastructure one.
    const teardown = firstFilesFatal(thrown);
    expect(parseFilesFatal(teardown)).toEqual({
      type: "executablemd.runtime.files-fatal/v1",
      kind: "invariant",
      category: "teardown",
    });
    expect(teardown instanceof Error ? teardown.message : "").toBe(
      "Files provider invariant failed",
    );
    const text = inspected(teardown);
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain(".tmp");
    expect(text).not.toContain("EPERM");
    // The category is structural control data for a consumer deciding what to
    // fence — it belongs in `data`, and never in the message.
    expect(teardown instanceof Error ? teardown.message : "").not.toContain("teardown");
    expect(teardown instanceof Error ? teardown.cause : "unset").toBeUndefined();
    expect(yield* readTextFile(join(fixture.workspace, "notes.md"))).toBe("first");
  });

  // HF13: the temporary directory is a resource, so its lifetime is the
  // acquiring scope's and a halt cannot land between creating it and owning its
  // removal.
  it("HF13: a temporary directory lives and dies with its acquiring scope", function* () {
    const files = handler();
    let acquired = "";

    yield* scoped(function* () {
      acquired = value(yield* files.temporaryDirectory());
      expect(yield* exists(acquired)).toBe(true);
    });
    expect(yield* exists(acquired)).toBe(false);

    // Halted before the acquiring task ran at all: an acquisition that
    // suspended on a pending creation would finish afterwards and leave a
    // directory nothing owns.
    const early = yield* spawn(() => files.temporaryDirectory());
    yield* early.halt();
    yield* sleep(50);
    const stale = (yield* entries(yield* until(realpath(tmpdir())))).filter((entry) =>
      entry.startsWith("xmd-tempdir-"),
    );
    expect(stale.includes(acquired)).toBe(false);
  });

  // HF14: absence is fatal, for every operation. A default that reached the
  // host would make an uninstalled provider indistinguishable from an installed
  // one, which is the whole reason this Api has no host default.
  it("HF14: with no provider installed every operation throws and touches nothing", function* () {
    const fixture = yield* useFixture();
    const touched: string[] = [];

    yield* scoped(function* () {
      yield* API.Fs.around({
        *stat([path], next) {
          touched.push(path);
          return yield* next(path);
        },
        *realpath([path], next) {
          touched.push(path);
          return yield* next(path);
        },
        *readTextFile([path], next) {
          touched.push(path);
          return yield* next(path);
        },
        *writeTextFile([path, content], next) {
          touched.push(path);
          return yield* next(path, content);
        },
        *lstat([path], next) {
          touched.push(path);
          return yield* next(path);
        },
        *remove([path, options], next) {
          touched.push(path);
          return yield* next(path, options);
        },
      });

      const calls: Array<Operation<unknown>> = [
        Files.operations.checkFilePath({ cwd: fixture.workspace, path: "a.md" }),
        Files.operations.readTextFile({ cwd: fixture.workspace, path: "a.md" }),
        Files.operations.writeTextFile({ cwd: fixture.workspace, path: "a.md", content: "x" }),
        Files.operations.deleteFile({ cwd: fixture.workspace, path: "a.md" }),
        Files.operations.globFiles({ cwd: fixture.workspace, include: ["*"], exclude: [] }),
        Files.operations.temporaryDirectory(),
      ];

      for (const call of calls) {
        let thrown: unknown;
        try {
          yield* call;
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(FilesProviderUnavailableError);
        expect(parseFilesFatal(thrown)).toEqual({
          type: "executablemd.runtime.files-fatal/v1",
          kind: "provider-unavailable",
        });
        // Fixed diagnostics, and no cause to inspect.
        expect(thrown instanceof Error ? thrown.message : "").toBe(
          "Files provider is not installed",
        );
        expect(thrown instanceof Error ? thrown.cause : "unset").toBeUndefined();
      }
    });

    expect(touched).toEqual([]);
  });

  // HF15: installation is what `useHostFiles` is for, and it goes beneath
  // ordinary middleware so a host can still wrap document filesystem access.
  it("HF15: useHostFiles installs beneath middleware that can wrap it", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "underneath");

    const observed: string[] = [];
    const read = yield* scoped(function* () {
      yield* useHostFiles();
      yield* Files.around({
        *readTextFile([input], next) {
          observed.push(input.path);
          return yield* next(input);
        },
      });
      return yield* Files.operations.readTextFile({ cwd: fixture.workspace, path: "notes.md" });
    });

    expect(value(read)).toBe("underneath");
    expect(observed).toEqual(["notes.md"]);
  });

  // HF15b: installation forwards every operation, not only the ones a caller
  // happens to try first.
  //
  // `useHostFiles` forwards member by member, and `Files.around` accepts a
  // partial handler by design — middleware implementing a subset and delegating
  // the rest is the ordinary case. So an operation left out of the forwarding
  // list is well-typed, and every caller of it falls through to the
  // absent-provider terminal instead. That is not a contract this suite can
  // check by construction; it has to be reached.
  //
  // Asserted through the installed provider rather than the handler, because
  // the handler having the method is exactly what the omission looks like.
  it("HF15b: every operation is reachable through the installed provider", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "reachable");
    yield* until(mkdir(join(fixture.workspace, "listed")));

    yield* scoped(function* () {
      yield* useHostFiles();
      // One call per operation the contract declares. A member missing from the
      // forwarding list throws `FilesProviderUnavailableError` here rather than
      // returning a Result, so an omission fails this case loudly.
      expect(
        (yield* Files.operations.checkFilePath({
          cwd: fixture.workspace,
          path: "notes.md",
        })).ok,
      ).toBe(true);
      expect(
        value(
          yield* Files.operations.readTextFile({
            cwd: fixture.workspace,
            path: "notes.md",
          }),
        ).length,
      ).toBeGreaterThan(0);
      expect(
        (yield* Files.operations.writeTextFile({
          cwd: fixture.workspace,
          path: "written.md",
          content: "x",
        })).ok,
      ).toBe(true);
      expect(
        (yield* Files.operations.ensureDirectory({
          cwd: fixture.workspace,
          path: "made/through/installation",
        })).ok,
      ).toBe(true);
      expect(
        (yield* Files.operations.deleteFile({
          cwd: fixture.workspace,
          path: "written.md",
        })).ok,
      ).toBe(true);
      expect(
        (yield* Files.operations.globFiles({
          cwd: fixture.workspace,
          include: ["**/*"],
          exclude: [],
        })).ok,
      ).toBe(true);
      yield* scoped(function* () {
        expect(value(yield* Files.operations.temporaryDirectory()).length).toBeGreaterThan(0);
      });
    });

    // And the directory really was made, through the installed provider rather
    // than a handler the test held itself.
    expect(yield* exists(join(fixture.workspace, "made", "through", "installation"))).toBe(true);
  });

  // HF16: a junction is the Windows shape of the same limitation, and this is
  // the row that names it. Elsewhere it is an ordinary directory symlink, so
  // the case runs on every target rather than only where the reparse point
  // exists.
  it("HF16: a directory link is refused at resolution on every platform", function* () {
    const fixture = yield* useFixture();
    yield* linkDirectory(fixture.outside, join(fixture.workspace, "escape"));

    const written = yield* handler().writeTextFile({
      cwd: fixture.workspace,
      path: "escape/planted.txt",
      content: "planted",
    });

    expect(parseFileWriteFailure(failed(written))?.reason).toBe("resolved-escape");
    expect(yield* entries(fixture.outside)).toEqual([]);
  });

  // HF17: where a minted directory lives is the caller's to choose. The host's
  // shared temporary root holds every process's directories, so a caller that
  // censuses the minted namespace supplies a root it owns — and the directory
  // still lives and dies with its acquiring scope there.
  it("HF17: a temporary directory is minted under the configured root", function* () {
    const { root } = yield* useFixture();
    const files = hostFilesHandler({ temporaryRoot: root });

    let acquired = "";
    yield* scoped(function* () {
      acquired = value(yield* files.temporaryDirectory());
      expect(acquired.startsWith(join(root, "xmd-tempdir-"))).toBe(true);
      expect(yield* exists(acquired)).toBe(true);
    });
    expect(yield* exists(acquired)).toBe(false);
  });

  // HF18: the ordinary deletion, and the shape of its success. Nothing comes
  // back — no receipt, no path, no word on whether anything was there — which is
  // also why the second call is a success rather than a "missing".
  it("HF18: a deletion removes one regular file, and absence is the same success", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");
    const files = handler();

    const removed = yield* files.deleteFile({ cwd: fixture.workspace, path: "notes.md" });
    expect(removed).toEqual({ ok: true, value: undefined });
    expect(yield* entries(fixture.workspace)).toEqual([]);

    const again = yield* files.deleteFile({ cwd: fixture.workspace, path: "notes.md" });
    expect(again).toEqual({ ok: true, value: undefined });
    expect(yield* entries(fixture.workspace)).toEqual([]);
  });

  // HF19: a final link is the entry the document named, so it is what goes.
  // Both directions matter: following an inward link would remove a file the
  // document did not name, and following an outward one would reach outside the
  // working directory entirely — which is why resolution stops at the parent.
  it("HF19: a final symbolic link is removed as the link, and no target is", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "real.txt"), "inside");
    yield* writeTextFile(join(fixture.outside, "secret.txt"), "SECRET");
    yield* until(symlink(join(fixture.workspace, "real.txt"), join(fixture.workspace, "inward")));
    yield* until(symlink(join(fixture.outside, "secret.txt"), join(fixture.workspace, "outward")));
    yield* until(symlink(join(fixture.outside, "absent.txt"), join(fixture.workspace, "dangling")));
    yield* linkDirectory(fixture.outside, join(fixture.workspace, "outward-dir"));
    const files = handler();

    for (const link of ["inward", "outward", "dangling", "outward-dir"]) {
      expect(yield* files.deleteFile({ cwd: fixture.workspace, path: link })).toEqual({
        ok: true,
        value: undefined,
      });
    }

    expect(yield* entries(fixture.workspace)).toEqual(["real.txt"]);
    expect(yield* readTextFile(join(fixture.workspace, "real.txt"))).toBe("inside");
    // Nothing on the far side of any of them moved.
    expect(yield* readTextFile(join(fixture.outside, "secret.txt"))).toBe("SECRET");
    expect(yield* entries(fixture.outside)).toEqual(["secret.txt"]);
  });

  // HF20: every directory is refused, and the empty one is the case that says
  // this is decided here rather than delegated. A nonrecursive removal of an
  // empty directory is what the platforms disagree about — and what the pinned
  // Workspace filesystem would simply carry out.
  //
  // The working directory naming itself is the other half. Its parent is
  // outside it, so a destination resolved through the parent would report `.`
  // as an escape; it is classified directly, and answers for what it is.
  it("HF20: every directory is refused, empty ones and the working directory too", function* () {
    const fixture = yield* useFixture();
    yield* until(mkdir(join(fixture.workspace, "empty")));
    yield* until(mkdir(join(fixture.workspace, "full")));
    yield* writeTextFile(join(fixture.workspace, "full/inner.txt"), "kept");
    const files = handler();

    for (const path of ["empty", "full", ".", "full/.."]) {
      const refused = yield* files.deleteFile({ cwd: fixture.workspace, path });
      expect(parseFilesFailure(failed(refused))).toEqual({
        type: FILES_ERROR,
        operation: "delete",
        phase: "target",
        reason: "directory",
      });
    }

    expect(yield* entries(fixture.workspace)).toEqual(["empty", "full"]);
    expect(yield* readTextFile(join(fixture.workspace, "full/inner.txt"))).toBe("kept");

    // And the same, from a working directory reached through a link — the case
    // that separates "classify the working directory" from "resolve its
    // parent". The link's own name is a final segment, so leaving it
    // unresolved would compare an uncanonical path against a canonical one and
    // report the working directory as an escape.
    yield* linkDirectory(fixture.workspace, join(fixture.root, "ws-link"));
    const throughLink = yield* files.deleteFile({
      cwd: join(fixture.root, "ws-link"),
      path: ".",
    });
    expect(parseFilesFailure(failed(throughLink))).toEqual({
      type: FILES_ERROR,
      operation: "delete",
      phase: "target",
      reason: "directory",
    });
  });

  // HF21: the four paths that never reach a removal, and the proof that they
  // did not. The spy watches the low-level call the provider would make, and an
  // admitted deletion at the end is what makes an empty list evidence rather
  // than a spy that was never wired up.
  it("HF21: an inadmissible or escaping path is refused before any removal", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.outside, "secret.txt"), "SECRET");
    yield* linkDirectory(fixture.outside, join(fixture.workspace, "escape"));
    const attempted: string[] = [];

    yield* scoped(function* () {
      yield* API.Fs.around({
        *remove([path, options], next) {
          attempted.push(path);
          return yield* next(path, options);
        },
      });
      const files = handler();

      const cases: Array<{ path: string; phase: string; reason: string }> = [
        { path: "", phase: "lexical", reason: "empty-path" },
        {
          path: join(fixture.outside, "secret.txt"),
          phase: "lexical",
          reason: "absolute-path",
        },
        { path: "../outside/secret.txt", phase: "lexical", reason: "lexical-escape" },
        { path: "escape/secret.txt", phase: "resolution", reason: "resolved-escape" },
      ];

      for (const refused of cases) {
        const result = yield* files.deleteFile({ cwd: fixture.workspace, path: refused.path });
        expect(parseFilesFailure(failed(result))).toEqual({
          type: FILES_ERROR,
          operation: "delete",
          phase: refused.phase,
          reason: refused.reason,
        });
        expect(inspected(failed(result))).not.toContain(fixture.outside);
        expect(inspected(failed(result))).not.toContain("SECRET");
      }

      yield* writeTextFile(join(fixture.workspace, "ordinary.txt"), "gone soon");
      expect(yield* files.deleteFile({ cwd: fixture.workspace, path: "ordinary.txt" })).toEqual({
        ok: true,
        value: undefined,
      });
    });

    expect(attempted).toEqual([join(fixture.workspace, "ordinary.txt")]);
    expect(yield* readTextFile(join(fixture.outside, "secret.txt"))).toBe("SECRET");
    expect(yield* entries(fixture.outside)).toEqual(["secret.txt"]);
  });

  // HF22: a platform failure during the removal is an ordinary Err carrying a
  // reason and nothing else, and a target that vanished between classification
  // and removal is the same success absence already is.
  it("HF22: a failed removal is a structured Err, and a vanished one is success", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");

    const denied = yield* scoped(function* () {
      yield* API.Fs.around({
        // deno-lint-ignore require-yield
        *remove() {
          throw planted("EPERM");
        },
      });
      return yield* handler().deleteFile({ cwd: fixture.workspace, path: "notes.md" });
    });
    expect(parseFilesFailure(failed(denied))).toEqual({
      type: FILES_ERROR,
      operation: "delete",
      phase: "access",
      reason: "permission-denied",
    });
    expect(inspected(failed(denied))).not.toContain(PLANTED);
    expect(inspected(failed(denied))).not.toContain("EPERM");
    expect(yield* readTextFile(join(fixture.workspace, "notes.md"))).toBe("first");

    const raced = yield* scoped(function* () {
      yield* API.Fs.around({
        // deno-lint-ignore require-yield
        *remove() {
          throw planted("ENOENT");
        },
      });
      return yield* handler().deleteFile({ cwd: fixture.workspace, path: "notes.md" });
    });
    expect(raced).toEqual({ ok: true, value: undefined });
  });

  // HF23: cancellation is not a Result here either. The removal is the single
  // commit point, so a halt before it leaves the entry exactly as it was — and
  // nothing is manufactured to describe what did not happen.
  it("HF23: cancellation before the removal produces no Result and keeps the file", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");
    let settled: unknown = "not settled";

    yield* race([
      scoped(function* () {
        yield* API.Fs.around({
          *remove() {
            yield* suspend();
          },
        });
        settled = yield* handler().deleteFile({ cwd: fixture.workspace, path: "notes.md" });
      }),
      sleep(250),
    ]);

    expect(settled).toBe("not settled");
    expect(yield* readTextFile(join(fixture.workspace, "notes.md"))).toBe("first");
    // Deletion acquires nothing, so a halt leaves no temporary and no leftover.
    expect(yield* entries(fixture.workspace)).toEqual(["notes.md"]);
  });
});

describe("host Files — making a directory exist", () => {
  // HF24: the two things a caller can write, and the guarantee that the
  // operation is finished before anything else happens. A relative path is
  // resolved against the working directory and every missing parent is made; an
  // absolute one names that exact location in the caller's filesystem and is
  // used as written, which is the established `<Dir>` exception and the reason
  // this operation resolves its own destination.
  it("HF24: creates missing parents for a relative path and uses an absolute one as written", function* () {
    const fixture = yield* useFixture();
    const files = handler();

    const nested = yield* files.ensureDirectory({
      cwd: fixture.workspace,
      path: "one/two/three",
    });
    expect(nested.ok).toBe(true);
    expect(yield* exists(join(fixture.workspace, "one", "two", "three"))).toBe(true);

    // Outside the working directory, and accepted: every other operation here
    // refuses an absolute path, so this asserts the exception rather than
    // inheriting it. A relative path spelled to reach the same place is refused
    // just below, which is what makes the two rules distinguishable.
    const elsewhere = join(fixture.outside, "made", "here");
    const absolute = yield* files.ensureDirectory({ cwd: fixture.workspace, path: elsewhere });
    expect(absolute.ok).toBe(true);
    expect(yield* exists(elsewhere)).toBe(true);

    const escaping = yield* files.ensureDirectory({
      cwd: fixture.workspace,
      path: "../outside/climbed",
    });
    expect(parseFilesFailure(failed(escaping))?.reason).toBe("lexical-escape");
    expect(yield* exists(join(fixture.outside, "climbed"))).toBe(false);
  });

  // HF25: an existing directory is the answer already. Nothing is replaced and
  // nothing is cleared — asserted on the bytes, because a provider that removed
  // and recreated the directory would pass a test that only checked it exists.
  it("HF25: an existing directory is used, and its contents are untouched", function* () {
    const fixture = yield* useFixture();
    const files = handler();
    const target = join(fixture.workspace, "existing");
    yield* until(mkdir(target));
    yield* writeTextFile(join(target, "kept.txt"), "the bytes that were here");
    yield* until(mkdir(join(target, "sub")));

    const again = yield* files.ensureDirectory({ cwd: fixture.workspace, path: "existing" });
    expect(again.ok).toBe(true);
    expect(yield* readTextFile(join(target, "kept.txt"))).toBe("the bytes that were here");
    expect(yield* entries(target)).toEqual(["kept.txt", "sub"]);
  });

  // HF26: a file where a directory was asked for is a mistake to report, never
  // a thing to remove. Both positions are covered — the target itself, and an
  // intermediate on the way to it — because they refuse through different code:
  // the target is classified here, the intermediate is the platform's ENOTDIR
  // carried into the shared vocabulary.
  it("HF26: a non-directory at the target or on the way refuses, sanitized", function* () {
    const fixture = yield* useFixture();
    const files = handler();
    yield* writeTextFile(join(fixture.workspace, "occupied"), "a file, not a directory");

    const atTarget = yield* files.ensureDirectory({ cwd: fixture.workspace, path: "occupied" });
    expect(parseFilesFailure(failed(atTarget))).toEqual({
      type: FILES_ERROR,
      operation: "ensure-directory",
      phase: "target",
      reason: "not-directory",
    });
    // The file is still a file: a refusal changed nothing.
    expect(yield* readTextFile(join(fixture.workspace, "occupied"))).toBe(
      "a file, not a directory",
    );

    const through = yield* files.ensureDirectory({
      cwd: fixture.workspace,
      path: "occupied/below/here",
    });
    const failure = parseFilesFailure(failed(through));
    expect(failure?.operation).toBe("ensure-directory");
    expect(failure?.reason).toBe("not-directory");
    // Nothing resolved crosses back: no host path, no errno, no platform text.
    // Asserted on the whole serialized failure, so a member added later that
    // carried one of them would fail here rather than pass unnoticed.
    const serialized = JSON.stringify(failed(through));
    expect(serialized).not.toContain(fixture.workspace);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toMatch(/ENOTDIR|ENOENT|errno/i);
  });

  // HF27: creation is direct and persists. The operation has no rollback and no
  // teardown removal, so a directory made inside a scope that then fails or is
  // cancelled is still there afterwards — which is the whole difference between
  // this provider and the transactional one.
  it("HF27: a created directory survives a later failure and a cancellation", function* () {
    const fixture = yield* useFixture();
    const files = handler();

    yield* scoped(function* () {
      const made = yield* files.ensureDirectory({ cwd: fixture.workspace, path: "kept-on-fail" });
      expect(made.ok).toBe(true);
      try {
        throw new Error("the work inside failed");
      } catch {
        // Swallowed here: what is under test is the directory, not the failure.
      }
    });
    expect(yield* exists(join(fixture.workspace, "kept-on-fail"))).toBe(true);

    const created = withResolvers<void>();
    const task = yield* spawn(function* () {
      const made = yield* files.ensureDirectory({
        cwd: fixture.workspace,
        path: "kept-on-halt",
      });
      expect(made.ok).toBe(true);
      created.resolve();
      yield* suspend();
    });
    // Halted only once the directory exists. Halting a task that had not run
    // yet would assert nothing about teardown — the directory would be absent
    // because it was never created, which is a different result wearing the
    // same shape.
    yield* created.operation;
    yield* task.halt();
    expect(yield* exists(join(fixture.workspace, "kept-on-halt"))).toBe(true);
  });

  // HF28: the operation is about a directory and nothing else. It reads no
  // repository, and a checkout it is pointed inside of is byte-identical after.
  it("HF28: ensuring a directory beneath a checkout leaves the checkout alone", function* () {
    const fixture = yield* useFixture();
    const files = handler();
    const checkout = join(fixture.workspace, "checkout");
    yield* until(mkdir(join(checkout, ".git"), { recursive: true }));
    yield* writeTextFile(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
    yield* writeTextFile(join(checkout, "tracked.txt"), "committed content");

    const made = yield* files.ensureDirectory({ cwd: checkout, path: "generated/output" });
    expect(made.ok).toBe(true);

    expect(yield* readTextFile(join(checkout, ".git", "HEAD"))).toBe("ref: refs/heads/main\n");
    expect(yield* readTextFile(join(checkout, "tracked.txt"))).toBe("committed content");
    expect(yield* entries(checkout)).toEqual([".git", "generated", "tracked.txt"]);
  });
});
