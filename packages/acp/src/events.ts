/**
 * Turn event normalization (specs/acp-client-spec.md §Prompt).
 *
 * `consumeTurn` receives an already-started ACPX turn and the resolved
 * identity, and produces the normalized public event sequence: exactly
 * one `started`, then `text_delta` events for output-stream deltas only,
 * then exactly one `terminal`, then the channel closes with the complete
 * concatenated text — including partial text on failure. Thought,
 * status, tool, usage, and raw ACP events stay private.
 *
 * A successfully completed turn may also name itself. When the adapter said
 * which turn this was, that name is associated with the exact terminal event
 * this produces, through the coordinator core delivered to this provider — never
 * as a property on the event, which every holder of the event could read and
 * every builder of one could write. A turn that was cancelled, failed, or
 * refused by the host names nothing.
 *
 * Usage is read on the same pass, by the same reader: a live update is offered
 * to the turn's collector as it arrives, and the terminal result — whichever
 * way the turn ended — settles it before the terminal event is sent. The
 * collector never throws, and it is consulted outside the failure handling
 * below, so observing a turn cannot cancel, close or fail it.
 */

import { each, race, stream, until } from "effection";
import type { Channel, Operation } from "effection";
import type { AgentPromptCheckpoint, AgentPromptEvent, Session } from "@executablemd/core";
import type { AcpRuntimeTurn, AcpRuntimeTurnResult } from "./acpx-runtime.ts";
import { checkpointFromResult } from "./checkpoint.ts";
import { XmdResponse, XMD_RESPONSE, xmdPromptEvent } from "./xmd-response.ts";
import type { Registration } from "./permission-bridge.ts";
import type { TurnUsage } from "./usage.ts";

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

/**
 * How this turn says which provider turn it was.
 *
 * Supplied by the caller that holds this provider's delivered coordinator, and by
 * nothing else. A turn consumed without one — an embedder driving the provider
 * directly — names no turn, which retains nothing.
 */
export type TurnCheckpoint = (terminal: AgentPromptEvent, token: AgentPromptCheckpoint) => void;

export function* consumeTurn(
  turn: AcpRuntimeTurn,
  identity: TurnIdentity,
  channel: Channel<AgentPromptEvent, string>,
  markCompleted: () => void,
  refused?: TurnRefusal,
  checkpoint?: TurnCheckpoint,
  inputs?: Registration,
  closeFailed?: () => Operation<void>,
  usage?: TurnUsage,
): Operation<void> {
  yield* channel.send({ type: "started", agent: identity.agent, session: identity.session });
  let text = "";
  let terminal: AgentPromptEvent;
  let named: AgentPromptCheckpoint | undefined;
  let settled: AcpRuntimeTurnResult | undefined;
  try {
    const reading = function* (): Operation<void> {
      for (const event of yield* each(stream(turn.events))) {
        usage?.observe(event);
        if (event.type === "text_delta" && (event.stream ?? "output") === "output") {
          text += event.text;
          yield* channel.send({ type: "text_delta", text: event.text });
        }
        if (
          event.type === "tool_call" &&
          event.rawOutput !== null &&
          typeof event.rawOutput === "object" &&
          XMD_RESPONSE in event.rawOutput
        ) {
          const response = XmdResponse.parse(Reflect.get(event.rawOutput, XMD_RESPONSE));
          if (response.event === "retired") {
            if (inputs !== undefined) {
              yield* inputs.retire(response.presentationId);
            }
          } else {
            const mapped = xmdPromptEvent(response);
            if (mapped !== undefined) {
              yield* channel.send(mapped);
            }
          }
        }
        yield* each.next();
      }
    };
    if (inputs === undefined) {
      yield* reading();
    } else {
      yield* race([
        reading(),
        (function* (): Operation<never> {
          throw yield* inputs.failed;
        })(),
      ]);
    }
    const result = yield* until(turn.result);
    settled = result;
    terminal = mapResult(result, turn.requestId);
    // Read from the result rather than from the mapped event: a turn ACP
    // reported as completed under a stop reason this host treats as a failure
    // is a failure here, and a failure names no turn.
    if (terminal.type === "terminal" && terminal.status === "completed") {
      named = checkpointFromResult(result);
    }
  } catch (error) {
    const original = error instanceof Error ? error : new Error(String(error));
    const cleanup: Error[] = [];
    for (const finish of [
      () => until(turn.cancel()),
      function* (): Operation<void> {
        settled = yield* until(turn.result);
      },
      ...(closeFailed === undefined ? [] : [closeFailed]),
    ]) {
      try {
        yield* finish();
      } catch (cause) {
        cleanup.push(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }
    terminal = {
      type: "terminal",
      status: "failed",
      error:
        cleanup.length === 0
          ? original
          : new AggregateError([original, ...cleanup], original.message, { cause: original }),
    };
  }
  const refusal = refused?.();
  if (refusal) {
    terminal = { type: "terminal", status: "failed", error: refusal };
    // The host already refused this turn. Whatever the adapter went on to call
    // it, there is no completion here to continue from.
    named = undefined;
  }
  if (named !== undefined) {
    checkpoint?.(terminal, named);
  }
  usage?.settle(settled);
  yield* channel.send(terminal);
  markCompleted();
  yield* channel.close(text);
}

function mapResult(result: AcpRuntimeTurnResult, requestId: string): AgentPromptEvent {
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
  Object.defineProperty(failure, "executablemd.agent.prompt-diagnostic", {
    value: {
      provider: "acp",
      operation: "session/prompt",
      stage: "runtime-turn",
      requestId,
      ...(result.error.code === undefined ? {} : { code: result.error.code }),
      ...(result.error.detailCode === undefined ? {} : { detailCode: result.error.detailCode }),
      ...(result.error.retryable === undefined ? {} : { retryable: result.error.retryable }),
      ...(result.error.origin === undefined ? {} : { origin: result.error.origin }),
      ...(result.error.acp === undefined
        ? {}
        : {
            acp: {
              code: result.error.acp.code,
              message: result.error.acp.message,
              ...(result.error.acp.details === undefined
                ? {}
                : { details: result.error.acp.details }),
            },
          }),
    },
  });
  return { type: "terminal", status: "failed", error: failure };
}
