/**
 * The ACP adapters a workflow run executes, and how they reach the disk
 * (`packages/acp/vendor/adapters/PROVENANCE.md`).
 *
 * A workflow Prompt needs an adapter that names the turn it just completed, on
 * `_meta`. No published adapter does yet, so this repository carries one npm
 * tarball per provider — packed from an exact patched upstream commit by that
 * project's own build — and runs those instead of whatever `npx` would resolve.
 *
 * ## Why the bytes travel in the module graph
 *
 * A tarball on disk is unreachable from a compiled binary and from the npm
 * artifact. The same bytes are therefore carried as a generated module, which
 * every distribution inlines identically, and this module writes them out. One
 * mechanism, so "the source tree, the npm package and the binary all run the
 * same adapter" is a fact rather than three arrangements that happen to agree.
 *
 * ## Content-addressed, so identity is the location
 *
 * A snapshot materializes under its own SHA-256. Two runs asking for the same
 * adapter name the same directory, a changed snapshot names a different one,
 * and nothing has to decide whether an existing directory is current — the
 * question does not arise.
 *
 * That is also what lets {@link EmbeddedAdapters.command} answer before
 * anything is on disk. The path is derived from the digest, so the command a
 * session key is built from is known early and never changes underneath it.
 *
 * ## Published atomically, verified before use
 *
 * Materialization happens in a private temporary directory and is published by
 * one rename. A concurrent run either wins that rename or finds the directory
 * already there — both then verify the marker before using it, so nobody
 * executes a tree another process is still filling.
 *
 * ## It refuses; it never falls back
 *
 * A digest that does not match, an extraction that fails, a dependency install
 * that fails, a missing entry file: each raises. Running the published adapter
 * instead would be running one that emits no token, which is the state this
 * exists to leave — silently, and after the run had already been told it was
 * continuing an exact conversation.
 */

import { decodeBase64 } from "@std/encoding/base64";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec, useQuietProcessOutput } from "@executablemd/runtime";
import type { AcpAgentRegistry } from "./acpx-runtime.ts";
import { ensure, type Operation, scoped } from "effection";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { rename, writeFile } from "node:fs/promises";
import { until } from "effection";
import {
  EMBEDDED_ADAPTER_SNAPSHOTS,
  type EmbeddedAdapterSnapshot,
} from "../vendor/adapters/generated/snapshots.ts";

/** A snapshot this host will not run, and why. */
export class AdapterSnapshotError extends Error {
  override name = "AdapterSnapshotError";
}

/**
 * What a materialized directory must contain before anything executes from it.
 *
 * Written last and read first. A tree without it is a tree some earlier attempt
 * abandoned part-way, which is exactly the tree that must not be run.
 */
const MARKER = ".xmd-adapter";

export interface EmbeddedAdapters {
  /** Every provider this host carries an adapter for. */
  readonly providers: readonly string[];
  /**
   * The command that runs one provider's embedded adapter.
   *
   * Answers before the adapter is on disk: the path is the snapshot's digest,
   * so it is known from the bytes rather than from the filesystem. Refuses a
   * provider this host carries no snapshot for.
   */
  command(provider: string): string;
  /**
   * Put one provider's adapter on disk, verified, or refuse.
   *
   * Idempotent, and safe to run concurrently with itself in another process.
   */
  materialize(provider: string): Operation<void>;
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The tarball a snapshot carries, once it has proven it is the one recorded.
 *
 * Both the length and the digest, because a truncated decode with a colliding
 * prefix is the failure a length check alone reads as success.
 */
function tarballOf(snapshot: EmbeddedAdapterSnapshot): Uint8Array {
  const bytes = decodeBase64(snapshot.base64);
  if (bytes.byteLength !== snapshot.byteLength) {
    throw new AdapterSnapshotError(
      `the embedded ${snapshot.provider} adapter is ${bytes.byteLength} bytes, and this build ` +
        `records ${snapshot.byteLength}`,
    );
  }
  const digest = digestOf(bytes);
  if (digest !== snapshot.sha256) {
    throw new AdapterSnapshotError(
      `the embedded ${snapshot.provider} adapter hashes to ${digest}, and this build records ` +
        `${snapshot.sha256}`,
    );
  }
  return bytes;
}

/** Where one snapshot's entry point lands once npm has installed it. */
function entryPoint(root: string, snapshot: EmbeddedAdapterSnapshot): string {
  return join(root, snapshot.sha256, "node_modules", snapshot.package, "dist", "index.js");
}

/**
 * Install the snapshot into `directory`, using npm's own resolution.
 *
 * A `file:` dependency rather than an unpacked tree, so the adapter's own
 * runtime dependencies are resolved the way they are for anybody installing it
 * from the registry. Provider CLIs are among those dependencies and are not
 * carried here: this repository vendors the adapter, never the agent.
 */
function* install(
  directory: string,
  snapshot: EmbeddedAdapterSnapshot,
  bytes: Uint8Array,
): Operation<void> {
  yield* ensureDir(directory);
  const tarball = join(directory, "adapter.tgz");
  yield* until(writeFile(tarball, bytes));
  yield* writeTextFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "xmd-embedded-adapter",
        version: "0.0.0",
        private: true,
        dependencies: { [snapshot.package]: "file:./adapter.tgz" },
      },
      undefined,
      2,
    )}\n`,
  );

  // Quiet: npm narrates an install at length, and none of it is this run's
  // output. A failure's own stderr is read back and reported instead.
  const installed = yield* scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({
      command: ["npm", "install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"],
      cwd: directory,
    });
  });
  if (installed.exitCode !== 0) {
    throw new AdapterSnapshotError(
      `installing the embedded ${snapshot.provider} adapter failed: ${installed.stderr.trim()}`,
    );
  }
}

/**
 * The embedded adapters, materializing beneath `root`.
 *
 * `root` is host-owned private state. Nothing a document can name reaches it,
 * and nothing here reads anything back out of it except the adapter it just
 * verified.
 */
export function createEmbeddedAdapters(root: string): EmbeddedAdapters {
  const byProvider = new Map(
    EMBEDDED_ADAPTER_SNAPSHOTS.map((snapshot) => [snapshot.provider, snapshot]),
  );

  function snapshotFor(provider: string): EmbeddedAdapterSnapshot {
    const snapshot = byProvider.get(provider);
    if (snapshot === undefined) {
      throw new AdapterSnapshotError(
        `this build carries no embedded ACP adapter for "${provider}", so there is nothing ` +
          "to run it with",
      );
    }
    return snapshot;
  }

  function* published(snapshot: EmbeddedAdapterSnapshot): Operation<boolean> {
    const marker = join(root, snapshot.sha256, MARKER);
    if (!(yield* exists(marker))) {
      return false;
    }
    // The marker names what it published. A directory carrying another
    // snapshot's name under this digest is damage, not a cache hit.
    const recorded = (yield* readTextFile(marker)).trim();
    if (recorded !== snapshot.sha256) {
      throw new AdapterSnapshotError(
        `the materialized ${snapshot.provider} adapter at ${join(root, snapshot.sha256)} ` +
          `records ${recorded || "nothing"} rather than ${snapshot.sha256}`,
      );
    }
    if (!(yield* exists(entryPoint(root, snapshot)))) {
      throw new AdapterSnapshotError(
        `the materialized ${snapshot.provider} adapter is missing its entry point`,
      );
    }
    return true;
  }

  return {
    providers: [...byProvider.keys()],

    command(provider: string): string {
      return `node ${entryPoint(root, snapshotFor(provider))}`;
    },

    *materialize(provider: string): Operation<void> {
      const snapshot = snapshotFor(provider);
      if (yield* published(snapshot)) {
        return;
      }

      // Verified from the bytes this build carries, before any of them reach
      // the disk: a snapshot that cannot prove its identity never becomes a
      // directory somebody could later mistake for a verified one.
      const bytes = tarballOf(snapshot);
      const target = join(root, snapshot.sha256);
      yield* ensureDir(root);

      yield* scoped(function* () {
        const staging = join(root, `.staging-${randomUUID()}`);
        // Registered before the work it guards, so a halt anywhere between here
        // and the rename still takes the staging tree with it.
        yield* ensure(() => rm(staging, { recursive: true, force: true }));

        yield* install(staging, snapshot, bytes);
        yield* writeTextFile(join(staging, MARKER), `${snapshot.sha256}\n`);

        // An unpublished directory at the target is what an attempt killed
        // part-way through leaves behind. It carries no marker, so nothing has
        // ever executed from it and nothing is resolving through it — and
        // leaving it would wedge this adapter for good, since a rename cannot
        // replace a non-empty directory. Concurrent attempts never write here
        // directly, so the only thing this can remove is abandoned work.
        if (!(yield* published(snapshot))) {
          yield* rm(target, { recursive: true, force: true });
        }

        try {
          // One rename publishes every byte at once. A concurrent run either
          // loses this race or wins it; either way nothing observes a tree that
          // is still being filled.
          yield* until(rename(staging, target));
        } catch (error) {
          if (!(yield* published(snapshot))) {
            throw error;
          }
        }
      });

      if (!(yield* published(snapshot))) {
        throw new AdapterSnapshotError(
          `the embedded ${snapshot.provider} adapter did not materialize at ` +
            `${join(root, snapshot.sha256)}`,
        );
      }
    },
  };
}

/**
 * An agent registry serving only this host's embedded adapters.
 *
 * Deliberately closed. ACPX's own registry knows a dozen agent names and
 * resolves each to whatever `npx` would fetch; a run that fell through to one
 * of those would be talking to an adapter that names no turn, and would find
 * out by retaining nothing. An agent this host carries no snapshot for is
 * refused here instead.
 *
 * `resolve` answers without touching the disk. The command is the snapshot's
 * digest, so it is settled by the bytes this build carries — which is what lets
 * a session key be derived from it before anything has been materialized.
 */
export function embeddedAdapterRegistry(adapters: EmbeddedAdapters): AcpAgentRegistry {
  return {
    resolve: (agentName: string) => adapters.command(agentName),
    list: () => [...adapters.providers],
  };
}

/** Every embedded snapshot's identity, for provenance checks and diagnostics. */
export function embeddedAdapterIdentities(): readonly EmbeddedAdapterSnapshot[] {
  return EMBEDDED_ADAPTER_SNAPSHOTS;
}

export type { EmbeddedAdapterSnapshot };
