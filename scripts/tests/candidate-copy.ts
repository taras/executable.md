import { exec, Stdio } from "@effectionx/process";
import { copyFile, ensureDir, exists } from "@effectionx/fs";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Copy candidate source and prepared assets while keeping build output private. */
export function* copyPreparedCandidate(destination: string): Operation<void> {
  const repo = new URL("../../", import.meta.url);
  const listed = yield* scoped(function* () {
    yield* Stdio.around({ *stdout() {} });
    return yield* exec("git", {
      arguments: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      cwd: fileURLToPath(repo),
    }).expect();
  });
  for (const path of [
    ...listed.stdout.split("\0").filter(Boolean),
    "packages/web/generated/client-bundle.ts",
    "packages/acp/generated/claude-snapshot.ts",
  ]) {
    if (yield* exists(new URL(path, repo))) {
      yield* ensureDir(dirname(join(destination, path)));
      yield* copyFile(new URL(path, repo), join(destination, path));
    }
  }
  yield* until(
    symlink(fileURLToPath(new URL("node_modules", repo)), join(destination, "node_modules"), "dir"),
  );
}
