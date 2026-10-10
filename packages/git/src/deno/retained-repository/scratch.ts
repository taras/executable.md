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

import { Ok, until } from "effection";
import type { Operation, Result } from "effection";
import { lstat, readdir, writeTextFile } from "@effectionx/fs";
import { copyFile, mkdir, readlink, symlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, join } from "node:path";
import type { RepositoryHost } from "../composition/host.ts";
import { gitSession } from "../composition/git.ts";
import type { GitSession } from "../composition/git.ts";
import { inventoryFrontier } from "./frontier.ts";
import type {
  RetainedAdministration,
  RetainedFrontier,
} from "../../retained-repository/records.ts";

/** Where a prediction may run without the original knowing. */
export interface Scratch {
  /** The administration directory to point Git at. */
  readonly gitDir: string;
}

/**
 * A scratch copy of the administration this checkout works through.
 *
 * The caller holds it for as long as it needs it: the directory belongs to the
 * acquiring scope, and the host removes it when that scope ends.
 *
 * The directory Git is pointed at is the selected checkout's own, not the
 * repository's. A linked worktree has its own HEAD and its own index, both
 * inside `worktrees/<name>` of the shared administration, and a prediction
 * pointed at the shared directory would compute a tree from the primary
 * checkout's index — the staging of a different checkout than the one the
 * document is working in. The copy carries both, because copying the shared
 * administration carries every worktree's directory with it.
 */
export function* useScratchAdministration(
  host: RepositoryHost,
  administration: RetainedAdministration,
): Operation<Scratch> {
  const root = yield* host.useDirectory();
  const common = join(root, "administration");
  yield* copyTree(administration.common, common);
  return {
    gitDir:
      administration.worktree === null
        ? common
        : join(common, "worktrees", basename(administration.worktree)),
  };
}

/**
 * One directory copied entry by entry.
 *
 * Bytes, modes and link targets carry; nothing is linked. A link is recreated
 * as a link rather than followed, so a copy of an administration that points
 * somewhere outside itself still points there instead of quietly absorbing
 * whatever it found.
 */
export function* copyTree(from: string, to: string): Operation<void> {
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

/**
 * Work the whole transition out in a copy of the checkout.
 *
 * Some transitions change the worktree in ways only Git can compute — a branch
 * switch replaces tracked content with another tree's — and computing them by
 * hand would mean reimplementing Git badly. So the checkout is copied, the
 * operation is performed in the copy, and what the copy ends up in is the
 * prediction.
 *
 * The copy is ordinary files and its own administration, so the original is
 * untouched. What comes back is reported under the original's identity: the
 * prediction is about that checkout, and the scratch is about to cease to
 * exist.
 */
export function* predictInScratch(
  host: RepositoryHost,
  original: { readonly directory: string; readonly checkout: string },
  administration: RetainedAdministration,
  perform: (git: GitSession, directory: string) => Operation<Result<void>>,
): Operation<Result<RetainedFrontier>> {
  const root = yield* host.useDirectory();
  const directory = join(root, "checkout");
  yield* copyTree(original.directory, directory);
  // A linked worktree's `.git` is a file holding an absolute path to its
  // administrative directory, and copying it verbatim would leave the copy
  // pointing at the original — so Git run in the copy would write refs, HEAD
  // and objects into the very checkout the prediction must not touch. The
  // administration is copied too and the two pointers are rewritten at each
  // other, which makes the copy a repository of its own.
  if (administration.worktree !== null) {
    const common = join(root, "common");
    yield* copyTree(administration.common, common);
    const admin = join(common, "worktrees", basename(administration.worktree));
    yield* writeTextFile(join(directory, ".git"), `gitdir: ${admin}\n`);
    yield* writeTextFile(join(admin, "gitdir"), `${join(directory, ".git")}\n`);
  }
  const git = gitSession(host, root);
  const performed = yield* perform(git, directory);
  if (!performed.ok) {
    return performed;
  }
  const predicted = yield* inventoryFrontier({
    git,
    checkout: original.checkout,
    directory,
  });
  if (!predicted.ok) {
    return predicted;
  }
  // The scratch's own administration paths are not the prediction: they belong
  // to a directory that is about to be removed.
  return Ok(
    Object.freeze({
      checkout: predicted.value.checkout,
      administration,
      objectFormat: predicted.value.objectFormat,
      head: predicted.value.head,
      refs: predicted.value.refs,
      index: predicted.value.index,
      worktree: predicted.value.worktree,
    }),
  );
}
