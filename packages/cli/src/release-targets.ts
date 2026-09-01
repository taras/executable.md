/**
 * The five targets a release publishes, as one table.
 *
 * Two consumers read it, and they have to agree. `release.yml` compiles a
 * binary per target and names each artifact; `xmd upgrade` picks the artifact
 * for the machine it is running on. A second map would let the release publish
 * `xmd-aarch64-apple-darwin` while self-upgrade asked for something else, and
 * the failure would appear only on the platform nobody built for.
 *
 * It lives in the shipped CLI rather than in `scripts/` because the compiled
 * binary needs it: `scripts/lib/release-targets.ts` imports this table and adds
 * only what the release tooling needs on top of it — the representative target,
 * the compile entrypoint, and the preparation argv.
 *
 * Pure data and one lookup. Nothing here reads the process, the filesystem or
 * the network, so a caller can ask what a platform's artifact is called without
 * having reached for anything.
 */

/** One published target: what compiles it, what runs it, and what it is called. */
export interface ReleaseTarget {
  /** The triple `deno compile --target` names. */
  readonly target: string;
  /** Node's `process.platform` for that triple. */
  readonly platform: string;
  /** Node's `process.arch` for that triple. */
  readonly architecture: string;
  /** The exact asset name the release publishes, `.exe` included. */
  readonly artifact: string;
}

/** Contractual: every release matrix member, and nothing else. */
export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  {
    target: "aarch64-apple-darwin",
    platform: "darwin",
    architecture: "arm64",
    artifact: "xmd-aarch64-apple-darwin",
  },
  {
    target: "x86_64-apple-darwin",
    platform: "darwin",
    architecture: "x64",
    artifact: "xmd-x86_64-apple-darwin",
  },
  {
    target: "x86_64-unknown-linux-gnu",
    platform: "linux",
    architecture: "x64",
    artifact: "xmd-x86_64-unknown-linux-gnu",
  },
  {
    target: "aarch64-unknown-linux-gnu",
    platform: "linux",
    architecture: "arm64",
    artifact: "xmd-aarch64-unknown-linux-gnu",
  },
  {
    target: "x86_64-pc-windows-msvc",
    platform: "win32",
    architecture: "x64",
    artifact: "xmd-x86_64-pc-windows-msvc.exe",
  },
];

/**
 * The row for one machine, or `undefined` when the release publishes none.
 *
 * An absent row is an answer rather than an error: a compiled binary running on
 * a platform no release targets has nothing to replace itself with, and the
 * command says so instead of reconstructing an asset name that was never built.
 */
export function releaseTargetFor(
  platform: string,
  architecture: string,
): ReleaseTarget | undefined {
  return RELEASE_TARGETS.find(
    (row) => row.platform === platform && row.architecture === architecture,
  );
}

/** The row for one target triple, or `undefined` when it names none. */
export function releaseTargetNamed(target: string): ReleaseTarget | undefined {
  return RELEASE_TARGETS.find((row) => row.target === target);
}
