import { Err, Ok, resource, until, useScope } from "effection";
import type { Operation, Result } from "effection";
import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";
import { attachmentDescriptor, requestAttachment } from "./client.ts";
import { MAX_TEXT, SidekickTransport } from "./protocol.ts";

const publicSnapshot = z
  .object({
    message: z
      .object({ execution: z.string(), conversation: z.string(), id: z.string() })
      .strict()
      .nullable(),
    origin: z.unknown(),
    activity: z.object({ response: z.string(), phase: z.string() }).strict().nullable(),
    preview: z
      .object({ provisional: z.literal(true), response: z.string(), text: z.string() })
      .strict()
      .nullable(),
    ending: z
      .object({
        joined: z.literal(true),
        outcome: z.enum(["completed", "failed", "cancelled"]),
        error: z.string().nullable(),
      })
      .strict()
      .nullable(),
    output: z.string(),
    outputs: z.array(z.object({ response: z.string(), text: z.string() }).strict()),
  })
  .strict();
const attached = z.object({ attachment: z.string().min(1) }).strict();
const loaded = z
  .object({
    attachment: z.string(),
    replay: z.array(z.object({ kind: z.enum(["person", "reply"]), text: z.string() }).strict()),
    status: z.unknown(),
  })
  .strict();
export function* runSidekickBridge(path: string): Operation<void> {
  const descriptor = yield* attachmentDescriptor(path);
  const streams = yield* (yield* SidekickTransport.expect()).stdio();
  const scope = yield* useScope();
  let loadFailed = false;
  const sessions = new Set<string>();
  function handle<T>(operation: () => Operation<T>): Promise<T> {
    return scope
      .run(function* (): Operation<Result<T>> {
        try {
          return Ok(yield* operation());
        } catch (error) {
          return Err(
            error instanceof Error ? error : new Error("The Sidekick attachment request failed."),
          );
        }
      })
      .then((result) => {
        if (result.ok) {
          return result.value;
        }
        throw result.error;
      });
  }
  function assertSession(session: string): void {
    if (!sessions.has(session)) {
      throw new acp.RequestError(-32602, "This bridge has not attached that exact session.");
    }
  }
  function overrides(params: {
    cwd: string;
    mcpServers?: unknown[];
    _meta?: { [key: string]: unknown } | null;
  }): void {
    if (
      params.cwd !== descriptor.cwd ||
      (params.mcpServers?.length ?? 0) !== 0 ||
      (params._meta !== undefined &&
        params._meta !== null &&
        Object.keys(params._meta).length !== 0)
    ) {
      throw new acp.RequestError(
        -32602,
        "The held Sidekick accepts no cwd, MCP, instruction or configuration override.",
      );
    }
  }
  const connection = yield* resource<acp.AgentConnection>(function* (provide) {
    const connection = acp
      .agent({ name: "xmd-sidekick" })
      .onRequest("initialize", () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      }))
      .onRequest("session/new", (ctx) =>
        handle(function* () {
          if (loadFailed) {
            throw new acp.RequestError(
              -32602,
              "A failed exact load fences fallback session creation on this bridge.",
            );
          }
          overrides(ctx.params);
          const value = attached.parse(
            yield* requestAttachment(path, { method: "attach", cwd: ctx.params.cwd }),
          );
          sessions.add(value.attachment);
          return { sessionId: value.attachment, _meta: { agentSessionId: value.attachment } };
        }),
      )
      .onRequest("session/load", (ctx) =>
        handle(function* () {
          try {
            overrides(ctx.params);
            const value = loaded.parse(
              yield* requestAttachment(path, {
                method: "load",
                attachment: ctx.params.sessionId,
                cwd: ctx.params.cwd,
              }),
            );
            sessions.add(value.attachment);
            for (const item of value.replay) {
              yield* until(
                ctx.client.notify(acp.methods.client.session.update, {
                  sessionId: value.attachment,
                  update: {
                    sessionUpdate:
                      item.kind === "person" ? "user_message_chunk" : "agent_message_chunk",
                    content: { type: "text", text: item.text },
                  },
                }),
              );
            }
            return { _meta: { agentSessionId: value.attachment } };
          } catch (error) {
            loadFailed = true;
            throw error;
          }
        }),
      )
      .onRequest("session/prompt", (ctx) =>
        handle(function* (): Operation<acp.PromptResponse> {
          assertSession(ctx.params.sessionId);
          if (
            (ctx.params._meta !== undefined &&
              ctx.params._meta !== null &&
              Object.keys(ctx.params._meta).length !== 0) ||
            ctx.params.prompt.some((block) => block.type !== "text")
          ) {
            throw new acp.RequestError(
              -32602,
              "The Sidekick accepts text-only prompts without overrides.",
            );
          }
          const text = ctx.params.prompt
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
          if (new TextEncoder().encode(text).length > MAX_TEXT || text.trim().length === 0) {
            throw new acp.RequestError(
              -32602,
              "Sidekick text must be nonempty and at most 64 KiB.",
            );
          }
          let accepted = false;
          const activities = new Set<string>();
          const output = new Map<string, string>();
          const update = function* (raw: unknown): Operation<void> {
            const snapshot = publicSnapshot.parse(raw);
            if (snapshot.message !== null && !accepted) {
              accepted = true;
              yield* until(
                ctx.client.notify(acp.methods.client.session.update, {
                  sessionId: ctx.params.sessionId,
                  update: {
                    sessionUpdate: "session_info_update",
                    _meta: {
                      "executablemd.session-materialization/v1": { state: "accepted" },
                      "executablemd.sidekick-message/v1": snapshot.message,
                    },
                  },
                }),
              );
            }
            const response = snapshot.activity?.response ?? snapshot.preview?.response;
            if (response !== undefined) {
              const known = activities.has(response);
              activities.add(response);
              const content: acp.ToolCallContent[] =
                snapshot.preview === null
                  ? []
                  : [
                      {
                        type: "content",
                        content: {
                          type: "text",
                          text: "Provisional preview:\n" + snapshot.preview.text,
                        },
                      },
                    ];
              if (known) {
                yield* until(
                  ctx.client.notify(acp.methods.client.session.update, {
                    sessionId: ctx.params.sessionId,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: response,
                      status:
                        snapshot.ending === null
                          ? "in_progress"
                          : snapshot.ending.outcome === "completed"
                            ? "completed"
                            : "failed",
                      content,
                    },
                  }),
                );
              } else {
                yield* until(
                  ctx.client.notify(acp.methods.client.session.update, {
                    sessionId: ctx.params.sessionId,
                    update: {
                      sessionUpdate: "tool_call",
                      toolCallId: response,
                      title: "Sidekick " + (snapshot.activity?.phase ?? "preview"),
                      kind: "other",
                      status: "in_progress",
                      content,
                    },
                  }),
                );
              }
            }
            if (snapshot.ending !== null) {
              for (const activity of activities) {
                yield* until(
                  ctx.client.notify(acp.methods.client.session.update, {
                    sessionId: ctx.params.sessionId,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: activity,
                      status: snapshot.ending.outcome === "completed" ? "completed" : "failed",
                    },
                  }),
                );
              }
            }
            for (const item of snapshot.outputs) {
              const previous = output.get(item.response) ?? "";
              if (!item.text.startsWith(previous)) {
                throw new Error("Acknowledged Sidekick Output changed incompatibly.");
              }
              const delta = item.text.slice(previous.length);
              output.set(item.response, item.text);
              if (delta.length !== 0) {
                yield* until(
                  ctx.client.notify(acp.methods.client.session.update, {
                    sessionId: ctx.params.sessionId,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: delta },
                    },
                  }),
                );
              }
            }
          };
          const completed = publicSnapshot.parse(
            yield* requestAttachment(
              path,
              { method: "prompt", attachment: ctx.params.sessionId, text },
              update,
            ),
          );
          const metadata = {
            owner: descriptor.owner,
            execution: descriptor.execution,
            conversation: descriptor.conversation,
            message: completed.message,
            joined: completed.ending?.joined ?? false,
          };
          if (!accepted || completed.ending === null || !completed.ending.joined) {
            throw new acp.RequestError(-32000, "Sidekick completion is unestablished.", metadata);
          }
          if (completed.ending.outcome === "cancelled") {
            return {
              stopReason: "cancelled",
              _meta: { "executablemd.sidekick-exchange/v1": metadata },
            };
          }
          if (completed.ending.outcome !== "completed") {
            throw new acp.RequestError(
              -32000,
              completed.ending.error ?? "Sidekick exchange failed.",
              metadata,
            );
          }
          return {
            stopReason: "end_turn",
            _meta: { "executablemd.sidekick-exchange/v1": metadata },
          };
        }),
      )
      .onNotification("session/cancel", (ctx) => {
        if (!sessions.has(ctx.params.sessionId)) {
          return;
        }
        void handle(function* () {
          yield* requestAttachment(path, { method: "cancel", attachment: ctx.params.sessionId });
        }).catch(() => {});
      })
      .onRequest("session/close", (ctx) =>
        handle(function* () {
          assertSession(ctx.params.sessionId);
          yield* requestAttachment(path, { method: "close", attachment: ctx.params.sessionId });
          sessions.delete(ctx.params.sessionId);
          return {};
        }),
      )
      .connect(acp.ndJsonStream(streams.output, streams.input));
    try {
      yield* provide(connection);
    } finally {
      connection.close();
    }
  });
  yield* until(connection.closed);
}
