import { z } from "zod";
import type { AgentPromptEvent } from "@executablemd/core";

const identity: z.ZodString = z.string().min(1).max(512);
const json: z.ZodJSONSchema = z.json();
const issue: z.ZodObject<
  {
    instancePath: z.ZodString;
    schemaPath: z.ZodString;
    keyword: z.ZodString;
    params: typeof json;
    message: z.ZodString;
  },
  z.core.$strict
> = z
  .object({
    instancePath: z.string(),
    schemaPath: z.string(),
    keyword: z.string(),
    params: json,
    message: z.string(),
  })
  .strict();
const address: z.ZodObject<{
  kind: z.ZodEnum<{ question: "question"; permission: "permission" }>;
  requestId: typeof identity;
  presentationId: typeof identity;
}> = z.object({
  kind: z.enum(["question", "permission"]),
  requestId: identity,
  presentationId: identity,
});
export const XmdResponse: z.ZodUnion<
  readonly [
    z.ZodObject<
      typeof address.shape & {
        event: z.ZodLiteral<"response">;
        outcome: z.ZodEnum<{
          accepted: "accepted";
          stale: "stale";
          "not-submitted": "not-submitted";
        }>;
      },
      z.core.$strict
    >,
    z.ZodObject<
      Omit<typeof address.shape, "kind"> & {
        kind: z.ZodLiteral<"question">;
        event: z.ZodLiteral<"response">;
        outcome: z.ZodLiteral<"invalid">;
        reason: z.ZodLiteral<"schema">;
        issues: z.ZodArray<typeof issue>;
      },
      z.core.$strict
    >,
    z.ZodObject<
      Omit<typeof address.shape, "kind"> & {
        kind: z.ZodLiteral<"permission">;
        event: z.ZodLiteral<"response">;
        outcome: z.ZodLiteral<"invalid">;
        reason: z.ZodLiteral<"option-not-offered">;
      },
      z.core.$strict
    >,
    z.ZodObject<
      typeof address.shape & {
        event: z.ZodLiteral<"response">;
        outcome: z.ZodLiteral<"invalid">;
        reason: z.ZodLiteral<"response-format">;
      },
      z.core.$strict
    >,
    z.ZodObject<
      typeof address.shape & {
        event: z.ZodLiteral<"retired">;
        reason: z.ZodLiteral<"request-ended">;
      },
      z.core.$strict
    >,
  ]
> = z.union([
  address
    .extend({
      event: z.literal("response"),
      outcome: z.enum(["accepted", "stale", "not-submitted"]),
    })
    .strict(),
  address
    .extend({
      kind: z.literal("question"),
      event: z.literal("response"),
      outcome: z.literal("invalid"),
      reason: z.literal("schema"),
      issues: z.array(issue).min(1),
    })
    .strict(),
  address
    .extend({
      kind: z.literal("permission"),
      event: z.literal("response"),
      outcome: z.literal("invalid"),
      reason: z.literal("option-not-offered"),
    })
    .strict(),
  address
    .extend({
      event: z.literal("response"),
      outcome: z.literal("invalid"),
      reason: z.literal("response-format"),
    })
    .strict(),
  address.extend({ event: z.literal("retired"), reason: z.literal("request-ended") }).strict(),
]);
export type XmdResponse = z.infer<typeof XmdResponse>;
export const XMD_RESPONSE = "executablemd.xmd-response/v1";
export function xmdPromptEvent(response: XmdResponse): AgentPromptEvent | undefined {
  if (response.event === "retired") {
    return undefined;
  }
  if (response.kind === "question") {
    const result =
      response.outcome !== "invalid"
        ? { status: response.outcome }
        : response.reason === "schema"
          ? { status: response.outcome, reason: response.reason, issues: response.issues }
          : { status: response.outcome, reason: response.reason };
    return {
      type: "question_answer_result",
      questionId: response.requestId,
      inputId: response.presentationId,
      result,
    };
  }
  const result =
    response.outcome !== "invalid"
      ? { status: response.outcome }
      : { status: response.outcome, reason: response.reason };
  return {
    type: "permission_decision_result",
    permissionId: response.requestId,
    inputId: response.presentationId,
    result,
  };
}
