/**
 * Proving that *this entry* published the branch its pull request names.
 *
 * `../composition/push-evidence.ts` answers the same question for an ordinary
 * run by scanning that run's Git-host results. An entry cannot use it. A run's
 * events are one run's; an entry's segment is reopened hours later beside other
 * entries, and what has to be proven is narrower: not "a push of this branch is
 * recorded somewhere", but "this entry asked for that publication, this entry's
 * own request was answered by its own acknowledged receipt, and this execution
 * has actually reached it".
 *
 * Each of those words excludes something. A bare receipt with no saved request
 * before it is not this entry's publication. A request with no receipt published
 * nothing yet. A receipt belonging to another entry's segment, a synthetic
 * `Git.push` answer a handler returned, a local `<Git.Commit>` result and a
 * pull-request receipt are all records that are not publications of this
 * branch — so none of them appears here at all. The admission beside this
 * module is what proves the pair; this module is what remembers the proven ones
 * and decides which of them a pull request may rest on.
 *
 * ## Reached, not merely present
 *
 * The admitted snapshot holds every publication this entry ever acknowledged,
 * including ones standing *after* the position execution is currently at. Those
 * are not usable. A document whose pull request is written before its second
 * publication must not be authorized by that second publication merely because
 * a previous session got further than this one has. So the snapshot establishes
 * the ordered facts, and each becomes usable only when execution reaches it —
 * live, or by restoring its receipt.
 *
 * ## Durable order, not arrival order
 *
 * Which publication decides is the *last* one to a destination, because a branch
 * holds whatever was published to it last. That order is the order the journal
 * acknowledged them in, and it is fixed. Replay does not have to revisit two
 * concurrent children in the order they first ran, so arrival order here can be
 * reversed from the durable one — and ordering by arrival would let a replayed
 * history authorize a head the entry had already published past. Every fact
 * therefore carries the rank the snapshot gave it, and a new live publication
 * ranks after all of them.
 */

import { destinationRefFor } from "../composition/git-push-records.ts";
import { PullRequestAdmissionError } from "../composition/errors.ts";
import type { PullRequestInputs } from "../composition/pull-request-records.ts";
import { sameRepositoryIdentity, type RepositoryIdentity } from "../composition/selection.ts";

/**
 * One publication this entry acknowledged, as a later pull request reads it.
 *
 * `site` is the invocation that asked for it, which is what identifies the same
 * publication across a reopen: the snapshot's facts and the receipt execution
 * restores are the same publication when they were asked for at the same
 * invocation.
 */
export interface ReplPublication {
  /** The invocation this publication was asked for at. */
  readonly site: string;
  readonly repository: RepositoryIdentity;
  /** The admitted credential-free locator the branch went to. */
  readonly origin: string;
  readonly branch: string;
  readonly destinationRef: string;
  /** The commit that was published, which is what a pull request's head must be. */
  readonly sourceCommit: string;
}

/** One acknowledged publication, with the durable order it was acknowledged in. */
export interface RankedReplPublication extends ReplPublication {
  /** Its position in this entry's durable acknowledgement order. */
  readonly rank: number;
}

/**
 * This entry's private memory of what it has published and actually reached.
 *
 * Created once per initialized entry and reachable only from this feature's own
 * closure. It is deliberately not an accessor, a registry or a handle: nothing
 * returns it to the CLI, puts it in Context, hands it to middleware or lets a
 * document, a prop or a public input name it.
 */
export interface ReplPublicationMemory {
  /** The ordered facts the admitted snapshot holds, none of them yet usable. */
  admitted(publications: readonly RankedReplPublication[]): void;
  /**
   * Record that execution has reached this publication, and remember it.
   *
   * One call covers both paths. A restored receipt names a publication the
   * snapshot already ranked, and that rank is kept. A live one is new, and
   * ranks after every publication the snapshot held.
   */
  reach(publication: ReplPublication): void;
  /**
   * Admit this pull request against the publications reached so far.
   *
   * Refuses rather than answers: the two closed words are the ones the ordinary
   * evidence scan uses, so one vocabulary describes both paths.
   */
  admit(inputs: PullRequestInputs, origin: string): void;
}

/** This entry's publication memory, empty until a snapshot is admitted. */
export function createReplPublicationMemory(): ReplPublicationMemory {
  /** The ordered facts the snapshot held, by the invocation that asked. */
  let snapshot: ReadonlyMap<string, RankedReplPublication> = new Map();
  /** The highest rank the snapshot used, which live work ranks after. */
  let ceiling = 0;
  /** How many live publications have been acknowledged since. */
  let live = 0;
  /** What execution has actually reached, usable and in durable order. */
  const reached = new Map<string, RankedReplPublication>();

  return {
    admitted(publications) {
      snapshot = new Map(publications.map((publication) => [publication.site, publication]));
      ceiling = publications.reduce((highest, one) => Math.max(highest, one.rank), 0);
    },

    reach(publication) {
      const ranked = snapshot.get(publication.site);
      reached.set(publication.site, {
        ...publication,
        // A publication the snapshot ranked keeps that rank however late
        // execution reaches it. One it never held is new work, and new work is
        // acknowledged after everything already in the journal.
        rank: ranked === undefined ? ceiling + ++live : ranked.rank,
      });
    },

    admit(inputs, origin) {
      const destinationRef = destinationRefFor(inputs.headBranch);
      const relevant = Array.from(reached.values())
        .filter(
          (publication) =>
            publication.destinationRef === destinationRef &&
            publication.branch === inputs.headBranch &&
            publication.origin === origin &&
            sameRepositoryIdentity(publication.repository, inputs.repository),
        )
        .sort((left, right) => left.rank - right.rank);
      const last = relevant.at(-1);
      if (last === undefined) {
        throw new PullRequestAdmissionError(
          "missing-push-evidence",
          "this entry holds no acknowledged <Git.Push /> of the branch and commit it would open " +
            "a pull request from. Write <Git.Push /> before <PullRequest>: a pull request names " +
            "work this entry published, and publishing it is an explicit act. Nothing was " +
            "contacted.",
        );
      }
      if (last.sourceCommit !== inputs.headSha) {
        throw new PullRequestAdmissionError(
          "conflicting-push-evidence",
          "this entry published that branch at a different commit than the one its checkout is " +
            "on now, so a pull request opened from it would name a head this entry never " +
            "published. Nothing was contacted.",
        );
      }
    },
  };
}
