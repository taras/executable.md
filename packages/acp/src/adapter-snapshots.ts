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
 * ## Identity is not the launch path
 *
 * Two different things are needed, and conflating them was a defect: an adapter
 * has a **stable identity** — its provider, package, version and snapshot
 * digest — and a **host-local launch path** under whatever root this machine
 * materialized into.
 *
 * Only the identity is durable. It is what a retained Agent session records and
 * what a sealed artifact carries, so two machines running the same snapshot
 * agree, and a run exported from one is readable on the other. The path appears
 * nowhere durable: it names a directory that exists on one host, and putting it
 * in an artifact would make where a file happened to live a compatibility term.
 *
 * The launch path is quoted, because a root containing a space is an ordinary
 * thing on a developer's machine and an unquoted command would split there.
 *
 * ## Published atomically, verified before use
 *
 * Materialization happens in a private temporary directory and is published by
 * one rename. A concurrent run either wins that rename or finds the directory
 * already there — both then verify before using it, so nobody executes a tree
 * another process is still filling.
 *
 * Replacing an *abandoned* tree is the one step that cannot be done by rename
 * alone, because a rename will not overwrite a non-empty directory. Removing it
 * first is a decision that goes stale: another attempt may publish a valid tree
 * between the observation and the removal, and deleting that would pull the
 * files out from under an adapter already running. So recovery is serialized on
 * an exclusive lock — `mkdir` is atomic, and exactly one attempt gets it — and
 * the holder re-checks under the lock before removing anything.
 *
 * ## It refuses; it never falls back
 *
 * A digest that does not match, an extraction that fails, a dependency install
 * that fails, a missing entry file: each raises. Running the published adapter
 * instead would be running one that emits no token, which is the state this
 * exists to leave — silently, and after the run had already been told it was
 * continuing an exact conversation.
 */

import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { mkdir, readdir, readFile, rmdir } from "node:fs/promises";
import { exec, useQuietProcessOutput } from "@executablemd/runtime";
import type { AcpAgentRegistry } from "./acpx-runtime.ts";
import { ensure, type Operation, scoped, sleep } from "effection";
import { Buffer } from "node:buffer";
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
 *
 * It carries two digests, not one: the snapshot this directory was published
 * for, and the content of the adapter package as installed. The second is what
 * makes a cache hit mean anything — a marker alone says only that some attempt
 * finished here, and the JavaScript beside it could have been edited since.
 */
const MARKER = ".xmd-adapter";

/** How long an attempt waits on somebody else's recovery, and how often. */
const RECOVERY_POLL_MS = 25;
const RECOVERY_ATTEMPTS = 400;

/** What one materialized directory recorded about itself. */
interface Published {
  readonly snapshot: string;
  readonly content: string;
}

function parseMarker(raw: string): Published | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    const snapshot = Reflect.get(Object(value), "snapshot");
    const content = Reflect.get(Object(value), "content");
    if (typeof snapshot !== "string" || typeof content !== "string") {
      return undefined;
    }
    return { snapshot, content };
  } catch {
    return undefined;
  }
}

export interface EmbeddedAdapters {
  /** Every provider this host carries an adapter for. */
  readonly providers: readonly string[];
  /**
   * What this adapter *is*, independent of where this host put it.
   *
   * The durable half: provider, package, version and snapshot digest, and
   * nothing about this machine. A retained Agent session records this and a
   * sealed artifact carries it, so the same snapshot compares equal wherever it
   * was materialized.
   */
  identity(provider: string): string;
  /**
   * Where this host will execute one provider's adapter from.
   *
   * The path on its own, for a caller that needs to inspect or verify it rather
   * than launch it. Host-local like {@link EmbeddedAdapters.command}, and
   * retained nowhere.
   */
  executablePath(provider: string): string;
  /**
   * The command that launches one provider's embedded adapter here.
   *
   * The host-local half, and never retained. Answers before the adapter is on
   * disk, because the path is the snapshot's digest beneath a known root. The
   * path is quoted: a materialization root may contain a space, and an unquoted
   * command would split there.
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
  // `node:buffer` rather than a JSR encoding module: this is production code and
  // has to decode identically under Deno, the dnt npm artifact and Bun.
  const bytes = new Uint8Array(Buffer.from(snapshot.base64, "base64"));
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
  return join(installedPackage(root, snapshot), "dist", "index.js");
}

/** The adapter package itself, as npm unpacked it from the snapshot. */
function installedPackage(root: string, snapshot: EmbeddedAdapterSnapshot): string {
  return join(root, snapshot.sha256, "node_modules", snapshot.package);
}

/**
 * A digest over the adapter package's own installed content.
 *
 * The adapter, not its dependency tree. Those belong to npm, legitimately vary
 * between resolutions, and hashing them would make an ordinary reinstall look
 * like tampering. What this covers is the code this repository vendored and
 * this host executes.
 *
 * Path and bytes together, in one deterministic order, so a renamed file is as
 * visible as an edited one.
 */
function* contentDigest(directory: string): Operation<string> {
  const digest = createHash("sha256");
  const walk = function* (current: string, prefix: string): Operation<void> {
    const entries = yield* until(readdir(current, { withFileTypes: true }));
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const at = join(current, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        digest.update(`d:${name}\n`);
        yield* walk(at, `${name}/`);
        continue;
      }
      const bytes = yield* until(readFile(at));
      digest.update(`f:${name}:${bytes.byteLength}\n`);
      digest.update(bytes);
    }
  };
  yield* walk(directory, "");
  return digest.digest("hex");
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
 * What a suite may observe between the steps of a recovery.
 *
 * Dependency injection, deliberately, rather than anything a scope can reach:
 * supplied by whoever constructs the materializer and by nobody else. It exists
 * because the ordering this guards against cannot otherwise be produced — a
 * second attempt has to publish in the exact window between one attempt's
 * observation and its removal, and ordinary scheduling will not reliably put it
 * there. `PrivateWorkspaceOptions.decorateFilesystem` exists for the same
 * reason.
 */
export interface EmbeddedAdapterObservers {
  /** Runs after a recovery takes its lock and before it removes anything. */
  readonly beforeRecoveryCleanup?: () => Operation<void>;
}

/**
 * The embedded adapters, materializing beneath `root`.
 *
 * `root` is host-owned private state. Nothing a document can name reaches it,
 * and nothing here reads anything back out of it except the adapter it just
 * verified.
 */
export function createEmbeddedAdapters(
  root: string,
  observers: EmbeddedAdapterObservers = {},
): EmbeddedAdapters {
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

  /**
   * Whether a verified adapter is already on disk for this snapshot.
   *
   * Three questions, in order: is there a marker, does it name this snapshot,
   * and does the installed package still hash to what that marker recorded. The
   * third is the one that matters on a cache hit — without it, JavaScript
   * edited after publication runs unchallenged under a marker that still looks
   * right.
   *
   * A marker naming another snapshot is damage and raises. Content that no
   * longer matches is *not* treated as damage: the directory is abandoned work
   * as far as this host is concerned, so it answers false and lets
   * materialization replace it.
   */
  function* published(snapshot: EmbeddedAdapterSnapshot): Operation<boolean> {
    const directory = join(root, snapshot.sha256);
    const marker = join(directory, MARKER);
    if (!(yield* exists(marker))) {
      return false;
    }
    const recorded = parseMarker(yield* readTextFile(marker));
    if (recorded === undefined) {
      return false;
    }
    // The marker names what it published. A directory carrying another
    // snapshot's name under this digest is damage, not a cache hit.
    if (recorded.snapshot !== snapshot.sha256) {
      throw new AdapterSnapshotError(
        `the materialized ${snapshot.provider} adapter at ${directory} records ` +
          `${recorded.snapshot} rather than ${snapshot.sha256}`,
      );
    }
    if (!(yield* exists(entryPoint(root, snapshot)))) {
      return false;
    }
    return (yield* contentDigest(installedPackage(root, snapshot))) === recorded.content;
  }

  /**
   * Replace an abandoned tree at the target, under an exclusive lock.
   *
   * Reached only when the rename failed and what is there does not verify.
   * The lock makes "check, then remove" one decision instead of two: without
   * it, a second attempt could publish a valid tree in the gap and this one
   * would delete it, taking the files out from under an adapter that had
   * already resolved and might already be running.
   *
   * An attempt that does not get the lock never removes anything. It waits
   * for the holder and then answers from what the holder published.
   */
  function* recover(
    snapshot: EmbeddedAdapterSnapshot,
    staging: string,
    target: string,
    failure: unknown,
  ): Operation<void> {
    const lock = `${target}.recovering`;
    let held = false;
    try {
      // Atomic across processes: exactly one `mkdir` of a given name wins.
      yield* until(mkdir(lock));
      held = true;
    } catch {
      held = false;
    }

    if (!held) {
      // Somebody else is recovering. Wait for them rather than racing, and
      // take whatever they published.
      for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt += 1) {
        yield* sleep(RECOVERY_POLL_MS);
        if (yield* published(snapshot)) {
          return;
        }
      }
      throw failure;
    }

    yield* scoped(function* () {
      yield* ensure(() => until(rmdir(lock).catch(() => {})));
      const observe = observers.beforeRecoveryCleanup;
      if (observe !== undefined) {
        yield* observe();
      }
      // Asked again under the lock, because the answer from before it may
      // have gone stale in exactly the window this lock closes.
      if (yield* published(snapshot)) {
        return;
      }
      yield* rm(target, { recursive: true, force: true });
      yield* until(rename(staging, target));
    });
  }

  return {
    providers: [...byProvider.keys()],

    identity(provider: string): string {
      const snapshot = snapshotFor(provider);
      return `xmd-embedded-adapter:${snapshot.provider}:${snapshot.package}@${snapshot.version}+${snapshot.sha256}`;
    },

    executablePath(provider: string): string {
      return entryPoint(root, snapshotFor(provider));
    },

    command(provider: string): string {
      // Quoted, and with any embedded quote escaped: ACPX splits this command
      // line, and a root holding a space or a quote would otherwise become two
      // arguments or an unterminated one.
      const path = entryPoint(root, snapshotFor(provider)).replaceAll('"', '\\"');
      return `node "${path}"`;
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
        // Recorded from what was actually installed, so a later read compares
        // the bytes it is about to execute rather than a claim about them.
        const content = yield* contentDigest(join(staging, "node_modules", snapshot.package));
        yield* writeTextFile(
          join(staging, MARKER),
          `${JSON.stringify({ snapshot: snapshot.sha256, content })}\n`,
        );

        try {
          // The ordinary path, and lock-free: one rename publishes every byte at
          // once, and it simply fails if anything is already there.
          yield* until(rename(staging, target));
          return;
        } catch (error) {
          if (yield* published(snapshot)) {
            // Another attempt got there first with a tree that verifies. Its
            // work is as good as this one's, and this staging tree is removed
            // by the ensure above.
            return;
          }
          yield* recover(snapshot, staging, target, error);
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
