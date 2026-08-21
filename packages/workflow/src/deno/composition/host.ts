/**
 * The two host things native Git needs: a place to work, and a way to run.
 *
 * Everything else the provider does — resolving a base, deciding a primary
 * branch, importing bytes, refusing a reuse — is arithmetic on what these two
 * return. Keeping them behind one small interface is what lets a suite hold a
 * command open to prove cancellation, or fail one, without a repository on disk
 * arranged to fail in that exact way.
 *
 * The production implementation is here, in the Deno adapter, because this is
 * where a host may be named. A shared module never reaches it.
 *
 * ## Why the environment is built rather than inherited
 *
 * Git reads the caller's environment, and almost everything it finds there can
 * change what a clone produces: `~/.gitconfig` can set `core.hooksPath`,
 * `init.templateDir` or a URL rewrite; `GIT_DIR` and `GIT_WORK_TREE` can point a
 * command at a repository nobody named. A workflow's retained state must not
 * depend on whose machine it was created on, so the environment is built from
 * nothing and `HOME` points at the disposable materialization rather than at a
 * person.
 *
 * `GIT_TERMINAL_PROMPT=0` is the other half: a command that needs an answer
 * nobody is there to give fails instead of blocking the run on a prompt.
 *
 * The one thing deliberately borrowed from the invoking environment is
 * authentication, and only by a command that transports to a remote. It arrives
 * through `authentication.ts` rather than through this environment, is acquired
 * for that command's own exact locator, and is disposed with the command. A
 * command with no `remote` reaches no authentication mechanism at all — which is
 * what makes a completed replay, which performs no remote operation, reach none
 * either.
 *
 * ## Why the configuration is fixed as well
 *
 * A checkout carries its own `.git/config`, and that file is inside the
 * Workspace this run retains — so a document can write one, and a replay
 * restores whatever is there. Several ordinary settings in it name a *program*
 * for Git to run, and one of them running would put work outside the effect's
 * transaction: a hook that survives a rollback, a signing helper that changes
 * the object this run verified, a file-system monitor consulted whenever the
 * index is refreshed.
 *
 * So the settings that name programs are fixed on the command line, where they
 * outrank every configuration file, for every command this host runs. This is
 * not `--no-verify`: that flag skips the hooks that can refuse a commit and
 * leaves the ones that run after it.
 */

import { ensure, type Operation, resource, until } from "effection";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { denoGitAuthentication, UNAUTHENTICATED } from "./authentication.ts";
import type { HelperAssembly } from "./credential-helper.ts";
import type {
  GitAttachment,
  GitAuthentication,
  GitAuthenticationSession,
} from "./authentication.ts";
import { runProcess, type ProcessOutcome } from "./subprocess.ts";

/** What one Git invocation reported. A nonzero exit is an answer, not a throw. */
export type GitOutcome = ProcessOutcome;

export interface GitInvocation {
  readonly args: readonly string[];
  /** The directory Git runs in. */
  readonly cwd: string;
  /** The materialization root, which is also what Git sees as `HOME`. */
  readonly home: string;
  /**
   * Bytes handed to the command on standard input, or none.
   *
   * A commit message is authored text of any length, and an argument list is
   * neither the place to put one nor a boundary that carries one unchanged.
   */
  readonly input?: string;
  /**
   * The whole Unix second a commit is authored and committed at.
   *
   * Two named variables rather than an environment a caller may fill: what a
   * run's Git state is written by is fixed, and the one thing an operation
   * decides for itself is when. Absent for every command that writes no object.
   */
  readonly committedAt?: number;
  /**
   * What this command's provider invocation borrowed from the host.
   *
   * Handed down rather than acquired here. One invocation opens one session,
   * after the authority checks that operation requires, and every native
   * command it runs attaches that same one — so an observation and the mutation
   * that follows it go out under one identity rather than two. Absent for every
   * command that stays inside the materialization.
   */
  readonly attachment?: GitAttachment;
}

export interface RepositoryHost {
  git(invocation: GitInvocation): Operation<GitOutcome>;
  /** A host directory owned by the acquiring scope, removed when it ends. */
  useDirectory(): Operation<string>;
  /**
   * One authentication session for this exact locator, owned by the acquiring
   * scope and disposed with it.
   *
   * Optional, because a suite that substitutes the whole host has already
   * replaced the thing a session would be attached to. Such a host lends none,
   * and every operation reads that as an absent mechanism rather than an error.
   */
  useAuthentication?(locator: string): Operation<GitAuthenticationSession>;
}

/** This host's session for one locator, or that of a host which lends none. */
export function* useGitAuthentication(
  host: RepositoryHost,
  locator: string,
): Operation<GitAuthenticationSession> {
  return host.useAuthentication === undefined
    ? UNAUTHENTICATED
    : yield* host.useAuthentication(locator);
}

/**
 * The settings a workflow run's Git may not take from a repository.
 *
 * Each one names a program. `/dev/null` is a hook directory nothing can be found
 * in, which is what makes every hook absent rather than merely skipped.
 */
const CONFIGURATION: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "push.gpgSign=false",
];

/** Who a workflow run's Git state is written by, on every host. */
const IDENTITY_NAME = "Executable.md workflow";
const IDENTITY_EMAIL = "workflow@executable.md.invalid";

/** The variables Git may see, and nothing else. */
function environment(home: string, committedAt: number | undefined): Record<string, string> {
  const path = process.env.PATH;
  return {
    // A fixed offset beside the second, so the instant a commit records is the
    // instant that was captured wherever the host happens to be standing.
    ...(committedAt === undefined
      ? {}
      : {
          GIT_AUTHOR_DATE: `${committedAt} +0000`,
          GIT_COMMITTER_DATE: `${committedAt} +0000`,
        }),
    ...(path === undefined ? {} : { PATH: path }),
    HOME: home,
    // A config file that exists and holds nothing, so Git neither reads a
    // person's settings nor complains about a file it cannot open.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    // The Workspace provider owns Git identity (spec §7.3). Without one Git
    // derives a name and an address from the operating-system user and the
    // machine's hostname and writes them into every reflog it touches, which
    // would put whoever ran the host into the run's own retained Git state.
    GIT_AUTHOR_NAME: IDENTITY_NAME,
    GIT_AUTHOR_EMAIL: IDENTITY_EMAIL,
    GIT_COMMITTER_NAME: IDENTITY_NAME,
    GIT_COMMITTER_EMAIL: IDENTITY_EMAIL,
    // Stable message text, so a refusal is selected by exit status and by the
    // conditions this provider tests for rather than by a translated sentence.
    LC_ALL: "C",
  };
}

export interface RepositoryHostOptions {
  /**
   * What this host lends a remote-touching invocation.
   *
   * The trusted host decides which ambient mechanisms exist, which is why this
   * is here rather than anywhere a document, a middleware or a retained record
   * could reach. Absent, the shipped one is used.
   */
  readonly authentication?: GitAuthentication;
  /** How this host writes and starts its own credential helper. */
  readonly helper?: HelperAssembly;
}

export function denoRepositoryHost(options: RepositoryHostOptions = {}): RepositoryHost {
  const authentication =
    options.authentication ??
    denoGitAuthentication(options.helper === undefined ? {} : { assembly: options.helper });
  return {
    git({ args, cwd, home, input, committedAt, attachment }: GitInvocation): Operation<GitOutcome> {
      // A command with no attachment reaches no authentication mechanism. That
      // is what makes a completed replay reach none: replay performs no remote
      // operation, so no invocation ever opens a session to attach.
      return runProcess({
        command: "git",
        args: [...CONFIGURATION, ...(attachment?.configuration ?? []), ...args],
        cwd,
        env: { ...environment(home, committedAt), ...(attachment?.environment ?? {}) },
        ...(input === undefined ? {} : { input }),
      });
    },

    useAuthentication(locator: string): Operation<GitAuthenticationSession> {
      return authentication.open(locator);
    },

    useDirectory(): Operation<string> {
      return resource(function* (provide) {
        const created = yield* until(mkdtemp(join(tmpdir(), "xmd-workflow-git-")));
        yield* ensure(function* () {
          yield* until(rm(created, { recursive: true, force: true }));
        });
        // The resolved path, not the one that was handed back. A temporary
        // directory reached through a symbolic link — `/var` on macOS is
        // `/private/var` — is one path to this process and another to Git, and
        // Git writes the resolved one into a linked worktree's administration.
        // Canonicalization is subtraction of this exact prefix, so a root that
        // does not match what Git wrote silently retains a host path.
        yield* provide(yield* until(realpath(created)));
      });
    },
  };
}
