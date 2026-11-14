import type { z } from "zod";
import type { outcomeSchema } from "./records.ts";

export const fableUsageLimitNotice =
  "You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";

export function isUsageLimit(
  provider: string,
  turn: z.infer<typeof outcomeSchema>["turn"],
  notice: string | undefined,
): boolean {
  if (
    notice === undefined ||
    turn === null ||
    turn.state !== "failed" ||
    turn.stage !== "turn" ||
    turn.configuration !== null ||
    turn.refusal === null
  ) {
    return false;
  }
  const message = `Internal error: ${notice}`;
  const { requestId: _requestId, ...diagnostic } = turn.refusal.diagnostic;
  return (
    turn.refusal.agent === provider &&
    turn.partial === notice &&
    turn.refusal.output === notice &&
    turn.refusal.closeValue === notice &&
    turn.refusal.message === message &&
    JSON.stringify(diagnostic) ===
      JSON.stringify({
        provider: "acp",
        operation: "session/prompt",
        stage: "runtime-turn",
        code: "RUNTIME",
        origin: "runtime",
        acp: { code: -32603, message: message },
      })
  );
}
