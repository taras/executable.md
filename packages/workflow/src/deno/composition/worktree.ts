/**
 * What a `<Worktree>` owns: one linked checkout inside a Repository.
 *
 * Its identity is the Repository's plus its own name, and everything here turns
 * on that pairing. Creation materializes the Repository and every sibling
 * beside it — Git decides what a repository's worktrees are by reading its own
 * record of them, and a sibling left out would look abandoned — then adds the
 * linked checkout and retains both trees. Attachment proves the pairing rather
 * than assuming it: the administration this worktree names has to be one the
 * Repository really has, and to name this worktree back.
 */
import { scoped, type Operation } from "effection";
import { getExpansion, sourceDescription } from "@executablemd/core";
import type { EffectDescription, Json } from "@executablemd/durable-streams";
import { ensureDir } from "@effectionx/fs";
import { RepositoryCompositionProtocolError } from "../../composition/errors.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import {
  parseWorktreeRecord,
  sameWorktreeRecord,
  worktreeRecordJson,
  type WorktreeCreationRequest,
  type WorktreeRecord,
} from "../../composition/records.ts";
import type { StoredRepository } from "../workspace/repositories.ts";
import type { PrivateWorkspaceTransaction } from "../workspace/private.ts";
import {
  addWorktree,
  checkoutReadable,
  commonDirectory,
  gitSession,
  type GitSession,
} from "./git.ts";
import type { RepositoryHost } from "./host.ts";
import {
  canonicalizeAdministration,
  exportTree,
  importTree,
  localizeAdministration,
  workspaceEntryPresent,
} from "./materialize.ts";
import { worktreeCheckoutPath } from "./placement.ts";
import {
  attempted,
  created,
  fingerprintOf,
  parentOf,
  settled,
  WORKSPACE_WORKTREE,
  type CompositionOutcome,
  type MutationContext,
} from "./effects.ts";
import { worktreeRefused } from "./refusals.ts";
import {
  agreedRepository,
  agreedStored,
  agreedWorktree,
  repositorySubject,
  stale,
  worktreeSubject,
  type Attached,
  type StaleReason,
} from "./identity.ts";
import { repositoryDisagreement } from "./repository.ts";

export function* describeWorktree(request: WorktreeCreationRequest): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  const configuration = fingerprintOf([
    request.repositoryName,
    request.name,
    request.branch,
    request.base ?? null,
  ]);
  return {
    type: WORKSPACE_WORKTREE,
    name: `${expansion.id}:${request.repositoryName}:${request.name}:${configuration}`,
    configuration,
    ...sourceDescription(expansion.position),
  };
}

function* retainWorktree(
  context: MutationContext,
  host: RepositoryHost,
  request: WorktreeCreationRequest,
  repository: StoredRepository,
): Operation<Json> {
  const checkoutPath = worktreeCheckoutPath(request.repositoryName, request.name);
  // Every retained path this effect will materialize, agreed before any of them
  // is joined to a host root: the repository's own, and each sibling's.
  const repositoryPath = agreedRepository(
    repository.record,
    repositorySubject(request.repositoryName),
  ).checkoutPath;
  const siblings = context.metadata
    .readWorktreesForRepository(request.repositoryName)
    .map((worktree) => agreedWorktree(worktree, worktreeSubject(worktree.name)).checkoutPath);

  const record: WorktreeRecord = yield* scoped(function* () {
    const root = yield* host.useDirectory();
    const git = gitSession(host, root);

    // Every retained worktree is materialized beside the repository, not only
    // the one being added. Git decides what a repository's worktrees are by
    // reading `.git/worktrees` and checking that each still exists; a sibling
    // left unmaterialized would look abandoned, and the repository this effect
    // imports back could be missing a checkout the run still holds.
    const repositoryDirectory = yield* exportTree(
      context.filesystem,
      root,
      repositoryPath,
      repositorySubject(request.repositoryName),
    );
    const siblingDirectories: string[] = [];
    for (const path of siblings) {
      siblingDirectories.push(
        yield* exportTree(context.filesystem, root, path, worktreeSubject(request.name)),
      );
    }
    yield* localizeAdministration(
      root,
      repositoryDirectory,
      siblingDirectories,
      repositorySubject(request.repositoryName),
    );

    const directory = `${root}${checkoutPath}`;
    yield* ensureDir(parentOf(directory));
    const added = yield* addWorktree(
      git,
      repositoryDirectory,
      directory,
      request.branch,
      request.base,
    );

    yield* canonicalizeAdministration(
      root,
      repositoryDirectory,
      [...siblingDirectories, directory],
      worktreeSubject(request.name),
    );
    yield* importTree(context.filesystem, root, repositoryPath);
    yield* importTree(context.filesystem, root, checkoutPath);

    return Object.freeze({
      repositoryName: request.repositoryName,
      name: request.name,
      requestedBranch: request.branch,
      requestedBase: request.base ?? null,
      creationCommit: added.commit,
      checkoutPath,
    });
  });

  context.metadata.insertWorktree(record);
  return worktreeRecordJson(record);
}

export function* performWorktree(
  context: MutationContext,
  host: RepositoryHost,
  request: WorktreeCreationRequest,
): Operation<CompositionOutcome> {
  const repository = context.metadata.readRepository(request.repositoryName);
  if (repository === undefined) {
    worktreeRefused(request.name, "unusable-repository");
  }
  agreedStored(repository, repositorySubject(request.repositoryName));

  const existing = context.metadata.readWorktree(request.repositoryName, request.name);
  if (existing !== undefined) {
    agreedWorktree(existing, worktreeSubject(request.name));
    const compatible =
      existing.requestedBranch === request.branch &&
      existing.requestedBase === (request.base ?? null);
    if (!compatible) {
      worktreeRefused(request.name, "incompatible-reuse");
    }
    return created(worktreeRecordJson(existing));
  }

  return yield* attempted(
    "worktree",
    request.name,
    worktreeSubject(request.name),
    retainWorktree(context, host, request, repository),
  );
}

export function* prepareWorktreeAttachment(
  workspace: PrivateWorkspaceTransaction,
  root: string,
  record: WorktreeRecord,
  subject: string,
): Operation<Attached> {
  const stored = workspace.metadata.readWorktree(record.repositoryName, record.name);
  if (stored === undefined || !sameWorktreeRecord(stored, record)) {
    throw stale(subject, "metadata");
  }
  const repository = workspace.metadata.readRepository(record.repositoryName);
  if (repository === undefined) {
    throw stale(subject, "repository");
  }
  agreedStored(repository, repositorySubject(record.repositoryName));
  const checkoutPath = agreedWorktree(record, subject).checkoutPath;
  const repositoryPath = repository.record.checkoutPath;
  if (
    !(yield* workspaceEntryPresent(workspace.filesystem, repositoryPath)) ||
    !(yield* workspaceEntryPresent(workspace.filesystem, checkoutPath))
  ) {
    throw stale(subject, "checkout");
  }

  // Every retained sibling is not needed here: reading HEAD does not consult
  // `.git/worktrees`, and this worktree's own pair is what has to resolve.
  const repositoryDirectory = yield* exportTree(
    workspace.filesystem,
    root,
    repositoryPath,
    repositorySubject(record.repositoryName),
  );
  const directory = yield* exportTree(workspace.filesystem, root, checkoutPath, subject);
  yield* localizeAdministration(root, repositoryDirectory, [directory], subject);
  return { directory, repositoryDirectory, repository: repository.record };
}

/**
 * The same questions for a linked worktree, plus the one only it raises.
 *
 * A worktree's identity is its Repository's identity and its own place inside
 * it, so the origin and the object format are read through the shared
 * administration — and *that* is the thing worth proving: the checkout retained
 * for this worktree has to be a worktree of the Repository this run says it
 * belongs to. Git answers that directly, because `--git-common-dir` resolves
 * through the administration pair to the repository the worktree is linked to.
 * A worktree of some other repository, or a whole repository of its own sitting
 * at the retained path, answers with a different directory.
 */
export function* worktreeDisagreement(
  git: GitSession,
  attached: Attached,
  record: WorktreeRecord,
): Operation<StaleReason | undefined> {
  if ((yield* checkoutReadable(git, attached.directory)) === undefined) {
    return "administration";
  }
  if (
    (yield* commonDirectory(git, attached.directory)) !== `${attached.repositoryDirectory}/.git`
  ) {
    return "linkage";
  }
  return yield* repositoryDisagreement(
    git,
    attached,
    attached.repository.objectFormat,
    record.creationCommit,
  );
}

/** The whole of what `<Worktree>` asks for, on the same terms as Repository. */
export function* createWorktree(
  database: WorkflowRunDatabase,
  host: RepositoryHost,
  request: WorktreeCreationRequest,
): Operation<WorktreeRecord> {
  const outcome = yield* settled(
    "worktree",
    request.name,
    database,
    yield* describeWorktree(request),
    (filesystem, metadata) => performWorktree({ filesystem, metadata }, host, request),
  );
  const record = parseWorktreeRecord(outcome);
  if (record === undefined) {
    throw new RepositoryCompositionProtocolError(WORKSPACE_WORKTREE);
  }
  return agreedWorktree(record, worktreeSubject(record.name));
}
