import type { AwaitedMountPolicy } from "../../mount-files.ts";
import { fileRecordingMiddleware, useEntryFileRecorder } from "../../file-recorder.ts";
import type { MountFileEntry } from "../../workspace-mount-installation.ts";
import type { WorkspaceMountTable } from "../../../workspace-mounts.ts";
import type { AuthoredFileOperation } from "@executablemd/core/host";
import { createMountPolicy } from "../../mount-files.ts";
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

import type { Operation, Result } from "effection";
import { isAbsolute, join, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { until } from "effection";
import type { FilesHandler } from "@executablemd/runtime";
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
}

/** The middleware that records this entry's authored mutations. */
export function replFileMiddleware(
  recorder: ReplLocalRecorder,
  workspace?: string,
): Partial<Around<FilesHandler>> {
  return fileRecordingMiddleware((operation, request, perform) =>
    routed(recorder, operation, request, perform, workspace),
  );
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
  authored?: AuthoredFileOperation,
  mounts?: AwaitedMountPolicy,
): Operation<Result<ReplLocalValue>> {
  if (mounts !== undefined) {
    yield* mounts.guard();
  }
  const name = yield* localRecordName({ operation, request });
  if (yield* retainedSelectionAhead()) {
    yield* recorder.selection();
  }
  if (authored !== undefined && mounts !== undefined) {
    const replay = yield* mounts.replay(authored, request);
    if (replay !== undefined) {
      return yield* replay;
    }
  }
  if (yield* retainedResultAhead(name)) {
    return yield* recordedLocalOperation({ operation, request, perform });
  }

  const retain = (coverage: import("../../mount-records.ts").MountCoverage) =>
    authored === undefined || mounts === undefined
      ? recordedLocalOperation({ operation, request, perform })
      : mounts.record(authored, request, perform, coverage);
  const target = yield* targetOf(request);
  const managed = covering(recorder.placements(), target);
  if (managed !== undefined) {
    // Placement ownership first, and for a read as much as for a write: what it
    // answers is that one entry at a time owns this managed checkout, which an
    // observation inside it needs as much as a change does.
    yield* managed.own();
    if (operation !== "file-read") {
      yield* recorder.hold(managed.commonDirectory);
    }
    return yield* retain({
      kind: "existing",
      owner: "placement",
      root: managed.checkoutRoot,
      target,
    });
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
        return yield* retain({ kind: "existing", owner: "session", root, target: resolvedTarget });
      }
    }
    return authored !== undefined && mounts !== undefined
      ? yield* mounts.record(authored, request, perform, { kind: "external-mapped-read" })
      : yield* perform();
  }
  if (operation !== "file-read") {
    yield* recorder.hold(checkout.commonDirectory);
  }
  return yield* retain({
    kind: "existing",
    owner: "checkout",
    root: checkout.checkoutRoot,
    target,
  });
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

export function* useReplFileRecorder(
  recorder: ReplLocalRecorder,
  workspace: string | undefined,
  mounts: WorkspaceMountTable,
  directory: string,
): Operation<MountFileEntry> {
  const policy = yield* createMountPolicy(mounts, directory);
  const files = yield* useEntryFileRecorder((operation, request, perform, authored) =>
    routed(recorder, operation, request, perform, workspace, authored, policy),
  );
  return { files, policy };
}
