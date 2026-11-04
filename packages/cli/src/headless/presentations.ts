import * as acp from "@agentclientprotocol/sdk";
import { ensure, spawn, until } from "effection";
import type { Operation, Task } from "effection";
import { z } from "zod";
import { XmdResponse, XMD_RESPONSE } from "@executablemd/acp";
import { readQuestionForm } from "../repl/elicitation.ts";
import { requestAttachment } from "../sidekick-acp/client.ts";
import type { Descriptor } from "../sidekick-acp/protocol.ts";
import type { Request } from "../sidekick-acp/protocol.ts";
import { ChildInput } from "./requests.ts";

export function standardQuestion(
  input: Extract<ChildInput, { kind: "question" }>,
  sessionId: string,
  presentationId: string,
): acp.CreateElicitationRequest {
  const form = readQuestionForm(input.schema);
  const condition = form.condition;
  const rule =
    condition === undefined
      ? ""
      : `If ${condition.field} is ${JSON.stringify(condition.equals)}, ${condition.requires.map((field) => `${field.name} is required${field.minLength === undefined ? "" : ` and must contain at least ${field.minLength} characters`}`).join("; ")}.`;
  const properties: Record<string, acp.ElicitationPropertySchema> = {};
  for (const field of form.fields) {
    const conditional =
      condition?.requires.some((one) => one.name === field.name) === true ? rule : "";
    properties[field.name] = {
      type: "string",
      ...(field.secret ? { writeOnly: true } : {}),
      ...(field.title === undefined ? {} : { title: field.title }),
      ...([field.description, conditional].filter(Boolean).length === 0
        ? {}
        : { description: [field.description, conditional].filter(Boolean).join(" ") }),
      ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
      ...(field.choices === undefined ? {} : { enum: [...field.choices] }),
    };
  }
  return {
    sessionId,
    mode: "form",
    message: [input.message, rule].filter(Boolean).join("\n"),
    requestedSchema: {
      type: "object",
      properties,
      required: form.fields.filter((one) => one.required).map((one) => one.name),
    },
    _meta: {
      "executablemd.xmd-question/v1": {
        requestId: input.requestId,
        presentationId,
        schema: input.schema,
      },
    },
  };
}

function outcomeText(result: XmdResponse): string {
  if (result.event === "retired") {
    return `XMD ${result.kind} input retired: its original request ended.`;
  }
  if (result.outcome === "invalid") {
    return `XMD ${result.kind} response is invalid: ${result.reason}${result.reason === "schema" ? ": " + result.issues.map((one) => `${one.instancePath}: ${one.message}`).join("; ") : "."}`;
  }
  return `XMD ${result.kind} response: ${result.outcome}.`;
}

export function responseNotification(
  sessionId: string,
  result: XmdResponse,
  extra?: string,
): acp.SessionNotification {
  const completed = result.event === "retired" || result.outcome === "accepted";
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: result.presentationId,
      kind: "other",
      title: `XMD ${result.kind} response`,
      status: completed ? "completed" : "failed",
      rawOutput: { [XMD_RESPONSE]: result },
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: outcomeText(result) + (extra === undefined ? "" : "\n" + extra),
          },
        },
      ],
    },
  };
}

export function* useChildPresentations(
  path: string,
  descriptor: Descriptor,
  client: acp.AgentContext,
  sessionId: string,
  formCapable: boolean,
) {
  const exactRequest = (request: Request) =>
    requestAttachment(path, request, undefined, descriptor);
  const active = new Map<
    string,
    { input: ChildInput; presentationId?: string; task?: Task<void>; abort?: AbortController }
  >();
  function* notify(result: XmdResponse, extra?: string): Operation<void> {
    yield* until(
      client.notify(
        acp.methods.client.session.update,
        responseNotification(sessionId, result, extra),
      ),
    );
  }
  yield* ensure(function* () {
    for (const held of active.values()) {
      held.abort?.abort();
      if (held.task !== undefined) {
        yield* held.task.halt();
      }
      if (held.presentationId !== undefined) {
        yield* exactRequest({ method: "child-release", presentationId: held.presentationId });
      }
    }
  });
  return {
    *update(inputs: readonly ChildInput[]): Operation<void> {
      for (const [id, held] of active) {
        if (inputs.some((one) => one.requestId === id && one.kind === held.input.kind)) {
          continue;
        }
        const presentationId = held.presentationId;
        if (presentationId !== undefined) {
          const result = yield* exactRequest({
            method: "child-retire",
            presentationId,
          });
          if (result !== null) {
            yield* notify(XmdResponse.parse(result));
          }
        }
        held.abort?.abort();
        if (held.task !== undefined) {
          yield* held.task.halt();
        }
        if (presentationId !== undefined) {
          yield* exactRequest({ method: "child-release", presentationId });
        }
        active.delete(id);
      }
      for (const input of inputs) {
        if (active.has(input.requestId)) {
          continue;
        }
        const held: {
          input: ChildInput;
          presentationId?: string;
          task?: Task<void>;
          abort?: AbortController;
        } = { input };
        active.set(input.requestId, held);
        held.task = yield* spawn(function* (): Operation<void> {
          while (true) {
            const raw = yield* exactRequest({ method: "child-offer", requestId: input.requestId });
            if (raw === null) {
              return;
            }
            const offered = z
              .object({ input: ChildInput, presentationId: z.string() })
              .strict()
              .parse(raw);
            held.presentationId = offered.presentationId;
            const original = offered.input;
            const question =
              original.kind === "question"
                ? standardQuestion(original, sessionId, offered.presentationId)
                : undefined;
            const text =
              question === undefined
                ? JSON.stringify(original, null, 2)
                : question.message + "\n" + JSON.stringify(original, null, 2);
            yield* until(
              client.notify(acp.methods.client.session.update, {
                sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: offered.presentationId,
                  kind: "other",
                  title: `XMD ${input.kind}`,
                  status: "in_progress",
                  content: [{ type: "content", content: { type: "text", text } }],
                },
              }),
            );
            const controller = new AbortController();
            held.abort = controller;
            let answer: unknown;
            if (question !== undefined) {
              answer = formCapable
                ? yield* until(
                    client.request("elicitation/create", question, {
                      cancellationSignal: controller.signal,
                    }),
                  )
                : readQuestionForm(original.kind === "question" ? original.schema : {}).fields.some(
                      (field) => field.secret,
                    )
                  ? { action: "refuse", reason: "live-input-required" }
                  : { action: "cancel" };
            } else if (original.kind === "permission") {
              answer = yield* until(
                client.request(
                  "session/request_permission",
                  {
                    sessionId,
                    toolCall: original.toolCall,
                    options: original.options,
                    _meta: {
                      "executablemd.xmd-permission/v1": {
                        requestId: original.requestId,
                        presentationId: offered.presentationId,
                      },
                    },
                  },
                  { cancellationSignal: controller.signal },
                ),
              );
            }
            const result = XmdResponse.parse(
              yield* exactRequest({
                method: "child-response",
                kind: original.kind,
                requestId: original.requestId,
                presentationId: offered.presentationId,
                value: answer,
              }),
            );
            yield* notify(
              result,
              question !== undefined && !formCapable
                ? original.kind === "question" &&
                  readQuestionForm(original.schema).fields.some((field) => field.secret)
                  ? "Protected input requires a live form-capable responder. The question was refused and withdrawn."
                  : "This ACP client does not advertise form elicitation. The original child question remains pending; use a capable ACP client or xmd repl --attach with the saved sessionId."
                : undefined,
            );
            if (!(result.event === "response" && result.outcome === "invalid")) {
              return;
            }
          }
        });
      }
    },
  };
}
