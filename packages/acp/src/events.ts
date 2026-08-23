/**
 * Turn event normalization (specs/acp-client-spec.md §Prompt).
 *
 * `consumeTurn` receives an already-started ACPX turn and the resolved
 * identity, and produces the normalized public event sequence: exactly
 * one `started`, then `text_delta` events for output-stream deltas only,
 * then exactly one `terminal`, then the channel closes with the complete
 * concatenated text — including partial text on failure. Thought,
 * status, tool, usage, and raw ACP events stay private.
 */

import { each, stream, until } from "effection";
import type { Channel, Operation } from "effection";
import type { AgentPromptEvent, Session } from "@executablemd/core";
import type { AcpRuntimeTurn, AcpRuntimeTurnResult } from "./acpx-runtime.ts";

export interface TurnIdentity {
  agent: string;
  session: Session;
}

/**
 * What the host decided about this turn, whatever the adapter reported.
 *
 * A refusal the host authored — a denied native permission request — outranks
 * the adapter's own result: an adapter that carries on after being told no would
 * otherwise report a turn the host had already refused as completed.
 */
export type TurnRefusal = () => Error | undefined;

export function* consumeTurn(
  turn: AcpRuntimeTurn,
  identity: TurnIdentity,
  channel: Channel<AgentPromptEvent, string>,
  markCompleted: () => void,
  refused?: TurnRefusal,
): Operation<void> {
  yield* channel.send({ type: "started", agent: identity.agent, session: identity.session });
  let text = "";
  let terminal: AgentPromptEvent;
  try {
    for (const event of yield* each(stream(turn.events))) {
      if (event.type === "text_delta" && (event.stream ?? "output") === "output") {
        text += event.text;
        yield* channel.send({ type: "text_delta", text: event.text });
      }
      yield* each.next();
    }
    terminal = mapResult(yield* until(turn.result));
  } catch (error) {
    terminal = {
      type: "terminal",
      status: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  const refusal = refused?.();
  if (refusal) {
    terminal = { type: "terminal", status: "failed", error: refusal };
  }
  yield* channel.send(terminal);
  markCompleted();
  yield* channel.close(text);
}

function mapResult(result: AcpRuntimeTurnResult): AgentPromptEvent {
  if (result.status === "completed") {
    // ACP defines end_turn as the only successful stop reason. An absent
    // stop reason on a completed turn is treated as end_turn — some
    // adapters omit it on normal completion.
    const stopReason = result.stopReason ?? "end_turn";
    if (stopReason === "end_turn") {
      return { type: "terminal", status: "completed", stopReason };
    }
    return {
      type: "terminal",
      status: "failed",
      stopReason,
      error: new Error(`agent prompt failed with stop reason "${stopReason}"`),
    };
  }
  if (result.status === "cancelled") {
    const terminal: AgentPromptEvent = { type: "terminal", status: "cancelled" };
    if (result.stopReason !== undefined) {
      terminal.stopReason = result.stopReason;
    }
    return terminal;
  }
  const failure = new Error(result.error.message);
  return { type: "terminal", status: "failed", error: failure };
}
