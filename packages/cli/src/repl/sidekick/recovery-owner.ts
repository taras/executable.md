import { z } from "zod";
import { AGENT_PROMPT, parsePromptRecord } from "@executablemd/core/host";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { agentSessionKeyDigest } from "@executablemd/runtime";
import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import type { AgentSessionOwnershipAdministration } from "@executablemd/runtime";
import type { SidekickRecord } from "./history.ts";

export const UNSUPPORTED_STOP =
  "The earlier turn is not known to have stopped. This build cannot stop and join it after its owner is lost. No instruction was sent. You can close this view or explicitly abandon this conversation.";
const configuration = z
  .object({
    provider: z.string().min(1),
    agentCommand: z.string().min(1),
    configuration: z.unknown(),
  })
  .strict();

export function* inspectRecoveryOwnership(
  records: readonly SidekickRecord[],
  conversation: string,
  administration: AgentSessionOwnershipAdministration | undefined,
): Operation<Result<void>> {
  let key: string | undefined;
  let construction: z.infer<typeof configuration> | undefined;
  for (const record of records) {
    if (record.kind !== "event" || record.conversation !== conversation) {
      continue;
    }
    const event = parseDurableEvent(record.event);
    if (!event.ok || event.value.type !== "yield") {
      continue;
    }
    if (event.value.description.type === "agent_conversation_configuration") {
      const parsed = configuration.safeParse(event.value.description.input);
      if (event.value.result.status === "ok" && parsed.success) {
        construction = parsed.data;
      }
    }
    if (event.value.description.type === AGENT_PROMPT && event.value.result.status === "ok") {
      const prompt = parsePromptRecord(event.value.result.value);
      if (prompt !== undefined && prompt.sessionKey.length > 0) {
        key = prompt.sessionKey;
      }
    }
  }
  if (key === undefined || construction === undefined || administration === undefined) {
    return Err(new Error(UNSUPPORTED_STOP));
  }
  const digest = agentSessionKeyDigest({
    provider: construction.provider,
    agent: construction.agentCommand,
    sessionKey: key,
  });
  const inspection = yield* administration.inspectOwnership(digest);
  if (
    !inspection.ok ||
    inspection.value.record.state !== "idle" ||
    inspection.value.record.release !== "quiesced"
  ) {
    return Err(new Error(UNSUPPORTED_STOP));
  }
  return Ok(undefined);
}
