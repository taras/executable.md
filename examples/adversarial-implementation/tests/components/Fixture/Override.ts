import { Component } from "@executablemd/core/api";
import { API, fileWriteFailure } from "@executablemd/runtime";
import { exists } from "@effectionx/fs";
import { Err, Ok } from "effection";
import { z } from "zod";

export const props = {
  type: "object",
  properties: {
    match: { type: "string" },
    mode: { enum: ["read", "deny-write", "unknown-write", "rename-unknown"] },
    content: { type: "string", default: "Changed fixture text." },
    flag: { type: ["string", "null"], default: null },
  },
  required: ["match", "mode"],
  additionalProperties: false,
};
const input = z
  .object({
    match: z.string().min(1),
    mode: z.enum(["read", "deny-write", "unknown-write", "rename-unknown"]),
    content: z.string(),
    flag: z.string().nullable(),
  })
  .strict();

function located(selected: { cwd: string; path: string }): string {
  return selected.path.startsWith("/") ? selected.path : selected.cwd + "/" + selected.path;
}

/**
 * Change one Files boundary for the enclosed content only. Reads of the
 * matching path return replacement text, once `flag` exists when one is named;
 * matching writes fail before the target changes or with an unknown commit;
 * `rename-unknown` lets the host rename commit and then faults, so the caller
 * observes commit-unknown while the complete target bytes remain.
 */
export default function* Override(value: unknown) {
  const selected = input.parse(value);
  if (selected.mode === "read") {
    yield* API.Files.around({
      *readTextFile([request], next) {
        if (
          located(request).endsWith(selected.match) &&
          (selected.flag === null || (yield* exists(selected.flag)))
        ) {
          return Ok(selected.content);
        }
        return yield* next(request);
      },
    });
  } else if (selected.mode === "rename-unknown") {
    yield* API.Fs.around({
      *rename([from, to], next) {
        yield* next(from, to);
        if (to.endsWith(selected.match)) {
          throw new Error("Fixture fault after the rename committed.");
        }
      },
    });
  } else {
    yield* API.Files.around({
      *writeTextFile([request], next) {
        if (located(request).includes(selected.match)) {
          return Err(
            selected.mode === "deny-write"
              ? fileWriteFailure({ phase: "target", reason: "permission-denied" })
              : fileWriteFailure({ phase: "commit", reason: "operation-failed" }),
          );
        }
        return yield* next(request);
      },
    });
  }
  return yield* Component.operations.content();
}
