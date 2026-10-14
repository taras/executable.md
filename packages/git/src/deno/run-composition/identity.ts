/**
 * Capture the invoking user's effective Git author and committer for ordinary
 * commits. Workflow commits keep their fixed identity.
 *
 * The first Git.Commit captures `git var GIT_AUTHOR_IDENT` and
 * `GIT_COMMITTER_IDENT` once through the trusted entrypoint's reader, using the
 * invocation directory and host environment/configuration. A run that commits
 * nothing reads no identity. Props, Context and middleware cannot select or
 * replace it.
 *
 * Only four identity strings are borrowed. Hooks, filesystem monitors, signing
 * programs and repository credential helpers remain disabled by fixed command-line
 * configuration, and HOME stays disposable. Missing identity refuses Git.Commit
 * with corrective commands; it never substitutes the workflow identity or affects
 * other components.
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
