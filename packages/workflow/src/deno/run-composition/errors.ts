/**
 * What an ordinary run refuses, and in whose words.
 *
 * Two of the three reuse the vocabulary the components already speak, because
 * they are the same conditions: a locator this provider will not use, a base
 * that names no commit, a branch another checkout holds. What is new here is
 * only what a shared host root adds — a slot another process is working in, and
 * a slot whose contents do not match what it would be reused as — so those get
 * words of their own.
 *
 * None of these deletes, resets or repairs anything. A managed checkout is
 * somebody's work; a refusal leaves every byte where it was and says what to
 * look at.
 */

import { StaleInputError } from "@executablemd/durable-streams";

/** A word from the fixed vocabulary a managed-checkout refusal is reported under. */
export type ManagedCheckoutReason =
  /** Another process holds this slot's lock right now. */
  | "in-use"
  /** The slot holds a checkout that is not what this request would reuse. */
  | "incompatible-reuse"
  /** The slot holds an interrupted creation this provider cannot prove. */
  | "partial-creation"
  /** The slot holds something that is not a readable Git checkout. */
  | "unusable-checkout";

/**
 * A managed checkout this run may not use.
 *
 * An ordinary Error rather than a stale-state one: every condition here is
 * something the person running the document can act on — wait for the other
 * process, look at what is in the slot, ask for a different name — so an
 * authored `<PrintErrors>` region may decide what to do about it, exactly as it
 * may for a Repository refusal.
 */
export class ManagedCheckoutError extends Error {
  override name = "ManagedCheckoutError";

  readonly reason: ManagedCheckoutReason;

  constructor(reason: ManagedCheckoutReason, sentence: string) {
    super(sentence);
    this.reason = reason;
  }
}

/**
 * An element that needs a repository, written where the host is not in one.
 *
 * A `StaleInputError`, because it is not a refusal a document asked for: a
 * document that goes on running past this would run later siblings as though a
 * branch had moved. The sentence names the two ways to fix it, because both are
 * ordinary — write a `<Repository>`, or run from inside a checkout.
 */
export class NoAmbientRepositoryError extends StaleInputError {
  override name = "NoAmbientRepositoryError";

  constructor(operation: string) {
    super(
      `${operation} needs a repository, and it is written outside a <Repository> in a directory ` +
        "that is not inside a Git checkout. Run xmd from inside one, or write " +
        '<Repository name=".." url={..}>…</Repository> around it.',
    );
  }
}

/**
 * This host cannot say who a commit would be by.
 *
 * A refusal a document can act on, in the same vocabulary `<Git.Commit>`
 * already speaks: it names the two commands that fix it. Substituting the
 * workflow identity instead would write a name nobody in this repository
 * recognizes, which is exactly what an ordinary run must not do — and it would
 * do it silently.
 *
 * It reaches `<Git.Commit>` alone. Repository, Worktree, Dir, Switch, Add,
 * Push, Issue and PullRequest write no commit object and are unaffected.
 */
export class UnresolvedGitIdentityError extends Error {
  override name = "UnresolvedGitIdentityError";

  readonly reason = "unresolved-identity";

  constructor() {
    super(
      "<Git.Commit> cannot record who this commit is by: this host's Git reports no author or " +
        'committer identity. Set one with `git config --global user.name "Your Name"` and ' +
        "`git config --global user.email you@example.com`, or export GIT_AUTHOR_NAME, " +
        "GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL. Nothing was committed, " +
        "and no other identity was substituted for yours.",
    );
  }
}

/**
 * A branch this run has not published, or has published somewhere else.
 *
 * The ordinary run's counterpart to the journal scan a workflow run performs.
 * The evidence it reads is this provider instance's own record of a verified
 * `<Git.Push>`; nothing a document, a Context value or a previous `--journal`
 * file holds is admissible, which is why an execution that did not push refuses
 * here rather than observing the Git host.
 */
export class LivePushEvidenceError extends StaleInputError {
  override name = "LivePushEvidenceError";

  readonly reason: "missing-push-evidence" | "conflicting-push-evidence";

  constructor(reason: "missing-push-evidence" | "conflicting-push-evidence", sentence: string) {
    super(
      `<PullRequest> is not authorized by what this execution published: ${sentence} Nothing was ` +
        "observed at the Git host, and no pull request was created.",
    );
    this.reason = reason;
  }
}
