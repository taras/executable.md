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

/**
 * What one live canonical turn has said so far, for a host that shows it.
 *
 * A snapshot, not a delta: `text` is the whole source received up to this
 * point, already cleared for disclosure by the execution the turn runs in. A
 * host that wants the next word reads this value again rather than appending
 * to the last one, because the consumer re-offers the whole prefix every time
 * and may replace it outright when the stream returns something else.
 *
 * It is not rendered output, a durable result, or evidence that the provider
 * accepted anything. Nothing here can be journaled: there is no session, no
 * checkpoint, no turn number and no append.
 */
export interface AgentPromptObservation {
  /** The exact value this turn's host `begin()` returned. */
  readonly begun: AgentPromptHandle;
  /**
   * The whole source received so far, or `null` to withdraw live text.
   *
   * An empty string is a cleared empty prefix — the turn has said nothing yet,
   * and what it has said is nothing. `null` is the other thing entirely: this
   * turn's source may not be shown at all, so a host drops whatever it was
   * showing and hears nothing further about this turn. No finding, scanner
   * error or rejected value comes with it, because a screen is not where a
   * secret is reported.
   */
  readonly text: string | null;
}

/** One Prompt, ready to publish. */
export interface AgentPromptPublication {
  /**
   * What this host's own `begin()` returned for this exact turn, or nothing
   * when it declared no `begin()`.
   *
   * This is the only thing that says which live turn this publication ends. A
   * prompt that never began canonically — a direct `Agent.prompt()` call from
   * a component, which core does not journal — reaches no publication at all,
   * so this publication cannot be associated with that prompt in either
   * direction.
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
   * This turn has said something more; nothing is durable yet.
   *
   * Called from the canonical consumer after each source delta, and once more
   * when the stream returns text the deltas did not already say — awaited, in
   * that turn's own scope, before the next provider event is asked for. A host
   * that declares none is consumed exactly as it always was: no prefix is
   * accumulated and nothing extra is scanned for it.
   *
   * It is a live courtesy and not an account of the turn: what the turn *was*
   * is the record `publish()` ends it with. A host that throws from here has
   * failed a trusted operation, which fails the run rather than the agent —
   * the same as a throwing `publish()`.
   *
   * An observing publisher must also declare `begin()`: an observation names
   * the turn it belongs to by the handle that turn began with, and a publisher
   * that begins nothing could not tell one of its conversations from another.
   */
  observe?(observation: AgentPromptObservation): Operation<void>;
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
export function* useAgentPromptPublisher(publisher: AgentPromptPublisher): Operation<void> {
  if (publisher.observe !== undefined && publisher.begin === undefined) {
    // Refused here, before a turn exists: an observation is addressed by the
    // handle its turn began with, so a publisher that observes without
    // beginning is asking to be told about turns it cannot name.
    throw new AgentPromptPublisherError(
      "a prompt publisher that observes live text must also begin each turn, because an " +
        "observation names the turn its own begin returned",
    );
  }
  yield* AgentInternal.around({ promptPublisher: () => publisher }, { at: "min" });
}

/** An installation that could not do what it declared. */
export class AgentPromptPublisherError extends Error {
  override name = "AgentPromptPublisherError";
}

/**
 * A trusted host's live observation threw.
 *
 * Package-private, and carried rather than classified: the turn's own consumer
 * reads provider errors as what the agent did, and the publication coordinator
 * serializes an execution error into a failed result. Neither is true of this
 * — the host failed, not the agent — so the original failure travels inside
 * this wrapper, past both conversions, to the durability failure the run
 * already has for a host that cannot be trusted with its own turn.
 */
export class HostObservationFailure extends Error {
  override name = "HostObservationFailure";
  constructor(readonly reason: unknown) {
    super("an installed prompt publisher failed while observing this turn");
  }
}
