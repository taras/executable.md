import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { exec, realpath, useQuietProcessOutput } from "@executablemd/runtime";
import { scoped } from "effection";
import { z } from "zod";

export const props = {
  type: "object",
  properties: {
    repository: { type: "string" },
    attempt: { type: "string" },
    session: { type: "string" },
  },
  required: ["repository", "attempt", "session"],
  additionalProperties: false,
};

function* canonical(path: string) {
  const parts: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    const found = yield* realpath(current);
    if (found !== undefined) {
      return resolve(found, ...parts);
    }
    if (dirname(current) === current) {
      throw new Error("Diagnosis could not resolve the attempt directory.");
    }
    parts.unshift(basename(current));
  }
}

export default function* Paths(input: unknown) {
  const { repository, attempt, session } = z
    .strictObject({ repository: z.string(), attempt: z.string(), session: z.string() })
    .parse(input);
  const git = yield* scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({
      command: [
        "git",
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      cwd: repository,
    });
  });
  const paths = git.stdout.trimEnd().split("\n");
  if (git.exitCode !== 0 || paths.length !== 3 || !paths.every(isAbsolute)) {
    throw new Error("Diagnosis requires an identified Git checkout.");
  }
  const directory = yield* canonical(attempt);
  for (const path of paths) {
    const part = relative(yield* canonical(path), directory);
    if (!isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep)) {
      throw new Error("Keep diagnostic artifacts outside the checkout and Git directories.");
    }
  }
  const suffix = createHash("sha256").update(directory).digest("hex").slice(0, 20);
  return { directory, name: session + "-" + suffix, identities: directory + "/sessions" };
}
