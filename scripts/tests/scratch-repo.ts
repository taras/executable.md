/**
 * A git repository of this test's own.
 *
 * Selection is a question about a worktree, and asking it of the repository
 * under test would make every answer depend on whatever the developer happened
 * to have staged. These fixtures build the worktree they interrogate, commit
 * to it, and throw it away.
 */

import { ensure } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { captured } from "../lib/captured.ts";

export interface ScratchRepo {
  root: URL;
  git(...args: string[]): Operation<string>;
  write(file: string, contents: string): Operation<void>;
  remove(file: string): Operation<void>;
  commit(message: string): Operation<string>;
}

/** Identity on the command line, so the fixture never depends on a global config. */
const AUTHOR = [
  "-c",
  "user.email=scratch@example.test",
  "-c",
  "user.name=Scratch",
  "-c",
  "commit.gpgsign=false",
];

export function* scratchRepo(prefix: string): Operation<ScratchRepo> {
  // @effectionx/fs has no mkdtemp.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  yield* ensure(() => rm(base, { recursive: true, force: true }));
  const root = pathToFileURL(`${base}/`);
  const cwd = fileURLToPath(root);

  function* git(...args: string[]): Operation<string> {
    const result = yield* captured("git", { arguments: args, cwd });
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  function* write(file: string, contents: string): Operation<void> {
    const target = new URL(file, root);
    yield* ensureDir(new URL(".", target));
    yield* writeTextFile(target, contents);
  }

  function* commit(message: string): Operation<string> {
    yield* git("add", "-A");
    yield* git(...AUTHOR, "commit", "-qm", message);
    return (yield* git("rev-parse", "HEAD")).trim();
  }

  yield* git("init", "-q", "-b", "main");
  return {
    root,
    git,
    write,
    remove: (file) => rm(new URL(file, root), { force: true }),
    commit,
  };
}
