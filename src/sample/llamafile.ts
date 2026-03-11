/**
 * HTTP utility for llamafile / llama.cpp inference (spec §5).
 *
 * `callLlamafile` sends a single `/v1/chat/completions` request to a
 * running llamafile or llama.cpp server and returns the response content
 * as a string.
 *
 * This is a plain utility — not user-facing middleware. It is called from
 * `LlamafileProvider.md`'s final eval block with `baseUrl` and `model`
 * closed over at middleware install time.
 *
 * Uses `fetch().expect().json()` (DEC-007) — NOT the double-yield pattern.
 */

import { fetch } from "@effectionx/fetch";
import type { Operation } from "effection";
import type { SampleContext } from "../types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlamafileOptions {
  /**
   * Temperature for generation. 0 maximizes greedy decoding consistency.
   * True cross-hardware determinism requires CPU-only inference.
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
   * Default: buildDefaultMessages
   */
  buildMessages?: (context: SampleContext) => ChatMessage[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Default message builder (spec §5.5)
// ---------------------------------------------------------------------------

export function buildDefaultMessages(context: SampleContext): ChatMessage[] {
  const systemLines: string[] = [
    "You are a precise technical assistant embedded in a durable document workflow.",
    "Analyze the provided command output and respond according to the instructions.",
    "Be concise. Output only what is requested — no preamble, no explanation unless asked.",
  ];

  if (context.componentName) {
    systemLines.push(
      `Context: you are assisting the ${context.componentName} component.`,
    );
  }

  if (context.params) {
    systemLines.push(`Instruction: ${context.params}`);
  }

  const userLines: string[] = [];

  if (context.command) {
    userLines.push(
      `Command: \`${context.language} -c '${context.command}'\``,
    );
  }

  if (context.exitCode !== 0) {
    userLines.push(`Exit code: ${context.exitCode}`);
  }

  if (context.stderr) {
    userLines.push(`Stderr:\n\`\`\`\n${context.stderr}\n\`\`\``);
  }

  if (context.stdout) {
    userLines.push(`Output:\n\`\`\`\n${context.stdout}\n\`\`\``);
  }

  return [
    { role: "system", content: systemLines.join("\n") },
    { role: "user", content: userLines.join("\n\n") },
  ];
}

// ---------------------------------------------------------------------------
// callLlamafile (spec §5.4)
// ---------------------------------------------------------------------------

/**
 * Send one inference request to a running llamafile or llama.cpp server.
 *
 * @param baseUrl  - HTTP origin of the server, e.g. "http://127.0.0.1:8080"
 * @param model    - Model identifier, passed as the `model` field in the request body
 * @param context  - SampleContext from the Sample Api call
 * @param opts     - Optional generation parameters and message builder
 */
export function* callLlamafile(
  baseUrl: string,
  model: string,
  context: SampleContext,
  opts: LlamafileOptions = {},
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
      `Llamafile server returned unexpected response shape: ${JSON.stringify(result)}`,
    );
  }

  return content;
}
