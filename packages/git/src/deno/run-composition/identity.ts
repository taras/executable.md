/**
 * Who an ordinary run's commits are by.
 *
 * A workflow run's Git state must not depend on whose machine it was created
 * on, so its provider commits under one fixed identity and builds Git's
 * environment from nothing. An ordinary run is the opposite case: the commit
 * lands in a person's own checkout, on a branch they will look at tomorrow, and
 * attributing it to `Executable.md workflow` would put a name in their history
 * that nobody there recognizes.
 *
 * So the invoking user's effective identity is captured once, before the
 * document expands, and used for `<Git.Commit>` alone.
 *
 * ## Captured from the trusted host, and nowhere else
 *
 * `git var GIT_AUTHOR_IDENT` and `GIT_COMMITTER_IDENT` are exactly what native
 * Git would use: the `GIT_*_NAME`/`GIT_*_EMAIL` variables, then `user.name` and
 * `user.email` from the configuration Git itself resolves, then whatever the
 * host can auto-detect. Reading it takes the caller's own environment and the
 * directory the command was run in, which is why it happens here — at the
 * trusted entrypoint's provider construction, before any document code exists.
 *
 * It is not a prop, a Context value, a component result or a middleware answer,
 * and no document can read it, replace it or ask for a different one.
 *
 * ## Only the identity is borrowed
 *
 * The commands that run afterwards keep every other protection: hooks,
 * file-system monitors, signing programs and repository-supplied credential
 * helpers stay disabled by the same fixed command-line configuration a workflow
 * run uses, and `HOME` still points at a disposable directory. What crosses
 * from the caller's environment is four strings.
 *
 * ## An unresolvable identity refuses, and refuses narrowly
 *
 * A host where Git cannot say who the user is is a host that cannot commit, and
 * substituting the workflow identity would be writing somebody else's name into
 * a person's repository to avoid saying so. `<Git.Commit>` reports it and names
 * the two commands that fix it. Every other component — Repository, Worktree,
 * Dir, Switch, Add, Push, Issue, PullRequest — is unaffected: none of them
 * writes a commit object.
 */

import type { Operation } from "effection";
import process from "node:process";
import { runProcess } from "../composition/subprocess.ts";

/** The four strings a commit object records about who made it. */
export interface GitCommitIdentity {
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
}

/**
 * What one `git var …_IDENT` answer says, or `undefined` when it says nothing
 * usable.
 *
 * The shape is `Name <email> <seconds> <offset>`, and the timestamp is
 * deliberately discarded: when a commit is made is the operation's own decision,
 * captured at the moment it runs.
 */
export function parseGitIdent(reported: string): { name: string; email: string } | undefined {
  const opened = reported.lastIndexOf(" <");
  const closed = reported.indexOf(">", opened);
  if (opened <= 0 || closed < 0) {
    return undefined;
  }
  const name = reported.slice(0, opened).trim();
  const email = reported.slice(opened + 2, closed).trim();
  return name === "" || email === "" ? undefined : { name, email };
}

/** How this module asks Git a question. Substituted whole by a suite. */
export type IdentityReader = (variable: string) => Operation<string | undefined>;

/**
 * The reader the trusted entrypoint uses: native Git, the caller's own
 * environment, and the directory the command was run in.
 *
 * The environment is inherited rather than built, which is the one place in
 * this provider that is true — the whole question being asked is what the
 * caller's environment and configuration say.
 */
export function denoIdentityReader(cwd: string): IdentityReader {
  return function* (variable: string): Operation<string | undefined> {
    const outcome = yield* runProcess({
      command: "git",
      args: ["var", variable],
      cwd,
      env: { ...inherited(), LC_ALL: "C" },
    });
    if (outcome.code !== 0) {
      return undefined;
    }
    const reported = outcome.stdout.trim();
    return reported === "" ? undefined : reported;
  };
}

function inherited(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

/**
 * The identity ordinary commits are made under, or `undefined` when this host
 * cannot say.
 *
 * Both idents are asked for, because Git resolves them separately and a host
 * may know one and not the other. Either one missing leaves the whole answer
 * absent: a commit whose author this run knows and whose committer it guessed
 * would be exactly the substitution this exists to prevent.
 */
export function* captureCommitIdentity(
  read: IdentityReader,
): Operation<GitCommitIdentity | undefined> {
  const authored = yield* read("GIT_AUTHOR_IDENT");
  const committed = yield* read("GIT_COMMITTER_IDENT");
  if (authored === undefined || committed === undefined) {
    return undefined;
  }
  const author = parseGitIdent(authored);
  const committer = parseGitIdent(committed);
  if (author === undefined || committer === undefined) {
    return undefined;
  }
  return Object.freeze({
    authorName: author.name,
    authorEmail: author.email,
    committerName: committer.name,
    committerEmail: committer.email,
  });
}
