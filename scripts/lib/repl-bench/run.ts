import { ensureDir, writeTextFile } from "@effectionx/fs";
import { exec, Stdio } from "@effectionx/process";
import { scoped } from "effection";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Launch, Size } from "./protocol.ts";
import { z } from "zod";
import { worktree } from "./protocol.ts";

export const root = dirname(fileURLToPath(new URL("deno.json", worktree)));
const entry = fileURLToPath(new URL("packages/cli/src/deno.ts", worktree));
export const evidence = join(root, ".bench");

export function* prepareRun(cwd: string, size: Size, args: string[], home?: string) {
  const id = randomUUID();
  const directory = join(evidence, id);
  yield* ensureDir(directory);
  const { revision, dirty, denoDir } = yield* scoped(function* () {
    yield* Stdio.around({
      // deno-lint-ignore require-yield
      *stdout() {
        return;
      },
    });
    const head = (yield* exec("git", {
      cwd: root,
      arguments: ["rev-parse", "HEAD"],
    }).expect()).stdout.trim();
    const status = (yield* exec("git", {
      cwd: root,
      arguments: ["--no-optional-locks", "status", "--porcelain"],
    }).expect()).stdout;
    const info = (yield* exec("deno", { cwd: root, arguments: ["info", "--json"] }).expect())
      .stdout;
    const cache = z.object({ denoDir: z.string() }).parse(JSON.parse(info));
    return { revision: head, dirty: status.trim() !== "", denoDir: cache.denoDir };
  });
  if (!/^[a-f0-9]{40,64}$/.test(revision)) {
    throw new Error(`Could not identify the worktree revision. Evidence: ${directory}`);
  }
  const launch: Launch = {
    ...size,
    entry,
    denoDir,
    directory,
    cwd,
    home: home ?? join(directory, "home"),
    args,
  };
  yield* writeTextFile(
    join(directory, "run.json"),
    JSON.stringify({ id, worktree: root, revision, dirty, ...launch }, null, 2),
  );
  return { id, revision, launch };
}
