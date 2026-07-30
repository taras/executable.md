/**
 * `<File>` — read and write UTF-8 text inside the contextual working directory
 * (specs/executable-mdx-spec.md §6.13).
 *
 * Both forms take one relative `path`, resolved against `Env.cwd`, so a
 * document composes with `<TempDir>` without choosing where anything lives.
 * Everything the component touches is confined to that directory, checked in
 * two stages that answer different questions at different times.
 *
 * The first stage is pure path arithmetic against `Env.cwd`: an empty path, an
 * absolute path, and a lexical `..` escape are refused with no filesystem call
 * at all. It runs **before** the children expand, so an unusable path costs
 * nothing and its diagnostic is written before there is any child failure to
 * report alongside it.
 *
 * The second stage resolves what is actually on disk and re-checks the result,
 * which is what catches a symlink leaving the workspace. It runs **after** the
 * children have finished, because a child can change what a path means —
 * replacing a directory with a symlink out of the workspace, for instance —
 * and a destination resolved earlier would not be the one the write lands on.
 *
 * Writes go through a sibling temporary file and a rename. The rename is the
 * **commit point**: everything before it can fail or be cancelled with the
 * previous file untouched, and once it begins the result is the complete old
 * file or the complete new one, never a partial write. It is not a
 * transaction — a commit that has happened is not rolled back by a later
 * cancellation. The temporary also closes the one containment hole resolution
 * cannot: a dangling symlink has nothing to resolve, and `rename` replaces the
 * link rather than following it wherever it points.
 *
 * Diagnostics name only the path the document wrote. A resolved workspace
 * path, the destination a symlink pointed at, a temporary file, and a rejected
 * absolute path are all withheld — §1.2 keeps absolute paths out of
 * diagnostics, and a containment failure is the last place to start reporting
 * them. A platform error carries the path it failed on, so every filesystem
 * call is wrapped and nothing from the error it caught is reproduced: the errno
 * code *selects* a phrase from the allowlist in `fs-diagnostics.ts`.
 *
 * A failed cleanup of the temporary is the one thing reported that the document
 * did not ask for, and it is reported alongside the write's own outcome rather
 * than instead of it — a file the document did not create may be sitting in its
 * directory, which it cannot learn any other way.
 *
 * Every filesystem call goes through the contextual `API.Fs`, so a host can
 * observe or sandbox a document's own file access on the same terms as the
 * engine's component resolution.
 *
 * ## Threat model
 *
 * Containment is judged against the filesystem as this component observes it.
 * That is sound while the filesystem is stable, and every guarantee here is
 * stated on that basis. It is not a sandbox: nothing prevents another process
 * from replacing a directory with a symlink between the moment a path is
 * validated and the moment it is used. Deferring resolution until immediately
 * before the write narrows that window and covers the document's own children,
 * which is the case a document controls; closing it entirely needs a
 * capability or a platform-enforced sandbox, and is issue #227.
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import {
  cwd,
  ensureDir,
  readTextFile,
  realpath,
  remove,
  rename,
  stat,
  writeTextFile,
} from "@executablemd/runtime";
import { content } from "../component-api.ts";
import { hasContent } from "../content-context.ts";
import { ContentError } from "../errors.ts";
import type { Json } from "../types.ts";
import { reason } from "./fs-diagnostics.ts";

export const props = {
  type: "object",
  properties: {
    path: { type: "string" },
  },
  required: ["path"],
  additionalProperties: false,
};

/** A path that leaves the working directory, or a target that cannot be text. */
export class FileAccessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileAccessError";
  }
}

/** One sanitized sentence: the document's own path, and an allowlisted phrase. */
function sentence(requested: string, verb: string, error: unknown): string {
  return `cannot ${verb} "${requested}": ${reason(error)}.`;
}

/**
 * Run a filesystem operation, replacing whatever it throws with a diagnostic
 * built only from the path the document wrote and an allowlisted phrase.
 *
 * Nothing is passed through, including a `FileAccessError`. This component's
 * own checks throw outside guarded calls, so an error surfacing from inside one
 * came from the Api — and an error's class says nothing about whether its
 * message is safe to show. Trusting one would let middleware choose the text of
 * a diagnostic by choosing what to throw.
 *
 * Cancellation is not a thrown error in Effection — halting resumes the
 * generator through `return()` — so this never converts a halt into a failure.
 */
function* guard<T>(requested: string, verb: string, operation: Operation<T>): Operation<T> {
  try {
    return yield* operation;
  } catch (error) {
    throw new FileAccessError(sentence(requested, verb, error));
  }
}

export default function* (props: Record<string, Json>): Operation<string> {
  const requested = String(props.path);
  const admitted = yield* admissible(requested);

  if (yield* hasContent()) {
    // The children run only once the path is known to be usable, and the
    // destination is resolved only once they are done.
    const text = yield* rendered(requested);
    yield* write(requested, yield* destination(admitted), text);
    return "";
  }

  return yield* read(requested, yield* destination(admitted));
}

/**
 * The rendered children, or a failure if anything went wrong producing them.
 *
 * `content()` is a failure boundary: content that fails to expand throws
 * `ContentError` there rather than coming back as text with the diagnostic
 * embedded in it. For a component that renders its content, embedding is the
 * right outcome — the reader sees what failed, in place. A write has nowhere to
 * show it, and writing the diagnostic into the file would be worse than
 * useless, so this recovers from the boundary and turns the whole invocation
 * into a failure instead. Nothing reaches the filesystem, and the target keeps
 * whatever it already held.
 *
 * The original messages come along, because `<File>` renders nothing: this
 * diagnostic is the only place the reader would learn what actually went wrong.
 * Anything else thrown is not a content failure and passes through untouched.
 *
 * The content failure itself stays in this failure's cause chain. What is
 * reported is this component's own diagnostic — the write is what the document
 * asked for, and that it did not happen is the fact a reader needs — while the
 * failure it was translated from, and the error segments it carries, remain
 * reachable underneath for a host inspecting what ended the execution.
 */
function* rendered(requested: string): Operation<string> {
  try {
    return yield* content();
  } catch (error) {
    if (!(error instanceof ContentError)) {
      throw error;
    }
    const failures = error.errors.map((segment) => segment.message);
    throw new FileAccessError(
      `did not write "${requested}": its content failed to expand. ${failures.join(" ")}`,
      { cause: error },
    );
  }
}

/** A path that has passed the lexical stage, carried to the resolving one. */
interface Admissible {
  /** The path the document wrote, for diagnostics. */
  requested: string;
  /** `requested` joined onto the contextual directory and normalized. */
  lexical: string;
}

/**
 * Stage one: what can be decided without touching the filesystem.
 *
 * An empty path, an absolute path, and a `..` escape are all answerable from
 * `Env.cwd` and path arithmetic alone. Deciding them here means an unusable
 * path is refused before the children of a write run at all, and that the
 * diagnostic never has to mention a path that was rejected for being absolute.
 *
 * `resolve` normalizes `..` lexically, so this holds against the contextual
 * directory as given — canonicalizing it is stage two's job and would only
 * move the same comparison onto a different pair of strings.
 */
function* admissible(requested: string): Operation<Admissible> {
  if (requested.length === 0) {
    throw new FileAccessError("path is empty; give a path relative to the working directory.");
  }
  if (isAbsolute(requested)) {
    throw new FileAccessError(
      "an absolute path is not accepted; give a path relative to the working directory.",
    );
  }

  const directory = yield* cwd();
  const lexical = resolve(directory, requested);
  if (!within(directory, lexical)) {
    throw new FileAccessError(`"${requested}" resolves outside the working directory.`);
  }

  return { requested, lexical };
}

/**
 * Stage two: the path as the filesystem currently has it.
 *
 * Resolves the part of the path that is already on disk — the file itself when
 * it is there, the deepest existing ancestor when it is not — and re-checks
 * the result, which is what catches a symlink pointing out of the workspace.
 * What comes back is that resolved path, so an internal symlink is followed to
 * the file it names rather than being replaced by the write.
 *
 * Both sides of the comparison are canonical here, so a working directory
 * reached through a symlink — macOS's `/var` against `/private/var` — does not
 * read as an escape.
 */
function* destination({ requested, lexical }: Admissible): Operation<string> {
  const directory = yield* cwd();
  const base = (yield* guard(requested, "resolve", realpath(directory))) ?? directory;

  const effective = yield* guard(requested, "resolve", resolveExisting(lexical));
  if (!within(base, effective)) {
    throw new FileAccessError(
      `"${requested}" leads through a symlink outside the working directory.`,
    );
  }

  return effective;
}

/**
 * Whether `path` names the working directory or something inside it.
 *
 * The directory itself is contained — `.` is not an escape. What it is instead
 * is a directory, which is a question about the target rather than about
 * containment, so it belongs to the read and write checks that come after.
 *
 * Only a complete `..` segment leaves. A name that merely starts with two dots
 * — `..notes.md`, `..config/settings.json` — is an ordinary file inside, and a
 * prefix test would refuse it.
 */
function within(base: string, path: string): boolean {
  const rel = relative(base, path);
  if (isAbsolute(rel)) {
    return false;
  }
  if (rel.length === 0) {
    return true;
  }
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * `path` with every symlink in its existing prefix resolved.
 *
 * `realpath` needs the whole path to exist, and a write commonly names one
 * that does not yet, so the walk gives up one trailing segment at a time until
 * something answers and then puts the segments back. The working directory
 * always exists, so the loop terminates there at the latest.
 */
function* resolveExisting(path: string): Operation<string> {
  const trailing: string[] = [];
  let current = path;

  while (true) {
    const resolved = yield* realpath(current);
    if (resolved !== undefined) {
      return trailing.length === 0 ? resolved : join(resolved, ...trailing);
    }
    const parent = dirname(current);
    if (parent === current) {
      return join(current, ...trailing);
    }
    trailing.unshift(basename(current));
    current = parent;
  }
}

function* read(requested: string, target: string): Operation<string> {
  const info = yield* guard(requested, "read", stat(target));
  if (!info.exists) {
    throw new FileAccessError(`cannot read "${requested}": no such file.`);
  }
  if (info.isDirectory) {
    throw new FileAccessError(`cannot read "${requested}": it is a directory, not a text file.`);
  }
  if (!info.isFile) {
    throw new FileAccessError(`cannot read "${requested}": it is not a regular file.`);
  }

  return yield* guard(requested, "read", readTextFile(target));
}

/**
 * Which step a write failed at, which is what decides what can be said about
 * the target afterwards.
 */
type Step = "preparation" | "commit";

/**
 * Replace `target` with exactly `text`.
 *
 * The content is whole by the time this runs — the children expanded first —
 * so a child that failed never reaches the filesystem at all. What remains is
 * the write, and it has one commit point.
 *
 * Everything up to the rename is preparation: a failure or a cancellation
 * there leaves the previous file untouched, because nothing has replaced it
 * yet. The rename is the commit, and it is a commit rather than a transaction —
 * `rename` is a single filesystem call that cannot be interrupted once started,
 * and a cancellation arriving after it has completed does not undo it. What is
 * promised is that no write is ever half visible, not that a finished write can
 * be taken back.
 *
 * A rename that *throws* is the one case where the outcome cannot be inferred.
 * `rename` is an operation on the contextual Fs Api, and an `around` handler
 * legitimately does work on both sides of `next()` — so a throw may arrive
 * before the underlying rename ran or after it succeeded, and there is no way
 * from here to tell which. What still holds is atomicity: the target is the
 * complete previous content or the complete replacement, never a partial write.
 * Claiming the previous file survived would be a guess, and it would be wrong
 * exactly when a handler failed after committing.
 *
 * Removal of the temporary is registered before it is written rather than
 * after. `writeTextFile` is where an interruption is most likely to land, and
 * a cleanup installed on the far side of it would not run for the one failure
 * it exists to handle. `remove` is forced, so registering it for a file that
 * was never created — or one the rename has already consumed — is a no-op.
 *
 * A removal that does fail is reported, because a file the document did not
 * create may be left in its directory. It is reported *alongside* whatever the
 * write did rather than instead of it: both outcomes are collected here and
 * raised together, so neither hides the other.
 */
function* write(requested: string, target: string, text: string): Operation<void> {
  const info = yield* guard(requested, "write", stat(target));
  if (info.exists && !info.isFile) {
    throw new FileAccessError(
      `cannot write "${requested}": it is a ${info.isDirectory ? "directory" : "special file"}, ` +
        "not a text file.",
    );
  }

  yield* guard(requested, "write", ensureDir(dirname(target)));

  // Both halves are collected rather than thrown, then reported together. A
  // destructor that threw would replace the failure it is unwinding, or be
  // aggregated into it in a shape a document cannot read; and the write's own
  // failure must not hide the fact that a temporary was left behind.
  const failed: string[] = [];
  const uncleaned: string[] = [];
  let step: Step = "preparation";

  yield* scoped(function* () {
    const temporary = `${target}.xmd-${randomUUID().slice(0, 8)}.tmp`;
    yield* ensure(() => discard(requested, temporary, uncleaned));
    try {
      yield* writeTextFile(temporary, text);
      step = "commit";
      yield* rename(temporary, target);
    } catch (error) {
      failed.push(sentence(requested, "write", error));
    }
  });

  if (failed.length === 0 && uncleaned.length === 0) {
    return;
  }
  throw new FileAccessError(
    [
      ...failed,
      ...uncleaned,
      outcome(failed.length > 0 ? step : undefined),
      ...(uncleaned.length > 0 ? [LEFTOVER] : []),
    ].join(" "),
  );
}

/**
 * What can be said about the target, given where the write stopped.
 *
 * Only two of these are conclusions. A preparation failure changed nothing,
 * and a rename that returned committed. A rename that threw is the honest
 * "unknown": atomicity still holds, so the answer is one of two whole files,
 * but which one is not observable from here.
 */
function outcome(failedAt: Step | undefined): string {
  if (failedAt === undefined) {
    return "The file was written.";
  }
  if (failedAt === "preparation") {
    return "The previous file is unchanged.";
  }
  return (
    "Whether the replacement committed is unknown: the target holds either the " +
    "complete previous content or the complete replacement, never a partial write."
  );
}

/**
 * Orthogonal to `outcome`: a temporary that could not be removed is a separate
 * fact about the directory, and composes with any of the three.
 */
const LEFTOVER = "A temporary file beside it may remain.";

/**
 * Remove the temporary, recording a sanitized sentence if it cannot be.
 *
 * Runs during teardown, sometimes the teardown of a write that is already
 * failing, so it records rather than throws — see `write`. What it records
 * names the document's own path: the temporary is generated, and a document
 * that never chose that name cannot be shown it.
 */
function* discard(requested: string, temporary: string, uncleaned: string[]): Operation<void> {
  try {
    yield* remove(temporary, { force: true });
  } catch (error) {
    uncleaned.push(sentence(requested, "clean up", error));
  }
}
