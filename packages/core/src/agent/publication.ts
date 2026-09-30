/**
 * Where a Prompt's durable result is published, for a host that retains
 * something beside it.
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
 * A publisher sees one turn at two moments, and only these two. `begin()` is
 * called before the provider is asked, so a host that shows live work can
 * create it there; `publish()` is called once the turn has finished talking to
 * its provider, so nothing a host does at publication holds a database open
 * across a conversation. What `begin()` returned comes back on the
 * publication, and that is the only thing tying the two together — core never
 * reads it.
 *
 * `begin()` is optional. A publisher that declares none is called exactly as
 * it always was, and its publications carry an undefined handle.
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

/**
 * What a host recognised one canonical turn by, exactly as its own `begin()`
 * returned it.
 *
 * Opaque to core, which never reads it, compares it or writes it anywhere: it
 * is carried from the turn that began to the publication that ends it and
 * nowhere else. Ephemeral and process-local by construction — it is whatever
 * object the host made, so it cannot outlive the process and cannot be
 * journaled.
 */
export type AgentPromptHandle = unknown;

/** One Prompt, ready to publish. */
export interface AgentPromptPublication {
  /**
   * What this host's own `begin()` returned for this exact turn, or nothing
   * when it declared no `begin()`.
   *
   * This is the only thing that says which live turn this publication ends. A
   * prompt that never began canonically — a direct `Agent.prompt()` call from
   * a component, which core does not journal — reaches no publication at all,
   * so it can neither claim this one nor be claimed by it.
   */
  readonly begun: AgentPromptHandle;
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
   * A canonical Prompt is about to ask its provider; nothing is durable yet.
   *
   * Called once per journal-owned turn, in that turn's own scope and at the
   * moment its private audit ledger is placed — so a host that shows live work
   * can create it here and be handed the same value back in `publish()`. What
   * it returns is the host's own, and core only carries it.
   *
   * `input` is the rendered prompt this turn is about to ask, exactly as the
   * record will hold it.
   *
   * Only the canonical `<Prompt>` boundary calls this. A component that calls
   * the public `Agent.prompt()` itself is not journal-owned work: it begins
   * nothing, publishes nothing, and appends no record.
   */
  begin?(input: string): Operation<AgentPromptHandle>;
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
