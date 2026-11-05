import { API } from "@executablemd/runtime";
import { access } from "node:fs/promises";
import { stat } from "@effectionx/fs";
import { constants } from "node:fs";
import { until } from "effection";
import type { Operation } from "effection";
import type { EntryPlacement } from "./entry-placement.ts";

function accessible(directory: string): Operation<void> {
  return until(access(directory, constants.R_OK | constants.X_OK));
}

export function* validateProjectPlacement(
  placement: EntryPlacement,
  checkAccess: (directory: string) => Operation<void> = accessible,
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
