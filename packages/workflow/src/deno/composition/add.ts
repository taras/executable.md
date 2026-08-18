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
import { ADD } from "../../composition/components/GitAdd.ts";
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
export function* describeAdd(request: GitAddRequest): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  const configuration = gitOperationFingerprint([
    request.repository.name,
    request.repository.locatorFingerprint,
    request.repository.requestedBase,
    request.repository.creationCommit,
    request.repository.primaryBranch,
    request.repository.objectFormat,
    request.repository.checkoutPath,
    request.workingDirectory,
    ...request.paths,
  ]);
  return {
    type: WORKSPACE_GIT_ADD,
    name: `${expansion.id}:${request.repository.name}:${configuration}`,
    configuration,
    ...sourceDescription(expansion.position),
  };
}

export function performGitAdd(
  context: MutationContext,
  host: RepositoryHost,
  request: GitAddRequest,
): Operation<CompositionOutcome> {
  return performGitOperation(
    context,
    host,
    ADD,
    { repository: request.repository, workingDirectory: request.workingDirectory },
    (checkout: GitCheckout) =>
      addPaths(checkout.git, {
        operation: ADD,
        workingDirectory: checkout.workingDirectory,
        paths: request.paths,
      }),
    (checkout, before: GitCheckoutState, after: GitCheckoutState): Json =>
      gitAddResultJson({
        checkout: checkout.identity,
        paths: request.paths,
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
  const outcome = yield* settled(
    "git",
    ADD,
    database,
    yield* describeAdd(request),
    (filesystem, metadata) => performGitAdd({ filesystem, metadata }, host, request),
  );
  const result = parseGitAddResult(outcome, request);
  if (result === undefined || !placedCheckout(result.checkout, request.repository)) {
    throw new GitOperationProtocolError(ADD);
  }
  return result;
}
