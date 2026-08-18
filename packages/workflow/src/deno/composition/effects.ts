/**
 * The durable envelope every composition effect is performed inside.
 *
 * One effect, one Workspace transaction. What a `<Repository>` or `<Worktree>`
 * asks for becomes a mutation that either commits with its metadata row, its
 * published Workspace root and its filtered journal result, or does none of
 * those. This module owns that shape; what goes inside it belongs to the two
 * components' own modules.
 *
 * The three ways an attempt can end are kept apart deliberately. A refusal is a
 * failed durable outcome the document can act on. A Workspace that could not
 * retain what Git produced is infrastructure and fails the run. Anything else
 * travels on untouched, which is what keeps a stale-state condition fatal and
 * cancellation cancellation.
 */
import { type Operation } from "effection";
import type { EffectDescription, Json, Workflow } from "@executablemd/durable-streams";
import { createHash } from "node:crypto";
import {
  GitOperationProtocolError,
  RepositoryCompositionProtocolError,
} from "../../composition/errors.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { WorkflowStorageError } from "../../storage/errors.ts";
import { savepoint } from "../transaction.ts";
import { createWorkspaceEffect } from "../workspace/effect.ts";
import { isJournalableWorkspaceFailure } from "../workspace/errors.ts";
import type { DenoWorkspaceFilesystem } from "../workspace/filesystem.ts";
import type { WorkspaceMetadata } from "../workspace/repositories.ts";
import { GitRefusal } from "./git.ts";
import {
  CompositionRefusal,
  gitRefused,
  refusalReason,
  repositoryRefusal,
  repositoryRefused,
  restoredGitRefusal,
  worktreeRefusal,
  worktreeRefused,
  type RefusalKind,
} from "./refusals.ts";

/** The effect type a Repository's creation identity is recorded under. */
export const WORKSPACE_REPOSITORY = "workspace_repository";

/** The effect type a Worktree's creation identity is recorded under. */
export const WORKSPACE_WORKTREE = "workspace_worktree";

/**
 * What one composition effect recorded.
 *
 * A refusal is not one of these. It is the effect's *failed* outcome, published
 * against the unchanged Workspace root, because a refusal is the durable fact
 * that this run asked for a checkout and did not get one — recording it as a
 * successful result would leave a history saying the operation succeeded.
 */
export type CompositionOutcome = { readonly kind: "created"; readonly record: Json };

/**
 * The transaction one composition effect works in.
 *
 * The two halves a retained checkout is made of, bound together: what the
 * effect writes and what names it. Assembled here rather than threaded through
 * every function, so no step can reach one without the other.
 */
export interface MutationContext {
  readonly filesystem: DenoWorkspaceFilesystem;
  readonly metadata: WorkspaceMetadata;
}

/** A Workspace that could not retain what native Git produced. */
class RepositoryRetentionError extends WorkflowStorageError {
  override name = "RepositoryRetentionError";

  constructor(subject: string, cause: unknown) {
    super(
      `the Workspace could not retain the Git state for ${subject}. Nothing was committed: ` +
        "the run is exactly what it was before this effect began.",
      { cause },
    );
  }
}

export function fingerprintOf(values: readonly (string | null)[]): string {
  const canonical = values.map((value) => (value === null ? "\u0000" : value)).join("\u0001");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

function parseOutcome(value: unknown): unknown | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const keys = Object.keys(record);
  if (record.kind === "created" && keys.length === 2 && Object.hasOwn(record, "record")) {
    return record.record;
  }
  return undefined;
}

export function created(record: Json): CompositionOutcome {
  return { kind: "created", record };
}

export function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/**
 * Discard the native work and refuse with a word, or let the failure be one.
 *
 * A `GitRefusal` is a condition the document can act on, and becomes this
 * effect's failed durable outcome. The savepoint is what makes that honest: the
 * clone, the checkout and the rows the attempt had already written are taken
 * back before the refusal is published, so the failed result describes a
 * Workspace that is exactly what it was.
 *
 * Anything else — a Workspace that could not hold what Git produced, a
 * connection that went away — is infrastructure, and is re-raised as a retention
 * failure so it fails the run rather than being published as something the
 * document asked for.
 */
export function* attempted(
  kind: RefusalKind,
  name: string,
  subject: string,
  work: Operation<Json>,
): Operation<CompositionOutcome> {
  try {
    return created(yield* savepoint(work));
  } catch (error) {
    if (error instanceof GitRefusal) {
      return refused(kind, name, error.reason);
    }
    if (isJournalableWorkspaceFailure(error)) {
      throw new RepositoryRetentionError(subject, error);
    }
    throw error;
  }
}

function refused(kind: RefusalKind, name: string, reason: string): never {
  if (kind === "repository") {
    repositoryRefused(name, reason);
  }
  if (kind === "worktree") {
    worktreeRefused(name, reason);
  }
  gitRefused(name, reason);
}

function* compositionEffect(
  database: WorkflowRunDatabase,
  description: EffectDescription,
  perform: (
    filesystem: DenoWorkspaceFilesystem,
    metadata: WorkspaceMetadata,
  ) => Operation<CompositionOutcome>,
): Workflow<unknown> {
  return yield createWorkspaceEffect(database, description, perform);
}

/**
 * The record this effect settled on, or the refusal it settled as.
 *
 * One place converts a durable outcome into what the document sees, so a live
 * refusal and a replayed one cannot diverge: both arrive here as a failure
 * carrying the same name, and both leave as the same fixed component-owned
 * error. A failure that is not a refusal is not this component's to describe and
 * travels on untouched — a stale-state condition stays fatal, and cancellation
 * stays cancellation.
 */
/**
 * The refusal a restored failure describes, or the protocol failure it is.
 *
 * A retained refusal carries a word, and a word outside the vocabulary this
 * build speaks is not a refusal it may rebuild — it is a retained result this
 * version cannot read, which is fatal rather than something to approximate.
 */
function refusal(kind: RefusalKind, name: string, reason: string): Error {
  if (kind === "repository") {
    return repositoryRefusal(name, reason);
  }
  if (kind === "worktree") {
    return worktreeRefusal(name, reason);
  }
  return restoredGitRefusal(name, reason) ?? new GitOperationProtocolError(name);
}

export function* settled(
  kind: RefusalKind,
  name: string,
  database: WorkflowRunDatabase,
  description: EffectDescription,
  perform: (
    filesystem: DenoWorkspaceFilesystem,
    metadata: WorkspaceMetadata,
  ) => Operation<CompositionOutcome>,
): Operation<unknown> {
  let value: unknown;
  try {
    value = yield* compositionEffect(database, description, perform);
  } catch (error) {
    const reason = refusalReason(error, kind);
    if (reason === undefined) {
      throw error;
    }
    throw refusal(kind, name, reason);
  }
  const outcome = parseOutcome(value);
  if (outcome === undefined) {
    throw new RepositoryCompositionProtocolError(description.type);
  }
  return outcome;
}
