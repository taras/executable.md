import { lstat, readdir, readTextFile } from "@effectionx/fs";
import { until } from "effection";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import process from "node:process";
import { z } from "zod";
import { platformDataRoot } from "../../../packages/cli/src/repl-assembly.ts";
import { isOpaqueExecution } from "../../../packages/cli/src/repl/route.ts";
import { REPL_DIRECTORY } from "../../../packages/cli/src/repl/storage.ts";
import {
  ENTRIES_FILE,
  PAIRED_DIRECTORY,
  SIDEKICK_FILE,
} from "../../../packages/cli/src/repl/sidekick/history.ts";
import type { SavedJournalFile } from "../../../packages/cli/src/test-diagnostics.ts";
import { privateDataEnvironment, type Launch } from "./protocol.ts";

const closure = z.object({ joined: z.boolean(), providerQuiescent: z.boolean() });

export function* snapshotChild(launch: Launch, report: (error: unknown) => void) {
  const files: SavedJournalFile[] = [];
  const { home, directory } = launch;

  function* inspect(path: string, directory: boolean) {
    try {
      const info = yield* lstat(path);
      if (directory ? info.isDirectory() : info.isFile()) {
        return true;
      }
      throw new Error(`Unexpected entry in child capture: ${relative(home, path)}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        report(error);
      }
      return false;
    }
  }

  function* list(path: string) {
    let current = home;
    for (const component of relative(home, path).split(sep)) {
      current = join(current, component);
      if (!(yield* inspect(current, true))) {
        return [];
      }
    }
    try {
      return yield* readdir(path);
    } catch (error) {
      report(error);
      return [];
    }
  }

  function* keep(path: string) {
    if (yield* inspect(path, false)) {
      try {
        files.push({ path: relative(home, path), bytes: yield* until(readFile(path)) });
      } catch (error) {
        report(error);
      }
    }
  }

  let closed: z.infer<typeof closure>;
  try {
    closed = closure.parse(JSON.parse(yield* readTextFile(join(directory, "closed.json"))));
  } catch (error) {
    report(new Error("REPL child closure could not be confirmed", { cause: error }));
    return files;
  }
  if (!closed.joined) {
    report(new Error("REPL child closure could not be confirmed"));
    return files;
  }

  if (!(yield* inspect(home, true))) {
    return files;
  }

  const data = platformDataRoot(process.platform, home, privateDataEnvironment(home), sep);
  const relativeData = relative(home, data);
  if (
    relativeData === "" ||
    isAbsolute(relativeData) ||
    relativeData === ".." ||
    relativeData.startsWith(`..${sep}`)
  ) {
    report(new Error("REPL data root is outside the private home"));
    return files;
  }

  const repository = join(data, ...REPL_DIRECTORY, PAIRED_DIRECTORY);
  const executions = (yield* list(repository)).filter(isOpaqueExecution);
  const [execution] = executions;
  if (executions.length > 1) {
    report(new Error("Ambiguous execution in the private REPL repository"));
  } else if (execution !== undefined) {
    const selected = join(repository, execution);
    if (yield* inspect(selected, true)) {
      yield* keep(join(selected, SIDEKICK_FILE));
      yield* keep(join(selected, ENTRIES_FILE));
    }
  }
  if (closed.providerQuiescent) {
    const sessions = join(home, ".xmd-scripted-sidekick", "sessions");
    for (const name of (yield* list(sessions)).sort()) {
      if (/^(?:[A-Za-z0-9_.!~*'()-]|%[A-F0-9]{2})+\.json$/u.test(name)) {
        yield* keep(join(sessions, name));
      }
    }
  } else {
    report(new Error("Scripted provider closure could not be confirmed"));
  }
  return files;
}
