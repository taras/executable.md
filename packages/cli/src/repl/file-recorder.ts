import { createContext, Err, Ok, scoped, useScope } from "effection";
import type { Operation, Result } from "effection";
import {
  FilesInvariantError,
  filesFailure,
  fileWriteFailure,
  parseFilesFailure,
  parseFileWriteFailure,
  parseFileWriteSuccess,
} from "@executablemd/runtime";
import type {
  FileCopyInput,
  FilesHandler,
  FilesOperation,
  FilesPhase,
  FilePathInput,
  FileWriteSuccess,
} from "@executablemd/runtime";
import {
  registerFileRecorder,
  assembleFileCall,
  withHostCopyRoute,
} from "@executablemd/runtime/files-host";
import {
  checkCopyPublication,
  copyReplayContext,
  recordedLocalOperation,
  retainedCopyAhead,
  ReplLocalRecordError,
  retainedSelectionAhead,
  failCopy,
} from "./repositories/deno/local.ts";
import type { LocalOperation } from "./repositories/deno/local.ts";
import type { Around } from "@effectionx/context-api";
import type { AuthoredFileOperation } from "@executablemd/core/host";
import type {
  ReplLocalOperation,
  ReplLocalRequest,
  ReplLocalValue,
} from "./repositories/records.ts";

export type FileRecordingRoute = (
  operation: ReplLocalOperation,
  request: ReplLocalRequest,
  perform: () => Operation<Result<ReplLocalValue>>,
  authored?: AuthoredFileOperation,
) => Operation<Result<ReplLocalValue>>;
export interface EntryFileCalls {
  read(authored: AuthoredFileOperation, input: FilePathInput): Operation<Result<string>>;
  ensure(authored: AuthoredFileOperation, input: FilePathInput): Operation<Result<void>>;
}
interface CopyRouting {
  guard(): Operation<void>;
  observe?(input: FilePathInput): Operation<Result<void>>;
  restoreSelection?(): Operation<unknown>;
  route(source: string, destination: string): Operation<Operation<void> | undefined>;
}

function copyRecorder(routing: CopyRouting) {
  const nextOrdinal = new Map<string, number>();
  return function* (
    input: FileCopyInput,
    perform: () => Operation<Result<void>>,
  ): Operation<Result<void>> {
    const context = yield* copyReplayContext();
    const ordinal = nextOrdinal.get(context.coroutineId) ?? 0;
    nextOrdinal.set(context.coroutineId, ordinal + 1);
    const identity: Pick<LocalOperation, "operation" | "ordinal" | "request"> = {
      operation: "file-copy",
      ordinal,
      request: { cwd: input.cwd, source: input.source, path: input.destination },
    };
    yield* routing.guard();
    if (routing.restoreSelection !== undefined && (yield* retainedSelectionAhead())) {
      yield* routing.restoreSelection();
    }
    if (yield* retainedCopyAhead(ordinal)) {
      const result = yield* recordedLocalOperation({
        ...identity,
        *perform() {
          throw new ReplLocalRecordError("Cannot perform a retained file-copy occurrence live.");
        },
      });
      return result.ok ? Ok(undefined) : result;
    }

    let covered = false;
    let result: Result<ReplLocalValue>;
    try {
      result = yield* scoped(() =>
        withHostCopyRoute(
          function* (source, destination) {
            try {
              yield* copyReplayContext();
              const hold = yield* routing.route(source, destination);
              if (hold !== undefined) {
                yield* checkCopyPublication();
                yield* hold;
                covered = true;
              }
              yield* copyReplayContext();
            } catch (error) {
              // A delegating layer may recover before the composed call settles.
              throw yield* failCopy(error);
            }
          },
          (function* () {
            return yield* unitOutcome(perform(), { operation: "copy", phase: "access" });
          })(),
        ),
      );
    } catch (error) {
      throw yield* failCopy(error);
    }
    yield* copyReplayContext();
    if (covered) {
      result = yield* recordedLocalOperation({
        ...identity,
        perform: function* () {
          return result;
        },
      });
    }
    return result.ok ? Ok(undefined) : result;
  };
}

function recordingBody(
  route: FileRecordingRoute,
  copy: ReturnType<typeof copyRecorder> | undefined,
  routing: CopyRouting,
) {
  return {
    *read(
      input: FilePathInput,
      perform: () => Operation<Result<string>>,
      authored?: AuthoredFileOperation,
    ): Operation<Result<string>> {
      const result = yield* route(
        "file-read",
        { ...input },
        () => textOutcome(perform()),
        authored,
      );
      return result.ok ? Ok(expectText(result.value)) : result;
    },
    *ensure(
      input: FilePathInput,
      perform: () => Operation<Result<void>>,
      authored?: AuthoredFileOperation,
    ): Operation<Result<void>> {
      const result = yield* route(
        "dir-ensure",
        { ...input },
        () => unitOutcome(perform(), { operation: "ensure-directory", phase: "access" }),
        authored,
      );
      return result.ok ? Ok(undefined) : result;
    },
    boundary(): Partial<Around<FilesHandler>> {
      const body = this;
      return {
        *readTextFile([input], next) {
          if (input.transform === undefined) {
            return yield* body.read(input, () => next(input));
          }
          yield* routing.guard();
          const permitted =
            routing.observe === undefined ? Ok(undefined) : yield* routing.observe(input);
          return permitted.ok ? yield* next(input) : permitted;
        },
        ensureDirectory: ([input], next) => body.ensure(input, () => next(input)),
        *writeTextFile([input], next) {
          const result = yield* route("file-write", { ...input }, () => writeOutcome(next(input)));
          return result.ok ? Ok(expectWritten(result.value)) : result;
        },
        ...(copy === undefined
          ? {}
          : {
              copyFile: ([input], next) => copy(input, () => next(input)),
            }),
        *deleteFile([input], next) {
          const result = yield* route("file-delete", { ...input }, () =>
            unitOutcome(next(input), { operation: "delete", phase: "access" }),
          );
          return result.ok ? Ok(undefined) : result;
        },
      };
    },
  };
}
const entryCopyInstalled = createContext<boolean>("executablemd.repl.entry-copy-installed");

export function* useEntryFileRecorder(
  route: FileRecordingRoute,
  copy: CopyRouting,
): Operation<EntryFileCalls> {
  // Repository initialization can precede mount fallback in the same execution.
  const scope = yield* useScope();
  const alreadyInstalled = scope.hasOwn(entryCopyInstalled);
  scope.set(entryCopyInstalled, true);
  const body = recordingBody(route, alreadyInstalled ? undefined : copyRecorder(copy), copy);
  const handle = yield* registerFileRecorder(body.boundary());
  const read = assembleFileCall(handle, "readTextFile");
  const ensure = assembleFileCall(handle, "ensureDirectory");
  return Object.freeze({
    read: (authored: AuthoredFileOperation, input: FilePathInput) =>
      body.read(input, () => read(input), authored),
    ensure: (authored: AuthoredFileOperation, input: FilePathInput) =>
      body.ensure(input, () => ensure(input), authored),
  });
}
function* writeOutcome(call: Operation<Result<unknown>>): Operation<Result<ReplLocalValue>> {
  const produced: unknown = yield* call;
  const settled = settlement(produced);
  if (settled === undefined) {
    throw new FilesInvariantError("protocol");
  }
  if (settled) {
    const carried = read(produced, "value");
    if (carried === undefined) {
      throw new FilesInvariantError("protocol");
    }
    const success = parseFileWriteSuccess(carried.value);
    if (success === undefined) {
      throw new FilesInvariantError("protocol");
    }
    return Ok(success);
  }
  const reported = read(produced, "error");
  if (reported === undefined) {
    throw new FilesInvariantError("protocol");
  }
  const data = parseFileWriteFailure(reported.value);
  if (data === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return Err(
    fileWriteFailure({
      phase: data.phase,
      ...(data.reason === undefined ? {} : { reason: data.reason }),
      ...(data.cleanup === undefined ? {} : { cleanup: data.cleanup }),
    }),
  );
}

/**
 * The read outcome the composition answered with, normalized before it is kept.
 *
 * Core's rules for a payload-carrying non-write operation: a readable boolean
 * settlement, a `value` that is really a string, and — where it failed — the
 * generic ordinary refusal for failure data this version does not recognize,
 * because an unrecognized reason still described a failure and the document
 * carries on past it.
 */
function* textOutcome(call: Operation<Result<string>>): Operation<Result<ReplLocalValue>> {
  const produced: unknown = yield* call;
  const settled = settlement(produced);
  if (settled === undefined) {
    throw new FilesInvariantError("protocol");
  }
  if (!settled) {
    const reported = read(produced, "error");
    if (reported === undefined) {
      throw new FilesInvariantError("protocol");
    }
    const data = parseFilesFailure(reported.value);
    if (data === undefined || data.operation !== "read") {
      return Err(filesFailure({ operation: "read", phase: "access", reason: "operation-failed" }));
    }
    return Err(filesFailure({ operation: data.operation, phase: data.phase, reason: data.reason }));
  }
  const carried = read(produced, "value");
  if (carried === undefined || typeof carried.value !== "string") {
    throw new FilesInvariantError("protocol");
  }
  return Ok(carried.value);
}

/**
 * The outcome of the two operations that answer with nothing, normalized.
 *
 * Core's rules, kept exactly. A success carries no payload at all, so an
 * *absent* `value` is the ordinary answer; one that cannot be read, and one
 * that is present but is not `undefined`, are both provider-contract failures.
 *
 * A failure is where the two differ from a write, and the difference matters: an
 * `error` that reads fine but carries data this version does not recognize *did*
 * describe a failure, just not a known one, so it becomes the generic ordinary
 * refusal and the document carries on. Only an `error` that is absent or
 * unreadable is fatal.
 */
function* unitOutcome(
  call: Operation<Result<void>>,
  contract: { readonly operation: FilesOperation; readonly phase: FilesPhase },
): Operation<Result<ReplLocalValue>> {
  const produced: unknown = yield* call;
  const settled = settlement(produced);
  if (settled === undefined) {
    throw new FilesInvariantError("protocol");
  }
  if (!settled) {
    const reported = read(produced, "error");
    if (reported === undefined) {
      throw new FilesInvariantError("protocol");
    }
    const data = parseFilesFailure(reported.value);
    if (data === undefined || data.operation !== contract.operation) {
      return Err(
        filesFailure({
          operation: contract.operation,
          phase: contract.phase,
          reason: "operation-failed",
        }),
      );
    }
    return Err(filesFailure({ operation: data.operation, phase: data.phase, reason: data.reason }));
  }
  const carried = present(produced, "value");
  if (carried === undefined) {
    throw new FilesInvariantError("protocol");
  }
  if (carried) {
    // Present, so it has to be readable *and* be the absent payload. Asking
    // only whether the value is `undefined` would let a member that refused to
    // be read pass as one that read as nothing.
    const value = read(produced, "value");
    if (value === undefined || value.value !== undefined) {
      throw new FilesInvariantError("protocol");
    }
  }
  return Ok(undefined);
}

/**
 * Whether a member is there at all, or `undefined` when asking threw.
 *
 * Core's reader, because this boundary reads the same provider-controlled
 * values it does. Absence and unreadability are different answers and only one
 * of them is ever legitimate, and a `has` trap can refuse the question.
 */
function present(target: unknown, name: string): boolean | undefined {
  if (typeof target !== "object" || target === null) {
    return undefined;
  }
  try {
    return Reflect.has(target, name);
  } catch {
    return undefined;
  }
}

/**
 * A member of a value this code did not create, boxed so that an absent member
 * is distinguishable from one that could not be read.
 */
function read(target: unknown, name: string): { readonly value: unknown } | undefined {
  if (present(target, name) !== true) {
    return undefined;
  }
  try {
    return { value: Reflect.get(Object(target), name) };
  } catch {
    return undefined;
  }
}

/**
 * Whether this container said it succeeded, as a boolean it really carries.
 *
 * Truthiness is not the question: a provider whose `ok` is a string has not
 * described a settlement, and reading it as success would record an outcome
 * core is about to refuse.
 */
function settlement(result: unknown): boolean | undefined {
  const ok = read(result, "ok");
  return typeof ok?.value === "boolean" ? ok.value : undefined;
}

/**
 * The write success a recorded write answers with.
 *
 * A record of a write carries one by construction, so an absent payload here is
 * this host's own invariant rather than anything a provider did.
 */
function expectWritten(value: ReplLocalValue): FileWriteSuccess {
  if (value === undefined || typeof value === "string") {
    throw new FilesInvariantError("protocol");
  }
  return value;
}

/**
 * The text a recorded read answers with.
 *
 * A record of a read carries a string by construction, so anything else here is
 * this host's own invariant rather than anything a provider did.
 */
function expectText(value: ReplLocalValue): string {
  if (typeof value !== "string") {
    throw new FilesInvariantError("protocol");
  }
  return value;
}
