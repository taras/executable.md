/**
 * The host `API.Files` contract, as an executable a release target can run.
 *
 * `packages/runtime/tests/host-files.test.ts` proves the same contract from
 * source. This exists because the shipped artifact is a compiled binary, and
 * the host adapter reaches `node:path`, `node:fs`, and `node:os` — the modules
 * whose behavior a `deno compile` graph, and the platform it was compiled for,
 * can change. A source suite that passes says nothing about that.
 *
 * So this is deliberately small and self-verifying: it asserts the contract's
 * observable claims and exits non-zero if any does not hold. It prints every
 * claim it checked, because a probe that passes silently is indistinguishable
 * from one that checked nothing.
 *
 * Usage:
 *   deno run --allow-all scripts/files-contract-probe.ts
 *   deno compile --allow-all --output <path> scripts/files-contract-probe.ts
 */

import { ensure, exit, main, scoped } from "effection";
import type { Result } from "effection";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  Files,
  parseFileWriteFailure,
  parseFileWriteSuccess,
  parseFilesFailure,
  parseFilesFatal,
  useHostFiles,
} from "@executablemd/runtime";

const checked: string[] = [];
const failures: string[] = [];

function check(claim: string, held: boolean): void {
  checked.push(claim);
  if (!held) {
    failures.push(claim);
  }
}

function reasonOf<T>(result: Result<T>): string | undefined {
  return result.ok ? undefined : parseFilesFailure(result.error)?.reason;
}

/**
 * A write reports its own shape. Reading one with the non-write parser is how a
 * probe silently checks nothing, so the two are separate here.
 */
function writeReasonOf(result: Result<unknown>): string | undefined {
  return result.ok ? undefined : parseFileWriteFailure(result.error)?.reason;
}

function valueOf<T>(result: Result<T>): T | undefined {
  return result.ok ? result.value : undefined;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A junction is what an unprivileged Windows process gets; elsewhere, a symlink. */
const DIRECTORY_LINK = process.platform === "win32" ? "junction" : "dir";

await main(function* () {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xmd-files-probe-")));
  yield* ensure(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);

  // Absence is checked before a provider exists, so the terminal handler is the
  // one answering.
  let absent: unknown;
  try {
    yield* Files.operations.readTextFile({ cwd: workspace, path: "notes.md" });
  } catch (error) {
    absent = error;
  }
  check(
    "an absent provider throws provider-unavailable",
    parseFilesFatal(absent)?.kind === "provider-unavailable",
  );

  yield* useHostFiles();

  check(
    "an empty path is refused lexically",
    reasonOf(yield* Files.operations.checkFilePath({ cwd: workspace, path: "" })) === "empty-path",
  );
  check(
    "an absolute path is refused lexically",
    reasonOf(
      yield* Files.operations.checkFilePath({ cwd: workspace, path: join(outside, "secret.txt") }),
    ) === "absolute-path",
  );
  check(
    "a lexical escape is refused",
    reasonOf(
      yield* Files.operations.checkFilePath({ cwd: workspace, path: "../outside/secret.txt" }),
    ) === "lexical-escape",
  );
  check(
    "an admissible path is admitted",
    (yield* Files.operations.checkFilePath({ cwd: workspace, path: "notes.md" })).ok,
  );

  const written = yield* Files.operations.writeTextFile({
    cwd: workspace,
    path: "nested/notes.md",
    content: "probe content",
  });
  check(
    "a write commits to the host",
    parseFileWriteSuccess(valueOf(written))?.publication === "host-committed",
  );
  check(
    "the write reads back",
    valueOf(yield* Files.operations.readTextFile({ cwd: workspace, path: "nested/notes.md" })) ===
      "probe content",
  );
  check("the commit left no temporary behind", !exists(join(workspace, "nested/notes.md.tmp")));

  symlinkSync(outside, join(workspace, "escape"), DIRECTORY_LINK);
  check(
    "a directory link out of the working directory is refused",
    writeReasonOf(
      yield* Files.operations.writeTextFile({
        cwd: workspace,
        path: "escape/planted.txt",
        content: "planted",
      }),
    ) === "resolved-escape",
  );
  check("nothing was written through the link", !exists(join(outside, "planted.txt")));

  const found = yield* Files.operations.globFiles({
    cwd: workspace,
    include: ["**/*.md"],
    exclude: [],
  });
  check(
    "the search returns POSIX-relative files",
    JSON.stringify(valueOf(found)) === '["nested/notes.md"]',
  );

  let temporary = "";
  yield* scoped(function* () {
    temporary = valueOf(yield* Files.operations.temporaryDirectory()) ?? "";
    check("a temporary directory is acquired", temporary.length > 0 && exists(temporary));
  });
  check("a temporary directory is removed with its scope", !exists(temporary));

  // Diagnostics rather than a result, so they go to stderr: this probe's whole
  // output is the account of what it checked.
  for (const claim of checked) {
    console.error(`${failures.includes(claim) ? "FAIL" : "ok  "} ${claim}`);
  }
  if (failures.length > 0) {
    console.error(`files contract: ${failures.length} of ${checked.length} claims failed`);
    yield* exit(1);
  }
  console.error(
    `files contract: ${checked.length} claims hold on ${process.platform}/${process.arch}`,
  );
});
