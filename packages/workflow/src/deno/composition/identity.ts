/**
 * Holding a retained record to the identity that names it.
 *
 * Placement is a function of identity — a name decides a slot, a slot decides a
 * path — so a retained path is checkable rather than merely plausible. None of
 * it is this provider's word by the time it is read back: a column is whatever
 * the database holds, and every disagreement found here is stale retained state
 * rather than a refusal, because the document did not ask for it and could not
 * have avoided it.
 */
import { RepositoryStaleStateError } from "../../composition/errors.ts";
import type { RepositoryRecord, WorktreeRecord } from "../../composition/records.ts";
import type { StoredRepository } from "../workspace/repositories.ts";
import { admitLocator, locatorFingerprint } from "./locator.ts";
import { repositoryCheckoutPath, worktreeCheckoutPath } from "./placement.ts";

/**
 * What attachment found, when what it found is not what the record says.
 *
 * A word rather than a sentence, so the fatal failure the caller raises names
 * the disagreement without quoting a path or anything Git printed.
 */
export type StaleReason =
  | "metadata"
  | "checkout"
  | "administration"
  | "repository"
  | "placement"
  | "locator"
  | "origin"
  | "object-format"
  | "creation-commit"
  | "linkage";

const STALE_SENTENCES: ReadonlyMap<StaleReason, string> = new Map([
  ["metadata", "the retained record naming it is gone or names something else"],
  ["checkout", "the Workspace no longer holds a checkout at the path it recorded"],
  ["administration", "what the Workspace holds there is no longer a readable Git checkout"],
  ["repository", "the repository it belongs to is no longer retained"],
  ["placement", "the path it recorded is not the one this run's placement gives its identity"],
  ["locator", "the url retained for it is not the one its identity names"],
  ["origin", "the checkout it holds came from a different repository"],
  ["object-format", "the checkout it holds names its objects with a different algorithm"],
  ["creation-commit", "the commit it was created at is not in the checkout it holds"],
  ["linkage", "the checkout it holds is not a worktree of the repository it belongs to"],
]);

export function stale(subject: string, reason: StaleReason): RepositoryStaleStateError {
  return new RepositoryStaleStateError(subject, STALE_SENTENCES.get(reason) ?? "it disagrees");
}

/**
 * The retained record, once it still agrees with the identity that names it.
 *
 * Placement is a function of identity: a name decides a slot, and the slot
 * decides the path. So a retained path is checkable rather than merely
 * plausible — recomputing it from the record's own name and comparing the whole
 * string is the difference between "this looks like a Workspace path" and "this
 * is the path this run gives this identity".
 *
 * It matters because the retained path is not this provider's word by the time
 * it is read back. It is a column, and a column is whatever the database holds:
 * an edited row naming `/../../etc` would otherwise be joined to a host root and
 * followed out of the run's own tree. Checking here means the disagreement is
 * found before Git runs, before a child begins, and before anything is written.
 *
 * A disagreement is stale-state rather than a refusal, and deliberately so. The
 * document did not ask for this and could not have avoided it; retained state
 * says something this run cannot have written, and nothing repairs that.
 */
export function agreedRepository(record: RepositoryRecord, subject: string): RepositoryRecord {
  if (record.checkoutPath !== repositoryCheckoutPath(record.name)) {
    throw stale(subject, "placement");
  }
  return record;
}

/**
 * The locator retained for a Repository, once it is still the one it names.
 *
 * Two things are checked and they are different. The bytes must still be
 * admissible — a stored locator that this provider would refuse today is not one
 * it may hand to Git tomorrow, whatever it was when it was written. And the
 * fingerprint the record carries must be the fingerprint of exactly those bytes:
 * the fingerprint is the identity every comparison uses, so a locator edited
 * underneath it would otherwise reuse, replay and attach under a name that no
 * longer describes it.
 */
export function agreedLocator(stored: StoredRepository, subject: string): string {
  if (admitLocator(stored.locator) !== stored.locator) {
    throw stale(subject, "locator");
  }
  if (locatorFingerprint(stored.locator) !== stored.record.locatorFingerprint) {
    throw stale(subject, "locator");
  }
  return stored.locator;
}

/** A retained Repository row, once its path and its locator both still agree. */
export function agreedStored(stored: StoredRepository, subject: string): StoredRepository {
  agreedRepository(stored.record, subject);
  agreedLocator(stored, subject);
  return stored;
}

export function repositorySubject(name: string): string {
  return `repository ${JSON.stringify(name)}`;
}

/**
 * A materialized checkout, and what it has to turn out to be.
 *
 * `repositoryDirectory` is where the Repository this checkout belongs to was
 * materialized — for a primary checkout, itself — and `repository` is that
 * Repository's retained record. Both travel with the directory because
 * verification is a comparison, and neither half of it can be read off the host
 * tree alone.
 */
export interface Attached {
  readonly directory: string;
  readonly repositoryDirectory: string;
  readonly repository: RepositoryRecord;
}
