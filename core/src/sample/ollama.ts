/**
 * HTTP utility for Ollama inference.
 *
 * `callOllama` sends a single `/v1/chat/completions` request to a
 * running Ollama server using its OpenAI-compatible API endpoint
 * and returns the response content as a string.
 *
 * This is a plain utility — not user-facing middleware. It is called from
 * `OllamaProvider.md`'s middleware eval block with `baseUrl` and `model`
 * closed over at middleware install time.
 *
 * Uses `fetch().expect().json()` (DEC-007) — NOT the double-yield pattern.
 */

import { fetch } from "@effectionx/fetch";
import type { Operation } from "effection";
import type { SampleContext } from "../types.ts";
import { buildDefaultMessages, type ChatMessage } from "./llamafile.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OllamaOptions {
  /**
   * Temperature for generation. 0 maximizes greedy decoding consistency.
   * Default: 0
   */
  temperature?: number;

  /**
   * Maximum tokens to generate.
   * Default: 2048
   */
  maxTokens?: number;

  /**
   * Build the message array sent to /v1/chat/completions from the
   * SampleContext. Override to customize system prompt, few-shot examples,
   * or structured output instructions.
   * Default: buildDefaultMessages (reused from llamafile.ts)
   */
  buildMessages?: (context: SampleContext) => ChatMessage[];
}

// ---------------------------------------------------------------------------
// callOllama
// ---------------------------------------------------------------------------

/**
 * Send one inference request to a running Ollama server.
 *
 * Ollama exposes an OpenAI-compatible API at `/v1/chat/completions`,
 * so this follows the same pattern as callLlamafile.
 *
 * @param baseUrl  - HTTP origin of the Ollama server, e.g. "http://127.0.0.1:11434"
 * @param model    - Model identifier, e.g. "llama3.2", "phi3", "qwen2.5"
 * @param context  - SampleContext from the Sample Api call
 * @param opts     - Optional generation parameters and message builder
 */
export function* callOllama(
  baseUrl: string,
  model: string,
  context: SampleContext,
  opts: OllamaOptions = {},
): Operation<string> {
  const {
    temperature = 0,
    maxTokens = 2048,
    buildMessages = buildDefaultMessages,
  } = opts;

  const messages = buildMessages(context);

  const result = yield* fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages,
    }),
  })
    .expect()
    .json<{ choices: Array<{ message: { content: string } }> }>();

  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(
      `Ollama server returned unexpected response shape: ${JSON.stringify(result)}`,
    );
  }

  return content;
}
