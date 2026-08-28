/**
 * Where a workflow run's Prompts publish
 * (specs/workflow-workspace-spec.md §8.6).
 *
 * A Prompt talks to a provider, and that has nothing to do with SQLite. So the
 * order here is: the conversation happens, it finishes, and only then does a
 * transaction open — long enough to append the Prompt's ordinary event, name
 * the exact event that append produced, retain what the run keeps beside it,
 * and commit. Nothing holds this run's one writer open across a turn.
 *
 * The two halves commit together or not at all, which is the whole reason this
 * exists. An association that could survive a Prompt that was never journaled
 * would name a turn the run has no record of; a Prompt that could commit while
 * its association was lost would silently become one this run cannot continue
 * from. A failure anywhere before the commit leaves neither.
 *
 * ## What is retained, and what is not
 *
 * Only a completion the provider named, in a session this run retains. Both are
 * supplied — the token by the provider through core's delivered authority, the
 * logical session key by the placement that made the session — and neither is
 * derived. In particular the retained key is never recovered from the spelling
 * of the provider's own session key: those are two different namespaces that
 * happen to share a prefix, and reading one out of the other is a parse that
 * would quietly keep working while it was wrong.
 *
 * A Prompt whose session this host cannot name retains no association and is
 * published exactly as any other Prompt.
 */

import type { Operation } from "effection";
import type { AgentPromptPublication, AgentPromptPublisher } from "@executablemd/core/host";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import { WorkflowTransactionError } from "../storage/errors.ts";
import { withEnlistedJournalRoute } from "./journal-route.ts";
import {
  type PrivateWorkspaceTransaction,
  withPrivateWorkspaceTransaction,
  workflowRunTransactionToken,
} from "./workspace/private.ts";

/**
 * How this host names the session one completion belonged to.
 *
 * Answers `undefined` for a session it did not place. Absent is ordinary: the
 * Prompt publishes, and nothing is retained beside it.
 */
export type RetainedSessionKey = (providerSessionKey: string) => string | undefined;

export interface WorkflowPromptPublisherOptions {
  /** The exact run this publisher publishes to. */
  readonly database: WorkflowRunDatabase;
  /** What this run retains each placed session under. */
  readonly retainedSessionKey: RetainedSessionKey;
}

/** A publication that did not produce exactly the one event it was for. */
class WorkflowPromptPublicationError extends WorkflowTransactionError {
  override name = "WorkflowPromptPublicationError";
}

/**
 * The publisher one workflow attachment installs, for its own database.
 *
 * Bound to that exact handle. A publication for anything else has no
 * transaction to open here, which is why this takes the database rather than
 * looking one up.
 */
export function createWorkflowPromptPublisher(
  options: WorkflowPromptPublisherOptions,
): AgentPromptPublisher {
  const { database, retainedSessionKey } = options;

  function* retain(
    workspace: PrivateWorkspaceTransaction,
    publication: AgentPromptPublication,
  ): Operation<void> {
    const before = workspace.appendedEventIds().length;
    yield* publication.append();
    const appended = workspace.appendedEventIds().slice(before);
    const eventId = appended[0];
    if (appended.length !== 1 || eventId === undefined) {
      // One Prompt is one event. Anything else means this transaction holds
      // writes nobody here can account for, and an association would be
      // attached to whichever of them happened to come first.
      throw new WorkflowPromptPublicationError(
        `publishing one Prompt appended ${appended.length} journal events, so this run cannot ` +
          "say which event it just retained.",
      );
    }

    const association = publication.association;
    if (association === undefined) {
      return;
    }
    const sessionKey = retainedSessionKey(association.sessionKey);
    if (sessionKey === undefined) {
      // A session this attachment did not place. The Prompt is published;
      // there is simply no retained session to hang a checkpoint from.
      return;
    }
    workspace.agentCheckpoints.associate({
      eventId,
      sessionKey,
      provider: association.checkpoint.provider,
      tokenKind: association.checkpoint.kind,
      tokenValue: association.checkpoint.value,
    });
  }

  return {
    *publish(publication: AgentPromptPublication): Operation<void> {
      const transacted = yield* database.transact(function* (transaction) {
        const token = yield* workflowRunTransactionToken(database, transaction);
        return yield* withPrivateWorkspaceTransaction(database, transaction, (workspace) =>
          withEnlistedJournalRoute(database, transaction, token, retain(workspace, publication)),
        );
      });
      if (!transacted.ok) {
        throw transacted.error;
      }
    },
  };
}
