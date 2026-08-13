/**
 * The transaction-bound `API.Files` provider — a document's filesystem inside a
 * workflow run.
 *
 * This is what `xmd workflow` installs where `xmd run` installs the host
 * adapter. A document names the same paths and `<File>` calls the same
 * operations; what changes is where those paths land. Here they land in the
 * run's own logical Workspace, and every read, write and search is one durable
 * effect published by the run's effect transaction — the mutation, the
 * resulting immutable Workspace root and the filtered journal result commit
 * together or not at all.
 *
 * ## Why an authored path never reaches a host filesystem call
 *
 * Resolution is arithmetic on POSIX segments rooted at `/`, and the result is
 * handed to the run's DOFS filesystem. No host path appears anywhere in it, so
 * the containment claim needs no stable-namespace qualification: nothing
 * outside the Workspace can be named, and no other process can replace part of
 * a tree that lives inside one database.
 *
 * `checkFilePath` stays what the Api says it is — pure lexical admission that
 * hands back nothing usable. It performs no effect and appends no journal
 * entry, so a check that was skipped or answered elsewhere authorizes nothing;
 * the write repeats the same admission from the same authored path.
 *
 * ## What replay does instead
 *
 * A recorded effect restores its recorded value. A read therefore answers with
 * the bytes it read when it ran, even where the current frontier no longer
 * holds them, and a write already recorded neither mutates nor captures a root
 * again. Nothing here consults current state to decide whether an earlier
 * effect happened, which is what lets a create/delete/create history replay in
 * order rather than collapsing to whatever the file is now.
 *
 * ## What crosses the boundary
 *
 * A documented DOFS refusal selects a `FilesReason` and nothing else travels
 * with it: no DOFS message, no errno payload, no SQLite text, no resolved path.
 * A refusal is also a *rolled back* refusal — the mutation runs inside a
 * savepoint of its own, so partial logical mutation is discarded before the
 * sanitized result is durably published, and the run's current root is the one
 * it was before.
 *
 * Everything that is not a documented refusal — connection, authority,
 * savepoint, capture, publication, routing, teardown and commit failure — stays
 * an infrastructure failure and fails the run. None of them is something a
 * document did, and printing one would let the work after this file work run as
 * though the file work had happened.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import { globToRegExp } from "@effectionx/fs";
import { getExpansion, sourceDescription } from "@executablemd/core";
import {
  Files,
  FilesInvariantError,
  FilesOperationDeniedError,
  filesFailure,
  fileWriteFailure,
  fileWriteSuccess,
  parseFilesPhase,
  parseFilesReason,
  parseFileWritePhase,
} from "@executablemd/runtime";
import type {
  FilePathInput,
  FilesPhase,
  FilesReason,
  FileWriteInput,
  FileWritePhase,
  FileWriteSuccess,
  GlobInput,
} from "@executablemd/runtime";
import type { EffectDescription, Json, Workflow } from "@executablemd/durable-streams";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { savepoint } from "../transaction.ts";
import { createWorkspaceEffect } from "./effect.ts";
import { journalableWorkspaceCode } from "./errors.ts";
import type { DenoWorkspaceFilesystem, DenoWorkspaceStat } from "./filesystem.ts";
import {
  logicalDirectory,
  logicalJoin,
  logicalParent,
  LogicalPathError,
  resolveLogicalPath,
  WORKSPACE_ROOT,
} from "./logical-path.ts";

/** The effect type every document filesystem operation in a run is recorded under. */
export const WORKSPACE_FILE = "workspace_file";

/**
 * The condition each documented DOFS code reports as.
 *
 * A `Map` rather than an object literal, because a lookup on one answers for
 * inherited keys and the code comes from the filesystem rather than from here.
 */
const REASON_BY_CODE: ReadonlyMap<string, FilesReason> = new Map<string, FilesReason>([
  ["ENOENT", "missing"],
  ["ENOTDIR", "not-directory"],
  ["EISDIR", "directory"],
  ["ENOTEMPTY", "directory-not-empty"],
  ["EACCES", "permission-denied"],
  ["EPERM", "permission-denied"],
  ["EROFS", "read-only"],
  ["ELOOP", "too-many-symlinks"],
]);

/** A documented filesystem condition, carrying its reason and nothing else. */
class WorkspaceRefusal extends Error {
  override name = "WorkspaceRefusal";
  readonly reason: FilesReason;

  constructor(reason: FilesReason) {
    super("workspace filesystem refused");
    this.reason = reason;
  }
}

/**
 * The refusal this failure is, or a rethrow when it is not one.
 *
 * Rethrowing is what keeps infrastructure failures infrastructure failures: a
 * condition DOFS never documented is not something a document did, and turning
 * it into a printable reason would let the work after this file work run as
 * though the file work had happened.
 */
function asRefusal(error: unknown): WorkspaceRefusal {
  const code = journalableWorkspaceCode(error);
  if (code === undefined) {
    throw error;
  }
  return new WorkspaceRefusal(REASON_BY_CODE.get(code) ?? "operation-failed");
}

function refusalReason(error: Error): FilesReason {
  return error instanceof WorkspaceRefusal ? error.reason : "operation-failed";
}

function lexicalReason(error: Error): FilesReason {
  return error instanceof LogicalPathError ? error.reason : "operation-failed";
}

/**
 * What one file effect recorded.
 *
 * A JSON value, because it is what the journal holds and what a replay hands
 * back. A refusal is carried as a phase and a reason rather than as a
 * serialized error, so nothing a filesystem said is retained and a restored
 * refusal is rebuilt from the same vocabulary a live one is.
 */
type FileEffectOutcome<Phase extends string> =
  | { readonly kind: "content"; readonly content: string }
  | { readonly kind: "written" }
  | { readonly kind: "paths"; readonly paths: string[] }
  | { readonly kind: "refused"; readonly phase: Phase; readonly reason: FilesReason };

function refused<Phase extends string>(
  phase: Phase,
  reason: FilesReason,
): FileEffectOutcome<Phase> {
  return { kind: "refused", phase, reason };
}

/**
 * The whole of what each outcome carries.
 *
 * A `Map` rather than an object literal, because the discriminant is read from
 * the journal and a lookup on an object answers for keys `Object.prototype`
 * happens to hold. A record carrying anything beyond its variant's members —
 * `written` with content, `content` with a reason — describes two outcomes at
 * once and is therefore no outcome at all.
 */
const OUTCOME_MEMBERS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["content", ["kind", "content"]],
  ["written", ["kind"]],
  ["paths", ["kind", "paths"]],
  ["refused", ["kind", "phase", "reason"]],
]);

function carriesExactly(record: Record<string, unknown>, kind: string): boolean {
  const members = OUTCOME_MEMBERS.get(kind);
  if (members === undefined) {
    return false;
  }
  return (
    Object.keys(record).length === members.length &&
    members.every((member) => Object.hasOwn(record, member))
  );
}

function readPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return undefined;
    }
    paths.push(entry);
  }
  return paths;
}

/**
 * The outcome a journal record describes, or `undefined` when it describes none.
 *
 * The journal is parsed, never trusted, and parsing here is total: a record must
 * carry its variant's members and no others, each of the declared type, and a
 * refusal's phase and reason must both be words this operation's vocabulary
 * holds. A record this cannot read has no printable reading, so the caller turns
 * it into one fixed provider invariant rather than inventing a filesystem
 * condition that was never reported.
 */
function parseOutcome<Phase extends string>(
  value: unknown,
  parsePhase: (value: unknown) => Phase | undefined,
): FileEffectOutcome<Phase> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const kind = record.kind;
  if (typeof kind !== "string" || !carriesExactly(record, kind)) {
    return undefined;
  }
  if (kind === "content") {
    return typeof record.content === "string"
      ? { kind: "content", content: record.content }
      : undefined;
  }
  if (kind === "written") {
    return { kind: "written" };
  }
  if (kind === "paths") {
    const paths = readPaths(record.paths);
    return paths === undefined ? undefined : { kind: "paths", paths };
  }
  const phase = parsePhase(record.phase);
  const reason = parseFilesReason(record.reason);
  if (phase === undefined || reason === undefined) {
    return undefined;
  }
  return { kind: "refused", phase, reason };
}

/**
 * How one file effect is identified, deterministically.
 *
 * The expansion is what makes two `<File>` elements different effects and one
 * element the same effect across replays; the operation separates a read from a
 * write performed by the same element; and the resolved logical target is what
 * a changed authored path or a changed working directory moves. A document
 * edited to name another file therefore diverges rather than quietly replaying
 * the previous file's recorded bytes.
 */
function* describeFileEffect(
  operation: string,
  target: string,
  detail: Record<string, Json>,
): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  return {
    type: WORKSPACE_FILE,
    name: `${operation}:${expansion.id}:${target}`,
    ...detail,
    ...sourceDescription(expansion.position),
  };
}

function* fileEffect<Phase extends string>(
  database: WorkflowRunDatabase,
  description: EffectDescription,
  perform: (filesystem: DenoWorkspaceFilesystem) => Operation<FileEffectOutcome<Phase>>,
): Workflow<unknown> {
  return yield createWorkspaceEffect(database, description, (filesystem) => perform(filesystem));
}

/**
 * Run one file effect and read back what it recorded.
 *
 * The same path serves a live effect and a replayed one: live execution
 * publishes the outcome and hands it back, replay hands back the outcome that
 * was published. Neither branch is written twice here, which is what makes
 * "replay restores the recorded result" a property of the code rather than a
 * claim about it.
 */
function* performed<Phase extends string>(
  database: WorkflowRunDatabase,
  description: EffectDescription,
  parsePhase: (value: unknown) => Phase | undefined,
  perform: (filesystem: DenoWorkspaceFilesystem) => Operation<FileEffectOutcome<Phase>>,
): Operation<FileEffectOutcome<Phase>> {
  const outcome = parseOutcome(yield* fileEffect(database, description, perform), parsePhase);
  if (outcome === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return outcome;
}

function* statPath(
  filesystem: DenoWorkspaceFilesystem,
  path: string,
): Operation<Result<DenoWorkspaceStat>> {
  try {
    return Ok(yield* filesystem.stat(path));
  } catch (error) {
    return Err(asRefusal(error));
  }
}

function* readOutcome(
  filesystem: DenoWorkspaceFilesystem,
  path: string,
): Operation<FileEffectOutcome<FilesPhase>> {
  const info = yield* statPath(filesystem, path);
  if (!info.ok) {
    return refused("resolution", refusalReason(info.error));
  }
  if (info.value.kind !== "file") {
    return refused("target", "directory");
  }
  try {
    return { kind: "content", content: yield* filesystem.readTextFile(path) };
  } catch (error) {
    return refused("access", refusalReason(asRefusal(error)));
  }
}

/**
 * What the target already is, when that decides the write before it starts.
 *
 * A directory cannot become a file, and saying so before anything is attempted
 * is what keeps the target claim `unchanged` rather than `rolled-back`. A path
 * that does not exist yet is the ordinary case and answers `undefined`.
 */
function* classifyWriteTarget(
  filesystem: DenoWorkspaceFilesystem,
  path: string,
): Operation<FileEffectOutcome<FileWritePhase> | undefined> {
  const info = yield* statPath(filesystem, path);
  if (info.ok) {
    return info.value.kind === "file" ? undefined : refused("target", "directory");
  }
  const reason = refusalReason(info.error);
  return reason === "missing" ? undefined : refused("target", reason);
}

function* replace(
  filesystem: DenoWorkspaceFilesystem,
  parent: string,
  path: string,
  content: string,
): Operation<void> {
  if (parent !== WORKSPACE_ROOT) {
    yield* filesystem.mkdir(parent, { recursive: true });
  }
  yield* filesystem.writeFile(path, content);
}

/**
 * Replace one file, discarding every part of the attempt if any part refuses.
 *
 * The parents and the replacement share one savepoint, so a write that creates
 * two directories and then cannot be written leaves neither behind. The refusal
 * that comes back therefore describes a Workspace that is exactly what it was,
 * which is the `rolled-back` target claim the write vocabulary already has.
 */
function* writeOutcome(
  filesystem: DenoWorkspaceFilesystem,
  path: string,
  content: string,
): Operation<FileEffectOutcome<FileWritePhase>> {
  const existing = yield* classifyWriteTarget(filesystem, path);
  if (existing !== undefined) {
    return existing;
  }

  try {
    yield* savepoint(replace(filesystem, logicalParent(path), path, content));
  } catch (error) {
    return refused("transaction", refusalReason(asRefusal(error)));
  }
  return { kind: "written" };
}

const SUBTREE = "/**";

function toRegExp(pattern: string): RegExp {
  return globToRegExp(pattern, { extended: true, globstar: true });
}

/**
 * A matcher for directories whose entire subtree an exclusion covers.
 *
 * Only a trailing `/**` proves it: matching the directory itself says nothing
 * about the files beneath it, so anything else is walked and filtered one file
 * at a time. Descending a subtree whose files are all excluded costs reads;
 * skipping one that holds a match loses the match.
 */
function pruneMatcher(pattern: string): RegExp | undefined {
  if (pattern === "**") {
    return toRegExp("**");
  }
  if (!pattern.endsWith(SUBTREE)) {
    return undefined;
  }
  return toRegExp(pattern.slice(0, -SUBTREE.length));
}

interface Traversal {
  readonly include: RegExp[];
  readonly exclude: RegExp[];
  readonly prune: RegExp[];
  readonly matched: string[];
}

/**
 * Collect matching regular files beneath one logical directory.
 *
 * A search answers with regular files, which is what `API.Files` says a search
 * answers with wherever it runs. A symbolic link is neither reported nor
 * descended through, so a link is not a result and no target is reached twice or
 * reached at all through a name outside the walk — traversal stays inside the
 * directory it started in and cannot cycle. `readdir` classifies a link by what
 * the entry is rather than by what it points at, so a link to a directory is
 * refused on the same terms as a link to a file.
 *
 * Exclusion is decided per candidate: a file whose own relative path an
 * exclusion matches is not reported. A directory is never a candidate, so its
 * own path is not tested against exclusions at all — the only question it raises
 * is whether walking it can still produce something.
 */
function* descend(
  filesystem: DenoWorkspaceFilesystem,
  directory: string,
  prefix: string,
  walk: Traversal,
): Operation<void> {
  for (const entry of yield* filesystem.readdir(directory)) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.kind === "directory") {
      if (!walk.prune.some((expression) => expression.test(path))) {
        yield* descend(filesystem, logicalJoin(directory, entry.name), path, walk);
      }
      continue;
    }

    if (entry.kind !== "file") {
      continue;
    }
    if (walk.exclude.some((expression) => expression.test(path))) {
      continue;
    }
    if (walk.include.some((expression) => expression.test(path))) {
      walk.matched.push(path);
    }
  }
}

function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compile(include: string[], exclude: string[]): Result<Traversal> {
  try {
    return Ok({
      include: include.map(toRegExp),
      exclude: exclude.map(toRegExp),
      prune: exclude
        .map(pruneMatcher)
        .filter((expression): expression is RegExp => expression !== undefined),
      matched: [],
    });
  } catch (error) {
    // The patterns are compiled before the walk, so an unusable one — an
    // unterminated character class — arrives as a `SyntaxError` from `RegExp`.
    // It is the one failure here a document can fix by editing what it wrote.
    if (error instanceof SyntaxError) {
      return Err(new WorkspaceRefusal("invalid-pattern"));
    }
    throw error;
  }
}

function* globOutcome(
  filesystem: DenoWorkspaceFilesystem,
  directory: string,
  include: string[],
  exclude: string[],
): Operation<FileEffectOutcome<FilesPhase>> {
  const info = yield* statPath(filesystem, directory);
  if (!info.ok) {
    return refused("target", refusalReason(info.error));
  }
  if (info.value.kind !== "directory") {
    return refused("target", "not-directory");
  }

  const walk = compile(include, exclude);
  if (!walk.ok) {
    return refused("pattern", refusalReason(walk.error));
  }

  try {
    yield* descend(filesystem, directory, "", walk.value);
  } catch (error) {
    return refused("traversal", refusalReason(asRefusal(error)));
  }
  return { kind: "paths", paths: [...new Set(walk.value.matched)].sort(byCodePoint) };
}

/** The document filesystem of one workflow run. */
export interface WorkflowFilesHandler {
  checkFilePath(input: FilePathInput): Operation<Result<void>>;
  readTextFile(input: FilePathInput): Operation<Result<string>>;
  writeTextFile(input: FileWriteInput): Operation<Result<FileWriteSuccess>>;
  globFiles(input: GlobInput): Operation<Result<string[]>>;
  temporaryDirectory(): Operation<Result<string>>;
}

export function workflowFilesHandler(database: WorkflowRunDatabase): WorkflowFilesHandler {
  return {
    // deno-lint-ignore require-yield
    *checkFilePath(input: FilePathInput): Operation<Result<void>> {
      const resolved = resolveLogicalPath(input.cwd, input.path);
      if (!resolved.ok) {
        return Err(
          filesFailure({
            operation: "check-file-path",
            phase: "lexical",
            reason: lexicalReason(resolved.error),
          }),
        );
      }
      return Ok(undefined);
    },

    *readTextFile(input: FilePathInput): Operation<Result<string>> {
      const resolved = resolveLogicalPath(input.cwd, input.path);
      if (!resolved.ok) {
        return Err(
          filesFailure({
            operation: "read",
            phase: "lexical",
            reason: lexicalReason(resolved.error),
          }),
        );
      }
      const path = resolved.value;
      const outcome = yield* performed(
        database,
        yield* describeFileEffect("read", path, { path: input.path, cwd: input.cwd }),
        parseFilesPhase,
        (filesystem) => readOutcome(filesystem, path),
      );
      if (outcome.kind === "refused") {
        return Err(
          filesFailure({ operation: "read", phase: outcome.phase, reason: outcome.reason }),
        );
      }
      if (outcome.kind !== "content") {
        throw new FilesInvariantError("protocol");
      }
      return Ok(outcome.content);
    },

    *writeTextFile(input: FileWriteInput): Operation<Result<FileWriteSuccess>> {
      const resolved = resolveLogicalPath(input.cwd, input.path);
      if (!resolved.ok) {
        return Err(fileWriteFailure({ phase: "lexical", reason: lexicalReason(resolved.error) }));
      }
      const path = resolved.value;
      const outcome = yield* performed(
        database,
        yield* describeFileEffect("write", path, { path: input.path, cwd: input.cwd }),
        parseFileWritePhase,
        (filesystem) => writeOutcome(filesystem, path, input.content),
      );
      if (outcome.kind === "refused") {
        return Err(fileWriteFailure({ phase: outcome.phase, reason: outcome.reason }));
      }
      if (outcome.kind !== "written") {
        throw new FilesInvariantError("protocol");
      }
      return Ok(fileWriteSuccess("transaction-staged"));
    },

    *globFiles(input: GlobInput): Operation<Result<string[]>> {
      const directory = logicalDirectory(input.cwd);
      const include = [...input.include];
      const exclude = [...input.exclude];
      const outcome = yield* performed(
        database,
        yield* describeFileEffect("glob", directory, { include, exclude }),
        parseFilesPhase,
        (filesystem) => globOutcome(filesystem, directory, include, exclude),
      );
      if (outcome.kind === "refused") {
        return Err(
          filesFailure({ operation: "glob", phase: outcome.phase, reason: outcome.reason }),
        );
      }
      if (outcome.kind !== "paths") {
        throw new FilesInvariantError("protocol");
      }
      return Ok(outcome.paths);
    },

    /**
     * A workflow run has no host directory to hand out.
     *
     * Denied rather than emulated inside the Workspace: `<TempDir>` exists so a
     * document can hand a path to a tool the caller already has, and a logical
     * path is not one. Falling through to the host would give a run exactly the
     * unretained, uncontained filesystem the boundary exists to keep it out of.
     */
    // deno-lint-ignore require-yield
    *temporaryDirectory(): Operation<Result<string>> {
      throw new FilesOperationDeniedError("temporary-directory");
    },
  };
}

/**
 * Install this run's document filesystem for the current scope and below.
 *
 * `{ at: "min" }` on the same terms as every other provider: an outer host
 * adapter installed by the CLI entrypoint would otherwise answer ahead of this
 * one, and the whole point of a workflow run is that it does not.
 */
export function useWorkflowFiles(database: WorkflowRunDatabase): Operation<void> {
  const handler = workflowFilesHandler(database);
  return Files.around(
    {
      *checkFilePath([input]) {
        return yield* handler.checkFilePath(input);
      },
      *readTextFile([input]) {
        return yield* handler.readTextFile(input);
      },
      *writeTextFile([input]) {
        return yield* handler.writeTextFile(input);
      },
      *globFiles([input]) {
        return yield* handler.globFiles(input);
      },
      *temporaryDirectory() {
        return yield* handler.temporaryDirectory();
      },
    },
    { at: "min" },
  );
}
