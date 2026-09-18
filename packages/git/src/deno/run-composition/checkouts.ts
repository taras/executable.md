/**
 * Managed checkouts: creating one, reusing one, and refusing everything else.
 *
 * A workflow Repository is created once and restored from a journal. A managed
 * one is created once and then *found again* by later executions that have no
 * journal at all, so everything a run needs to trust about it has to be
 * re-established from what is on disk, every time, under the slot's lock.
 *
 * ## Reuse checks creation identity, and only creation identity
 *
 * What is compared is what the checkout was made from: the immutable request,
 * the recorded creation facts, and the Git identity of the directory. HEAD, the
 * current branch, the index, the working tree and dirtiness are all deliberately
 * unchecked — they are the mutable work the checkout exists to preserve, and a
 * reuse that required them to match creation would refuse every checkout
 * anybody had actually used.
 *
 * A conflict is a refusal, never a repair. Nothing here resets, switches,
 * cleans, fetches, moves, replaces or deletes; a slot that does not match is
 * left byte for byte as it was found and the sentence says what it is.
 *
 * ## An interrupted creation is adopted only when it can be proved
 *
 * A process killed between cloning and writing the sidecar leaves a checkout
 * nothing describes. Deleting it would be destroying work; using it blindly
 * would be trusting a directory this provider cannot account for. So it is
 * adopted only after the *stricter* pre-exposure state is proved — the exact
 * owner and locator, the branch and base this request resolves to, the creation
 * commit still being HEAD, the object format, and nothing in the slot but the
 * checkout — and the sidecar is then written atomically. Anything less refuses.
 */

import { open, rename } from "node:fs/promises";
import { ensureDir, exists, readTextFile, readdir } from "@effectionx/fs";
import { realpath } from "node:fs/promises";
import { ensure, scoped, until, type Operation } from "effection";
import { randomUUID } from "node:crypto";
import type { GitObjectFormat } from "../../composition/records.ts";
import { admitLocator, locatorFingerprint } from "../composition/locator.ts";
import {
  addWorktree,
  branchExists,
  checkoutPrimary,
  clone,
  commonDirectory,
  currentBranch,
  objectFormat as readFormat,
  originLocator,
  readObjectFormat,
  resolveBaseCommit,
  resolveCommit,
  resolveRepositoryStart,
} from "../composition/git.ts";
import type { GitSession } from "../composition/git.ts";
import { useGitAuthentication, type RepositoryHost } from "../composition/host.ts";
import { repositoryRefused, worktreeRefused } from "../composition/refusals.ts";
import { ManagedCheckoutError } from "./errors.ts";
import {
  METADATA_VERSION,
  metadataBytes,
  parseRepositoryMetadata,
  parseWorktreeMetadata,
  type ManagedMetadata,
  type ManagedRepositoryMetadata,
  type ManagedWorktreeMetadata,
} from "./metadata.ts";
import { CHECKOUT, checkoutOf, METADATA, metadataOf } from "./placement.ts";

/** One managed checkout, once this execution is entitled to work in it. */
export interface ManagedCheckout {
  readonly checkout: string;
  readonly commonDirectory: string;
  readonly objectFormat: GitObjectFormat;
  readonly creationCommit: string;
}

export interface ManagedRepository extends ManagedCheckout {
  readonly metadata: ManagedRepositoryMetadata;
}

export interface ManagedWorktree extends ManagedCheckout {
  readonly metadata: ManagedWorktreeMetadata;
}

function conflict(reason: "incompatible-reuse" | "partial-creation", sentence: string): never {
  throw new ManagedCheckoutError(reason, sentence);
}

function unusable(sentence: string): never {
  throw new ManagedCheckoutError("unusable-checkout", sentence);
}

/**
 * Write a sidecar by exclusive temporary sibling plus atomic rename.
 *
 * Exclusive because the temporary name must never be one another process is
 * already writing; atomic because a reader under the same lock must see either
 * the whole sidecar or none of it, and a partially written one would describe a
 * checkout nobody made.
 */
function* writeMetadata(slot: string, metadata: ManagedMetadata): Operation<void> {
  const temporary = `${metadataOf(slot)}.${randomUUID()}`;
  yield* scoped(function* () {
    const handle = yield* until(open(temporary, "wx"));
    // Registered before the write, so a halt closes the descriptor: closing is
    // asynchronous, and a `finally` that suspended would not be guaranteed to
    // finish.
    yield* ensure(() => until(handle.close()));
    yield* until(handle.writeFile(metadataBytes(metadata), "utf8"));
  });
  yield* until(rename(temporary, metadataOf(slot)));
}

/** The sidecar this slot holds, or `undefined` when it holds none. */
function* readMetadata(slot: string): Operation<unknown> {
  const path = metadataOf(slot);
  if (!(yield* exists(path))) {
    return undefined;
  }
  const bytes = yield* readTextFile(path);
  try {
    return JSON.parse(bytes);
  } catch {
    return null;
  }
}

/** The canonical directory this path resolves to, or `undefined`. */
function* canonical(path: string): Operation<string | undefined> {
  try {
    return yield* until(realpath(path));
  } catch {
    return undefined;
  }
}

/**
 * The Git facts a slot's checkout reports, once it reports a whole set.
 *
 * Read as one group because a comparison needs all of it: a checkout that can
 * answer where its objects are but not which repository it belongs to is not
 * one this provider can decide anything about.
 */
interface CheckoutFacts {
  readonly root: string;
  readonly commonDirectory: string;
  readonly objectFormat: GitObjectFormat;
  readonly head: string;
}

function* readCheckoutFacts(
  git: GitSession,
  directory: string,
): Operation<CheckoutFacts | undefined> {
  const reportedRoot = yield* git.read(["rev-parse", "--show-toplevel"], directory);
  if (reportedRoot === undefined) {
    return undefined;
  }
  const root = yield* canonical(reportedRoot);
  const common = yield* commonDirectory(git, directory);
  const objectFormat = yield* readObjectFormat(git, directory);
  const head = yield* resolveCommit(git, directory, "HEAD");
  if (root === undefined || common === undefined || objectFormat === undefined) {
    return undefined;
  }
  const commonCanonical = yield* canonical(common);
  if (commonCanonical === undefined || head === undefined) {
    return undefined;
  }
  return { root, commonDirectory: commonCanonical, objectFormat, head };
}

/** Whether the slot holds nothing but its own checkout directory. */
function* slotHoldsOnlyCheckout(slot: string): Operation<boolean> {
  const entries = yield* readdir(slot);
  return entries.length === 1 && entries[0] === CHECKOUT;
}

/**
 * Select the managed Repository this request names.
 *
 * The lease is already held by the caller, so everything below is this
 * execution's alone until the execution ends.
 */
export function* selectManagedRepository(
  git: GitSession,
  host: RepositoryHost,
  slot: string,
  request: { readonly name: string; readonly locator: string; readonly base: string | undefined },
): Operation<ManagedRepository> {
  const locator = admitLocator(request.locator);
  if (locator === undefined) {
    repositoryRefused(request.name, "invalid-locator");
  }
  const fingerprint = locatorFingerprint(locator);
  const checkout = checkoutOf(slot);
  const requestedBase = request.base ?? null;

  const stored = yield* readMetadata(slot);
  if (stored !== undefined) {
    const metadata = parseRepositoryMetadata(stored);
    if (metadata === undefined) {
      conflict(
        "incompatible-reuse",
        `the managed checkout for repository ${JSON.stringify(request.name)} carries a ` +
          `${METADATA} this version cannot read, so what it holds cannot be decided. Nothing ` +
          "was changed.",
      );
    }
    if (
      metadata.name !== request.name ||
      metadata.locator !== locator ||
      metadata.locatorFingerprint !== fingerprint ||
      metadata.requestedBase !== requestedBase
    ) {
      conflict(
        "incompatible-reuse",
        `the managed checkout for repository ${JSON.stringify(request.name)} was created from a ` +
          "different url or base than this invocation asks for. Nothing was reset, fetched or " +
          "replaced; ask for a different name to get a checkout of your own.",
      );
    }
    const facts = yield* verifyRepository(git, checkout, metadata, request.name);
    return { checkout, ...facts, creationCommit: metadata.creationCommit, metadata };
  }

  if (yield* exists(checkout)) {
    const metadata = yield* adoptRepository(git, slot, checkout, {
      name: request.name,
      locator,
      fingerprint,
      requestedBase,
      base: request.base,
    });
    const facts = yield* verifyRepository(git, checkout, metadata, request.name);
    return { checkout, ...facts, creationCommit: metadata.creationCommit, metadata };
  }

  return yield* createManagedRepository(git, host, slot, checkout, {
    name: request.name,
    locator,
    fingerprint,
    requestedBase,
    base: request.base,
  });
}

interface RepositoryCreation {
  readonly name: string;
  readonly locator: string;
  readonly fingerprint: string;
  readonly requestedBase: string | null;
  readonly base: string | undefined;
}

/**
 * What a compatible reuse re-establishes about a repository's checkout.
 *
 * Five facts, and each of them is something an edited or replaced directory
 * would fail: it is a canonical checkout at exactly this path, it belongs to
 * the common directory recorded for it, it names its objects the same way, its
 * `origin` still names the recorded locator, and the commit it was created at
 * is still present. None of it is about where HEAD is now.
 */
function* verifyRepository(
  git: GitSession,
  checkout: string,
  metadata: ManagedRepositoryMetadata,
  name: string,
): Operation<{ commonDirectory: string; objectFormat: GitObjectFormat }> {
  const expected = yield* canonical(checkout);
  const facts = expected === undefined ? undefined : yield* readCheckoutFacts(git, checkout);
  if (expected === undefined || facts === undefined) {
    unusable(
      `the managed checkout for repository ${JSON.stringify(name)} is no longer a readable Git ` +
        "checkout. Nothing was changed; move it aside or ask for a different name.",
    );
  }
  if (facts.root !== expected || facts.commonDirectory !== metadata.commonDirectory) {
    conflict(
      "incompatible-reuse",
      `the managed checkout for repository ${JSON.stringify(name)} belongs to a different Git ` +
        "repository than the one recorded for it. Nothing was changed.",
    );
  }
  if (facts.objectFormat !== metadata.objectFormat) {
    conflict(
      "incompatible-reuse",
      `the managed checkout for repository ${JSON.stringify(name)} names its objects with a ` +
        "different algorithm than the one recorded for it. Nothing was changed.",
    );
  }
  if ((yield* originLocator(git, checkout)) !== metadata.locator) {
    conflict(
      "incompatible-reuse",
      `the managed checkout for repository ${JSON.stringify(name)} no longer has the origin it ` +
        "was cloned from. Nothing was changed.",
    );
  }
  if ((yield* resolveCommit(git, checkout, metadata.creationCommit)) === undefined) {
    conflict(
      "incompatible-reuse",
      `the managed checkout for repository ${JSON.stringify(name)} no longer holds the commit it ` +
        "was created at. Nothing was fetched or repaired.",
    );
  }
  return { commonDirectory: facts.commonDirectory, objectFormat: facts.objectFormat };
}

/**
 * Adopt an interrupted repository creation, or refuse and change nothing.
 *
 * The proof is stricter than a reuse's, because there is no record to compare
 * against: the checkout has to still be in exactly the state creation would
 * have left it in — nothing but the checkout in the slot, the recorded origin,
 * the branch and commit this request resolves to, and HEAD still on them.
 */
function* adoptRepository(
  git: GitSession,
  slot: string,
  checkout: string,
  creation: RepositoryCreation,
): Operation<ManagedRepositoryMetadata> {
  function refuse(): never {
    conflict(
      "partial-creation",
      `the managed checkout for repository ${JSON.stringify(creation.name)} holds an interrupted ` +
        "creation this version cannot account for. Every byte was left where it was: look at it, " +
        "or ask for a different name.",
    );
  }

  if (!(yield* slotHoldsOnlyCheckout(slot))) {
    refuse();
  }
  const expected = yield* canonical(checkout);
  const facts = expected === undefined ? undefined : yield* readCheckoutFacts(git, checkout);
  if (expected === undefined || facts === undefined || facts.root !== expected) {
    refuse();
  }
  if ((yield* originLocator(git, checkout)) !== creation.locator) {
    refuse();
  }
  const start = yield* resolveRepositoryStart(git, checkout, creation.base);
  if (start.commit !== facts.head) {
    refuse();
  }
  if ((yield* currentBranch(git, checkout)) !== start.primaryBranch) {
    refuse();
  }

  const metadata: ManagedRepositoryMetadata = Object.freeze({
    kind: "repository" as const,
    version: METADATA_VERSION,
    name: creation.name,
    locator: creation.locator,
    locatorFingerprint: creation.fingerprint,
    requestedBase: creation.requestedBase,
    creationCommit: start.commit,
    primaryBranch: start.primaryBranch,
    objectFormat: facts.objectFormat,
    commonDirectory: facts.commonDirectory,
  });
  yield* writeMetadata(slot, metadata);
  return metadata;
}

function* createManagedRepository(
  git: GitSession,
  host: RepositoryHost,
  slot: string,
  checkout: string,
  creation: RepositoryCreation,
): Operation<ManagedRepository> {
  yield* ensureDir(slot);
  // One session for this clone, opened after the locator was admitted and
  // released with the scope this operation runs in.
  const session = yield* useGitAuthentication(host, creation.locator);
  yield* clone(git, creation.locator, checkout, slot, session);
  const start = yield* resolveRepositoryStart(git, checkout, creation.base);
  yield* checkoutPrimary(git, checkout, start);
  const format = yield* readFormat(git, checkout);
  const common = yield* commonDirectory(git, checkout);
  const commonCanonical = common === undefined ? undefined : yield* canonical(common);
  if (commonCanonical === undefined) {
    unusable(
      `the checkout just cloned for repository ${JSON.stringify(creation.name)} does not report ` +
        "the Git directory it belongs to.",
    );
  }

  const metadata: ManagedRepositoryMetadata = Object.freeze({
    kind: "repository" as const,
    version: METADATA_VERSION,
    name: creation.name,
    locator: creation.locator,
    locatorFingerprint: creation.fingerprint,
    requestedBase: creation.requestedBase,
    creationCommit: start.commit,
    primaryBranch: start.primaryBranch,
    objectFormat: format,
    commonDirectory: commonCanonical,
  });
  // After the checkout is complete and verified, never before: a sidecar that
  // existed beside a half-made checkout would make the next execution reuse it.
  yield* writeMetadata(slot, metadata);
  return {
    checkout,
    commonDirectory: commonCanonical,
    objectFormat: format,
    creationCommit: start.commit,
    metadata,
  };
}

/** What a Worktree selection asks for, once its owner is known. */
export interface WorktreeCreation {
  readonly name: string;
  readonly branch: string;
  readonly base: string | undefined;
  /** The canonical common Git directory of the repository it belongs to. */
  readonly owner: string;
  /** A checkout of that repository, which is where `worktree add` runs. */
  readonly ownerCheckout: string;
}

export function* selectManagedWorktree(
  git: GitSession,
  slot: string,
  creation: WorktreeCreation,
): Operation<ManagedWorktree> {
  const checkout = checkoutOf(slot);
  const requestedBase = creation.base ?? null;

  const stored = yield* readMetadata(slot);
  if (stored !== undefined) {
    const metadata = parseWorktreeMetadata(stored);
    if (metadata === undefined) {
      conflict(
        "incompatible-reuse",
        `the managed checkout for worktree ${JSON.stringify(creation.name)} carries a ` +
          `${METADATA} this version cannot read. Nothing was changed.`,
      );
    }
    if (
      metadata.name !== creation.name ||
      metadata.owner !== creation.owner ||
      metadata.requestedBranch !== creation.branch ||
      metadata.requestedBase !== requestedBase
    ) {
      conflict(
        "incompatible-reuse",
        `the managed checkout for worktree ${JSON.stringify(creation.name)} was created for a ` +
          "different repository, branch or base than this invocation asks for. Nothing was " +
          "reset or replaced; ask for a different name to get a worktree of your own.",
      );
    }
    const facts = yield* verifyWorktree(git, checkout, metadata, creation.name);
    return { checkout, ...facts, creationCommit: metadata.creationCommit, metadata };
  }

  if (yield* exists(checkout)) {
    const metadata = yield* adoptWorktree(git, slot, checkout, creation);
    const facts = yield* verifyWorktree(git, checkout, metadata, creation.name);
    return { checkout, ...facts, creationCommit: metadata.creationCommit, metadata };
  }

  return yield* createManagedWorktree(git, slot, checkout, creation);
}

/**
 * What a compatible reuse re-establishes about a worktree's checkout.
 *
 * The owner relationship is the one that matters and the one a plain "is this a
 * checkout" question cannot see: a linked worktree's common directory is the
 * repository it belongs to, so comparing it is what proves this checkout is
 * still a worktree *of that repository* rather than an unrelated clone left at
 * the same path.
 */
function* verifyWorktree(
  git: GitSession,
  checkout: string,
  metadata: ManagedWorktreeMetadata,
  name: string,
): Operation<{ commonDirectory: string; objectFormat: GitObjectFormat }> {
  const expected = yield* canonical(checkout);
  const facts = expected === undefined ? undefined : yield* readCheckoutFacts(git, checkout);
  if (expected === undefined || facts === undefined) {
    unusable(
      `the managed checkout for worktree ${JSON.stringify(name)} is no longer a readable Git ` +
        "checkout. Nothing was changed.",
    );
  }
  if (facts.root !== expected || facts.commonDirectory !== metadata.owner) {
    conflict(
      "incompatible-reuse",
      `the managed checkout for worktree ${JSON.stringify(name)} is no longer a linked checkout ` +
        "of the repository it belongs to. Nothing was changed.",
    );
  }
  if (facts.objectFormat !== metadata.objectFormat) {
    conflict(
      "incompatible-reuse",
      `the managed checkout for worktree ${JSON.stringify(name)} names its objects with a ` +
        "different algorithm than the one recorded for it. Nothing was changed.",
    );
  }
  if ((yield* resolveCommit(git, checkout, metadata.creationCommit)) === undefined) {
    conflict(
      "incompatible-reuse",
      `the managed checkout for worktree ${JSON.stringify(name)} no longer holds the commit it ` +
        "was created at. Nothing was fetched or repaired.",
    );
  }
  return { commonDirectory: facts.commonDirectory, objectFormat: facts.objectFormat };
}

function* adoptWorktree(
  git: GitSession,
  slot: string,
  checkout: string,
  creation: WorktreeCreation,
): Operation<ManagedWorktreeMetadata> {
  function refuse(): never {
    conflict(
      "partial-creation",
      `the managed checkout for worktree ${JSON.stringify(creation.name)} holds an interrupted ` +
        "creation this version cannot account for. Every byte was left where it was.",
    );
  }

  if (!(yield* slotHoldsOnlyCheckout(slot))) {
    refuse();
  }
  const expected = yield* canonical(checkout);
  const facts = expected === undefined ? undefined : yield* readCheckoutFacts(git, checkout);
  if (expected === undefined || facts === undefined || facts.root !== expected) {
    refuse();
  }
  // Registration as a linked worktree of exactly this repository, which is what
  // makes an unrelated clone at the same path fail rather than be adopted.
  if (facts.commonDirectory !== creation.owner) {
    refuse();
  }
  if ((yield* currentBranch(git, checkout)) !== creation.branch) {
    refuse();
  }
  const start = yield* worktreeStart(git, creation);
  if (start === undefined || start !== facts.head) {
    refuse();
  }

  const metadata: ManagedWorktreeMetadata = Object.freeze({
    kind: "worktree" as const,
    version: METADATA_VERSION,
    owner: creation.owner,
    name: creation.name,
    requestedBranch: creation.branch,
    requestedBase: creation.base ?? null,
    creationCommit: start,
    objectFormat: facts.objectFormat,
  });
  yield* writeMetadata(slot, metadata);
  return metadata;
}

/**
 * The commit an adoption expects this worktree to have started at.
 *
 * The branch is the answer when it already exists — `worktree add <path>
 * <branch>` checks it out where it is — and the base, or the owner checkout's
 * own commit, when it had to be created.
 */
function* worktreeStart(
  git: GitSession,
  creation: WorktreeCreation,
): Operation<string | undefined> {
  if (yield* branchExists(git, creation.ownerCheckout, creation.branch)) {
    return yield* resolveCommit(git, creation.ownerCheckout, `refs/heads/${creation.branch}`);
  }
  return creation.base === undefined
    ? yield* resolveCommit(git, creation.ownerCheckout, "HEAD")
    : yield* resolveBaseCommit(git, creation.ownerCheckout, creation.base);
}

function* createManagedWorktree(
  git: GitSession,
  slot: string,
  checkout: string,
  creation: WorktreeCreation,
): Operation<ManagedWorktree> {
  yield* ensureDir(slot);
  const added = yield* addWorktree(
    git,
    creation.ownerCheckout,
    checkout,
    creation.branch,
    creation.base,
  );
  const facts = yield* readCheckoutFacts(git, checkout);
  if (facts === undefined || facts.commonDirectory !== creation.owner) {
    unusable(
      `the worktree just created for ${JSON.stringify(creation.name)} does not report the ` +
        "repository it belongs to.",
    );
  }

  const metadata: ManagedWorktreeMetadata = Object.freeze({
    kind: "worktree" as const,
    version: METADATA_VERSION,
    owner: creation.owner,
    name: creation.name,
    requestedBranch: creation.branch,
    requestedBase: creation.base ?? null,
    creationCommit: added.commit,
    objectFormat: facts.objectFormat,
  });
  yield* writeMetadata(slot, metadata);
  return {
    checkout,
    commonDirectory: facts.commonDirectory,
    objectFormat: facts.objectFormat,
    creationCommit: added.commit,
    metadata,
  };
}

/** The refusal a Worktree request reports when native Git refuses it. */
export function worktreeRefusal(name: string, reason: string): never {
  worktreeRefused(name, reason);
}
