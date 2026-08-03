/**
 * The release matrix, as flags rather than as prose.
 *
 * A release compiles five targets, and `deno compile --target` resolves the npm
 * packages of the platform it compiles *for*, not the one it runs on. Host
 * preparation caches the host's — measured: a `x86_64-unknown-linux-gnu`
 * compile on a prepared macOS tree fails on
 * `@msgpackr-extract/msgpackr-extract-linux-x64` under `--cached-only`. So each
 * matrix job prepares its own target's graph first, and every release compile
 * keeps `--cached-only --frozen` (#279).
 *
 * This module owns the executable half of that: which OS and architecture each
 * target maps to, and the exact argv preparation runs. `release.yml` keeps the
 * matrix list GitHub fans out over, and
 * `scripts/tests/publish-workflow-membership.test.ts` holds the two to exact set
 * equality, so a target can never be added in one place alone.
 */

export interface Platform {
  os: string;
  arch: string;
}

/** Contractual: every release matrix member, and nothing else. */
export const RELEASE_TARGETS: Record<string, Platform> = {
  "aarch64-apple-darwin": { os: "darwin", arch: "arm64" },
  "x86_64-apple-darwin": { os: "darwin", arch: "x64" },
  "x86_64-unknown-linux-gnu": { os: "linux", arch: "x64" },
  "aarch64-unknown-linux-gnu": { os: "linux", arch: "arm64" },
  "x86_64-pc-windows-msvc": { os: "win32", arch: "x64" },
};

/**
 * The one `verify:clean` compiles for. Cross-compiled from every developer
 * machine and every runner, so the purity phase exercises the same argument
 * shape everywhere rather than a different one per host.
 */
export const RELEASE_TARGET = "x86_64-unknown-linux-gnu";

/** What a release compiles, and therefore what preparation caches the graph of. */
export const RELEASE_ENTRYPOINT = "packages/cli/src/compiled.ts";

/**
 * The argv that prepares `target`'s dependency graph.
 *
 * `--node-modules-dir=none` is the isolation: preparation populates the Deno
 * cache and neither replaces nor relinks the host `node_modules` layout.
 * `--frozen` keeps it from rewriting the tracked lock.
 *
 * An unknown target throws here, before a caller can spawn anything.
 */
export function preparationArguments(target: string): string[] {
  const platform = RELEASE_TARGETS[target];
  if (!platform) {
    throw new Error(
      `unknown release target "${target}" — expected one of ${Object.keys(RELEASE_TARGETS).join(
        ", ",
      )}`,
    );
  }
  return [
    "install",
    "--entrypoint",
    "--node-modules-dir=none",
    "--frozen",
    "--os",
    platform.os,
    "--arch",
    platform.arch,
    RELEASE_ENTRYPOINT,
  ];
}
