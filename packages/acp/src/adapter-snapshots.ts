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
 * an exclusive claim, and the holder re-checks under it before removing
 * anything.
 *
 * The claim is a ticket: the directory `claims/<n>`, taken by renaming a
 * prepared directory onto that name, which only one attempt can win and which
 * is never handed out a second time.
 *
 * Two properties come from that, and the claim needs both. Because numbers are
 * never reissued, finishing a dead holder's ticket can only ever act on the
 * exact ticket that was inspected. Because they are taken in ascending order,
 * an attempt arriving later cannot obtain a lower number, so it cannot come to
 * precede a holder that has already been elected.
 *
 * The holder is the lowest ticket still outstanding. Releasing is marking one
 * finished, and a process killed mid-recovery leaves a ticket whose owner a
 * later attempt reads as dead and finishes on its behalf.
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
import { readdir, readFile, rename as renamePath, rm as rmPath, writeFile } from "node:fs/promises";
import { exec, useQuietProcessOutput } from "@executablemd/runtime";
import { createAgentRegistry } from "./acpx-runtime.ts";
import type { AcpAgentRegistry } from "./acpx-runtime.ts";
import { ensure, type Operation, scoped, sleep } from "effection";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import process from "node:process";
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

/** Inside a ticket: who took it, and whether it is finished with. */
const OWNER = "owner";
const DONE = "done";

/** A ceiling on ticket numbers, so a pathological claims directory cannot spin. */
const MAX_TICKETS = 10_000;

/** Who holds a recovery claim, so a later attempt can tell live from dead. */
interface RecoveryOwner {
  readonly pid: number;
  readonly host: string;
  readonly at: number;
}

function parseOwner(raw: string): RecoveryOwner | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    const pid = Reflect.get(Object(value), "pid");
    const host = Reflect.get(Object(value), "host");
    if (typeof pid !== "number" || typeof host !== "string") {
      return undefined;
    }
    return { pid, host, at: 0 };
  } catch {
    return undefined;
  }
}

/**
 * Whether a process still exists on this host.
 *
 * Signal 0 asks without delivering anything. `EPERM` means it exists and
 * belongs to somebody else, which is still alive; only `ESRCH` means gone. An
 * answer this cannot interpret is treated as alive, so an unreadable state
 * never becomes a reason to take somebody's claim.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") !== "ESRCH";
  }
}

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
   * Take the next free ticket, and answer with its number.
   *
   * A ticket is the directory `claims/<n>`. It is prepared complete elsewhere
   * and renamed into place, because a rename will not replace a directory that
   * has anything in it — so exactly one attempt can take any given number, and a
   * ticket is never visible half-made.
   *
   * A number, once taken, is never given out again: the directory stays after
   * its holder has finished with it. That is the guarantee the election rests
   * on. An attempt arriving later cannot obtain a number below one already
   * taken, so it cannot come to sit ahead of a holder.
   *
   * Ordering names by time could not offer that. Two claims made in the same
   * millisecond were separated only by the random part of their names, and a
   * clock adjustment could hand a later arrival an earlier name — either way an
   * elected holder could be preceded after the fact.
   */
  function* takeTicket(claims: string): Operation<number> {
    yield* ensureDir(claims);
    const staging = join(claims, `.taking-${randomUUID()}`);
    yield* ensureDir(staging);
    yield* ensure(() => until(rmPath(staging, { recursive: true, force: true }).catch(() => {})));

    const owner: RecoveryOwner = { pid: process.pid, host: hostname(), at: Date.now() };
    yield* until(writeFile(join(staging, OWNER), `${JSON.stringify(owner)}\n`));

    for (let ticket = 0; ticket < MAX_TICKETS; ticket += 1) {
      try {
        yield* until(renamePath(staging, join(claims, String(ticket))));
      } catch {
        continue;
      }
      return ticket;
    }
    throw new AdapterSnapshotError(
      `recovery for this adapter has been claimed ${MAX_TICKETS} times under ${claims} without ` +
        "finishing. Remove that directory by hand once nothing is using the adapter.",
    );
  }

  /** Finish one ticket. The number itself is never handed out again. */
  function* releaseTicket(claims: string, ticket: number): Operation<void> {
    yield* until(writeFile(join(claims, String(ticket), DONE), "").catch(() => {}));
  }

  /**
   * Whether this attempt now holds the claim.
   *
   * The holder is the lowest ticket still outstanding, so every number below
   * this attempt's own is examined in order: a finished ticket is passed over, a
   * ticket whose owner is a dead process on this host is finished here, and a
   * live owner, an owner on another machine, or a record that cannot be read
   * each stop the election where it stands. The last one says so, because
   * refusing to act on what it cannot read is the only safe reading of somebody
   * else's claim.
   *
   * Finishing a dead holder's ticket is safe for the reason the election is:
   * the number is never reissued, so this can only ever act on the exact ticket
   * it just read.
   */
  function* electTicket(
    claims: string,
    mine: number,
  ): Operation<"held" | "waiting" | "unreadable"> {
    let ahead: number[];
    try {
      ahead = (yield* until(readdir(claims)))
        .map((name) => Number.parseInt(name, 10))
        .filter((ticket) => Number.isInteger(ticket) && ticket < mine)
        .sort((left, right) => left - right);
    } catch {
      return "waiting";
    }

    for (const ticket of ahead) {
      const holder = join(claims, String(ticket));
      if (yield* exists(join(holder, DONE))) {
        continue;
      }
      let owner: RecoveryOwner | undefined;
      try {
        owner = parseOwner(yield* readTextFile(join(holder, OWNER)));
      } catch {
        // A ticket is complete before it is visible, so there is no reading of
        // this that says the claim ahead is free.
        return "unreadable";
      }
      if (owner === undefined) {
        return "unreadable";
      }
      if (owner.host !== hostname() || alive(owner.pid)) {
        return "waiting";
      }
      yield* releaseTicket(claims, ticket);
    }
    return "held";
  }

  /**
   * Replace an abandoned tree at the target, holding an exclusive claim.
   *
   * Reached only when the rename failed and what is there does not verify. The
   * claim makes "check, then remove" one decision instead of two: without it, a
   * second attempt could publish a valid tree in the gap and this one would
   * delete it, taking the files out from under an adapter that had already
   * resolved and might already be running.
   *
   * An attempt that does not hold the claim never removes anything. It waits
   * and answers from what the holder published.
   */
  function* recover(
    snapshot: EmbeddedAdapterSnapshot,
    staging: string,
    target: string,
    failure: unknown,
  ): Operation<void> {
    const claims = `${target}.claims`;
    // Explicit, because the cleanup below is unreachable without it.
    let held = false;
    let settled = false;

    yield* scoped(function* () {
      const mine = yield* takeTicket(claims);
      // Registered before the wait it guards, so a halt anywhere below still
      // takes this attempt out of the election.
      yield* ensure(() => releaseTicket(claims, mine));

      for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt += 1) {
        const status = yield* electTicket(claims, mine);
        if (status === "unreadable") {
          throw new AdapterSnapshotError(
            `a recovery ticket under ${claims} cannot be read, so this host cannot tell whether ` +
              "another process is still using it. Remove it by hand once nothing is.",
          );
        }
        if (status === "held") {
          held = true;
          break;
        }
        yield* sleep(RECOVERY_POLL_MS);
        if (yield* published(snapshot)) {
          settled = true;
          return;
        }
      }

      if (!held) {
        return;
      }

      yield* scoped(function* () {
        const observe = observers.beforeRecoveryCleanup;
        if (observe !== undefined) {
          yield* observe();
        }
        // Asked again while holding the claim, because the answer from before
        // it may have gone stale in exactly the window this claim closes.
        if (yield* published(snapshot)) {
          settled = true;
          return;
        }
        yield* rm(target, { recursive: true, force: true });
        yield* until(renamePath(staging, target));
        settled = true;
      });
    });

    if (!held && !settled) {
      throw failure;
    }
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
          yield* until(renamePath(staging, target));
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
 * ACPX's own agent registry, with this host's embedded adapters over the top.
 *
 * An overlay, not a replacement. The two providers this build carries a patched
 * snapshot for resolve to that snapshot, because only it names the turn it just
 * completed. Every other agent resolves exactly as it did before any of this
 * existed — ACPX's registry, ACPX's command — because nothing about carrying a
 * Codex adapter is a reason to stop a run from using Gemini.
 *
 * A closed registry was the wrong shape for the same reason. It made "this
 * build has no Codex snapshot problem to solve for Gemini" into "this build
 * refuses Gemini", which is a much larger claim than the one being made, and it
 * would have changed the retained identity of agents the checkpoint work has
 * nothing to say about.
 *
 * The overlay is *qualified*: an embedded provider never falls through. A
 * snapshot that cannot be verified or materialized refuses the agent, and does
 * not quietly become the published adapter that names no turn — finding out by
 * retaining nothing is the failure this exists to remove.
 *
 * `resolve` answers without touching the disk on both paths. The embedded
 * command is the snapshot's digest beneath a known root, so it is settled by
 * the bytes this build carries, which is what lets a session key be derived
 * before anything has been materialized.
 */
export function overlaidAdapterRegistry(
  adapters: EmbeddedAdapters,
  baseline: AcpAgentRegistry = createAgentRegistry(),
): AcpAgentRegistry {
  const embedded = new Set(adapters.providers);
  return {
    resolve: (agentName: string) =>
      embedded.has(agentName) ? adapters.command(agentName) : baseline.resolve(agentName),
    // Both, deduplicated: the embedded providers are ACPX names this build
    // resolves differently, not names it adds.
    list: () => [...new Set([...baseline.list(), ...adapters.providers])],
  };
}

/** Whether this build carries an embedded adapter for `agentName`. */
export function carriesEmbeddedAdapter(adapters: EmbeddedAdapters, agentName: string): boolean {
  return adapters.providers.includes(agentName);
}

/** Every embedded snapshot's identity, for provenance checks and diagnostics. */
export function embeddedAdapterIdentities(): readonly EmbeddedAdapterSnapshot[] {
  return EMBEDDED_ADAPTER_SNAPSHOTS;
}

export type { EmbeddedAdapterSnapshot };
