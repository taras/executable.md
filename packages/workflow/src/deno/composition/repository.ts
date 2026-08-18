/**
 * What a `<Repository>` owns: one clone, pinned once, and its live facade.
 *
 * Creation authorizes the locator, resolves the base exactly once, pins the
 * commit, puts the checkout on a named branch and retains the whole of it.
 * Attachment rebuilds that checkout from the Workspace root the journal
 * selected and proves it is still the one the record names — where it came
 * from, how it names objects, and whether the commit it was created at is in
 * it. Neither half asks where HEAD is: a later Git effect moves that
 * transactionally, and creation identity does not move.
 */
import { scoped, type Operation } from "effection";
import { getExpansion, sourceDescription } from "@executablemd/core";
import type { EffectDescription, Json } from "@executablemd/durable-streams";
import { ensureDir } from "@effectionx/fs";
import { RepositoryCompositionProtocolError } from "../../composition/errors.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import {
  parseRepositoryRecord,
  repositoryRecordJson,
  sameRepositoryRecord,
  type GitObjectFormat,
  type RepositoryCreationRequest,
  type RepositoryRecord,
} from "../../composition/records.ts";
import type { PrivateWorkspaceTransaction } from "../workspace/private.ts";
import {
  checkoutPrimary,
  checkoutReadable,
  clone,
  commitPresent,
  gitSession,
  objectFormat,
  originLocator,
  readObjectFormat,
  resolveRepositoryStart,
  type GitSession,
} from "./git.ts";
import type { RepositoryHost } from "./host.ts";
import { admitLocator, locatorFingerprint } from "./locator.ts";
import {
  exportTree,
  importTree,
  localizeAdministration,
  workspaceEntryPresent,
} from "./materialize.ts";
import { repositoryCheckoutPath } from "./placement.ts";
import {
  attempted,
  created,
  fingerprintOf,
  parentOf,
  settled,
  WORKSPACE_REPOSITORY,
  type CompositionOutcome,
  type MutationContext,
} from "./effects.ts";
import { repositoryRefused } from "./refusals.ts";
import {
  agreedRepository,
  agreedStored,
  repositorySubject,
  stale,
  type Attached,
  type StaleReason,
} from "./identity.ts";

/**
 * How one composition effect is identified.
 *
 * The expansion is what makes two elements different effects and one element
 * the same effect across replays. The configuration fingerprint is what makes a
 * document edited to name another repository, base or branch diverge rather than
 * quietly replaying the previous one's retained checkout — durable identity is
 * type and name, so the fingerprint belongs in the name rather than beside it.
 * The locator reaches it only through its own fingerprint, so a credential that
 * was written into a URL is not in an effect description either.
 */
export function* describeRepository(
  request: RepositoryCreationRequest,
  locatorIdentity: string,
): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  const configuration = fingerprintOf([request.name, locatorIdentity, request.base ?? null]);
  return {
    type: WORKSPACE_REPOSITORY,
    name: `${expansion.id}:${request.name}:${configuration}`,
    configuration,
    ...sourceDescription(expansion.position),
  };
}

function* retainRepository(
  context: MutationContext,
  host: RepositoryHost,
  request: RepositoryCreationRequest,
  locator: string,
  identity: string,
): Operation<Json> {
  const checkoutPath = repositoryCheckoutPath(request.name);

  const record: RepositoryRecord = yield* scoped(function* () {
    const root = yield* host.useDirectory();
    const git = gitSession(host, root);
    const directory = `${root}${checkoutPath}`;
    yield* ensureDir(parentOf(directory));

    yield* clone(git, locator, directory, root);
    const start = yield* resolveRepositoryStart(git, directory, request.base);
    yield* checkoutPrimary(git, directory, start);
    const format = yield* objectFormat(git, directory);

    yield* importTree(context.filesystem, root, checkoutPath);

    return Object.freeze({
      name: request.name,
      locatorFingerprint: identity,
      requestedBase: request.base ?? null,
      creationCommit: start.commit,
      primaryBranch: start.primaryBranch,
      objectFormat: format,
      checkoutPath,
    });
  });

  context.metadata.insertRepository({ record, locator });
  return repositoryRecordJson(record);
}

export function* performRepository(
  context: MutationContext,
  host: RepositoryHost,
  request: RepositoryCreationRequest,
): Operation<CompositionOutcome> {
  const locator = admitLocator(request.locator);
  if (locator === undefined) {
    repositoryRefused(request.name, "invalid-locator");
  }
  const identity = locatorFingerprint(locator);

  const existing = context.metadata.readRepository(request.name);
  if (existing !== undefined) {
    const stored = agreedStored(existing, repositorySubject(request.name));
    // The exact admitted bytes, not only their fingerprint. Two locators with
    // one fingerprint would be a broken digest rather than a compatible reuse,
    // and comparing what Git is actually given is what makes that unreachable.
    const compatible =
      stored.locator === locator && stored.record.requestedBase === (request.base ?? null);
    if (!compatible) {
      repositoryRefused(request.name, "incompatible-reuse");
    }
    return created(repositoryRecordJson(stored.record));
  }

  return yield* attempted(
    "repository",
    request.name,
    repositorySubject(request.name),
    retainRepository(context, host, request, locator, identity),
  );
}

export function* prepareRepositoryAttachment(
  workspace: PrivateWorkspaceTransaction,
  root: string,
  record: RepositoryRecord,
  subject: string,
): Operation<Attached> {
  const stored = workspace.metadata.readRepository(record.name);
  if (stored === undefined || !sameRepositoryRecord(stored.record, record)) {
    throw stale(subject, "metadata");
  }
  // Before the Workspace is read and long before Git runs: what is retained has
  // to still be this identity's own placement and this identity's own url.
  agreedStored(stored, subject);
  const checkoutPath = agreedRepository(record, subject).checkoutPath;
  if (!(yield* workspaceEntryPresent(workspace.filesystem, checkoutPath))) {
    throw stale(subject, "checkout");
  }
  const directory = yield* exportTree(workspace.filesystem, root, checkoutPath, subject);
  yield* localizeAdministration(root, directory, [], subject);
  return { directory, repositoryDirectory: directory, repository: record };
}

/**
 * What the checkout at a retained path has to turn out to be, or what disagrees.
 *
 * Readable is where this used to stop, and readable is a property of *any*
 * repository. A clone of an unrelated repository written over the retained path
 * is perfectly readable, so attachment that asked only that question accepted
 * one identity's history against another identity's bytes — and the document
 * carried on, restoring recorded reads that no longer describe what is there
 * while every later live effect ran against the substitute.
 *
 * So the three things the record actually claims are read back out of the
 * checkout: where it came from, how it names objects, and whether the commit it
 * was created at is in it. Each is creation identity, and creation identity does
 * not move. What is deliberately *not* asked is where HEAD or the current branch
 * is: #294 moves those transactionally, and requiring them to equal creation
 * state would make an ordinary commit look like corruption.
 *
 * The origin is compared by fingerprint rather than by bytes. The fingerprint is
 * what every other comparison in this provider uses, and it is the one form of
 * the locator that is safe to hold beside a diagnostic.
 */
export function* repositoryDisagreement(
  git: GitSession,
  attached: Attached,
  objectFormat: GitObjectFormat,
  creationCommit: string,
): Operation<StaleReason | undefined> {
  if ((yield* checkoutReadable(git, attached.directory)) === undefined) {
    return "administration";
  }

  const origin = yield* originLocator(git, attached.repositoryDirectory);
  if (
    origin === undefined ||
    locatorFingerprint(origin) !== attached.repository.locatorFingerprint
  ) {
    return "origin";
  }
  if ((yield* readObjectFormat(git, attached.repositoryDirectory)) !== objectFormat) {
    return "object-format";
  }
  if (!(yield* commitPresent(git, attached.directory, creationCommit))) {
    return "creation-commit";
  }
  return undefined;
}

/**
 * The whole of what `<Repository>` asks for: one durable effect, then the
 * record it settled on, held to the identity that names it.
 */
export function* createRepository(
  database: WorkflowRunDatabase,
  host: RepositoryHost,
  request: RepositoryCreationRequest,
): Operation<RepositoryRecord> {
  const admitted = admitLocator(request.locator);
  const outcome = yield* settled(
    "repository",
    request.name,
    database,
    yield* describeRepository(request, admitted === undefined ? "" : locatorFingerprint(admitted)),
    (filesystem, metadata) => performRepository({ filesystem, metadata }, host, request),
  );
  const record = parseRepositoryRecord(outcome);
  if (record === undefined) {
    throw new RepositoryCompositionProtocolError(WORKSPACE_REPOSITORY);
  }
  return agreedRepository(record, repositorySubject(record.name));
}
