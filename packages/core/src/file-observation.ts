import { Err, lift, Ok } from "effection";
import type { Operation, Result } from "effection";
import { Files, filesFailure } from "@executablemd/runtime";
import { readFileText } from "./files.ts";
import { retainsOptionalText } from "./secrets/policy.ts";
import { fileRevision, FILE_WINDOW_LIMIT, readFileWindow } from "./file-window.ts";
import type { FileReadSelection } from "./file-window.ts";
import type { Json } from "./types.ts";

export function* observeFile<T extends Json>(
  cwd: string,
  path: string,
  excludeGitMetadata: boolean,
  projection:
    | { read: (text: string) => Operation<T> }
    | { match: (text: string) => Operation<(() => T) | undefined>; miss: T },
): Operation<Result<T>> {
  let approved: { value: T; serialized: string } | undefined;
  const input = {
    cwd,
    path,
    observation: {
      excludeGitMetadata,
      *project(text: string): Operation<Result<string>> {
        const match = "match" in projection ? yield* projection.match(text) : undefined;
        const missed = "match" in projection && match === undefined;
        if (!missed && !(yield* retainsOptionalText(text))) {
          return Err(
            filesFailure({ operation: "read", phase: "access", reason: "permission-denied" }),
          );
        }
        const value =
          "read" in projection
            ? yield* projection.read(text)
            : match === undefined
              ? projection.miss
              : match();
        const serialized = JSON.stringify(value);
        approved = { value, serialized };
        return Ok(serialized);
      },
    },
  };
  const observed = yield* readFileText(input, Files.operations.observeTextFile(input));
  if (!observed.ok) {
    return observed;
  }
  return approved !== undefined && observed.value === approved.serialized
    ? Ok(approved.value)
    : Err(filesFailure({ operation: "read", phase: "access", reason: "operation-failed" }));
}

export function observeFileWindow(
  cwd: string,
  selection: FileReadSelection,
): Operation<Result<{ path: string; changed: boolean | null; text: string }>> {
  return observeFile(cwd, selection.path, selection.revision !== undefined, {
    read: lift((text: string) => ({
      path: selection.path,
      changed: selection.revision === undefined ? null : selection.revision !== fileRevision(text),
      text: readFileWindow(text, { ...selection, limit: selection.limit ?? FILE_WINDOW_LIMIT }),
    })),
  });
}
