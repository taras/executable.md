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

/**
 * A failure this effect publishes as its own durable outcome instead of raising.
 *
 * The distinction the effect layer needs is not "what went wrong" but "who
 * this belongs to". A failure of this kind is part of what the effect *did*: it
 * is written into the journal as the effect's result, the Workspace root stays
 * where it was, and a replay reproduces it without performing anything. Every
 * other failure is the run failing, and travels as an ordinary raise.
 *
 * It is a base class rather than a predicate over shapes so that being publishable
 * is something a failure declares by construction. A module that wants its own
 * refusal published extends this; nothing acquires the property by resembling
 * something.
 */
export abstract class JournaledEffectFailure extends Error {}

/**
 * Whether this failure is the effect's outcome rather than the run's failure.
 *
 * Asked by the one place that has to choose between writing a result and
 * letting a failure through.
 */
export function isJournaledEffectFailure(error: unknown): error is Error {
  return error instanceof JournaledEffectFailure;
}

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
