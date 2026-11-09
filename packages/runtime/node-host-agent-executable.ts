import { stat } from "@effectionx/fs";
import { realpath } from "node:fs/promises";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import process from "node:process";
import { ProcessApi, Stdio } from "@effectionx/process";
import { resolveExecutablePath } from "./node-executable-path.ts";

/** Select the host Claude launcher without requiring a version observation. */
export function hostClaudeExecutable(): Operation<string> {
  return hostAgentExecutable("CLAUDE_CODE_EXECUTABLE", "claude", "Claude Code");
}

/** Select the host Codex launcher without requiring a version observation. */
export function hostCodexExecutable(): Operation<string> {
  return hostAgentExecutable("CODEX_PATH", "codex", "Codex");
}

function* hostAgentExecutable(
  variable: string,
  command: string,
  product: string,
): Operation<string> {
  try {
    const environment = process.env;
    const explicit = environment[variable];
    const windows = process.platform === "win32";
    const selected = yield* resolveExecutablePath(explicit || command, {
      cwd: process.cwd(),
      path: environment.PATH ?? environment.Path ?? "",
      ...(windows && !explicit
        ? { extensions: ["", ...(environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] }
        : {}),
    });
    const path = yield* until(realpath(selected));
    const info = yield* stat(path);
    if (!info.isFile() || (!windows && (info.mode & 0o111) === 0)) {
      throw new Error(`host ${product} is not executable`);
    }
    yield* scoped(function* () {
      yield* Stdio.around({ *stdout() {}, *stderr() {} });
      // Exit status and version text are diagnostic; only failure to start refuses.
      const child = yield* ProcessApi.operations.exec(path, {
        arguments: ["--version"],
        cwd: process.cwd(),
      });
      yield* child.join();
    });
    return path;
  } catch {
    throw new Error(
      `Host ${product} is unavailable. Install ${command} on the host PATH or correct ` +
        `${variable} to select a launchable host executable.`,
    );
  }
}
