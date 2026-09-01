/**
 * The repository the person running the document is standing in.
 *
 * A workflow document names every repository it touches, because a workflow is
 * a program that runs somewhere else. An ordinary `xmd run` is a command
 * somebody typed in a checkout, so the checkout is the obvious subject — and
 * making it the default is what lets a document say
 *
 * ```md
 * <Worktree name="issue-643" branch="issue-643">…</Worktree>
 * ```
 *
 * and mean the repository the command was run in.
 *
 * ## Two identities, and they are not the same
 *
 * The **common Git directory** identifies the repository; the **checkout root**
 * identifies which of its checkouts this invocation is in. They differ exactly
 * when the caller is standing in a linked worktree — where `.git` is a file
 * naming the primary repository's administration — and keeping them apart is
 * what makes starting XMD in a worktree produce the same Repository identity as
 * starting it in the primary checkout, while Git operations still act on the
 * worktree the command was actually run in.
 *
 * ## Discovery is not an operation the document asked for
 *
 * It happens once, before root expansion, from the invocation's starting
 * directory. Being outside a repository is not a startup failure: a document
 * that never asks for a Repository-dependent operation runs exactly as it would
 * anywhere else, and only an element that needs one refuses.
 *
 * The `origin` is read the same way, and its absence is likewise not a failure.
 * A repository with no origin is a perfectly good Repository for a Worktree, a
 * Switch, an Add and a Commit; it is only Push and PullRequest that need a
 * destination, and each of those checks for one before it opens a credential.
 */

import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { until, type Operation } from "effection";
import type { GitObjectFormat } from "../../composition/records.ts";
import { admitLocator, locatorFingerprint } from "../composition/locator.ts";
import { currentBranch, readObjectFormat, resolveCommit } from "../composition/git.ts";
import type { GitSession } from "../composition/git.ts";

/** What one Git checkout on this host turned out to be. */
export interface AmbientRepository {
  /** The display name a document sees: the checkout directory's own name. */
  readonly name: string;
  /** The canonical root of the checkout the invocation started in. */
  readonly checkoutRoot: string;
  /** The canonical common Git directory, which identifies the repository. */
  readonly commonDirectory: string;
  readonly objectFormat: GitObjectFormat;
  /** The commit HEAD named when this invocation started. */
  readonly head: string;
  /** The locally recorded, admitted `origin`, or `undefined` when there is none. */
  readonly origin: string | undefined;
  readonly originFingerprint: string | undefined;
  /**
   * The branch a `<PullRequest>` defaults its base to.
   *
   * `refs/remotes/origin/HEAD` when the checkout records one, and the branch
   * this invocation started on otherwise. Nothing is asked of a remote for it:
   * a default branch this run had to fetch would make an ordinary document
   * reach the network before it did anything.
   */
  readonly defaultBranch: string;
}

/**
 * The canonical directory this path resolves to, or `undefined`.
 *
 * Canonicalization matters more than usual here. `/var` on macOS is
 * `/private/var`, and Git writes the resolved path into a linked worktree's
 * administration — so a comparison against an unresolved path would report a
 * worktree as belonging to no repository.
 */
function* canonical(path: string): Operation<string | undefined> {
  try {
    return yield* until(realpath(path));
  } catch {
    return undefined;
  }
}

/**
 * Discover the ambient repository from this directory, or answer `undefined`.
 *
 * Every step is a local Git question. Nothing here contacts a remote, opens a
 * credential or writes anything.
 */
export function* discoverAmbientRepository(
  git: GitSession,
  from: string,
): Operation<AmbientRepository | undefined> {
  const reportedRoot = yield* git.read(["rev-parse", "--show-toplevel"], from);
  if (reportedRoot === undefined) {
    return undefined;
  }
  const checkoutRoot = yield* canonical(reportedRoot);
  if (checkoutRoot === undefined) {
    return undefined;
  }

  const reportedCommon = yield* git.read(["rev-parse", "--git-common-dir"], checkoutRoot);
  if (reportedCommon === undefined) {
    return undefined;
  }
  // Without `--path-format=absolute`, which not every supported Git has: a
  // linked worktree already answers absolutely, and a primary checkout answers
  // `.git` relative to itself.
  const commonDirectory = yield* canonical(
    reportedCommon.startsWith("/") ? reportedCommon : `${checkoutRoot}/${reportedCommon}`,
  );
  if (commonDirectory === undefined) {
    return undefined;
  }

  const objectFormat = yield* readObjectFormat(git, checkoutRoot);
  const head = yield* resolveCommit(git, checkoutRoot, "HEAD");
  if (objectFormat === undefined || head === undefined) {
    // A directory Git recognizes but cannot say the shape of is not a
    // repository this provider will act on. Refusing here is the same answer as
    // being outside one, and for the same reason: nothing has been read that
    // could name a checkout.
    return undefined;
  }

  const branch = yield* currentBranch(git, checkoutRoot);
  const recorded = yield* git.read(["config", "--get", "remote.origin.url"], checkoutRoot);
  // Admitted on the way in, not on the way out: what is not a locator this
  // provider would hand to Git is a repository with no usable origin, which is
  // a state Push and PullRequest already know how to refuse.
  const origin = recorded === undefined ? undefined : admitLocator(recorded);

  const recordedDefault = yield* git.read(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    checkoutRoot,
  );
  const defaultBranch = defaultFrom(recordedDefault, branch);

  return Object.freeze({
    name: basename(checkoutRoot),
    checkoutRoot,
    commonDirectory,
    objectFormat,
    head,
    origin,
    originFingerprint: origin === undefined ? undefined : locatorFingerprint(origin),
    defaultBranch,
  });
}

/**
 * The default branch, from what the checkout records.
 *
 * `refs/remotes/origin/HEAD` reads as `origin/main`, and what a base names is
 * `main`. A detached HEAD with no recorded remote default leaves nothing to
 * name, and the empty string is what a `<PullRequest>` then has to be given a
 * `base` for.
 */
function defaultFrom(recorded: string | undefined, branch: string | undefined): string {
  if (recorded !== undefined && recorded.startsWith("origin/")) {
    return recorded.slice("origin/".length);
  }
  return recorded ?? branch ?? "";
}
