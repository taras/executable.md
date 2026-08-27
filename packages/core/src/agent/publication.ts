/**
 * Where a completed Prompt's durable result is published, for a host that
 * retains something beside it.
 *
 * An ordinary `xmd run` has no publisher, and publishes exactly as it always
 * did: the `agent_prompt` event is appended by the durable machinery and
 * nothing else happens. A host that retains an association — a workflow run
 * keeping which provider turn a Prompt was — installs one, and the append then
 * happens inside whatever transaction that publisher opened. That is the whole
 * point of the seam: the event and what a host keeps beside it commit together
 * or not at all, so no association can survive a Prompt that was never
 * journaled and no journaled Prompt can be left half-described.
 *
 * The Prompt itself runs *before* any of this. A publisher receives a Prompt
 * that has already finished talking to its provider, so nothing a host does
 * here holds a database open across a conversation.
 *
 * Installing one is a host act and reads as one at the import: this is reached
 * through `@executablemd/core/host`, and the private Api it seeds is exported
 * from nowhere. A document, a component, or a middleware package importing
 * `@executablemd/core` cannot name it.
 */

import type { Operation } from "effection";
import { AgentInternal } from "./internal.ts";
import type { AgentPromptCheckpoint } from "./checkpoint.ts";

/** What one completed Prompt turn was, beside the result the journal keeps. */
export interface AgentPromptAssociation {
  /** The provider's checkpoint for this exact completion. */
  readonly checkpoint: AgentPromptCheckpoint;
  /**
   * The session this completion belonged to, exactly as the provider named it.
   *
   * The provider's own key, carried across unchanged. What a host retains it
   * under is that host's business, and resolving one to the other is a lookup
   * the host already holds — never something read out of the spelling of this
   * value.
   */
  readonly sessionKey: string;
}

/** One Prompt, ready to publish. */
export interface AgentPromptPublication {
  /**
   * What this completion carries, or nothing.
   *
   * Absent for every unsuccessful turn, for a provider that named none, and for
   * a completion whose metadata this build could not read. Absent is ordinary:
   * it publishes the Prompt and retains no association.
   */
  readonly association: AgentPromptAssociation | undefined;
  /**
   * Append this Prompt's ordinary durable result.
   *
   * Exactly the event an unattached run appends, unchanged. Call it once, from
   * inside whatever transaction this publisher opened.
   */
  append(): Operation<void>;
}

export interface AgentPromptPublisher {
  /**
   * Publish one completed Prompt, and whatever this host keeps beside it.
   *
   * A publisher that returns without appending has published nothing, and the
   * Prompt fails rather than answering with a result no journal holds.
   */
  publish(publication: AgentPromptPublication): Operation<void>;
}

/**
 * Install the publisher this scope's Prompts publish through.
 *
 * Scope-local, and seeded into the private component Api rather than into
 * anything a document can reach. A nested installation overrides an outer one
 * for its own scope, which is how one process attaches to two runs.
 */
export function useAgentPromptPublisher(publisher: AgentPromptPublisher): Operation<void> {
  return AgentInternal.around({ promptPublisher: () => publisher }, { at: "min" });
}
