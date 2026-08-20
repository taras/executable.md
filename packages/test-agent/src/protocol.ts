/**
 * Controller ↔ worker wire protocol (specs/test-agent-spec.md
 * §Controller and worker): newline-delimited JSON over localhost TCP.
 * Every inbound line is parsed into a validated type — malformed,
 * unknown, and directionally invalid messages are rejected, never cast.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";
import { z } from "zod";
import type { DurableEvent, Json } from "@executablemd/durable-streams";

const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);

/** The validated journal-event wire shape; structurally a DurableEvent. */
export type WireDurableEvent = DurableEvent;

export type WorkerMessage =
  | { t: "attach"; token: string; instance: string }
  | { t: "journal"; seq: number; event: WireDurableEvent }
  | { t: "read"; path: string }
  | { t: "stat"; path: string }
  | { t: "session"; systemPrompt?: string }
  | {
      t: "turn-failure";
      kind: "mismatch" | "exhausted" | "config";
      expected?: string;
      actual: string;
    }
  | { t: "fatal"; message: string };

export type ControllerMessage =
  | { t: "config"; mode: "probe" }
  | {
      t: "config";
      mode: "scenario";
      doc: { path: string; source: string };
      journal: WireDurableEvent[];
      /**
       * The provider-native session identity this scenario asserts. The
       * scenario owns it, so a worker that reconnects names the state that
       * already exists rather than minting a replacement for it.
       */
      nativeSessionId: string;
    }
  | { t: "ack"; seq: number }
  | { t: "recorded" }
  | { t: "read"; path: string; source?: string; missing: boolean }
  | { t: "stat"; path: string; exists: boolean; isFile: boolean }
  | { t: "error"; message: string };

const durableResult = z.union([
  z.object({ status: z.literal("ok"), value: json.optional() }),
  z.object({
    status: z.literal("err"),
    error: z.object({
      message: z.string(),
      name: z.string().optional(),
      stack: z.string().optional(),
    }),
  }),
  z.object({ status: z.literal("cancelled") }),
]);

const durableEvent: z.ZodType<WireDurableEvent> = z.union([
  z
    .object({
      type: z.literal("yield"),
      coroutineId: z.string(),
      description: z.object({ type: z.string(), name: z.string() }).catchall(json),
      result: durableResult,
    })
    .catchall(json),
  z
    .object({
      type: z.literal("close"),
      coroutineId: z.string(),
      result: durableResult,
    })
    .catchall(json),
]);

const workerMessage: z.ZodType<WorkerMessage> = z.discriminatedUnion("t", [
  z.object({ t: z.literal("attach"), token: z.string(), instance: z.string() }),
  z.object({ t: z.literal("journal"), seq: z.number().int().nonnegative(), event: durableEvent }),
  z.object({ t: z.literal("read"), path: z.string() }),
  z.object({ t: z.literal("stat"), path: z.string() }),
  z.object({ t: z.literal("session"), systemPrompt: z.string().optional() }),
  z.object({
    t: z.literal("turn-failure"),
    kind: z.enum(["mismatch", "exhausted", "config"]),
    expected: z.string().optional(),
    actual: z.string(),
  }),
  z.object({ t: z.literal("fatal"), message: z.string() }),
]);

const configMessage: z.ZodType<ControllerMessage> = z.discriminatedUnion("mode", [
  z.object({ t: z.literal("config"), mode: z.literal("probe") }),
  z.object({
    t: z.literal("config"),
    mode: z.literal("scenario"),
    doc: z.object({ path: z.string(), source: z.string() }),
    journal: z.array(durableEvent),
    nativeSessionId: z.string(),
  }),
]);

const controllerMessage: z.ZodType<ControllerMessage> = z.union([
  configMessage,
  z.object({ t: z.literal("ack"), seq: z.number().int().nonnegative() }),
  z.object({ t: z.literal("recorded") }),
  z.object({
    t: z.literal("read"),
    path: z.string(),
    source: z.string().optional(),
    missing: z.boolean(),
  }),
  z.object({
    t: z.literal("stat"),
    path: z.string(),
    exists: z.boolean(),
    isFile: z.boolean(),
  }),
  z.object({ t: z.literal("error"), message: z.string() }),
]);

export function encodeMessage(message: WorkerMessage | ControllerMessage): string {
  return JSON.stringify(message) + "\n";
}

function parseLine<T>(schema: z.ZodType<T>, line: string, direction: string): Result<T> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return Err(
      new Error(
        `malformed ${direction} message (invalid JSON): ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return Err(new Error(`invalid ${direction} message: ${parsed.error.message}`));
  }
  return Ok(parsed.data);
}

export function parseWorkerMessage(line: string): Result<WorkerMessage> {
  return parseLine(workerMessage, line, "worker");
}

export function parseControllerMessage(line: string): Result<ControllerMessage> {
  return parseLine(controllerMessage, line, "controller");
}

/** Incremental newline splitter: feed chunks, receive complete lines. */
export function createLineSplitter(): { feed(chunk: string): string[] } {
  let buffered = "";
  return {
    feed(chunk) {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      return lines.filter((line) => line.trim().length > 0);
    },
  };
}

export interface ParsedRoute {
  host: string;
  port: number;
  token: string;
  instance: string;
}

/**
 * Routes are opaque to ACPX and workers alike; this is the one place
 * that knows the encoding: host:port/token/instance.
 */
export function formatRoute(route: ParsedRoute): string {
  return `${route.host}:${route.port}/${route.token}/${route.instance}`;
}

export function parseRoute(value: string): Result<ParsedRoute> {
  const match = /^([^:/]+):(\d+)\/([^/]+)\/(.+)$/.exec(value);
  if (!match) {
    return Err(new Error(`malformed controller route: ${value}`));
  }
  const port = Number.parseInt(match[2]!, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return Err(new Error(`malformed controller route port: ${value}`));
  }
  return Ok({ host: match[1]!, port, token: match[3]!, instance: match[4]! });
}

export const PROBE_INSTANCE = "probe";
