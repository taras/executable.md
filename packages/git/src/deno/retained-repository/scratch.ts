/**
 * A disposable copy of one repository's administration, for predicting in.
 *
 * Some transitions cannot be worked out without Git. A commit's object id is
 * the clearest case: it is a digest of the tree, the parents, the message and
 * both identities, and the only thing that computes it correctly is Git itself.
 * Running `write-tree` and `commit-tree` in the selected checkout would compute
 * it — and would also write those objects into the repository the document is
 * working in, before its intent had been recorded.
 *
 * So the administration is copied and the prediction happens in the copy. The
 * copy is ordinary files, taken with no hard links, no alternates and no
 * worktree backpointer, so nothing it does can reach the original. It is owned
 * by the scope that asked for it and goes away with it.
 *
 * Copying the administration rather than cloning is deliberate: a clone carries
 * only what a ref can reach, and the blobs a document has just staged are
 * reachable from the index alone. A clean clone is not the same repository as a
 * dirty one.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { lstat, readdir } from "@effectionx/fs";
import { copyFile, mkdir, readlink, symlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import type { RepositoryHost } from "../composition/host.ts";

/** Where a prediction may run without the original knowing. */
export interface Scratch {
  /** The administration directory to point Git at. */
  readonly gitDir: string;
}

/**
 * A scratch copy of this repository's administration.
 *
 * The caller holds it for as long as it needs it: the directory belongs to the
 * acquiring scope, and the host removes it when that scope ends.
 */
export function* useScratchAdministration(
  host: RepositoryHost,
  administration: string,
): Operation<Scratch> {
  const root = yield* host.useDirectory();
  const gitDir = join(root, "administration");
  yield* copyTree(administration, gitDir);
  return { gitDir };
}

/**
 * One directory copied entry by entry.
 *
 * Bytes, modes and link targets carry; nothing is linked. A link is recreated
 * as a link rather than followed, so a copy of an administration that points
 * somewhere outside itself still points there instead of quietly absorbing
 * whatever it found.
 */
function* copyTree(from: string, to: string): Operation<void> {
  yield* until(mkdir(to, { recursive: true }));
  const names = yield* readdir(from);
  for (const name of names) {
    const source = join(from, name);
    const target = join(to, name);
    const info: Stats = yield* lstat(source);
    if (info.isSymbolicLink()) {
      yield* until(symlink(yield* until(readlink(source)), target));
      continue;
    }
    if (info.isDirectory()) {
      yield* copyTree(source, target);
      continue;
    }
    if (!info.isFile()) {
      // A socket or a device in an administration directory is not something a
      // prediction needs, and copying it would be copying a host facility.
      continue;
    }
    yield* until(copyFile(source, target));
  }
}
