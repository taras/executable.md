import { z } from "zod";
import { createContext } from "effection";
import type { Operation } from "effection";

export const MAX_FRAME = 1024 * 1024;
export const MAX_TEXT = 64 * 1024;
export const MAX_DESCRIPTOR = 16 * 1024;
export const MAILBOX = 64;
const identity = z.string().min(1).max(512);
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/"));
export const Descriptor = z
  .object({
    version: z.literal(1),
    transport: z.literal("unix"),
    socket: absolute,
    owner: identity,
    execution: identity,
    conversation: identity,
    cwd: absolute,
  })
  .strict();
export type Descriptor = z.infer<typeof Descriptor>;
const MessageReference = z
  .object({ execution: identity, conversation: identity, id: identity })
  .strict();
type MessageReference = z.infer<typeof MessageReference>;
const continuation = z
  .object({
    entry: z.number().int().positive(),
    prompt: z.number().int().positive().optional(),
    field: z.enum(["request", "reply", "error"]).optional(),
    offset: z.number().int().nonnegative(),
  })
  .strict();
export const Cursor = z
  .object({
    version: z.literal(1),
    execution: identity,
    conversation: identity,
    view: z.enum(["source", "prompt", "output", "journal"]),
    next: continuation,
  })
  .strict();
export const Request = z.discriminatedUnion("method", [
  z.object({ method: z.literal("hello"), descriptor: Descriptor }).strict(),
  z.object({ method: z.literal("attach"), cwd: absolute }).strict(),
  z.object({ method: z.literal("load"), attachment: identity, cwd: absolute }).strict(),
  z
    .object({
      method: z.literal("prompt"),
      attachment: identity,
      text: z
        .string()
        .min(1)
        .refine((text) => new TextEncoder().encode(text).length <= MAX_TEXT),
    })
    .strict(),
  z.object({ method: z.literal("cancel"), attachment: identity }).strict(),
  z.object({ method: z.literal("close"), attachment: identity }).strict(),
  z.object({ method: z.literal("status") }).strict(),
  z
    .object({ method: z.literal("message"), reference: MessageReference, follow: z.boolean() })
    .strict(),
  z
    .object({
      method: z.literal("entry"),
      entry: z.number().int().positive(),
      view: z.enum(["source", "prompt", "output", "journal"]),
      prompt: z.number().int().positive().optional(),
      field: z.enum(["request", "reply", "error"]).optional(),
      cursor: z.string().max(16384).optional(),
    })
    .strict(),
]);
export type Request = z.infer<typeof Request>;
export const Envelope = z.object({ id: z.number().int().nonnegative(), request: Request }).strict();
export const Reply = z.discriminatedUnion("kind", [
  z
    .object({ id: z.number().int().nonnegative(), kind: z.literal("value"), value: z.unknown() })
    .strict(),
  z
    .object({ id: z.number().int().nonnegative(), kind: z.literal("update"), value: z.unknown() })
    .strict(),
  z
    .object({
      id: z.number().int().nonnegative(),
      kind: z.literal("error"),
      error: z.string().max(4096),
      facts: z.unknown().optional(),
    })
    .strict(),
]);
export type Reply = z.infer<typeof Reply>;
export interface Wire {
  receive(): Operation<unknown>;
  send(frame: unknown): Operation<void>;
  close(): void;
}
export interface SidekickTransport {
  supported(): boolean;
  identify(): string;
  publish(
    path: string,
    descriptor: Omit<Descriptor, "version" | "transport" | "socket">,
  ): Operation<{ descriptor: Descriptor; accept(): Operation<Operation<Wire>> }>;
  connect(path: string): Operation<{ descriptor: Descriptor; wire: Wire }>;
  stdio(): Operation<{ input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> }>;
}
export const SidekickTransport = createContext<SidekickTransport>(
  "executablemd.cli.sidekick-acp.transport",
);
export function messageReference(text: string): MessageReference {
  return MessageReference.parse(JSON.parse(decodeURIComponent(text)));
}
export function referenceText(value: MessageReference): string {
  return encodeURIComponent(JSON.stringify(value));
}
