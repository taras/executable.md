/**
 * What a trusted host allows a generated fragment to do, stated before any
 * document code exists.
 *
 * `<Evaluate>` is a public component: any author may write it, and canonical
 * core owns what it means. That settles *which implementation runs* and nothing
 * else — a protected name is not authority, and a component that granted some
 * by being protected would be a capability anybody could reach by spelling it.
 * So the authority is here instead, in a value the host hands canonical
 * execution at the installation boundary: the maximum a fragment may do under
 * this host, whatever a document later asks for.
 *
 * `allow` then selects from this profile. It can narrow it and it can do
 * nothing else — a class this profile has no table for is a policy that cannot
 * be stated, not a fragment to refuse, and a table entry an author never asked
 * for is simply not selected.
 *
 * ## One per execution
 *
 * Two profiles would be two answers to "what may a fragment do here", and
 * choosing between them by installation order would make authority depend on
 * assembly. So an execution accepts one, refuses two, and evaluating without one
 * refuses before the producer runs — a host that stated no profile did not
 * decline to restrict evaluation, it declined to offer it.
 *
 * It is captured by value with the rest of the installation, before the root
 * import and before any document, component or middleware code exists. Nothing a
 * running document can reach names it: not a context, whose name is not a
 * secret; not a registry, which a nested scope layers over; not a prop, which an
 * author writes.
 */

import type { GeneratedMutation, GeneratedObservation } from "./generated-xmd.ts";

/**
 * The Workspace basis a workflow host evaluates against.
 *
 * Absent for an ordinary run, which has no Workspace and addresses its Files
 * provider directly. Present for a workflow run, where an admitted effect
 * crosses the run's own transaction-bound provider and the retained roots are
 * the provenance a continuation is held to.
 */
export interface FragmentWorkspace {
  /** The retained roots this host is willing to expose. */
  readonly roots: readonly string[];
  /** The one root admitted effects address. */
  readonly selectedRoot: string;
}

/**
 * One host's complete statement of what a fragment may do.
 *
 * The two tables are stated whether or not a document asks for either: `allow`
 * selects from what the host already installed and can add nothing to it, so a
 * host that omits the write table has made a fragment unable to write no matter
 * what an author writes in `allow`.
 */
export interface FragmentEvaluationProfile {
  /**
   * The pinned identities the `read` class resolves to.
   *
   * For both standard profiles this is exactly the self-closing `<File>`.
   * `<Fetch>` joins it only where the host also states the exact requests it
   * may perform, because an unbounded network read is a different decision
   * from an admitted one.
   */
  readonly read: readonly GeneratedObservation[];
  /**
   * The pinned identities the `write` class resolves to, when this host offers
   * the class at all.
   *
   * For both standard profiles this is exactly paired `<File>`, paired `<Dir>`
   * and self-closing `<File.Delete>`. It does not include the read table:
   * `write` selects mutation and nothing else, so an author needing both writes
   * `allow={["read", "write"]}`.
   */
  readonly write?: readonly GeneratedMutation[];
  /** The Workspace basis, for a host that evaluates against one. */
  readonly workspace?: FragmentWorkspace;
  /**
   * Whether this host accepts the released `source` spelling beside `text`.
   *
   * The workflow profile does, silently, because documents were written against
   * it before `text` existed. The ordinary profile does not: it never shipped
   * that spelling, and acquiring a legacy alias it has no legacy for would be
   * inventing one.
   */
  readonly deprecatedSourceAlias?: boolean;
}

/** What an execution that was offered no evaluation profile refuses with. */
export const NO_PROFILE =
  "<Evaluate /> has no evaluation profile here: this host stated none, so nothing established " +
  "what a generated fragment may do. A profile is the host's own statement of the maximum " +
  "authority an evaluation has, and `allow` only narrows it.";

/** What an execution offered two evaluation profiles refuses with. */
export const TWO_PROFILES =
  "two installations stated the evaluation profile this execution offers. One execution offers " +
  "one maximum authority, so what a generated fragment may do is never a question of assembly " +
  "order.";
