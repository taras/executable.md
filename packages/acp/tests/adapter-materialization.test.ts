/**
 * Tier AM — putting an embedded adapter on disk
 * (packages/acp/src/adapter-snapshots.ts).
 *
 * The bytes are proven byte-level by Tier AD. What these ask is what happens
 * around them: that a snapshot is verified before anything executes from it,
 * that a half-written tree is never mistaken for a finished one, that two runs
 * racing converge on one directory, and that every failure refuses rather than
 * falling back to a published adapter that names no turn.
 *
 * The install is real. `npm` resolves the adapter's own dependency tree here,
 * which is what a run does, and is why these carry their own timeout.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { all, ensure, spawn, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  AdapterSnapshotError,
  createEmbeddedAdapters,
  embeddedAdapterIdentities,
  embeddedAdapterRegistry,
} from "../src/adapter-snapshots.ts";
import { cp, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { sleep, withResolvers } from "effection";

function* useRoot(): Operation<string> {
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-am-")));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** The package a materialized Codex adapter is installed as. */
const CODEX_PACKAGE = "@agentclientprotocol/codex-acp";

/** The digest one provider's snapshot materializes under. */
function digestOf(provider: string): string {
  const snapshot = embeddedAdapterIdentities().find((each) => each.provider === provider);
  if (snapshot === undefined) {
    throw new Error(`no embedded snapshot for ${provider}`);
  }
  return snapshot.sha256;
}

/** What a failed operation raised, as a value rather than a throw. */
function* refusal(body: () => Operation<unknown>): Operation<unknown> {
  try {
    yield* body();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("Tier AM — embedded adapter materialization", () => {
  it("AM1: the command is content-addressed and answers before anything is on disk", function* () {
    const root = yield* useRoot();
    const adapters = createEmbeddedAdapters(root);

    const command = adapters.command("codex");

    // Known from the bytes, not from the filesystem: a session key is derived
    // from this command before the adapter has been installed.
    expect(command).toContain(digestOf("codex"));
    expect(command.startsWith("node ")).toBe(true);
    expect(yield* until(readdir(root))).toEqual([]);
  });

  it("AM2: an agent this build carries no snapshot for is refused", function* () {
    const root = yield* useRoot();
    const adapters = createEmbeddedAdapters(root);

    const named = yield* refusal(function* () {
      return adapters.command("gemini");
    });
    const materialized = yield* refusal(() => adapters.materialize("gemini"));

    // Both halves refuse. Answering with a command for an agent this host has
    // no snapshot for would resolve to a path that never appears, and the
    // failure would surface as a spawn error long after the decision.
    expect(named).toBeInstanceOf(AdapterSnapshotError);
    expect(materialized).toBeInstanceOf(AdapterSnapshotError);
  });

  it("AM3: the closed registry lists exactly the embedded providers", function* () {
    const root = yield* useRoot();
    const registry = embeddedAdapterRegistry(createEmbeddedAdapters(root));

    expect(registry.list().sort()).toEqual(["claude", "codex"]);
    // Not a fall-through to ACPX's own registry, which knows a dozen names and
    // resolves each to whatever `npx` would fetch.
    expect(
      yield* refusal(function* () {
        return registry.resolve("openclaw");
      }),
    ).toBeInstanceOf(AdapterSnapshotError);
  });

  it("AM4: an abandoned tree is replaced rather than adopted or wedged", function* () {
    const root = yield* useRoot();
    const adapters = createEmbeddedAdapters(root);
    const directory = join(root, digestOf("codex"));
    // Exactly what an attempt killed part-way through leaves: the right path,
    // holding a plausible-looking tree and nothing that proves what it is.
    yield* ensureDir(join(directory, "node_modules"));
    yield* writeTextFile(join(directory, "node_modules", "stale.txt"), "half a install\n");

    yield* adapters.materialize("codex");

    // Not adopted — nothing executes from a tree that never proved itself. Not
    // wedged either: a rename cannot replace a non-empty directory, so leaving
    // it would have made one crashed run poison this adapter permanently.
    expect(yield* exists(join(directory, ".xmd-adapter"))).toBe(true);
    expect(yield* exists(join(directory, "node_modules", "stale.txt"))).toBe(false);
    expect(yield* exists(adapters.executablePath("codex"))).toBe(true);
  });

  it("AM5: a marker naming another snapshot is damage, not a cache hit", function* () {
    const root = yield* useRoot();
    const adapters = createEmbeddedAdapters(root);
    const directory = join(root, digestOf("codex"));
    yield* ensureDir(directory);
    yield* writeTextFile(
      join(directory, ".xmd-adapter"),
      `${JSON.stringify({ snapshot: "0".repeat(64), content: "0".repeat(64) })}\n`,
    );

    const refused = yield* refusal(() => adapters.materialize("codex"));

    expect(refused).toBeInstanceOf(AdapterSnapshotError);
    expect((refused as Error).message).toContain("rather than");
  });

  it("AM6: a real install materializes, verifies, and is idempotent", function* () {
    const root = yield* useRoot();
    const adapters = createEmbeddedAdapters(root);

    yield* adapters.materialize("codex");

    const entry = adapters.executablePath("codex");
    expect(yield* exists(entry)).toBe(true);
    expect(yield* exists(join(root, digestOf("codex"), ".xmd-adapter"))).toBe(true);

    // Asking again does nothing and still succeeds; a run reaches this on every
    // placement.
    yield* adapters.materialize("codex");
    expect(yield* exists(entry)).toBe(true);
    // No staging left behind on the happy path.
    const entries = yield* until(readdir(root));
    expect(entries.filter((name) => name.startsWith(".staging-"))).toEqual([]);
  });

  it("AM8: a recovery re-checks under its lock and never deletes what appeared", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));

    // A valid published tree, built elsewhere, ready to drop in.
    const donorRoot = yield* useRoot();
    const donor = createEmbeddedAdapters(donorRoot);
    yield* donor.materialize("codex");
    const donorTree = join(donorRoot, digestOf("codex"));

    // The exact ordering the lock exists for: the recovering attempt has
    // already decided the target is abandoned, and a valid tree appears in the
    // window before it acts on that decision.
    let appeared = false;
    const recovering = createEmbeddedAdapters(root, {
      *beforeRecoveryCleanup(): Operation<void> {
        yield* rm(target, { recursive: true, force: true });
        yield* until(cp(donorTree, target, { recursive: true }));
        appeared = true;
      },
    });

    // Abandoned work at the target, so the attempt takes the recovery path.
    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(join(target, "node_modules", "stale.txt"), "half an install\n");

    const entry = recovering.executablePath("codex");
    yield* recovering.materialize("codex");

    expect(appeared).toBe(true);
    // Re-checked under the lock, so the stale decision was not acted on: what
    // appeared is still there, byte for byte, and is what the adapter resolves
    // to. Removing it would have pulled the files out from under an adapter
    // another run had already resolved and might be running.
    expect(yield* exists(entry)).toBe(true);
    expect(yield* until(readFile(entry))).toEqual(
      yield* until(readFile(join(donorTree, "node_modules", CODEX_PACKAGE, "dist", "index.js"))),
    );
  });

  it("AM8b: a second attempt neither deletes nor publishes while a recovery holds the lock", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const stale = join(target, "node_modules", "stale.txt");

    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    const recovering = createEmbeddedAdapters(root, {
      *beforeRecoveryCleanup(): Operation<void> {
        entered.resolve();
        yield* release.operation;
      },
    });
    const other = createEmbeddedAdapters(root);

    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(stale, "half an install\n");

    const first = yield* spawn(() => recovering.materialize("codex"));
    yield* entered.operation;
    const second = yield* spawn(() => other.materialize("codex"));
    // Long enough for the second attempt to have tried and been turned away.
    yield* sleep(250);

    // It is waiting, not racing: it has removed nothing and published nothing
    // while somebody else holds the recovery.
    expect(yield* exists(stale)).toBe(true);
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(false);

    release.resolve();
    yield* all([first, second]);

    // Both converge on the one tree the holder published.
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(true);
    expect(yield* exists(stale)).toBe(false);
    expect(yield* exists(other.executablePath("codex"))).toBe(true);
  });

  it("AM12: a recovery claim left by a dead process is reclaimed, not waited on", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const adapters = createEmbeddedAdapters(root);

    // An invalid target, so recovery is required at all.
    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(join(target, "node_modules", "stale.txt"), "half an install\n");

    // A claim whose owner is genuinely gone: a real process, run to completion,
    // whose pid is therefore dead. Inventing a number could collide with a
    // live process and make this test lie.
    const finished = spawnSync(process.execPath, ["eval", "0"]);
    expect(finished.status).toBe(0);
    const deadPid = finished.pid;
    yield* writeTextFile(
      `${target}.recovering`,
      `${JSON.stringify({ pid: deadPid, host: hostname(), at: Date.now() })}\n`,
    );

    yield* adapters.materialize("codex");

    // Reclaimed and published, rather than waiting out an owner that is never
    // coming back. Without this, one process killed mid-recovery would wedge
    // the adapter permanently — the exact abandoned-state failure the recovery
    // path exists to remove.
    expect(yield* exists(adapters.executablePath("codex"))).toBe(true);
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(true);
    expect(yield* exists(join(target, "node_modules", "stale.txt"))).toBe(false);
    // The claim is not left lying around for the next attempt to puzzle over.
    expect(yield* exists(`${target}.recovering`)).toBe(false);
  });

  it("AM13: a claim held by a live process on this host is never taken", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const adapters = createEmbeddedAdapters(root);

    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(join(target, "node_modules", "stale.txt"), "half an install\n");

    // This very process: alive by construction.
    const lock = `${target}.recovering`;
    yield* writeTextFile(
      lock,
      `${JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() })}\n`,
    );

    const attempt = yield* spawn(() => adapters.materialize("codex"));
    yield* sleep(300);

    // It waits. The claim is untouched and nothing has been removed or
    // published, because the owner is alive and may be mid-recovery.
    expect(yield* exists(lock)).toBe(true);
    expect(yield* exists(join(target, "node_modules", "stale.txt"))).toBe(true);
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(false);
    yield* attempt.halt();
  });

  it("AM14: a claim owned by another host is never taken", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const adapters = createEmbeddedAdapters(root);

    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(join(target, "node_modules", "stale.txt"), "half an install\n");

    // A dead pid, but on a machine this host cannot ask about. Liveness is only
    // knowable locally, so this must be left alone rather than assumed gone.
    const finished = spawnSync(process.execPath, ["eval", "0"]);
    const lock = `${target}.recovering`;
    yield* writeTextFile(
      lock,
      `${JSON.stringify({ pid: finished.pid, host: `not-${hostname()}`, at: Date.now() })}\n`,
    );

    const attempt = yield* spawn(() => adapters.materialize("codex"));
    yield* sleep(300);

    expect(yield* exists(lock)).toBe(true);
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(false);
    yield* attempt.halt();
  });

  it("AM9: edited adapter bytes are refused rather than executed", function* () {
    const root = yield* useRoot();
    const adapters = createEmbeddedAdapters(root);
    yield* adapters.materialize("codex");
    const entry = adapters.executablePath("codex");
    const original = yield* until(readFile(entry));

    // The marker is untouched, so nothing about the directory *looks* wrong.
    // Only the bytes changed — which is the whole point: a cache hit that
    // checked a marker alone would run this.
    yield* until(writeFile(entry, `${original.toString("utf8")}\n// tampered\n`));

    yield* adapters.materialize("codex");

    // Rematerialized before use, back to exactly the recorded content.
    expect(yield* until(readFile(entry))).toEqual(original);
  });

  it("AM10: identity is stable across hosts; only the launch path is local", function* () {
    const plain = yield* useRoot();
    // A root with a space in it, which is ordinary on a developer's machine and
    // would split an unquoted command line.
    const spaced = join(yield* useRoot(), "Application Support", "xmd runs");
    yield* ensureDir(spaced);

    const here = createEmbeddedAdapters(plain);
    const there = createEmbeddedAdapters(spaced);

    // What a run retains and an artifact carries: identical, because it names
    // the snapshot rather than the machine.
    expect(there.identity("codex")).toBe(here.identity("codex"));
    expect(there.identity("claude")).toBe(here.identity("claude"));
    expect(here.identity("codex")).toContain(digestOf("codex"));
    expect(here.identity("codex")).not.toContain(plain);

    // What each host launches: its own, and quoted so the space survives.
    expect(there.executablePath("codex")).not.toBe(here.executablePath("codex"));
    expect(there.command("codex")).toContain('"');
    expect(there.command("codex")).toContain(spaced);
  });

  it("AM11: an adapter materializes and launches from a root containing a space", function* () {
    const root = join(yield* useRoot(), "Application Support", "xmd runs");
    yield* ensureDir(root);
    const adapters = createEmbeddedAdapters(root);

    yield* adapters.materialize("codex");

    // The path survives materialization, and the command ACPX would split
    // reduces to that exact single argument.
    expect(yield* exists(adapters.executablePath("codex"))).toBe(true);
    const command = adapters.command("codex");
    expect(command.startsWith('node "')).toBe(true);
    expect(command.slice('node "'.length, -1)).toBe(adapters.executablePath("codex"));
  });

  it("AM7: two concurrent materializations converge on one directory", function* () {
    const root = yield* useRoot();
    const adapters = createEmbeddedAdapters(root);

    const first = yield* spawn(() => adapters.materialize("codex"));
    const second = yield* spawn(() => adapters.materialize("codex"));
    yield* all([first, second]);

    // One published directory, and no staging orphaned by the loser of the
    // rename. Whichever attempt lost still verified what it found before
    // returning.
    const entries = yield* until(readdir(root));
    expect(entries).toEqual([digestOf("codex")]);
    expect(yield* exists(adapters.executablePath("codex"))).toBe(true);
  });
});
