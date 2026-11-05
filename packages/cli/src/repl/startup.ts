import { API } from "@executablemd/runtime";
import { stat } from "@effectionx/fs";
import type { Operation } from "effection";
import type { EntryPlacement } from "./entry-placement.ts";
import { ReplHost } from "./host.ts";

export function* validateProjectPlacement(
  placement: EntryPlacement,
  checkAccess: (directory: string) => Operation<void> = ReplHost.operations.checkProjectAccess,
): Operation<void> {
  try {
    yield* checkAccess(placement.projectDirectory);
    const info = yield* stat(placement.projectDirectory);
    if (
      !info.isDirectory() ||
      (yield* canonicalProject(placement.projectDirectory)) !== placement.canonicalProjectRoot
    ) {
      throw new Error("unavailable");
    }
  } catch {
    throw new Error(
      `The recorded project ${placement.projectDirectory} is unavailable or resolves to a different directory. Restore it before reopening this location.`,
    );
  }
}

export function* canonicalProject(directory: string): Operation<string> {
  const canonical = yield* API.Fs.operations.realpath(directory);
  if (canonical === undefined) {
    throw new Error(`The project directory ${directory} does not exist.`);
  }
  return canonical;
}
