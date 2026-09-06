/**
 * Reading a retained SQLite value, rather than converting one.
 *
 * `String(null)` is `"null"` and `Number(null)` is `0`. Both are plausible
 * values, and once a damaged row has been converted into one, nothing further
 * down can tell that the store held the wrong type — a client checking shapes
 * sees a well-formed answer. So a retained member is read as the type it is
 * declared to be, and a row that is not that is damage, reported as damage.
 *
 * These are the same rules the accepted owner reads already hold their rows to;
 * they live here so the read plane holds its rows to them too rather than
 * keeping a second, weaker set.
 */

import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import { SHA256 } from "../workspace/root-manifest.ts";
import { bytesOf } from "./encoding.ts";

/** One row as the runtime hands it over. */
export type RetainedRow = Record<string, unknown>;

export function damaged(reason: string): never {
  throw new WorkflowRecordMalformedError("workflow owner storage", reason);
}

/** Non-empty text, or damage. */
export function retainedText(row: RetainedRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value === "") {
    return damaged(`expected ${column} to be non-empty text`);
  }
  return value;
}

/** Non-empty text or a real null, and nothing else. */
export function retainedNullableText(row: RetainedRow, column: string): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value === "") {
    return damaged(`expected ${column} to be non-empty text or null`);
  }
  return value;
}

/** A nonnegative whole number, or damage. */
export function retainedCount(row: RetainedRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return damaged(`expected ${column} to be a nonnegative whole number`);
  }
  return value;
}

/** A lowercase hex content identity, or damage. */
export function retainedDigest(row: RetainedRow, column: string): string {
  const value = retainedText(row, column);
  if (!SHA256.test(value)) {
    return damaged(`expected ${column} to be a content identity`);
  }
  return value;
}

/** A stored byte sequence, copied so the caller holds no cursor memory. */
export function retainedBytes(row: RetainedRow, column: string): Uint8Array {
  try {
    return bytesOf(row[column]);
  } catch {
    return damaged(`expected ${column} to be a byte sequence`);
  }
}

/** One of the object formats this build writes, or damage. */
export function retainedObjectFormat(row: RetainedRow, column: string): "sha1" | "sha256" {
  const value = retainedText(row, column);
  if (value !== "sha1" && value !== "sha256") {
    return damaged(`expected ${column} to name an object format`);
  }
  return value;
}

/** A Workspace-relative path, which is absolute within the Workspace. */
export function retainedPath(row: RetainedRow, column: string): string {
  const value = retainedText(row, column);
  if (!value.startsWith("/")) {
    return damaged(`expected ${column} to be a Workspace path`);
  }
  return value;
}
