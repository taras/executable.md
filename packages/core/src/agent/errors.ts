/**
 * Agent prompt failure (specs/acp-client-spec.md §Prompt completion and
 * failure). Carries the agent, session identity, and stop reason; partial
 * output is not part of the public error contract — it lives in the durable
 * prompt record and the prompt stream's close value.
 */

import { z } from "zod";

const PROMPT_DIAGNOSTIC = "executablemd.agent.prompt-diagnostic";
const Diagnostic: z.ZodObject<
  {
    provider: z.ZodLiteral<"acp">;
    operation: z.ZodLiteral<"session/prompt">;
    stage: z.ZodLiteral<"runtime-turn">;
    requestId: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodString>;
    detailCode: z.ZodOptional<z.ZodString>;
    retryable: z.ZodOptional<z.ZodBoolean>;
    origin: z.ZodOptional<
      z.ZodEnum<{ cli: "cli"; runtime: "runtime"; queue: "queue"; acp: "acp" }>
    >;
    acp: z.ZodOptional<
      z.ZodObject<
        {
          code: z.ZodNumber;
          message: z.ZodOptional<z.ZodString>;
          details: z.ZodOptional<z.ZodString>;
        },
        z.core.$strict
      >
    >;
  },
  z.core.$strict
> = z
  .object({
    provider: z.literal("acp"),
    operation: z.literal("session/prompt"),
    stage: z.literal("runtime-turn"),
    requestId: z.string().optional(),
    code: z.string().min(1).optional(),
    detailCode: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
    origin: z.enum(["cli", "runtime", "queue", "acp"]).optional(),
    acp: z
      .object({
        code: z.number().finite(),
        message: z.string().min(1).optional(),
        details: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type PromptDiagnostic = z.infer<typeof Diagnostic>;

export function readPromptDiagnostic(error: unknown): PromptDiagnostic | undefined {
  return isRecord(error) ? parsePromptDiagnostic(error[PROMPT_DIAGNOSTIC]) : undefined;
}

function parsePromptDiagnostic(value: unknown): PromptDiagnostic | undefined {
  const parsed = Diagnostic.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export class AgentPromptError extends Error {
  override name = "AgentPromptError";
  agent: string;
  sessionKey: string;
  stopReason?: string;

  constructor(
    message: string,
    options: {
      agent: string;
      sessionKey: string;
      stopReason?: string;
      cause?: unknown;
      diagnostic?: PromptDiagnostic;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.agent = options.agent;
    this.sessionKey = options.sessionKey;
    if (options.diagnostic !== undefined) {
      Object.defineProperty(this, PROMPT_DIAGNOSTIC, { value: options.diagnostic });
    }
    if (options.stopReason !== undefined) {
      this.stopReason = options.stopReason;
    }
  }
}

export type SerializedPromptFailure = {
  message: string;
  name?: string;
  cause?: string;
  diagnostic?: PromptDiagnostic;
};

export function serializePromptFailure(
  error: unknown,
  diagnostic?: PromptDiagnostic,
): SerializedPromptFailure {
  if (error instanceof Error) {
    const serialized: SerializedPromptFailure = { message: error.message };
    if (error.name !== "Error") {
      serialized.name = error.name;
    }
    if (error.cause instanceof Error) {
      serialized.cause = error.cause.message;
    }
    if (diagnostic !== undefined) {
      serialized.diagnostic = diagnostic;
    }
    return serialized;
  }
  return { message: String(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePromptFailure(value: unknown): SerializedPromptFailure | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { message, name, cause } = value;
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
  if (Object.hasOwn(value, "diagnostic")) {
    const diagnostic = parsePromptDiagnostic(value.diagnostic);
    if (diagnostic === undefined) {
      return undefined;
    }
    parsed.diagnostic = diagnostic;
  }
  return parsed;
}
