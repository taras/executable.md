/**
 * What one REPL entry's `<Git.Push />` asked to publish, on the wire.
 *
 * An entry that publishes a branch writes this down *before* a remote is
 * contacted, and the external outcome is reconciled afterwards under the shared
 * Git-host contract. Those are two records: this one says what was asked, and
 * the Git-host record beside it says what the host did about it. Reopen the
 * entry and the saved request is what the next attempt reconciles — the branch
 * and the commit it originally named, however far HEAD has moved since.
 *
 * It is a request publication and nothing else. A record here is not evidence
 * that anything was published: an entry interrupted between this append and the
 * remote leaves exactly this record and no outcome, which is the window the
 * reconciliation exists to close.
 *
 * ## Three readings of one place
 *
 * `requested` is what the invocation observed: the Repository identity it
 * authenticated, the checkout that selection named, its common Git directory
 * and the working directory exactly as it arrived. `received` is the same four
 * as they stood when the live dispatch reached this provider, so an intentional
 * middleware transformation is visible rather than hidden — when nothing
 * transformed them the two readings are equal and both are still written.
 * `resolved` is the answer: the covering checkout, its common directory, the
 * admitted credential-free origin and the complete Push inputs.
 *
 * Only `requested` names the record. A replay matches the question, not the
 * answer, so `received` and `resolved` are read back and held to each other
 * rather than re-resolved: resolving them again would ask today's filesystem
 * what a saved request meant.
 *
 * ## What is deliberately absent
 *
 * No opaque selection identifier, no source object, no token, no Git output, no
 * HEAD inventory and no publication flag. A selection identifier names nothing
 * once the entry ends; everything else is either a secret, a snapshot this
 * feature does not take, or an assertion this record is not entitled to make.
 *
 * Host paths are kept as the bytes they arrived as. The Workflow codecs
 * normalize a logical Workspace path because a Workspace owns its own layout;
 * an entry's paths are places on somebody's disk, and rewriting one would make
 * a saved request name a different directory than the one that was asked for.
 */

import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import { members, text } from "../composition/parse.ts";
import { admitLocator } from "../composition/locator.ts";
import {
  gitPushInputsJson,
  parseGitPushInputs,
  type GitPushInputs,
} from "../composition/git-push-records.ts";
import {
  parseRepositoryIdentity,
  repositoryIdentityJson,
  sameRepositoryIdentity,
  type RepositoryIdentity,
} from "../composition/selection.ts";
import { digest, REPL_REPOSITORY_VERSION } from "./records.ts";

/** The durable type one entry Push request is published under. */
export const REPL_REPOSITORY_PUSH_REQUEST = "repl_repository_push_request";

/** The prefix the request's own name is built from. */
const PUSH_REQUEST_PREFIX = "executablemd.repl.push-request";

/**
 * Where one Push was asked for, as one reading of it.
 *
 * The same four facts the local Git records carry, and for the same reason: a
 * Push belongs to the Repository the invocation authenticated, to the checkout
 * that selection named, to the repository that checkout shares, and to the
 * directory the element was written in.
 */
export interface ReplPushPlace {
  /** All six members of the authenticated Repository identity. */
  readonly repository: RepositoryIdentity;
  /** The checkout root the authenticated selection named. */
  readonly selectionCheckout: string;
  /** That selection's canonical common Git directory. */
  readonly commonDirectory: string;
  /** The working directory exactly as it was received, uncanonicalized. */
  readonly workingDirectory: string;
}

/** What routing answered, and the complete request it produced. */
export interface ReplPushResolution {
  /** The checkout actually covering the received working directory. */
  readonly checkoutRoot: string;
  /** That checkout's canonical common Git directory. */
  readonly commonDirectory: string;
  /** The admitted credential-free locator this branch is published to. */
  readonly origin: string;
  /** The complete inputs the Git-host effect acts on. */
  readonly inputs: GitPushInputs;
}

/** One entry Push request, as a continuation reads it back. */
export interface ReplPushRequestRecord {
  readonly version: typeof REPL_REPOSITORY_VERSION;
  /** The entry whose retained work this is. */
  readonly owner: string;
  /** The invocation inside that entry, as canonical core minted it. */
  readonly site: string;
  readonly requested: ReplPushPlace;
  readonly received: ReplPushPlace;
  readonly resolved: ReplPushResolution;
}

/** What names one request: the owner, the site and the question it asked. */
export interface ReplPushRequestName {
  readonly owner: string;
  readonly site: string;
  readonly requested: ReplPushPlace;
}

const RECORD_MEMBERS = ["version", "owner", "site", "requested", "received", "resolved"] as const;

const PLACE_MEMBERS = [
  "repository",
  "selectionCheckout",
  "commonDirectory",
  "workingDirectory",
] as const;

const RESOLUTION_MEMBERS = ["checkoutRoot", "commonDirectory", "origin", "inputs"] as const;

/**
 * The stable name one Push request is published under.
 *
 * A digest of the version, the owner, the site and every member of the
 * question. Two equal questions at two positions produce one name, which is
 * allowed: telling them apart is the durable engine's own positional matching,
 * and nothing here searches history by name.
 *
 * The answer takes no part in it. A name derived from what routing resolved
 * would have to be recomputed to find the record — which means resolving a
 * saved request again, against a filesystem that has since moved.
 */
export function replPushRequestName(request: ReplPushRequestName): Operation<string> {
  return digest([
    PUSH_REQUEST_PREFIX,
    REPL_REPOSITORY_VERSION,
    request.owner,
    request.site,
    replPushPlaceJson(request.requested),
  ]);
}

/** The payload one published Push request carries. */
export function replPushRequestJson(record: {
  readonly owner: string;
  readonly site: string;
  readonly requested: ReplPushPlace;
  readonly received: ReplPushPlace;
  readonly resolved: ReplPushResolution;
}): Json {
  return {
    version: REPL_REPOSITORY_VERSION,
    owner: record.owner,
    site: record.site,
    requested: replPushPlaceJson(record.requested),
    received: replPushPlaceJson(record.received),
    resolved: {
      checkoutRoot: record.resolved.checkoutRoot,
      commonDirectory: record.resolved.commonDirectory,
      origin: record.resolved.origin,
      inputs: gitPushInputsJson(record.resolved.inputs),
    },
  };
}

/**
 * The Push request this saved value describes, or `undefined`.
 *
 * Total, and exact about every member. Beyond the shape it refuses a request
 * whose origin is not a locator this host would hand to Git, whose origin does
 * not name the Repository the inputs name, and whose resolved inputs belong to
 * a Repository other than the one the live dispatch received. Each of those
 * would make a saved request name work this entry cannot account for.
 *
 * Whether the saved roots are places this entry holds is not asked here. That
 * is a question about parsed placements and about this entry's own registry,
 * and it is answered by the admission and the readback beside this codec.
 */
export function parseReplPushRequestRecord(value: unknown): ReplPushRequestRecord | undefined {
  // Totally: enumeration and every property read are the value's own to
  // refuse, and a refusal of any of them is the same answer. A revoked proxy
  // and a throwing getter both mean this value describes no saved request, and
  // answering that is what keeps an untrusted value from carrying its own text
  // out through an exception.
  try {
    return readRequestRecord(value);
  } catch {
    return undefined;
  }
}

function readRequestRecord(value: unknown): ReplPushRequestRecord | undefined {
  const read = members(value, RECORD_MEMBERS);
  if (read === undefined || read["version"] !== REPL_REPOSITORY_VERSION) {
    return undefined;
  }
  const owner = text(read["owner"]);
  const site = text(read["site"]);
  const requested = parseReplPushPlace(read["requested"]);
  const received = parseReplPushPlace(read["received"]);
  if (
    owner === undefined ||
    site === undefined ||
    requested === undefined ||
    received === undefined
  ) {
    return undefined;
  }
  const resolved = parseResolution(read["resolved"], received);
  if (resolved === undefined) {
    return undefined;
  }
  return Object.freeze({
    version: REPL_REPOSITORY_VERSION,
    owner,
    site,
    requested,
    received,
    resolved,
  });
}

/**
 * One reading of where a Push was asked for, or `undefined`.
 *
 * Shared with the pull-request request codec beside this one: a pull request is
 * asked for at the same four facts, and two implementations of one place would
 * be two answers to where an entry's external work was asked for.
 */
export function parseReplPushPlace(value: unknown): ReplPushPlace | undefined {
  const read = members(value, PLACE_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const repository = parseRepositoryIdentity(read["repository"]);
  const selectionCheckout = text(read["selectionCheckout"]);
  const commonDirectory = text(read["commonDirectory"]);
  const workingDirectory = text(read["workingDirectory"]);
  if (
    repository === undefined ||
    selectionCheckout === undefined ||
    commonDirectory === undefined ||
    workingDirectory === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ repository, selectionCheckout, commonDirectory, workingDirectory });
}

/**
 * What routing resolved, held to the reading it resolved from.
 *
 * The origin is admitted through the same closed grammar a document's locator
 * passes, so a saved origin this host would not hand to Git is refused here.
 * Whether an admitted one is the origin the Repository identity was
 * fingerprinted from is the other half of that question, and the digest it
 * needs belongs to the runtime-named half of this package: the provider asks it
 * of every record it reads back, before the record may be reconciled. `remote`
 * stays the literal label `origin` and the destination stays the branch's own
 * ref, both of which the shared Push parser decides.
 */
function parseResolution(value: unknown, received: ReplPushPlace): ReplPushResolution | undefined {
  const read = members(value, RESOLUTION_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const checkoutRoot = text(read["checkoutRoot"]);
  const commonDirectory = text(read["commonDirectory"]);
  const origin = text(read["origin"]);
  const inputs = parseGitPushInputs(read["inputs"]);
  if (
    checkoutRoot === undefined ||
    commonDirectory === undefined ||
    origin === undefined ||
    inputs === undefined
  ) {
    return undefined;
  }
  if (admitLocator(origin) !== origin) {
    return undefined;
  }
  if (!sameRepositoryIdentity(inputs.repository, received.repository)) {
    return undefined;
  }
  return Object.freeze({ checkoutRoot, commonDirectory, origin, inputs });
}

/** The payload one reading of an entry's external-work place carries. */
export function replPushPlaceJson(place: ReplPushPlace): Json {
  return {
    repository: repositoryIdentityJson(place.repository),
    selectionCheckout: place.selectionCheckout,
    commonDirectory: place.commonDirectory,
    workingDirectory: place.workingDirectory,
  };
}

/** Whether two readings of one Push's place describe the same place. */
export function sameReplPushPlace(left: ReplPushPlace, right: ReplPushPlace): boolean {
  return canonicalJson(replPushPlaceJson(left)) === canonicalJson(replPushPlaceJson(right));
}
