/**
 * The canonical record that a withheld reply was accepted, and how every
 * reader joins it to its turn.
 *
 * A held conversation that withheld a completed reply first journals that
 * withheld completion, unchanged. When the person in front of the host
 * accepts the reply, a second, distinct record follows it in the same root
 * sequence: `agent_prompt_reply`, under the same durable name as the turn it
 * amends, holding the exact original text and an inert audit of the rule,
 * message and range each approved match had. The first record is never
 * rewritten. It consumes no turn ordinal and no feedback slot: it is the same
 * turn, now with its reply.
 *
 * One reconciler reads the pair for every consumer, so replay, the Sidekick's
 * readers and its projections agree on one rule. An acceptance counts only
 * directly after the withheld completion of the turn it names, once. Anything
 * else — one with no turn before it, a second one, one after another turn,
 * one after a turn that was not withheld, one whose record does not read — is
 * a history that cannot say what its turn answered, and it is refused rather
 * than resolved in favour of a later candidate.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { createDurableOperation } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { isJsonObject } from "../json.ts";
import { AGENT_PROMPT, parsePromptRecord } from "./journal.ts";
import type { ApprovedMatch } from "../secrets/reply-grant.ts";

/** The durable effect an accepted reply is retained under. */
export const AGENT_PROMPT_REPLY = "agent_prompt_reply";

const VERSION = 1;

/** One accepted reply, as its record holds it. */
export interface PromptReplyRecord {
  /** The exact text the provider completed the turn with. */
  readonly text: string;
  /** Where each approved match was, by rule and range. Never the matched text. */
  readonly approved: readonly {
    readonly ruleId: string;
    readonly messageId: string;
    readonly start: number;
    readonly end: number;
  }[];
}

/** Why an acceptance in a history cannot be joined to its turn. */
export class PromptReplyHistoryError extends Error {
  override name = "PromptReplyHistoryError";
}

/** Read one acceptance record, or nothing when it is not exactly one. */
export function parsePromptReply(value: Json | undefined): PromptReplyRecord | undefined {
  if (!isJsonObject(value) || value.version !== VERSION || typeof value.text !== "string") {
    return undefined;
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "approved,text,version" || !Array.isArray(value.approved)) {
    return undefined;
  }
  const approved: PromptReplyRecord["approved"][number][] = [];
  for (const one of value.approved) {
    if (
      !isJsonObject(one) ||
      Object.keys(one).sort().join(",") !== "end,messageId,ruleId,start" ||
      typeof one.ruleId !== "string" ||
      typeof one.messageId !== "string" ||
      typeof one.start !== "number" ||
      typeof one.end !== "number" ||
      !Number.isInteger(one.start) ||
      !Number.isInteger(one.end) ||
      one.start < 0 ||
      one.end <= one.start ||
      one.end > value.text.length
    ) {
      return undefined;
    }
    approved.push(
      Object.freeze({
        ruleId: one.ruleId,
        messageId: one.messageId,
        start: one.start,
        end: one.end,
      }),
    );
  }
  if (approved.length === 0) {
    return undefined;
  }
  return Object.freeze({ text: value.text, approved: Object.freeze(approved) });
}

/**
 * Append the acceptance of one withheld turn.
 *
 * Its own durable operation, in the turn's own frame, so it lands in the root
 * sequence directly after the turn it amends. The text is saved before
 * anything can show it as accepted or run it.
 */
export function* persistPromptReply(
  name: string,
  text: string,
  approved: readonly ApprovedMatch[],
): Operation<void> {
  const record: Json = {
    version: VERSION,
    text,
    approved: approved.map((one) => ({
      ruleId: one.ruleId,
      messageId: one.messageId,
      start: one.start,
      end: one.end,
    })),
  };
  yield createDurableOperation<Json>(
    { type: AGENT_PROMPT_REPLY, name, input: name },
    // deno-lint-ignore require-yield
    function* (): Operation<Json> {
      return record;
    },
  );
}

/**
 * One retained acceptance, offered again so replay stays aligned.
 *
 * Its live body refuses: reaching it means the record is not there after all,
 * and an acceptance is never made again without the person who made it.
 */
export function* replayPromptReply(name: string): Operation<void> {
  yield createDurableOperation<Json>(
    { type: AGENT_PROMPT_REPLY, name, input: name },
    // deno-lint-ignore require-yield
    function* (): Operation<Json> {
      throw new PromptReplyHistoryError(
        `the conversation's retained acceptance for "${name}" has no recorded outcome, so it ` +
          "cannot be read back and is not made again",
      );
    },
  );
}

/**
 * The accepted text of each turn in one conversation's root sequence.
 *
 * `events` are that conversation's canonical events in history order. Only
 * root yields take part; a generated evaluation's sequence is its own.
 */
export function acceptedReplies(
  events: readonly DurableEvent[],
): Result<ReadonlyMap<string, PromptReplyRecord>> {
  const accepted = new Map<string, PromptReplyRecord>();
  let previous: DurableEvent | undefined;
  for (const event of events) {
    if (event.type !== "yield") {
      continue;
    }
    if (event.description.type === AGENT_PROMPT_REPLY) {
      const name = event.description.name;
      const refused = (why: string) =>
        Err<ReadonlyMap<string, PromptReplyRecord>>(
          new PromptReplyHistoryError(
            `this conversation's acceptance for "${name}" ${why}, so what that turn answered ` +
              "cannot be read from its history",
          ),
        );
      if (event.coroutineId !== "root" || event.description.input !== name) {
        return refused("has a different canonical association");
      }
      if (event.result.status !== "ok") {
        return refused("recorded no outcome");
      }
      const reply = parsePromptReply(event.result.value);
      if (reply === undefined) {
        return refused("does not read as an acceptance");
      }
      if (accepted.has(name)) {
        return refused("is recorded more than once");
      }
      if (
        previous?.type !== "yield" ||
        previous.description.type !== AGENT_PROMPT ||
        previous.description.name !== name ||
        previous.result.status !== "ok"
      ) {
        return refused("does not directly follow that turn");
      }
      if (parsePromptRecord(previous.result.value)?.withheld !== true) {
        return refused("follows a turn whose reply was not withheld");
      }
      accepted.set(name, reply);
    }
    if (event.coroutineId === "root") {
      previous = event;
    }
  }
  return Ok(accepted);
}
