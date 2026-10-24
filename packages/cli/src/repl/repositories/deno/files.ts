/**
 * The file work one REPL entry records, and the work it simply performs.
 *
 * Checkout routing takes precedence over the marked entry's owned workspace.
 * Outside both, file work remains ordinary and unrecorded. Workspace-only work
 * uses the existing local-operation records without a Git lease.
 *
 * A managed placement is looked for first, and the most specific one wins. The
 * entry's ambient checkout answers for everything no placement covers, which is
 * what keeps an entry that selects nothing working exactly as it did before.
 *
 * Inside either the call goes through this entry's durable boundary: the
 * composition beneath performs it, and what it produced is recorded once. A
 * completed read answers with the text it answered with the first time and a
 * completed write answers from its receipt, each touching no file, however the
 * file has changed since.
 *
 * A new mutation also takes the checkout's lease, and a new read does not.
 * Being retained and being exclusive are different questions: what the lease
 * answers is that one entry at a time changes a repository, so a read proceeds
 * while another entry holds it and never holds it itself.
 *
 * A managed placement adds the other hold, and it answers a different question:
 * one entry at a time *owns* a managed slot. A restored placement took none
 * when it replayed, so the first new operation inside it — a read included —
 * takes the slot before it is performed.
 *
 * ## One route, one policy
 *
 * `<File>` reads and writes, `<File.Delete />` and `<Dir>` all arrive as
 * ordinary `API.Files` calls, and a generated fragment's operations cross that
 * same route, so the recording is ordinary middleware over the four operations
 * this feature retains and nothing else. A Glob, a path check and a temporary
 * directory bind nothing a continuation has to answer again, and are left
 * alone.
 *
 * What the middleware sees is the request as it arrived and the `Result` as the
 * composition answered. A middleware beneath that transforms the path or the
 * content is provider behavior rather than a second authored identity, so the
 * received request stays the operation's name.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { isAbsolute, join, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { until } from "effection";
import {
  FilesInvariantError,
  fileWriteFailure,
  filesFailure,
  parseFilesFailure,
  parseFileWriteFailure,
  parseFileWriteSuccess,
} from "@executablemd/runtime";
import type {
  FilesHandler,
  FilesOperation,
  FilesPhase,
  FileWriteSuccess,
} from "@executablemd/runtime";
import type { Around } from "@effectionx/context-api";
import {
  localRecordName,
  recordedLocalOperation,
  retainedResultAhead,
  retainedSelectionAhead,
} from "./local.ts";
import type {
  ReplAmbientCheckout,
  ReplLocalOperation,
  ReplLocalRequest,
  ReplLocalValue,
} from "../records.ts";

/**
 * One managed checkout this entry selected, as file routing needs it.
 *
 * The two routing facts and the one thing a restored placement still has to do
 * before it is written in: take the slot back. A completed selection recorded
 * where the checkout is and took no lease, so the first genuinely new operation
 * inside it is what takes it back — without rerunning the selector or looking at
 * what the checkout now holds.
 */
export interface ReplManagedPlacement {
  /** The canonical root of the selected checkout. */
  readonly checkoutRoot: string;
  /** The canonical common Git directory it belongs to. */
  readonly commonDirectory: string;
  /** Take ownership of its managed slot for the entry, or refuse. */
  own(): Operation<void>;
}

/** What the entry knows about where it is working and what it may hold. */
export interface ReplLocalRecorder {
  /**
   * This entry's ambient routing, restored from the journal or discovered live.
   *
   * An operation because discovery is lazy: the first mutation is what looks for
   * a checkout, and an entry that makes none never looks.
   */
  selection(): Operation<ReplAmbientCheckout | undefined>;
  /**
   * Hold the shared Git directory this entry is about to mutate in, or refuse.
   *
   * Asked once per entry and shared by every later request, so the lease belongs
   * to the entry rather than to the element that first needed it.
   */
  hold(commonDirectory: string): Operation<void>;
  /**
   * The managed checkouts this entry has registered, as they stand now.
   *
   * Not an operation: membership is rebuilt by selections that already
   * happened, so reading it acquires nothing. A placement stays registered for
   * the rest of the entry, which is what lets a self-closing `<Worktree>` bind
   * a path a later `<Dir>` sibling renders at.
   */
  placements(): readonly ReplManagedPlacement[];
  validateObservationTarget(target: string): Operation<void>;
}

/** The middleware that records this entry's authored mutations. */
export function replFileMiddleware(
  recorder: ReplLocalRecorder,
  workspace?: string,
): Partial<Around<FilesHandler>> {
  return {
    *readTextFile([input], next): Operation<Result<string>> {
      const produced = yield* routed(
        recorder,
        "file-read",
        { cwd: input.cwd, path: input.path },
        function* () {
          return yield* textOutcome(next(input));
        },
        workspace,
      );
      return produced.ok ? Ok(expectText(produced.value)) : produced;
    },
    *writeTextFile([input], next): Operation<Result<FileWriteSuccess>> {
      const produced = yield* routed(
        recorder,
        "file-write",
        { cwd: input.cwd, path: input.path, content: input.content },
        function* () {
          return yield* writeOutcome(next(input));
        },
        workspace,
      );
      return produced.ok ? Ok(expectWritten(produced.value)) : produced;
    },
    *deleteFile([input], next): Operation<Result<void>> {
      const produced = yield* routed(
        recorder,
        "file-delete",
        { cwd: input.cwd, path: input.path },
        function* () {
          return yield* unitOutcome(next(input), { operation: "delete", phase: "access" });
        },
        workspace,
      );
      return produced.ok ? Ok(undefined) : produced;
    },
    *ensureDirectory([input], next): Operation<Result<void>> {
      const produced = yield* routed(
        recorder,
        "dir-ensure",
        { cwd: input.cwd, path: input.path },
        function* () {
          return yield* unitOutcome(next(input), {
            operation: "ensure-directory",
            phase: "access",
          });
        },
        workspace,
      );
      return produced.ok ? Ok(undefined) : produced;
    },
  };
}

/**
 * Answer this request from the journal, or route it and perform it live.
 *
 * The retained cursor is read before the filesystem, because resolving a path is
 * work a saved result is not about: a continuation whose checkout has since been
 * removed answers from what it already recorded rather than failing at a
 * question nobody asked. Saved routing is restored first for the same reason —
 * it stands at the cursor ahead of the operation that discovered it.
 */
function* routed(
  recorder: ReplLocalRecorder,
  operation: ReplLocalOperation,
  request: ReplLocalRequest,
  perform: () => Operation<Result<ReplLocalValue>>,
  workspace: string | undefined,
): Operation<Result<ReplLocalValue>> {
  const name = yield* localRecordName({ operation, request });
  if (yield* retainedSelectionAhead()) {
    yield* recorder.selection();
  }
  if (yield* retainedResultAhead(name)) {
    return yield* recordedLocalOperation({ operation, request, perform });
  }

  const target = yield* targetOf(request);
  yield* recorder.validateObservationTarget(target);
  const managed = covering(recorder.placements(), target);
  if (managed !== undefined) {
    // Placement ownership first, and for a read as much as for a write: what it
    // answers is that one entry at a time owns this managed checkout, which an
    // observation inside it needs as much as a change does.
    yield* managed.own();
    return yield* held(recorder, managed.commonDirectory, { operation, request, perform });
  }
  const checkout = yield* recorder.selection();
  if (checkout === undefined || !inside(checkout.checkoutRoot, target)) {
    if (workspace !== undefined) {
      const root = yield* canonical(workspace);
      const lexical = resolve(workspace);
      const resolvedTarget =
        target === lexical || inside(lexical, target)
          ? resolve(root, relative(lexical, target))
          : target;
      if (root === resolvedTarget || inside(root, resolvedTarget)) {
        return yield* recordedLocalOperation({ operation, request, perform });
      }
    }
    return yield* perform();
  }
  return yield* held(recorder, checkout.commonDirectory, { operation, request, perform });
}

/**
 * Record this operation, holding the shared Git directory when it changes one.
 *
 * Only a mutation takes the lease. A read is retained like the rest, but the
 * lease is about one entry at a time *changing* a repository, and an
 * observation is not a change: a read that took it would refuse while somebody
 * else is working, and refuse them while it is only looking.
 */
function* held(
  recorder: ReplLocalRecorder,
  commonDirectory: string,
  operation: {
    readonly operation: ReplLocalOperation;
    readonly request: ReplLocalRequest;
    perform(): Operation<Result<ReplLocalValue>>;
  },
): Operation<Result<ReplLocalValue>> {
  if (operation.operation !== "file-read") {
    yield* recorder.hold(commonDirectory);
  }
  return yield* recordedLocalOperation(operation);
}

/**
 * The managed checkout this path belongs to, most specific first.
 *
 * The checkout root itself counts, which is where this differs from the ambient
 * route below it. A self-closing `<Worktree>` binds its path and a `<Dir>`
 * sibling then ensures exactly that directory, and an entry that recorded
 * selecting it has recorded what `<Dir>` is standing in — so the ensure is
 * retained rather than treated as ordinary work beside the document.
 *
 * A nested selection's checkout is never inside its owner's, so "most specific"
 * is about a path addressed through a placement registered more than once and
 * about the managed root layout, not about resolving an ambiguity between a
 * Repository and its Worktree.
 */
function covering(
  placements: readonly ReplManagedPlacement[],
  target: string,
): ReplManagedPlacement | undefined {
  let found: ReplManagedPlacement | undefined;
  for (const placement of placements) {
    if (target !== placement.checkoutRoot && !inside(placement.checkoutRoot, target)) {
      continue;
    }
    if (found === undefined || placement.checkoutRoot.length > found.checkoutRoot.length) {
      found = placement;
    }
  }
  return found;
}

/**
 * Where this request points.
 *
 * An absolute path names a place on its own, and the working directory is no
 * part of where it points — which is how a captured checkout path reaches a
 * `<Dir>`. Joining the two would have routed `/managed/…/checkout` as
 * `/ambient/managed/…/checkout`, a place inside no placement at all, so a
 * completed ensure was never retained and a new one took no ownership of the
 * checkout it was making a directory in. The ordinary operation beneath has
 * always used the absolute target by itself; this is the route agreeing with it.
 *
 * A relative path is resolved against the working directory, and that
 * directory is resolved through the filesystem rather than used as written:
 * a host's temporary root is commonly reached through a link — `/var` for
 * `/private/var` on macOS — and a checkout discovered by its real path would
 * not appear to contain a file addressed through the link. The file itself need
 * not exist; its directory does.
 */
function* targetOf(request: ReplLocalRequest): Operation<string> {
  if (isAbsolute(request.path)) {
    return resolve(request.path);
  }
  return resolve(join(yield* canonical(request.cwd), request.path));
}

function* canonical(directory: string): Operation<string> {
  try {
    return yield* until(realpath(directory));
  } catch {
    return resolve(directory);
  }
}

/**
 * Whether this absolute path is somewhere inside the checkout.
 *
 * The root itself is not: it is not a file anybody writes and not a directory
 * this entry creates, so a request naming it is the ordinary one.
 */
function inside(checkoutRoot: string, target: string): boolean {
  const at = relative(checkoutRoot, target);
  return at !== "" && !at.startsWith("..") && !isAbsolute(at);
}

/**
 * The write outcome the composition answered with, normalized before it is kept.
 *
 * Canonical core validates this same value again on the way out, and it is the
 * authority: `packages/core/src/files.ts` decides what a settlement, a Unit
 * success and an unrecognized failure mean. The readers below are its readers,
 * because what arrives here is an arbitrary runtime value rather than the
 * `Result` the signature promises — a `Proxy` can refuse to be read — and a
 * wrapper that normalized differently would either record an outcome core is
 * about to refuse or erase the invalid data core detects it by.
 *
 * A write's report is the one outcome that says something about the world, so
 * both a malformed success and a malformed failure are fatal: a provider that
 * cannot describe what it did may not have done it.
 */
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
