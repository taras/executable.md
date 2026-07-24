/**
 * Agent prompt failure (specs/acp-client-spec.md §Prompt completion and
 * failure). Carries the agent, session identity, and stop reason; partial
 * output is not part of the public error contract — it lives in the durable
 * prompt record and the prompt stream's close value.
 */

import type { Json } from "../types.ts";

export class AgentPromptError extends Error {
  override name = "AgentPromptError";
  agent: string;
  sessionKey: string;
  stopReason?: string;

  constructor(
    message: string,
    options: { agent: string; sessionKey: string; stopReason?: string; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.agent = options.agent;
    this.sessionKey = options.sessionKey;
    if (options.stopReason !== undefined) {
      this.stopReason = options.stopReason;
    }
  }
}

export interface SerializedPromptFailure extends Record<string, Json> {
  message: string;
}

export function serializePromptFailure(error: unknown): SerializedPromptFailure {
  if (error instanceof Error) {
    const serialized: SerializedPromptFailure = { message: error.message };
    if (error.name !== "Error") {
      serialized.name = error.name;
    }
    if (error.cause instanceof Error) {
      serialized.cause = error.cause.message;
    }
    return serialized;
  }
  return { message: String(error) };
}

export function parsePromptFailure(value: unknown): SerializedPromptFailure | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { message, name, cause } = value as Record<string, unknown>;
  if (typeof message !== "string") {
    return undefined;
  }
  const parsed: SerializedPromptFailure = { message };
  if (typeof name === "string") {
    parsed.name = name;
  }
  if (typeof cause === "string") {
    parsed.cause = cause;
  }
  return parsed;
}
