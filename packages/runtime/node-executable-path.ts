import { stat } from "@effectionx/fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Operation } from "effection";
import { ExecutableObservationError } from "./executable-observer.ts";

/** Resolve a launcher against a host-captured directory and search path. */
export function* resolveExecutablePath(
  command: string,
  host: { cwd: string; path: string; extensions?: readonly string[] },
): Operation<string> {
  if (command.length === 0) {
    throw new ExecutableObservationError("no executable was named", { refusal: "not-found" });
  }
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    return resolve(host.cwd, command);
  }
  for (const entry of host.path.split(delimiter)) {
    if (entry.length === 0) {
      continue;
    }
    for (const extension of host.extensions ?? [""]) {
      const candidate = resolve(host.cwd, join(entry, `${command}${extension}`));
      try {
        yield* stat(candidate);
        return candidate;
      } catch {
        // A missing PATH entry does not hide a later launcher.
      }
    }
  }
  throw new ExecutableObservationError(`${command} was not found on the host search path`, {
    refusal: "not-found",
  });
}
