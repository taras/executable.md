/**
 * Scanning candidate files with the execution's scanner.
 *
 * The Workflow snapshot path materializes candidate files under a scope-owned
 * temporary directory and must clear every one of them before any Git object
 * exists. It reuses the execution's scanner so a snapshot is held to exactly
 * the rules the journal was.
 *
 * Reads go straight to `@effectionx/fs` rather than through the runtime's
 * `Fs` Context Api. That Api exists so a document can be given a stubbed or
 * sandboxed filesystem, and its middleware is reachable from inside an
 * execution — routing a security scan through it would let the thing being
 * inspected choose what the inspector sees. A trusted scan reads the real
 * files.
 */

import { each, type Operation } from "effection";
import { readTextFile, walk } from "@effectionx/fs";
import type { SecretFinding } from "./findings.ts";
import type { SecretScanner } from "./scanner.ts";

/** A finding together with the file it came from. */
export interface FileSecretFinding extends SecretFinding {
  /** Path of the file the finding was found in. */
  path: string;
}

/**
 * Scan every file under `root`, in memory, and return all findings.
 *
 * Returning findings rather than throwing on the first one lets the caller
 * report everything a snapshot would have leaked instead of one file at a
 * time. An empty result means the candidate is clear.
 */
export function* scanFiles(root: string, scanner: SecretScanner): Operation<FileSecretFinding[]> {
  const findings: FileSecretFinding[] = [];

  for (const entry of yield* each(walk(root, { includeFiles: true, includeDirs: false }))) {
    const content = yield* readTextFile(entry.path);
    for (const finding of yield* scanner.scan(content)) {
      findings.push({ ...finding, path: entry.path });
    }
    yield* each.next();
  }

  return findings;
}
