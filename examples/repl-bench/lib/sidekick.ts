import type { Operation } from "effection";
import { z } from "zod";
import {
  attachmentDescriptor,
  requestAttachment,
} from "../../../packages/cli/src/sidekick-acp/client.ts";

const exchange = z.object({
  ending: z.object({
    joined: z.literal(true),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    error: z.string().nullable(),
  }),
  output: z.string(),
});

function* step<T>(label: string, directory: string, operation: Operation<T>): Operation<T> {
  try {
    return yield* operation;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Scripted Sidekick ${label}: ${reason}\nEvidence: ${directory}`, {
      cause: error,
    });
  }
}

export function* attachSidekick(path: string, directory: string) {
  const descriptor = yield* step("attachment handshake", directory, attachmentDescriptor(path));
  const { attachment } = yield* step(
    "attach",
    directory,
    (function* () {
      return z
        .object({ attachment: z.string() })
        .parse(
          yield* requestAttachment(
            path,
            { method: "attach", cwd: descriptor.cwd },
            undefined,
            descriptor,
          ),
        );
    })(),
  );
  return {
    prompt(text: string) {
      return step(
        `prompt ${JSON.stringify(text)}`,
        directory,
        (function* () {
          const completed = exchange.parse(
            yield* requestAttachment(
              path,
              { method: "prompt", attachment, text },
              undefined,
              descriptor,
            ),
          );
          if (completed.ending.outcome !== "completed") {
            throw new Error(completed.ending.error ?? completed.ending.outcome);
          }
          return completed;
        })(),
      );
    },
    status() {
      return step(
        "read status",
        directory,
        requestAttachment(path, { method: "status" }, undefined, descriptor),
      );
    },
    output(entry: number) {
      return step(
        `read entry ${entry} output`,
        directory,
        requestAttachment(path, { method: "entry", entry, view: "output" }, undefined, descriptor),
      );
    },
  };
}
