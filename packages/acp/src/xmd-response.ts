import { z } from "zod";
import type { AgentPromptEvent } from "@executablemd/core";

const identity = z.string().min(1).max(512);
const json = z.json();
const issue = z
  .object({
    instancePath: z.string(),
    schemaPath: z.string(),
    keyword: z.string(),
    params: json,
    message: z.string(),
  })
  .strict();
const address = z.object({
  kind: z.enum(["question", "permission"]),
  requestId: identity,
  presentationId: identity,
});
export const XmdResponse = z.union([
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
