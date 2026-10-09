/**
 * How a canonical File mutation reaches a trusted host that journals it.
 *
 * A host that retains repository work has to know *which* occurrence in the
 * document is writing, because that is what names the record a later open
 * restores. Everything a component could read that from is replaceable — a
 * context is addressed by name, a contextual answer is composed by whoever
 * installed a handler — so nothing is read. The engine verifies the live
 * invocation itself, keeps its identity in a terminal private to that one
 * mutation, and the host asks the terminal for it through a continuation that
 * exists only as the argument of one call.
 *
 * The pattern is the Git host's (`packages/git/src/git-host/effect.ts`): one
 * descriptor per invocation under the Api's shared stable name, so public
 * middleware still applies, while the chain ends in this invocation's own
 * default rather than the public one. A descriptor somebody rebuilds reaches
 * its own refusing default and answers for nothing here.
 *
 * Two things follow that are easy to miss. The handler returns no result — it
 * submits one through the continuation, and the caller reads the terminal's
 * private settlement, so a middleware return value cannot author a completion.
 * And the request is compared by object identity rather than by shape: a
 * request rebuilt with the same members describes the same ask and authorizes
 * nothing.
 */

import { createApi } from "@effectionx/context-api";
import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import {
  FILES_API,
  FilesInvariantError,
  FilesProviderUnavailableError,
  parseFileWriteSuccess,
} from "@executablemd/runtime";
import type {
  FilePathInput,
  FileWriteInput,
  FileWriteSuccess,
  FilesHandler,
  GlobInput,
} from "@executablemd/runtime";

/** One frozen request issued by the invocation's private router. */
export interface FileMutationRequest<Input> {
  readonly intent: "route";
  readonly input: Readonly<Input>;
}

/** The trusted provider's continuation to this invocation's private terminal. */
export interface FileMutationNext<Input, Value> {
  /** Read this occurrence's stable ID once, before journal matching or work. */
  (call: {
    readonly intent: "inspect";
    readonly routing: FileMutationRequest<Input>;
  }): Operation<string>;

  /** Submit this request's Files result once, after provider work settles. */
  (call: {
    readonly intent: "answer";
    readonly routing: FileMutationRequest<Input>;
    readonly answer: Result<Value>;
  }): Operation<void>;
}

/** Handle one request; completion is submitted through next. */
export type FileMutationHandler<Input, Value> = (
  args: [routing: FileMutationRequest<Input>],
  next: FileMutationNext<Input, Value>,
) => Operation<void>;

export interface FileMutationHandlers {
  /**
   * Handle the content rendered by one paired File occurrence.
   * Inspect through next before work, then submit the Files write result.
   */
  writeTextFile: FileMutationHandler<FileWriteInput, FileWriteSuccess>;

  /**
   * Handle the path named by one self-closing File.Delete occurrence.
   * Inspect through next before work, then submit the Files deletion result.
   */
  deleteFile: FileMutationHandler<FilePathInput, void>;
}

/**
 * The handler set this execution captured, or nothing when none was supplied.
 *
 * Read once, before any installation runs, on the terms every other
 * trusted-host value travels: two supplied sets are ambiguity rather than a
 * merge, and a set missing either method is a setup refusal rather than a
 * partial capability — a host that journals writes but not deletions would
 * leave a deletion unrecorded inside a checkout it claims to retain.
 */
export function captureFileMutations(
  supplied: readonly (FileMutationHandlers | undefined)[],
): FileMutationHandlers | undefined {
  const sets = supplied.filter((set) => set !== undefined);
  if (sets.length === 0) {
    return undefined;
  }
  if (sets.length > 1) {
    throw new FileMutationSetupError(
      "this execution was given two file-mutation handler sets, and one execution routes its " +
        "canonical File mutations through one host.",
    );
  }
  const set = sets[0];
  const writeTextFile = set?.writeTextFile;
  const deleteFile = set?.deleteFile;
  if (typeof writeTextFile !== "function" || typeof deleteFile !== "function") {
    throw new FileMutationSetupError(
      "a file-mutation handler set supplies both writeTextFile and deleteFile: a host that " +
        "retains writes but not deletions would leave a deletion unrecorded.",
    );
  }
  return Object.freeze({ writeTextFile, deleteFile });
}

/** A file-mutation binding this execution cannot be set up with. */
export class FileMutationSetupError extends Error {
  override name = "FileMutationSetupError";
}

interface Terminal<Input, Value> {
  readonly next: FileMutationNext<Input, Value>;
  accepted(): Result<Value> | undefined;
  close(): void;
}

/**
 * This mutation's authoritative terminal.
 *
 * It answers two private messages in one order and refuses everything else.
 * Refusals are the runtime's own `protocol` invariant: a host that sent a
 * copied, foreign, duplicated or out-of-order message has not described what it
 * did, which is the condition that classification already exists for.
 */
function mutationTerminal<Input, Value>(
  routing: FileMutationRequest<Input>,
  occurrence: string,
  parse: (answer: Result<Value>) => Result<Value> | undefined,
): Terminal<Input, Value> {
  let state: "available" | "inspected" | "answered" = "available";
  let accepted: Result<Value> | undefined;

  function refuse(): never {
    throw new FilesInvariantError("protocol");
  }

  // The two overloads are one implementation, declared rather than asserted:
  // which message arrived is read from the call, not from which signature the
  // caller saw.
  function next(call: {
    readonly intent: "inspect";
    readonly routing: FileMutationRequest<Input>;
  }): Operation<string>;
  function next(call: {
    readonly intent: "answer";
    readonly routing: FileMutationRequest<Input>;
    readonly answer: Result<Value>;
  }): Operation<void>;
  function* next(call: {
    readonly intent: "inspect" | "answer";
    readonly routing: FileMutationRequest<Input>;
    readonly answer?: Result<Value>;
  }): Operation<string | void> {
    // Object identity, not shape: a request rebuilt with the same members
    // describes the same ask and authorizes nothing.
    if (!Object.is(call.routing, routing)) {
      refuse();
    }
    if (call.intent === "inspect") {
      if (state !== "available") {
        refuse();
      }
      state = "inspected";
      return occurrence;
    }
    if (state !== "inspected" || call.answer === undefined) {
      refuse();
    }
    // Validated before it is recorded, so a result this boundary cannot read is
    // refused while there is still nothing to hand back.
    const answer = parse(call.answer);
    if (answer === undefined) {
      refuse();
    }
    accepted = answer;
    state = "answered";
  }

  return {
    next,
    accepted: () => accepted,
    close: () => {
      state = "answered";
    },
  };
}

/**
 * Run one handler over one frozen request and answer with what it submitted.
 *
 * A handler that returns without submitting has provided no completion, and
 * that is a protocol invariant rather than an empty success: the mutation may
 * or may not have happened, and nothing here can tell which.
 */
function* submitted<Input, Value>(
  handler: FileMutationHandler<Input, Value>,
  occurrence: string,
  input: Input,
  parse: (answer: Result<Value>) => Result<Value> | undefined,
): Operation<Result<Value>> {
  const routing: FileMutationRequest<Input> = Object.freeze({
    intent: "route",
    input: Object.freeze(input),
  });
  const terminal = mutationTerminal(routing, occurrence, parse);
  try {
    yield* handler([routing], terminal.next);
  } catch (error) {
    // An answer already accepted is what this mutation produced. A handler that
    // threw afterwards is reporting on work that already happened.
    if (terminal.accepted() === undefined) {
      throw error;
    }
  } finally {
    terminal.close();
  }
  const answer = terminal.accepted();
  if (answer === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return answer;
}

/** The write outcome a host may submit, validated and detached. */
function writeAnswer(answer: Result<FileWriteSuccess>): Result<FileWriteSuccess> | undefined {
  if (!answer.ok) {
    return answer.error instanceof Error ? Err(answer.error) : undefined;
  }
  const success = parseFileWriteSuccess(answer.value);
  return success === undefined ? undefined : Ok(success);
}

/**
 * The deletion outcome a host may submit.
 *
 * Success carries no value at all, on the Files contract's own terms: a
 * document that asked for a file to be gone has been answered by its absence.
 */
function deleteAnswer(answer: Result<void>): Result<void> | undefined {
  if (!answer.ok) {
    return answer.error instanceof Error ? Err(answer.error) : undefined;
  }
  return answer.value === undefined ? Ok(undefined) : undefined;
}

/**
 * The members of this invocation's own Files descriptor it never invokes.
 *
 * Present because the Api is one shape, unreachable because an invocation
 * enters exactly one of them: everything else a middleware calls travels
 * through the ordinary shared descriptor and reaches the installed provider.
 */
function unreachable() {
  // deno-lint-ignore require-yield
  function* refuse(): Operation<never> {
    throw new FilesProviderUnavailableError();
  }
  return {
    *checkFilePath(_input: FilePathInput): Operation<Result<void>> {
      return yield* refuse();
    },
    *readTextFile(_input: FilePathInput): Operation<Result<string>> {
      return yield* refuse();
    },
    *ensureDirectory(_input: FilePathInput): Operation<Result<void>> {
      return yield* refuse();
    },
    *globFiles(_input: GlobInput): Operation<Result<string[]>> {
      return yield* refuse();
    },
    *temporaryDirectory(): Operation<Result<string>> {
      return yield* refuse();
    },
  };
}

/**
 * An authored mutation, through the ordinary Files chain and out to the host.
 *
 * Public middleware sees the request data it has always seen and may observe,
 * narrow, refuse or delegate it. What it cannot do is answer: the value the
 * chain returns is never read, and the result comes from the terminal the
 * narrowed request finally reached. A middleware that does not delegate
 * establishes nothing at all.
 */
export function* routeAuthoredWrite(
  handlers: FileMutationHandlers,
  occurrence: string,
  input: FileWriteInput,
): Operation<Result<FileWriteSuccess>> {
  let settled: Result<FileWriteSuccess> | undefined;
  const descriptor = createApi<FilesHandler>(FILES_API, {
    ...unreachable(),
    *writeTextFile(final: FileWriteInput): Operation<Result<FileWriteSuccess>> {
      if (settled !== undefined) {
        throw new FilesInvariantError("protocol");
      }
      settled = yield* submitted(handlers.writeTextFile, occurrence, final, writeAnswer);
      return settled;
    },
    *deleteFile(_input: FilePathInput): Operation<Result<void>> {
      throw new FilesInvariantError("protocol");
    },
  });
  yield* descriptor.operations.writeTextFile(input);
  if (settled === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return settled;
}

/** An authored deletion, on the same terms. */
export function* routeAuthoredDelete(
  handlers: FileMutationHandlers,
  occurrence: string,
  input: FilePathInput,
): Operation<Result<void>> {
  let settled: Result<void> | undefined;
  const descriptor = createApi<FilesHandler>(FILES_API, {
    ...unreachable(),
    *writeTextFile(_input: FileWriteInput): Operation<Result<FileWriteSuccess>> {
      throw new FilesInvariantError("protocol");
    },
    *deleteFile(final: FilePathInput): Operation<Result<void>> {
      if (settled !== undefined) {
        throw new FilesInvariantError("protocol");
      }
      settled = yield* submitted(handlers.deleteFile, occurrence, final, deleteAnswer);
      return settled;
    },
  });
  yield* descriptor.operations.deleteFile(input);
  if (settled === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return settled;
}

/**
 * A generated mutation, straight to the host.
 *
 * A fragment's capabilities are captured before any document code exists and
 * deliberately bypass ambient Files and Env routing, so this enters the same
 * terminal protocol without the public chain: what the fragment may write was
 * already decided by the ceiling its admission was held to.
 */
export function routeGeneratedWrite(
  handlers: FileMutationHandlers,
  occurrence: string,
  input: FileWriteInput,
): Operation<Result<FileWriteSuccess>> {
  return submitted(handlers.writeTextFile, occurrence, input, writeAnswer);
}

/** A generated deletion, on the same terms. */
export function routeGeneratedDelete(
  handlers: FileMutationHandlers,
  occurrence: string,
  input: FilePathInput,
): Operation<Result<void>> {
  return submitted(handlers.deleteFile, occurrence, input, deleteAnswer);
}
