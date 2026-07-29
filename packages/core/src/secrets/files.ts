/**
 * Scanning candidate files with the execution's scanner.
 *
 * The Workflow snapshot path materializes candidate files under a scope-owned
 * temporary directory and must clear every one of them before any Git object
 * exists. It reuses the execution's scanner so a snapshot is held to exactly
 * the rules the journal was.
 *
 * ## Why this module does not use `@effectionx/fs`
 *
 * The repository rule is to reach the filesystem through `@effectionx/fs`,
 * and this module deliberately does not. That package's `readTextFile` and
 * `walk` are `FsApi.operations.*` — a Context Api — so `FsApi.around()`
 * replaces them for the current scope, exactly as `API.Fs.around()` replaces
 * the runtime's. Both are reachable from inside an execution, and eval blocks
 * can import anything.
 *
 * A scan that reads through either one lets the thing being inspected choose
 * what the inspector sees: middleware returning clean text for a file that
 * holds a credential defeats the check completely. So the reads here go to
 * `node:fs/promises`, which has no interception point, adapted with `until`.
 * The rule is about consistent I/O plumbing; this is a trust boundary, and
 * the two goals genuinely conflict here.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { SecretFinding } from "./findings.ts";
import type { SecretScanner } from "./scanner.ts";

/**
 * A finding from a candidate file, and what it was found in.
 *
 * A content finding names the file it came from — its path has already been
 * scanned and cleared by then, so reporting it leaks nothing. A path finding
 * deliberately carries no path at all: the offending value *is* the path, and
 * Git persists tree-entry names, so naming it in a report would republish the
 * credential the scan exists to stop.
 */
export type FileSecretFinding =
  | (SecretFinding & {
      subject: "content";
      /** Root-relative path of the file. Scanned and clean. */
      path: string;
    })
  | (SecretFinding & {
      subject: "path";
    });

/**
 * A candidate that cannot be scanned safely, so it is not published.
 *
 * Carries no path, no link target, and no cause. The name of an offending
 * entry can itself be the credential, and a symlink target can point at one,
 * so the diagnostic says what happened and nothing about where.
 */
export class CandidateRejectedError extends Error {
  constructor(reason: string) {
    super(
      `secret detection refused a snapshot candidate: ${reason}. ` +
        `Details are withheld because a path or link target can itself carry a credential.`,
    );
    this.name = "CandidateRejectedError";
  }
}

/**
 * Scan every file under `root`, in memory, and return all findings.
 *
 * Each entry's root-relative path is scanned before its content, because Git
 * persists tree-entry names as surely as blobs. Only the portion below `root`
 * is ever scanned or reported — the temporary directory prefix is an artifact
 * of how the candidate was staged and has nothing to do with the snapshot.
 *
 * Returning findings rather than throwing on the first one lets the caller
 * report everything a snapshot would have leaked instead of one file at a
 * time. An empty result means the candidate is clear.
 *
 * Symbolic links are refused outright rather than followed. A link can reach
 * outside the candidate entirely, so scanning what it points at would say
 * nothing about what Git would store. Supporting them is a separate design.
 */
export function* scanFiles(root: string, scanner: SecretScanner): Operation<FileSecretFinding[]> {
  const findings: FileSecretFinding[] = [];
  yield* scanDirectory(root, root, scanner, findings);
  return findings;
}

function* scanDirectory(
  root: string,
  directory: string,
  scanner: SecretScanner,
  findings: FileSecretFinding[],
): Operation<void> {
  const entries = yield* until(readdir(directory, { withFileTypes: true }));

  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    // Dirent types come from lstat, so a link is seen as a link rather than
    // as whatever it points at.
    if (entry.isSymbolicLink()) {
      throw new CandidateRejectedError("it contains a symbolic link");
    }

    // POSIX separators keep a path scanning the same on every platform.
    const path = relative(root, absolute).split(sep).join("/");
    const inPath = yield* scanner.scan(path);

    if (inPath.length > 0) {
      // Deliberately no `path` — reporting it would republish the credential.
      findings.push(...inPath.map((finding) => ({ ...finding, subject: "path" as const })));
      continue;
    }

    if (entry.isDirectory()) {
      yield* scanDirectory(root, absolute, scanner, findings);
      continue;
    }

    if (!entry.isFile()) {
      throw new CandidateRejectedError(
        "it contains an entry that is neither a file nor a directory",
      );
    }

    const content = yield* until(readFile(absolute, "utf8"));
    findings.push(
      ...(yield* scanner.scan(content)).map((finding) => ({
        ...finding,
        subject: "content" as const,
        path,
      })),
    );
  }
}
