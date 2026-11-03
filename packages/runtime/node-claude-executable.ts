import { stat } from "@effectionx/fs";
import { realpath } from "node:fs/promises";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import process from "node:process";
import { ProcessApi, Stdio } from "@effectionx/process";
import { resolveExecutablePath } from "./node-executable-path.ts";

/** Select the host Claude launcher without requiring a version observation. */
export function* hostClaudeExecutable(): Operation<string> {
  try {
    const environment = process.env;
    const explicit = environment.CLAUDE_CODE_EXECUTABLE;
    const command = explicit || "claude";
    const windows = process.platform === "win32";
    const selected = yield* resolveExecutablePath(command, {
      cwd: process.cwd(),
      path: environment.PATH ?? environment.Path ?? "",
      ...(windows && !explicit
        ? { extensions: ["", ...(environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] }
        : {}),
    });
    const path = yield* until(realpath(selected));
    const info = yield* stat(path);
    if (!info.isFile() || (!windows && (info.mode & 0o111) === 0)) {
      throw new Error("host Claude is not executable");
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
      "Host Claude Code is unavailable. Install claude on the host PATH or correct " +
        "CLAUDE_CODE_EXECUTABLE to select a launchable host executable.",
    );
  }
}
