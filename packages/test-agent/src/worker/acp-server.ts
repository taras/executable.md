/**
 * ACP-on-stdio serving for `xmd test-agent` (specs/test-agent-spec.md
 * §Controller and worker). stdout carries only JSON-RPC lines; all
 * logging goes to stderr. The worker is stateless but advertises and
 * serves session/load: all state loads from the controller, so a load
 * reopens the scenario's one conversation over the rehydrated document.
 */

import { ensure, Err, Ok, resource, until, useScope } from "effection";
import type { Operation, Result } from "effection";
import process from "node:process";
import * as acp from "@agentclientprotocol/sdk";
import type { ContentBlock, PromptResponse } from "@agentclientprotocol/sdk";

/**
 * The one versioned key an adapter reports its backend's acceptance of a turn
 * on. A session placed for a first turn is occupancy until this arrives, so an
 * agent that never sent it would leave every session it serves unestablished.
 */
const SESSION_MATERIALIZATION_META = "executablemd.session-materialization/v1";

export type TurnResult = { cancelled: true } | { cancelled: false; text: string };

export interface WorkerAgent {
  /** Resolves once the behavior document reached its first matcher. */
  ready(): Operation<void>;
  /**
   * The two names of the one conversation this worker serves, known before any
   * session exists: the handle `session/new` returns and `session/load`
   * accepts, and the provider-native identity the agent asserts for it.
   *
   * They are deliberately different strings. A native id is something an agent
   * asserts about its own durable state; a client that guessed one from the ACP
   * id would be inferring an identity the provider never asserted, and a test
   * agent that returned the same string for both would make that mistake
   * untestable.
   */
  identity(): { acpSessionId: string; nativeSessionId: string };
  /**
   * Materialize the provider-native session under the instruction layer the
   * client attached.
   */
  startSession(instructions: string | undefined): Operation<void>;
  runTurn(text: string): Operation<TurnResult>;
  configuration?(): Operation<acp.SessionConfigOption[] | undefined>;
  setConfiguration?(configId: string, value: string): Operation<acp.SessionConfigOption[]>;
  cancel(): void;
}

/** The byte transport the ACP connection is served over. */
export interface AcpByteStreams {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
}

/**
 * The instruction layer a client attached to session creation.
 *
 * ACPX writes it to `_meta.systemPrompt`, as the whole text or as an
 * `{ append }` fragment. Anything else is not an instruction layer this agent
 * recognizes, and is read as none rather than coerced.
 */
function systemPromptOf(meta: { [key: string]: unknown } | null | undefined): string | undefined {
  if (!meta) {
    return undefined;
  }
  const value = meta.systemPrompt;
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const append = (value as { append?: unknown }).append;
    return typeof append === "string" ? append : undefined;
  }
  return undefined;
}

function extractText(prompt: ContentBlock[]): string {
  let text = "";
  for (const block of prompt) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}

export function* serveAcp(worker: WorkerAgent, streams: AcpByteStreams): Operation<void> {
  const scope = yield* useScope();

  // The SDK awaits the handler's return. A scope.run task that throws raises
  // into the worker scope, so failures are trapped to a Result (task outcome
  // stays Ok — the worker survives) and re-surfaced as a rejection, which the
  // SDK maps to the JSON-RPC error. On halt the task's own future rejects, so
  // the returned promise always settles — no stranded handler.
  function handle<T>(op: () => Operation<T>): Promise<T> {
    return scope
      .run(function* (): Operation<Result<T>> {
        try {
          return Ok(yield* op());
        } catch (error) {
          return Err(error);
        }
      })
      .then((result) => {
        if (result.ok) {
          return result.value;
        }
        throw result.error;
      });
  }

  const connection = yield* useAcpConnection(worker, handle, streams);
  // Settles on EOF/error (which close the input stream, closing the
  // connection), explicit connection closure, and worker cancellation (this
  // scope halts, tearing the connection down).
  yield* until(connection.closed);
}

function useAcpConnection(
  worker: WorkerAgent,
  handle: <T>(op: () => Operation<T>) => Promise<T>,
  streams: AcpByteStreams,
): Operation<acp.AgentConnection> {
  return resource(function* (provide) {
    const connection = acp
      .agent({ name: "xmd-test-agent" })
      .onRequest("initialize", () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        // `close` is what a native session launch needs: releasing a session
        // an XMD instruction layer is about to be installed on, and releasing
        // ACP ownership before a native UI takes over.
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      }))
      .onRequest("session/new", (ctx) =>
        handle(function* () {
          yield* worker.ready();
          const identity = worker.identity();
          yield* worker.startSession(systemPromptOf(ctx.params._meta));
          const configOptions =
            worker.configuration === undefined ? [] : ((yield* worker.configuration()) ?? []);
          return {
            sessionId: identity.acpSessionId,
            _meta: { agentSessionId: identity.nativeSessionId },
            ...(configOptions.length === 0 ? {} : { configOptions }),
          };
        }),
      )
      .onRequest("session/load", (ctx) =>
        handle(function* () {
          // The requested id is a loading target, not evidence of identity: it
          // may be the ACP handle or the native name of this one conversation.
          // Anything else names a conversation this agent does not hold, and is
          // refused before a session is established or reported.
          const identity = worker.identity();
          const target = ctx.params.sessionId;
          if (target !== identity.acpSessionId && target !== identity.nativeSessionId) {
            throw new acp.RequestError(
              -32602,
              `Session "${target}" is not a conversation this agent holds.`,
            );
          }
          yield* worker.ready();
          yield* worker.startSession(systemPromptOf(ctx.params._meta));
          const configOptions =
            worker.configuration === undefined ? [] : ((yield* worker.configuration()) ?? []);
          return {
            _meta: { agentSessionId: identity.nativeSessionId },
            ...(configOptions.length === 0 ? {} : { configOptions }),
          };
        }),
      )
      .onRequest("session/set_config_option", (ctx) =>
        handle(function* () {
          if (worker.setConfiguration === undefined || typeof ctx.params.value !== "string") {
            throw new acp.RequestError(-32602, "Configuration choices are unavailable.");
          }
          return {
            configOptions: yield* worker.setConfiguration(ctx.params.configId, ctx.params.value),
          };
        }),
      )
      .onRequest("session/close", () => ({}))
      .onRequest("session/prompt", (ctx) =>
        handle(function* (): Operation<PromptResponse> {
          // This agent takes the turn the moment it is asked, so acceptance is
          // reported here — before the turn runs and before anything it
          // produces. A client that defers a session's durable state until a
          // conversation really exists waits for exactly this and nothing else.
          yield* until(
            ctx.client.notify(acp.methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: {
                sessionUpdate: "session_info_update",
                _meta: { [SESSION_MATERIALIZATION_META]: { state: "accepted" } },
              },
            }),
          );
          const result = yield* worker.runTurn(extractText(ctx.params.prompt));
          if (result.cancelled) {
            return { stopReason: "cancelled" };
          }
          yield* until(
            ctx.client.notify(acp.methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: result.text },
              },
            }),
          );
          return { stopReason: "end_turn" };
        }),
      )
      .onNotification("session/cancel", () => {
        worker.cancel();
      })
      .connect(acp.ndJsonStream(streams.output, streams.input));

    yield* ensure(() => connection.close());
    yield* provide(connection);
  });
}

// The only process-coupled piece. Named handlers with explicit ownership:
// end/close close the input stream idempotently; error errors the input
// stream, which closes the SDK connection; teardown removes every owned
// listener. connection.closed resolves regardless of the close reason, so
// serveAcp completes normally on a transport error.
export function useProcessStdio(): Operation<AcpByteStreams> {
  return resource(function* (provide) {
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        process.stdout.write(chunk);
      },
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const onData = (chunk: Uint8Array) => controller?.enqueue(new Uint8Array(chunk));
    const closeInput = () => {
      try {
        controller?.close();
      } catch {
        // already closed — end and close may both fire
      }
    };
    const onEnd = () => closeInput();
    const onClose = () => closeInput();
    const onError = (error: Error) => {
      try {
        controller?.error(error);
      } catch {
        // already settled
      }
    };
    // A lexical finalizer rather than `ensure()`: entering the `try` is
    // synchronous, so there is no instant at which standard input is observed
    // and the release is not yet armed.
    try {
      process.stdin.on("data", onData);
      process.stdin.on("end", onEnd);
      process.stdin.on("close", onClose);
      process.stdin.on("error", onError);

      yield* provide({ input, output });
    } finally {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onClose);
      process.stdin.off("error", onError);
    }
  });
}
