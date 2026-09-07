/**
 * The portable checkpoint one completed Prompt turn carries.
 *
 * A checkpoint is the identity a provider gives the turn it has just finished,
 * and it is what lets something later continue that exact conversation instead
 * of replaying its text into a new one. That makes it durable identity, so
 * where it lives matters more than what it says.
 *
 * It lives in a map this module holds, keyed by the exact terminal event object
 * the provider produced — not in a property on that event. An enumerable
 * property is public, and a symbol one is not private either: `Reflect.ownKeys`
 * returns symbol keys as readily as string ones, so anything holding the event
 * could read a checkpoint off it and anything building an event could put one
 * there.
 *
 * Writing is reachable only through the authority core delivers to a provider
 * as it installs it. Reading is reachable only from the prompt this core is
 * running. Middleware sits between the two holding the event and reaches
 * neither: substituting the terminal event loses the association and retains
 * nothing, which is the safe direction, and no substitution invents one.
 *
 * Keying on the event object is also what makes concurrent prompts separable.
 * Two turns in flight are two terminal events, and neither can be read for the
 * other — there is no "the latest completion" here to reach for.
 */

import type { AgentPromptEvent } from "./agent-api.ts";

/** One provider's opaque name for the turn it completed. */
export interface AgentPromptCheckpoint {
  /** The provider, as it names itself: `codex`, `claude`. */
  readonly provider: string;
  /**
   * What kind of identity the value is.
   *
   * Tagged, because "an App Server turn id" and "an assistant message uuid" are
   * different claims that happen to be strings. A host comparing them without
   * the tag would accept one for the other.
   */
  readonly kind: string;
  /**
   * The identity itself, exactly as the provider spelled it.
   *
   * Opaque. Core never parses it, never validates it as a UUID, and never
   * derives it from transcript text, from another turn, from a provider's
   * current head, or from prompt or journal order.
   */
  readonly value: string;
}

/** A checkpoint this core will not carry, and why. */
export class AgentPromptCheckpointError extends Error {
  override name = "AgentPromptCheckpointError";
}

/**
 * The association itself, behind the two operations that may touch it.
 *
 * Held in a closure rather than at module scope, and the distinction is a
 * lifetime one: nothing here accumulates. An entry is keyed by one terminal
 * event, is read once by the prompt that produced it, and is collected with that
 * event — there is no run whose entries are still answering questions during the
 * next one. `workspaceEffectOwners` in `@executablemd/workflow` holds an owner
 * association the same way, for the same reason.
 */
const associations = (() => {
  const entries = new WeakMap<object, AgentPromptCheckpoint>();
  return {
    has(terminal: object): boolean {
      return entries.has(terminal);
    },
    set(terminal: object, token: AgentPromptCheckpoint): void {
      entries.set(terminal, token);
    },
    get(terminal: object): AgentPromptCheckpoint | undefined {
      return entries.get(terminal);
    },
  };
})();

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read a checkpoint from what a provider handed over.
 *
 * Parsed rather than believed: a provider is trusted to know its own turn, not
 * to have built a value of the right shape. Every field is a non-empty string
 * or this is not a checkpoint.
 */
function parseCheckpoint(value: unknown): AgentPromptCheckpoint {
  const provider = nonEmpty(Reflect.get(Object(value), "provider"));
  const kind = nonEmpty(Reflect.get(Object(value), "kind"));
  const token = nonEmpty(Reflect.get(Object(value), "value"));
  if (provider === undefined || kind === undefined || token === undefined) {
    throw new AgentPromptCheckpointError(
      "a Prompt checkpoint names a provider, a kind and a value, each a non-empty string",
    );
  }
  return Object.freeze({ provider, kind, value: token });
}

/**
 * Read a checkpoint out of a value nobody has authenticated, or none.
 *
 * The total counterpart of the parser above, for a reader holding retained
 * bytes rather than something a provider just handed over. A retained
 * checkpoint that does not read back is not a checkpoint, and a caller that
 * needed one says so itself — this reports absence and refuses nothing.
 */
export function readCheckpoint(value: unknown): AgentPromptCheckpoint | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const provider = nonEmpty(Reflect.get(value, "provider"));
  const kind = nonEmpty(Reflect.get(value, "kind"));
  const token = nonEmpty(Reflect.get(value, "value"));
  if (provider === undefined || kind === undefined || token === undefined) {
    return undefined;
  }
  return Object.freeze({ provider, kind, value: token });
}

/**
 * Associate a checkpoint with the exact terminal event that carries it.
 *
 * Only a successful completion has one. A cancelled turn, a failed turn, and a
 * turn whose stop reason was not success each describe a conversation this run
 * cannot continue from, so associating one is refused rather than ignored — a
 * provider offering a checkpoint for a turn that did not complete has told this
 * core something it cannot both accept and be right about.
 *
 * Once, per event. A second association would be a second answer to which turn
 * this was, and there is no rule for choosing between them.
 */
export function associateCheckpoint(terminal: AgentPromptEvent, token: unknown): void {
  if (terminal.type !== "terminal" || terminal.status !== "completed") {
    throw new AgentPromptCheckpointError(
      "only a successfully completed Prompt turn carries a checkpoint",
    );
  }
  if (associations.has(terminal)) {
    throw new AgentPromptCheckpointError(
      "this Prompt completion already carries a checkpoint, and a second one names a " +
        "different turn",
    );
  }
  associations.set(terminal, parseCheckpoint(token));
}

/** The checkpoint this exact completion carries, when one was associated. */
export function checkpointOf(terminal: AgentPromptEvent): AgentPromptCheckpoint | undefined {
  return associations.get(terminal);
}
