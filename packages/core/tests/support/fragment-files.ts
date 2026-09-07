/**
 * A recording stand-in for the private filesystem operations a host hands an
 * evaluation profile.
 *
 * Deliberately *not* a Files provider. It is never installed into `API.Files`,
 * never composed around, and reachable only through the profile it is passed
 * to — which is the point: a row that reads a file through this one has proved
 * the read went through the captured operation, because there is no other way
 * to reach this object.
 */

import type { Operation, Result } from "effection";
import { Err, Ok } from "effection";

import type { FragmentFileAccess, FragmentPath, FragmentWrite } from "../../host.ts";

/** Every operation one fragment performed, in order, as `verb path`. */
export interface RecordedFiles extends FragmentFileAccess {
  readonly performed: string[];
  readonly entries: Map<string, string>;
}

/**
 * One recorder, seeded with whatever files a case says already exist.
 *
 * `workingDirectory` answers a fixed logical root, so a row asserting on a
 * recorded path is asserting on what the fragment asked for rather than on
 * wherever the test happened to run.
 */
export function recordedFiles(
  seed: Record<string, string> = {},
  options: { readonly hold?: (path: string) => Operation<void> } = {},
): RecordedFiles {
  const entries = new Map(Object.entries(seed));
  const performed: string[] = [];
  return {
    performed,
    entries,
    // deno-lint-ignore require-yield
    *checkFilePath(input: FragmentPath): Operation<Result<void>> {
      performed.push(`check ${input.path}`);
      return input.path.startsWith("..") ? Err(new Error("outside")) : Ok(undefined);
    },
    *readTextFile(input: FragmentPath): Operation<Result<string>> {
      performed.push(`read ${input.path}`);
      // A row about cancelling work already inside the fragment holds here:
      // the operation has begun and has not answered, which is the only state
      // where an admitted effect is in flight.
      if (options.hold !== undefined) {
        yield* options.hold(input.path);
      }
      const held = entries.get(input.path);
      return held === undefined ? Err(new Error("absent")) : Ok(held);
    },
    // deno-lint-ignore require-yield
    *writeTextFile(input: FragmentWrite): Operation<Result<unknown>> {
      performed.push(`write ${input.path}`);
      entries.set(input.path, input.content);
      return Ok(undefined);
    },
    // deno-lint-ignore require-yield
    *deleteFile(input: FragmentPath): Operation<Result<void>> {
      performed.push(`delete ${input.path}`);
      entries.delete(input.path);
      return Ok(undefined);
    },
    // deno-lint-ignore require-yield
    *ensureDirectory(input: FragmentPath): Operation<Result<void>> {
      performed.push(`ensure ${input.path}`);
      return Ok(undefined);
    },
    // deno-lint-ignore require-yield
    *workingDirectory(): Operation<string> {
      return "/workspace";
    },
  };
}
