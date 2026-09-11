const JOURNALABLE_CODES = new Set([
  "ENOENT",
  "ENOTEMPTY",
  "ENOTDIR",
  "EISDIR",
  "EEXIST",
  "EINVAL",
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSYS",
  "EBADF",
  "ELOOP",
]);

export { isJournaledEffectFailure, JournaledEffectFailure } from "../../workspace/failure.ts";

import { JournaledEffectFailure } from "../../workspace/failure.ts";

class JournalableWorkspaceFailure extends JournaledEffectFailure {
  override name = "WorkspaceFsError";
  readonly code: string;

  constructor(source: Error, code: string) {
    super(source.message, { cause: source });
    this.code = code;
  }
}

function journalableCode(error: unknown): string | undefined {
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  if (
    error instanceof Error &&
    error.name === "WorkspaceFsError" &&
    typeof code === "string" &&
    JOURNALABLE_CODES.has(code)
  ) {
    return code;
  }
  return undefined;
}

export function throwWorkspaceFilesystemFailure(error: unknown): never {
  const code = journalableCode(error);
  if (error instanceof Error && code !== undefined) {
    throw new JournalableWorkspaceFailure(error, code);
  }
  throw error;
}

export function isJournalableWorkspaceFailure(error: unknown): error is Error {
  return error instanceof JournalableWorkspaceFailure;
}

/**
 * The documented filesystem condition this failure is, or `undefined` for one
 * that is not documented.
 *
 * The code is the only part of a DOFS failure anything above this module reads.
 * Its message, its cause and the paths either of them names stay here, so a
 * consumer selecting a `FilesReason` from this receives a condition rather than
 * platform text.
 */
export function journalableWorkspaceCode(error: unknown): string | undefined {
  return error instanceof JournalableWorkspaceFailure ? error.code : undefined;
}
