/**
 * Local bare repositories, for suites that need a real remote and no network.
 *
 * Everything a Repository component does to a remote — resolving a default
 * branch, pinning a commit, cloning objects — is done here against a bare
 * repository in a temporary directory. Nothing in these suites contacts a
 * network host, and a suite may delete a remote outright to prove that a
 * replayed run no longer needs it.
 *
 * Git runs with the same neutralized environment the provider uses, so a
 * fixture cannot pass through configuration from whoever is running the suite.
 */

import { ensure, type Operation, resource, until } from "effection";
import { ensureDir, rm } from "@effectionx/fs";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export interface RemoteEntry {
  readonly path: string;
  readonly content?: string | Uint8Array;
  /** A symbolic link's target. When present, `content` is ignored. */
  readonly symlink?: string;
  readonly mode?: number;
}

export interface RemoteCommit {
  readonly message: string;
  /** The branch this commit lands on. The first commit's branch is the default. */
  readonly branch?: string;
  readonly entries: readonly RemoteEntry[];
  /** A tag pointing at this commit. */
  readonly tag?: string;
}

export interface RemoteOptions {
  /** The branch a clone gets when no base is supplied. Defaults to `main`. */
  readonly defaultBranch?: string;
  readonly commits: readonly RemoteCommit[];
}

export interface BareRemote {
  /** The locator a document passes as `url`. */
  readonly locator: string;
  /** The commit each named branch points at. */
  readonly heads: ReadonlyMap<string, string>;
  /** The commit each tag points at. */
  readonly tags: ReadonlyMap<string, string>;
  /** Delete this remote, so a later replay must not need it. */
  remove(): Operation<void>;
}

function environment(home: string): Record<string, string> {
  const path = process.env.PATH;
  return {
    ...(path === undefined ? {} : { PATH: path }),
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    // A fixed clock, so two runs of the same fixture produce the same commits.
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
}

/** Run one Git command, failing the suite with what Git said when it refuses. */
export function git(args: readonly string[], cwd: string, home: string): string {
  const output = spawnSync("git", [...args], {
    cwd,
    env: environment(home),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (output.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${output.status} in ${cwd}: ${output.stderr}`);
  }
  return output.stdout.trim();
}

function* writeEntry(root: string, entry: RemoteEntry): Operation<void> {
  const target = `${root}/${entry.path}`;
  yield* ensureDir(target.slice(0, target.lastIndexOf("/")));
  if (entry.symlink !== undefined) {
    yield* until(symlink(entry.symlink, target));
    return;
  }
  yield* until(writeFile(target, entry.content ?? ""));
  if (entry.mode !== undefined) {
    yield* until(chmod(target, entry.mode));
  }
}

/**
 * A bare repository built from `options`, removed when its scope ends.
 *
 * Built through a working checkout and then cloned bare, because that is the
 * only way to produce ordinary commits: a bare repository has no index to stage
 * into.
 */
export function useBareRemote(options: RemoteOptions): Operation<BareRemote> {
  return resource<BareRemote>(function* (provide) {
    const root = yield* until(mkdtemp(join(tmpdir(), "xmd-remote-")));
    let removed = false;
    yield* ensure(function* () {
      if (!removed) {
        yield* rm(root, { recursive: true, force: true });
      }
    });

    const defaultBranch = options.defaultBranch ?? "main";
    const work = `${root}/work`;
    yield* ensureDir(work);
    git(["init", `--initial-branch=${defaultBranch}`], work, root);

    const heads = new Map<string, string>();
    const tags = new Map<string, string>();

    for (const commit of options.commits) {
      const branch = commit.branch ?? defaultBranch;
      const known = heads.has(branch);
      if (branch !== defaultBranch || known) {
        git(known ? ["checkout", branch] : ["checkout", "-b", branch], work, root);
      }
      for (const entry of commit.entries) {
        yield* writeEntry(work, entry);
      }
      git(["add", "--all", "--", "."], work, root);
      git(["commit", "--message", commit.message], work, root);
      heads.set(branch, git(["rev-parse", "HEAD"], work, root));
      if (commit.tag !== undefined) {
        git(["tag", commit.tag], work, root);
        tags.set(commit.tag, heads.get(branch) ?? "");
      }
    }

    git(["checkout", defaultBranch], work, root);

    const bare = `${root}/remote.git`;
    git(["clone", "--bare", "--no-hardlinks", "--", work, bare], root, root);
    // A bare clone copies HEAD, but be explicit: the default branch is what a
    // clone with no base must follow, and a suite that changes it later must be
    // changing something the fixture actually established.
    git(["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], bare, root);

    yield* provide({
      locator: bare,
      heads,
      tags,
      *remove(): Operation<void> {
        removed = true;
        yield* rm(root, { recursive: true, force: true });
      },
    });
  });
}

/** Move a branch in a bare remote, for suites proving a pin does not follow it. */
export function moveRemoteBranch(remote: BareRemote, branch: string, commit: string): void {
  git(["update-ref", `refs/heads/${branch}`, commit], remote.locator, remote.locator);
}

/**
 * Every ref this bare remote holds right now, read out of the remote itself.
 *
 * The discriminating observation for a push. What a run retains says what it
 * believes it published; this says what the other end actually has.
 */
export function remoteRefs(remote: BareRemote): Map<string, string> {
  const listed = git(
    ["for-each-ref", "--format=%(objectname) %(refname)"],
    remote.locator,
    remote.locator,
  );
  const refs = new Map<string, string>();
  for (const line of listed.split("\n")) {
    if (line === "") {
      continue;
    }
    const [commit, name] = line.split(" ");
    if (commit !== undefined && name !== undefined) {
      refs.set(name, commit);
    }
  }
  return refs;
}

/** The commit one branch names on the remote, or `undefined` when it has none. */
export function remoteBranch(remote: BareRemote, branch: string): string | undefined {
  return remoteRefs(remote).get(`refs/heads/${branch}`);
}
