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

class JournalableWorkspaceFailure extends Error {
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
