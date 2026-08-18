/**
 * What `<Git.Add>` owns: one staging command, and the evidence it ran.
 *
 * Everything about *where* it happens belongs to the operation envelope. What is
 * here is the command itself, which has no decision in it: the pathspecs a
 * document wrote are handed to native Git in the order it wrote them, from the
 * directory the element was written in, as one command.
 *
 * The retained result keeps those pathspecs and the checkout on both sides.
 * Staging moves the index and nothing else, so the branch, the commit and the
 * HEAD tree are the same in both readings, and the index tree is the one value
 * that may have moved — or may not have, because staging what is already staged
 * changes nothing.
 */
import { type Operation } from "effection";
import { getExpansion, sourceDescription } from "@executablemd/core";
import type { EffectDescription, Json } from "@executablemd/durable-streams";
import { GitOperationProtocolError } from "../../composition/errors.ts";
import {
  gitAddResultJson,
  parseGitAddResult,
  type GitAddRequest,
  type GitAddResult,
  type GitCheckoutState,
} from "../../composition/git-records.ts";
import { ADD, admitPathspecs } from "../../composition/components/GitAdd.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { addPaths } from "./git.ts";
import type { RepositoryHost } from "./host.ts";
import { settled, type CompositionOutcome, type MutationContext } from "./effects.ts";
import { gitOperationFingerprint, performGitOperation, type GitCheckout } from "./operations.ts";
import { placedCheckout } from "./identity.ts";

/** The effect type one staging command is recorded under. */
export const WORKSPACE_GIT_ADD = "workspace_git_add";

/**
 * How one staging command is identified.
 *
 * Takes the admitted snapshot, like everything below it: `createGitAdd()` is the
 * only door, so nothing here can be handed a request whose values may still
 * change underneath it.
 *
 * The expansion makes two elements different effects and one element the same
 * effect across replays; the configuration fingerprint makes a document edited
 * to name other paths, another directory or another Repository diverge rather
 * than replaying the previous one's retained result.
 *
 * The pathspecs are carried entry by entry rather than joined. The fingerprint's
 * encoding is injective over a sequence, so two arrays that differ in order, in
 * repetition or in where one entry ends and the next begins are different
 * identities — which is the whole of what `paths` means.
 */
function* describeAdd(admitted: GitAddRequest): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  const configuration = gitOperationFingerprint([
    admitted.repository.name,
    admitted.repository.locatorFingerprint,
    admitted.repository.requestedBase,
    admitted.repository.creationCommit,
    admitted.repository.primaryBranch,
    admitted.repository.objectFormat,
    admitted.repository.checkoutPath,
    admitted.workingDirectory,
    ...admitted.paths,
  ]);
  return {
    type: WORKSPACE_GIT_ADD,
    name: `${expansion.id}:${admitted.repository.name}:${configuration}`,
    configuration,
    ...sourceDescription(expansion.position),
  };
}

function performGitAdd(
  context: MutationContext,
  host: RepositoryHost,
  admitted: GitAddRequest,
): Operation<CompositionOutcome> {
  return performGitOperation(
    context,
    host,
    ADD,
    { repository: admitted.repository, workingDirectory: admitted.workingDirectory },
    (checkout: GitCheckout) =>
      addPaths(checkout.git, {
        operation: ADD,
        workingDirectory: checkout.workingDirectory,
        paths: admitted.paths,
      }),
    (checkout, before: GitCheckoutState, after: GitCheckoutState): Json =>
      gitAddResultJson({
        checkout: checkout.identity,
        paths: admitted.paths,
        before,
        after,
      }),
  );
}

/** The whole of what `<Git.Add>` asks for: one durable effect, exactly parsed. */
export function* createGitAdd(
  database: WorkflowRunDatabase,
  host: RepositoryHost,
  request: GitAddRequest,
): Operation<GitAddResult> {
  // Admission takes a snapshot, and the snapshot is what the operation runs on.
  // A caller's array and record are its own objects, and this operation has
  // suspension points — a Git command, a transaction, an import — across which
  // whoever handed them over can still change them. Reading them again later
  // would let an effect identify one request, hand Git a second and retain a
  // third, and would put an unpaired surrogate back on the way to a process
  // argument list after it had been refused.
  const admitted: GitAddRequest = Object.freeze({
    repository: Object.freeze({ ...request.repository }),
    workingDirectory: request.workingDirectory,
    paths: admitPathspecs(request.paths),
  });

  const outcome = yield* settled(
    "git",
    ADD,
    database,
    yield* describeAdd(admitted),
    (filesystem, metadata) => performGitAdd({ filesystem, metadata }, host, admitted),
  );
  const result = parseGitAddResult(outcome, admitted);
  if (result === undefined || !placedCheckout(result.checkout, admitted.repository)) {
    throw new GitOperationProtocolError(ADD);
  }
  return result;
}
