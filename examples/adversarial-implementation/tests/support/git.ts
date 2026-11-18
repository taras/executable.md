import { API } from "@executablemd/runtime";
import { writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export function* git(args: string[], cwd: string, receipts: string) {
  const command = ["git", "-c", "gpg.ssh.program=ssh-keygen", ...args];
  const env = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const result = yield* API.Process.operations.exec({ command, cwd, env });
  yield* writeTextFile(
    join(receipts, "git-" + randomUUID() + ".json"),
    JSON.stringify({ command, cwd, env, ...result }),
  );
  if (result.exitCode !== 0) {
    throw new Error("Controlled git failed: " + args.join(" ") + " (" + result.exitCode + ")");
  }
  return result.stdout ?? "";
}
