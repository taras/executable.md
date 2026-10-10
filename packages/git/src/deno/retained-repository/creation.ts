/**
 * What a Repository or Worktree creation freezes before it creates anything.
 *
 * A creation changes persistent state, so it is fenced like every other
 * mutation: the complete request is decided and acknowledged before a slot is
 * made, a clone runs, a worktree is added, shared refs move or managed metadata
 * is written. The state it starts from is not a checkout — there is nothing
 * there — so the intent records absence, and what makes that recoverable is the
 * rest of what it freezes: the trusted slot, the metadata that will identify
 * the destination, the pinned commit it will start at, and the exact state it
 * will be in when it is done.
 *
 * The destination is worked out in isolated scratch, by doing to a disposable
 * directory exactly what the real creation will do to the slot. Its inventory
 * is then mapped onto the placement the real one will have: the scratch is
 * about to cease to exist, and the prediction is about the slot.
 *
 * A moving base is resolved once, here. A retry reads the commit back out of
 * the intent, because resolving `main` again a minute later can mean a
 * different commit and would be a different creation.
 */

import { Err, Ok, until } from "effection";
import type { Operation, Result } from "effection";
import { basename, join } from "node:path";
import { realpath } from "node:fs/promises";
import type { Json } from "@executablemd/durable-streams";
import {
  checkoutPrimary,
  clone,
  gitSession,
  resolveRepositoryStart,
  addWorktree,
  objectFormat,
} from "../composition/git.ts";
import type { GitSession } from "../composition/git.ts";
import { useGitAuthentication } from "../composition/host.ts";
import type { RepositoryHost } from "../composition/host.ts";
import { admitLocator, locatorFingerprint } from "../composition/locator.ts";
import { METADATA_VERSION } from "../../composition/managed-metadata.ts";
import type {
  ManagedRepositoryMetadata,
  ManagedWorktreeMetadata,
} from "../../composition/managed-metadata.ts";
import { checkoutOf } from "../run-composition/placement.ts";
import { inventoryFrontier } from "./frontier.ts";
import { copyTree } from "./scratch.ts";
import { retainedFrontierJson } from "../../retained-repository/records.ts";
import type { RetainedFrontier } from "../../retained-repository/records.ts";

/** What one creation freezes: where it goes, what it will be, and its state. */
export interface PredictedCreation {
  readonly postState: RetainedFrontier;
  readonly prepared: Json;
  readonly evidence: Json;
}

/**
 * The repository this request would clone, predicted in scratch.
 *
 * The same sequence the real creation runs — clone, resolve the start, check
 * the primary branch out — against a directory that is thrown away. What comes
 * back describes the slot, with the administration the real checkout will have.
 */
export function* predictRepositoryCreation(
  host: RepositoryHost,
  slot: string,
  request: { readonly name: string; readonly locator: string; readonly base: string | undefined },
): Operation<Result<PredictedCreation>> {
  const locator = admitLocator(request.locator);
  if (locator === undefined) {
    return Err(new Error(`<Repository> was given a url this host will not clone: invalid-locator`));
  }
  const root = yield* host.useDirectory();
  const scratch = join(root, "checkout");
  const git = gitSession(host, root);
  const session = yield* useGitAuthentication(host, locator);
  yield* clone(git, locator, scratch, root, session);
  const start = yield* resolveRepositoryStart(git, scratch, request.base);
  yield* checkoutPrimary(git, scratch, start);
  const format = yield* objectFormat(git, scratch);

  const checkout = checkoutOf(slot);
  const common = join(checkout, ".git");
  const predicted = yield* inventoryFrontier({ git, checkout, directory: scratch });
  if (!predicted.ok) {
    return predicted;
  }
  const metadata: ManagedRepositoryMetadata = Object.freeze({
    kind: "repository" as const,
    version: METADATA_VERSION,
    name: request.name,
    locator,
    locatorFingerprint: locatorFingerprint(locator),
    requestedBase: request.base ?? null,
    creationCommit: start.commit,
    primaryBranch: start.primaryBranch,
    objectFormat: format,
    commonDirectory: common,
  });
  return Ok({
    postState: placed(predicted.value, checkout, {
      common,
      worktree: null,
      role: "primary",
    }),
    prepared: { slot, metadata: metadataJson(metadata), owner: null },
    evidence: { type: "repository", checkout, commit: start.commit },
  });
}

/**
 * The worktree this request would add, predicted in scratch, with what it does
 * to its owner.
 *
 * Adding a worktree advances refs the owner shares, so the owner is copied too
 * and both of its states are frozen: the one the creation expects to find and
 * the one it will leave. Predicting against the real owner would move the very
 * refs the intent is about to claim it found.
 */
export function* predictWorktreeCreation(
  host: RepositoryHost,
  slot: string,
  owner: { readonly checkout: string; readonly directory: string; readonly common: string },
  request: { readonly name: string; readonly branch: string; readonly base: string | undefined },
): Operation<
  Result<
    PredictedCreation & {
      readonly owner: { preState: RetainedFrontier; postState: RetainedFrontier };
    }
  >
> {
  const root = yield* host.useDirectory();
  const git = gitSession(host, root);
  const ownerScratch = join(root, "owner");
  yield* copyTree(owner.directory, ownerScratch);
  const before = yield* inventoryFrontier({
    git,
    checkout: owner.checkout,
    directory: ownerScratch,
  });
  if (!before.ok) {
    return before;
  }
  const checkout = checkoutOf(slot);
  // Added at a directory with the real destination's own name, because Git
  // derives the administrative directory beneath `worktrees/` from that name —
  // and the copied owner carries the same existing entries, so it resolves any
  // collision exactly as the real one will.
  const scratch = join(root, basename(checkout));
  const added = yield* addWorktree(git, ownerScratch, scratch, request.branch, request.base);
  const worktreeAdministration = join(owner.common, "worktrees", added.slot);
  const predicted = yield* inventoryFrontier({ git, checkout, directory: scratch });
  if (!predicted.ok) {
    return predicted;
  }
  const after = yield* inventoryFrontier({
    git,
    checkout: owner.checkout,
    directory: ownerScratch,
  });
  if (!after.ok) {
    return after;
  }
  const format = yield* objectFormat(git, scratch);
  const metadata: ManagedWorktreeMetadata = Object.freeze({
    kind: "worktree" as const,
    version: METADATA_VERSION,
    name: request.name,
    owner: owner.common,
    requestedBranch: request.branch,
    requestedBase: request.base ?? null,
    creationCommit: added.commit,
    objectFormat: format,
  });
  const ownerStates = {
    preState: placed(before.value, owner.checkout, {
      common: owner.common,
      worktree: null,
      role: "primary",
    }),
    postState: placed(after.value, owner.checkout, {
      common: owner.common,
      worktree: null,
      role: "primary",
    }),
  };
  return Ok({
    postState: placed(predicted.value, checkout, {
      common: owner.common,
      worktree: worktreeAdministration,
      role: "linked",
    }),
    prepared: {
      slot,
      metadata: metadataJson(metadata),
      owner: {
        preState: frontierJsonOf(ownerStates.preState),
        postState: frontierJsonOf(ownerStates.postState),
      },
    },
    evidence: { type: "worktree", checkout, commit: added.commit },
    owner: ownerStates,
  });
}

/** The real path this directory's state will be at, with its real Git layout. */
function placed(
  predicted: RetainedFrontier,
  checkout: string,
  administration: { common: string; worktree: string | null; role: "primary" | "linked" },
): RetainedFrontier {
  return Object.freeze({
    checkout,
    administration: Object.freeze(administration),
    objectFormat: predicted.objectFormat,
    head: predicted.head,
    refs: predicted.refs,
    index: predicted.index,
    worktree: predicted.worktree,
  });
}

/** This directory's real path, or the one given when it cannot be resolved. */
export function* canonicalPath(directory: string): Operation<string> {
  try {
    return yield* until(realpath(directory));
  } catch {
    return directory;
  }
}

function metadataJson(metadata: ManagedRepositoryMetadata | ManagedWorktreeMetadata): Json {
  return { ...metadata };
}

function frontierJsonOf(frontier: RetainedFrontier): Json {
  return retainedFrontierJson(frontier);
}
