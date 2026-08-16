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
 * command at a repository nobody named; a credential helper can attach an
 * identity to a locator this run admitted as credential-free. A workflow's
 * retained state must not depend on whose machine it was created on, so the
 * environment is built from nothing and `HOME` points at the disposable
 * materialization rather than at a person.
 *
 * `GIT_TERMINAL_PROMPT=0` is the other half: a locator that needs a credential
 * fails instead of blocking a run on a prompt nobody is there to answer.
 */

import { ensure, type Operation, resource, until, withResolvers } from "effection";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** What one Git invocation reported. A nonzero exit is an answer, not a throw. */
export interface GitOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitInvocation {
  readonly args: readonly string[];
  /** The directory Git runs in. */
  readonly cwd: string;
  /** The materialization root, which is also what Git sees as `HOME`. */
  readonly home: string;
}

export interface RepositoryHost {
  git(invocation: GitInvocation): Operation<GitOutcome>;
  /** A host directory owned by the acquiring scope, removed when it ends. */
  useDirectory(): Operation<string>;
}

/** Who a workflow run's Git state is written by, on every host. */
const IDENTITY_NAME = "Executable.md workflow";
const IDENTITY_EMAIL = "workflow@executable.md.invalid";

/** The variables Git may see, and nothing else. */
function environment(home: string): Record<string, string> {
  const path = process.env.PATH;
  return {
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

export function denoRepositoryHost(): RepositoryHost {
  return {
    *git({ args, cwd, home }: GitInvocation): Operation<GitOutcome> {
      // `node:child_process` rather than the runtime's own global: this adapter
      // is selected by the host, not written against one, and `spawn` replaces
      // the child's environment outright when `env` is given — which is the
      // whole point of building one above rather than inheriting it.
      const child = spawnChild("git", [...args], {
        cwd,
        env: environment(home),
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Registered with no suspension point between spawning and registering,
      // so a halt cannot land between the two and leave a Git process running
      // after the scope that started it is gone.
      let settled = false;
      yield* ensure(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      });

      const outcome = withResolvers<GitOutcome>();
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      // `close` rather than `exit`: it is the event that fires once both pipes
      // have ended, so what is read here is everything Git wrote rather than
      // whatever had arrived when it stopped.
      child.on("close", (code: number | null) => {
        outcome.resolve({ code: code ?? -1, stdout, stderr });
      });
      child.on("error", (error: Error) => {
        outcome.reject(error);
      });

      const result = yield* outcome.operation;
      settled = true;
      return result;
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
