/**
 * HTTP utility for Anthropic inference.
 *
 * `callAnthropic` sends a single `/v1/messages` request to the
 * Anthropic Messages API using `@effectionx/fetch` and returns
 * the response content as a string.
 *
 * This is a plain utility — not user-facing middleware. It is called from
 * `AnthropicProvider.md`'s middleware eval block with `model` closed over
 * at middleware install time.
 *
 * Uses `fetch().expect().json()` (DEC-007) — NOT the double-yield pattern.
 *
 * The Anthropic Messages API differs from OpenAI-compatible APIs:
 * - System prompt is a top-level `system` param, NOT a message role.
 * - Response text lives at `response.content[0].text`, not
 *   `response.choices[0].message.content`.
 * - Auth via `x-api-key` header (not Bearer token).
 * - Requires `anthropic-version` header.
 */

import { fetch } from "@effectionx/fetch";
import type { Operation } from "effection";
import type { SampleContext } from "../types.ts";
import { buildDefaultMessages, type ChatMessage } from "./llamafile.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnthropicOptions {
  /**
   * Temperature for generation. 0 maximizes greedy decoding consistency.
   * Default: 0
   */
  temperature?: number;

  /**
   * Maximum tokens to generate.
   * Default: 4096
   */
  maxTokens?: number;

  /**
   * Build the message array from the SampleContext. The system message
   * is extracted and sent as the top-level `system` param; remaining
   * messages are sent in the `messages` array.
   * Default: buildDefaultMessages (reused from llamafile.ts)
   */
  buildMessages?: (context: SampleContext) => ChatMessage[];
}

// ---------------------------------------------------------------------------
// Anthropic response shape
// ---------------------------------------------------------------------------

interface AnthropicMessageResponse {
  content: Array<{ type: string; text: string }>;
}

// ---------------------------------------------------------------------------
// callAnthropic
// ---------------------------------------------------------------------------

/**
 * Send one inference request to the Anthropic Messages API.
 *
 * Reads `ANTHROPIC_API_KEY` from the environment at call time.
 * Throws if the key is not set.
 *
 * @param model    - Model identifier, e.g. "claude-sonnet-4-5", "claude-haiku-4-5"
 * @param context  - SampleContext from the Sample Api call
 * @param opts     - Optional generation parameters and message builder
 */
export function* callAnthropic(
  model: string,
  context: SampleContext,
  opts: AnthropicOptions = {},
): Operation<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is not set — " +
        "set it before using AnthropicProvider",
    );
  }

  const {
    temperature = 0,
    maxTokens = 4096,
    buildMessages = buildDefaultMessages,
  } = opts;

  const messages = buildMessages(context);

  // Anthropic uses a top-level `system` param — extract system messages
  // from the chat message array and join them into a single string.
  const systemMessages = messages.filter((m) => m.role === "system");
  const chatMessages = messages.filter((m) => m.role !== "system");

  const systemPrompt =
    systemMessages.length > 0
      ? systemMessages.map((m) => m.content).join("\n")
      : undefined;

  const result = yield* fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: chatMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    }),
  })
    .expect()
    .json<AnthropicMessageResponse>();

  const text = result.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(
      `Anthropic API returned unexpected response shape: ${JSON.stringify(result)}`,
    );
  }

  return text;
}
