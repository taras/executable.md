import { z } from "zod";
import type { XmdResponse } from "@executablemd/acp";
import type { ReplSession } from "../repl/session.ts";
import type { SidekickOwner } from "../repl/sidekick/owner.ts";
import type { ReplQuestion } from "../repl/elicitation.ts";

const identity = z.string().min(1).max(512);
export const ChildInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("question"),
      requestId: identity,
      message: z.string(),
      schema: z.record(z.string(), z.json()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("permission"),
      requestId: identity,
      toolCall: z
        .object({ toolCallId: identity, title: z.string().optional(), kind: z.string().optional() })
        .strict(),
      options: z.array(
        z
          .object({
            optionId: identity,
            name: z.string(),
            kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
          })
          .strict(),
      ),
    })
    .strict(),
]);
export type ChildInput = z.infer<typeof ChildInput>;
const address = z
  .object({
    kind: z.enum(["question", "permission"]),
    requestId: identity,
    presentationId: identity,
  })
  .strict();
export const ChildResponseRequest = address.extend({ value: z.unknown() }).strict();
type Presentation = {
  input: ChildInput;
  current(): boolean;
  submit(value: unknown): XmdResponse;
  responded: boolean;
  retired: boolean;
};

export function createChildRequests(
  owner: SidekickOwner,
  session: ReplSession,
  identify: () => string,
) {
  const names = new WeakMap<ReplQuestion, string>();
  const presentations = new Map<string, Presentation>();
  function name(question: ReplQuestion): string {
    let known = names.get(question);
    if (known === undefined) {
      known = identify();
      names.set(question, known);
    }
    return known;
  }
  function questions(): ReplQuestion[] {
    return [owner.questions.pending, session.elicitation.pending].filter(
      (one): one is ReplQuestion => one !== undefined && one.active !== false,
    );
  }
  function list(): ChildInput[] {
    return [
      ...questions().map((question) =>
        ChildInput.parse({
          kind: "question",
          requestId: name(question),
          message: question.message,
          schema: question.schema,
        }),
      ),
      ...session.agent.requests.map((request) =>
        ChildInput.parse({
          kind: "permission",
          requestId: request.key,
          toolCall: { toolCallId: request.toolCallId, title: request.title, kind: request.kind },
          options: request.choices,
        }),
      ),
    ];
  }
  return {
    list,
    release(presentationId: string) {
      presentations.delete(presentationId);
    },
    offer(requestId: string) {
      const input = list().find((one) => one.requestId === requestId);
      if (input === undefined) {
        return null;
      }
      if (presentations.size >= 64) {
        throw new Error("This child input connection has reached its presentation bound.");
      }
      const presentationId = identify();
      const correlation = { kind: input.kind, requestId, presentationId };
      const question = questions().find((one) => name(one) === requestId);
      const current = () =>
        input.kind === "question"
          ? question !== undefined && questions().includes(question)
          : session.agent.requests.some((one) => one.key === requestId);
      presentations.set(presentationId, {
        input,
        current,
        responded: false,
        retired: false,
        submit(value): XmdResponse {
          if (!current()) {
            return { ...correlation, event: "response", outcome: "stale" };
          }
          if (input.kind === "question" && question !== undefined) {
            const response = z
              .discriminatedUnion("action", [
                z
                  .object({
                    action: z.literal("accept"),
                    content: z.record(z.string(), z.string()),
                  })
                  .strict(),
                z.object({ action: z.enum(["cancel", "decline"]) }).strict(),
              ])
              .safeParse(value);
            if (!response.success) {
              return {
                ...correlation,
                event: "response",
                outcome: "invalid",
                reason: "response-format",
              };
            }
            if (response.data.action !== "accept") {
              return { ...correlation, event: "response", outcome: "not-submitted" };
            }
            const result = question.submit(response.data.content);
            return result.kind === "answered"
              ? { ...correlation, event: "response", outcome: "accepted" }
              : {
                  ...correlation,
                  kind: "question",
                  event: "response",
                  outcome: "invalid",
                  reason: "schema",
                  issues: [...result.issues],
                };
          }
          const response = z
            .object({
              outcome: z.discriminatedUnion("outcome", [
                z.object({ outcome: z.literal("selected"), optionId: z.string() }).strict(),
                z.object({ outcome: z.literal("cancelled") }).strict(),
              ]),
            })
            .strict()
            .safeParse(value);
          if (!response.success) {
            return {
              ...correlation,
              event: "response",
              outcome: "invalid",
              reason: "response-format",
            };
          }
          if (response.data.outcome.outcome === "cancelled") {
            return { ...correlation, event: "response", outcome: "not-submitted" };
          }
          const optionId = response.data.outcome.optionId;
          if (
            input.kind !== "permission" ||
            !input.options.some((one) => one.optionId === optionId)
          ) {
            return {
              ...correlation,
              kind: "permission",
              event: "response",
              outcome: "invalid",
              reason: "option-not-offered",
            };
          }
          return {
            ...correlation,
            event: "response",
            outcome: session.permissions.choose(requestId, optionId) ? "accepted" : "stale",
          };
        },
      });
      return { input, presentationId };
    },
    respond(request: z.infer<typeof ChildResponseRequest>): XmdResponse {
      const held = presentations.get(request.presentationId);
      if (
        held === undefined ||
        held.input.requestId !== request.requestId ||
        held.input.kind !== request.kind
      ) {
        throw new Error("This presentation is unknown or already classified.");
      }
      if (held.responded) {
        throw new Error("This presentation has already classified its one response.");
      }
      held.responded = true;
      presentations.delete(request.presentationId);
      if (held.retired) {
        return {
          kind: request.kind,
          requestId: request.requestId,
          presentationId: request.presentationId,
          event: "response",
          outcome: "stale",
        };
      }
      return held.submit(request.value);
    },
    retire(presentationId: string): XmdResponse | undefined {
      const held = presentations.get(presentationId);
      if (held === undefined || held.retired || held.responded || held.current()) {
        return undefined;
      }
      held.retired = true;
      return {
        kind: held.input.kind,
        requestId: held.input.requestId,
        presentationId,
        event: "retired",
        reason: "request-ended",
      };
    },
  };
}
