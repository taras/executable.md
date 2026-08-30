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
import { createAgentRegistry } from "../src/acpx-runtime.ts";
import type { EmbeddedAdapters } from "../src/adapter-snapshots.ts";
import {
  AdapterSnapshotError,
  createEmbeddedAdapters,
  embeddedAdapterIdentities,
  overlaidAdapterRegistry,
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

/** A recovery ticket somebody else took, staged by hand. */
function* plantTicket(
  claims: string,
  ticket: number,
  owner: { pid: number | undefined; host: string },
): Operation<void> {
  const directory = join(claims, String(ticket));
  yield* ensureDir(directory);
  yield* writeTextFile(join(directory, "owner"), `${JSON.stringify(owner)}\n`);
}

/** Which ticket numbers are taken, lowest first. */
function* takenTickets(claims: string): Operation<number[]> {
  return (yield* until(readdir(claims)))
    .map((name) => Number.parseInt(name, 10))
    .filter((ticket) => Number.isInteger(ticket))
    .sort((left, right) => left - right);
}

/** Wait until `ticket` has been taken, so a barrier is read from the claim. */
function* untilTicketTaken(claims: string, ticket: number): Operation<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if ((yield* takenTickets(claims)).includes(ticket)) {
      return;
    }
    yield* sleep(50);
  }
  throw new Error(`ticket ${ticket} was never taken under ${claims}`);
}

/**
 * A process that has certainly finished, for its certainly-dead pid.
 *
 * `--version` because this tier runs under Deno, Node and Bun and that is the
 * one argument vector all three accept. Inventing a pid instead could collide
 * with something live and make every case below lie.
 */
function endedProcess(): { status: number | null; pid: number } {
  const ended = spawnSync(process.execPath, ["--version"]);
  return { status: ended.status, pid: ended.pid };
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

  it("AM3: the overlay resolves the two embedded providers and delegates the rest", function* () {
    const root = yield* useRoot();
    const adapters = createEmbeddedAdapters(root);
    const baseline = createAgentRegistry();
    const registry = overlaidAdapterRegistry(adapters, baseline);

    // The two this build patches resolve to the snapshot, because only it names
    // the turn a Prompt completed.
    for (const provider of ["codex", "claude"]) {
      expect(registry.resolve(provider)).toBe(adapters.command(provider));
      expect(registry.resolve(provider)).not.toBe(baseline.resolve(provider));
    }

    // Everything else is ACPX's, byte for byte. Carrying a Codex adapter is not
    // a reason for a run to stop being able to use Gemini, and a registry that
    // refused one would be making a far larger claim than this work needs.
    expect(registry.resolve("gemini")).toBe(baseline.resolve("gemini"));
    // Names, not a new namespace: every built-in is still listed, and the
    // embedded two are among them rather than instead of them.
    const listed = registry.list();
    for (const name of baseline.list()) {
      expect(listed).toContain(name);
    }
    expect(listed).toContain("codex");
    expect(listed).toContain("claude");
    expect(listed.length).toBe(new Set(listed).size);
  });

  it("AM3b: a broken embedded snapshot refuses rather than falling back", function* () {
    const root = yield* useRoot();
    const baseline = createAgentRegistry();
    // Carries the two names, and cannot produce either. Exactly the state a
    // corrupt or unverifiable snapshot leaves: the override still owns the
    // agent, so the only honest answer is a refusal.
    const broken: EmbeddedAdapters = {
      providers: ["codex", "claude"],
      identity: (provider) => `xmd-embedded-adapter:${provider}:broken@0.0.0`,
      executablePath: () => {
        throw new AdapterSnapshotError("this snapshot cannot be verified");
      },
      command: () => {
        throw new AdapterSnapshotError("this snapshot cannot be verified");
      },
      // deno-lint-ignore require-yield
      *materialize(): Operation<void> {
        throw new AdapterSnapshotError("this snapshot cannot be verified");
      },
    };
    const registry = overlaidAdapterRegistry(broken, baseline);

    // Refused, and not silently answered with the published adapter — which
    // would complete every Prompt, retain nothing, and say nothing about why.
    const refused = yield* refusal(function* () {
      return registry.resolve("codex");
    });
    expect(refused).toBeInstanceOf(AdapterSnapshotError);
    // And the refusal is local to the override: a non-embedded agent still
    // resolves, so one broken snapshot does not take the registry with it.
    expect(registry.resolve("gemini")).toBe(baseline.resolve("gemini"));
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

  it("AM12: a recovery ticket left by a dead process is finished, not waited on", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const claims = `${target}.claims`;
    const adapters = createEmbeddedAdapters(root);

    // An invalid target, so recovery is required at all.
    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(join(target, "node_modules", "stale.txt"), "half an install\n");

    // A ticket whose owner is genuinely gone: a real process, run to
    // completion, whose pid is therefore dead. Inventing a number could collide
    // with a live process and make this test lie.
    const finished = endedProcess();
    expect(finished.status).toBe(0);
    yield* plantTicket(claims, 0, { pid: finished.pid, host: hostname() });

    yield* adapters.materialize("codex");

    // Finished and published, rather than waiting out an owner that is never
    // coming back. Without this, one process killed mid-recovery would wedge
    // the adapter permanently — the exact abandoned-state failure the recovery
    // path exists to remove.
    expect(yield* exists(adapters.executablePath("codex"))).toBe(true);
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(true);
    expect(yield* exists(join(target, "node_modules", "stale.txt"))).toBe(false);
    // Marked finished rather than removed. The number stays taken, which is
    // what stops it being handed to somebody arriving later.
    expect(yield* exists(join(claims, "0", "done"))).toBe(true);
  });

  it("AM13: a ticket held by a live process on this host is never finished", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const claims = `${target}.claims`;
    const adapters = createEmbeddedAdapters(root);

    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(join(target, "node_modules", "stale.txt"), "half an install\n");

    // This very process: alive by construction.
    yield* plantTicket(claims, 0, { pid: process.pid, host: hostname() });

    const attempt = yield* spawn(() => adapters.materialize("codex"));
    yield* sleep(300);

    // It waits. The ticket is outstanding and nothing has been removed or
    // published, because the owner is alive and may be mid-recovery.
    expect(yield* exists(join(claims, "0", "done"))).toBe(false);
    expect(yield* exists(join(target, "node_modules", "stale.txt"))).toBe(true);
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(false);
    yield* attempt.halt();
  });

  it("AM14: a ticket owned by another host is never finished", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const claims = `${target}.claims`;
    const adapters = createEmbeddedAdapters(root);

    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(join(target, "node_modules", "stale.txt"), "half an install\n");

    // A dead pid, but on a machine this host cannot ask about. Liveness is only
    // knowable locally, so this must be left alone rather than assumed gone.
    const finished = endedProcess();
    yield* plantTicket(claims, 0, { pid: finished.pid, host: `not-${hostname()}` });

    const attempt = yield* spawn(() => adapters.materialize("codex"));
    yield* sleep(300);

    expect(yield* exists(join(claims, "0", "done"))).toBe(false);
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(false);
    yield* attempt.halt();
  });

  it("AM15: a ticket whose record says nothing is not read as free, and nothing is touched", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const stale = join(target, "node_modules", "stale.txt");
    const claims = `${target}.claims`;

    let cleanups = 0;
    const adapters = createEmbeddedAdapters(root, {
      // deno-lint-ignore require-yield
      *beforeRecoveryCleanup(): Operation<void> {
        cleanups += 1;
      },
    });

    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(stale, "half an install\n");
    // A ticket taken, holding a record that says nothing — what a truncated or
    // half-flushed write would leave behind. The protocol itself cannot produce
    // it, because a ticket is complete before it is visible, which is exactly
    // why finding one has to stop rather than be explained away as free.
    yield* ensureDir(join(claims, "0"));
    yield* writeTextFile(join(claims, "0", "owner"), "");

    const refused = yield* refusal(() => adapters.materialize("codex"));

    // Refused, and named, rather than waited out or stepped over. This host
    // cannot tell whether somebody is still using it, and guessing either way
    // is worse than saying so.
    expect(refused).toBeInstanceOf(AdapterSnapshotError);
    expect((refused as Error).message).toContain("cannot be read");
    // Nothing was entered and nothing was moved.
    expect(cleanups).toBe(0);
    expect(yield* exists(stale)).toBe(true);
    expect(yield* exists(join(claims, "0", "done"))).toBe(false);
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(false);
  });

  it("AM16: a ticket holding a foreign record is left alone for the same reason", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const claims = `${target}.claims`;

    let cleanups = 0;
    const adapters = createEmbeddedAdapters(root, {
      // deno-lint-ignore require-yield
      *beforeRecoveryCleanup(): Operation<void> {
        cleanups += 1;
      },
    });

    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(join(target, "node_modules", "stale.txt"), "half an install\n");
    // Readable, but not a record this build wrote — so its owner is unknown,
    // which is not the same as absent.
    yield* ensureDir(join(claims, "0"));
    yield* writeTextFile(join(claims, "0", "owner"), `${JSON.stringify({ something: "else" })}\n`);

    const refused = yield* refusal(() => adapters.materialize("codex"));

    expect(refused).toBeInstanceOf(AdapterSnapshotError);
    expect(cleanups).toBe(0);
    expect(yield* exists(join(claims, "0", "done"))).toBe(false);
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(false);
  });

  it("AM17: waiting out a live ticket never reaches cleanup or mutates the target", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const stale = join(target, "node_modules", "stale.txt");
    const claims = `${target}.claims`;

    let cleanups = 0;
    const adapters = createEmbeddedAdapters(root, {
      // deno-lint-ignore require-yield
      *beforeRecoveryCleanup(): Operation<void> {
        cleanups += 1;
      },
    });

    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(stale, "half an install\n");
    // This process: alive for the whole test, so the ticket is never finishable
    // and the attempt can only wait.
    yield* plantTicket(claims, 0, { pid: process.pid, host: hostname() });

    const attempt = yield* spawn(() => adapters.materialize("codex"));
    yield* sleep(400);

    // Never enters the critical section without the claim: the cleanup
    // observer is the first thing inside it, and it has not been reached.
    expect(cleanups).toBe(0);
    expect(yield* exists(stale)).toBe(true);
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(false);
    yield* attempt.halt();
  });

  it("AM18: an attempt arriving after a holder is elected cannot precede it", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const claims = `${target}.claims`;

    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(join(target, "node_modules", "stale.txt"), "half an install\n");

    let cleanups = 0;
    const elected = withResolvers<void>();
    const release = withResolvers<void>();
    const holder = createEmbeddedAdapters(root, {
      *beforeRecoveryCleanup(): Operation<void> {
        cleanups += 1;
        elected.resolve();
        yield* release.operation;
      },
    });
    const later = createEmbeddedAdapters(root, {
      // deno-lint-ignore require-yield
      *beforeRecoveryCleanup(): Operation<void> {
        cleanups += 1;
      },
    });

    const first = yield* spawn(() => holder.materialize("codex"));
    yield* elected.operation;
    // The holder is inside the critical section, and its ticket is the only one
    // outstanding.
    expect(yield* takenTickets(claims)).toEqual([0]);

    // The second attempt arrives strictly afterwards, and the question this
    // case exists for is whether it can end up ahead. Waited for by its ticket
    // rather than by a clock: it stages a whole install before it reaches the
    // claim at all, so a fixed pause would be measuring npm.
    const second = yield* spawn(() => later.materialize("codex"));
    yield* untilTicketTaken(claims, 1);
    yield* sleep(200);

    // It cannot, and not by luck. Numbers are handed out in ascending order and
    // never handed out twice, so an arrival can only ever sit behind an elected
    // holder. Ordering by name could not promise that: two claims made in the
    // same millisecond were separated only by a random suffix, and a clock
    // adjustment could give a later arrival an earlier name — either of which
    // put a second attempt in front of a holder already in the cleanup.
    expect(yield* takenTickets(claims)).toEqual([0, 1]);
    expect(cleanups).toBe(1);
    expect(yield* exists(join(target, "node_modules", "stale.txt"))).toBe(true);
    expect(yield* exists(join(target, ".xmd-adapter"))).toBe(false);

    release.resolve();
    yield* all([first, second]);

    // Only ever one cleanup: the arrival waited out the barrier and then read
    // what the holder published rather than recovering over it.
    expect(cleanups).toBe(1);
    expect(yield* exists(later.executablePath("codex"))).toBe(true);
    expect(yield* exists(join(target, "node_modules", "stale.txt"))).toBe(false);
    // Both numbers stay taken after their holders are finished with them. That
    // is the whole barrier: 0 can never be issued again, so nothing that comes
    // later can acquire a number below one already elected.
    expect(yield* exists(join(claims, "0", "done"))).toBe(true);
    expect(yield* exists(join(claims, "1", "done"))).toBe(true);
  });

  it("AM19: two attempts racing one abandoned ticket leave exactly one holder", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const claims = `${target}.claims`;

    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(join(target, "node_modules", "stale.txt"), "half an install\n");

    const dead = endedProcess();
    yield* plantTicket(claims, 0, { pid: dead.pid, host: hostname() });

    // Both find the same abandoned ticket and both finish it. Only one of them
    // can then be the lowest outstanding number, so only one enters the
    // cleanup — which a claim keyed on a reusable name could not guarantee,
    // because both could take it in turn and each believe it held it.
    let cleanups = 0;
    const observers = {
      *beforeRecoveryCleanup(): Operation<void> {
        cleanups += 1;
        yield* sleep(50);
      },
    };
    const first = createEmbeddedAdapters(root, observers);
    const second = createEmbeddedAdapters(root, observers);

    const a = yield* spawn(() => first.materialize("codex"));
    const b = yield* spawn(() => second.materialize("codex"));
    yield* all([a, b]);

    expect(cleanups).toBe(1);
    expect(yield* exists(first.executablePath("codex"))).toBe(true);
    expect(yield* exists(join(target, "node_modules", "stale.txt"))).toBe(false);
  });

  it("AM20: an attempt elected behind a finished holder answers from its publication", function* () {
    const root = yield* useRoot();
    const target = join(root, digestOf("codex"));
    const claims = `${target}.claims`;

    // A valid published tree, built elsewhere, ready to drop in.
    const donorRoot = yield* useRoot();
    const donor = createEmbeddedAdapters(donorRoot);
    yield* donor.materialize("codex");
    const donorTree = join(donorRoot, digestOf("codex"));

    // Abandoned work at the target, so the attempt takes the recovery path.
    yield* ensureDir(join(target, "node_modules"));
    yield* writeTextFile(join(target, "node_modules", "stale.txt"), "half an install\n");

    // A live ticket ahead, so the attempt has to wait at least one pass.
    yield* plantTicket(claims, 0, { pid: process.pid, host: hostname() });

    // The window AM19 can only reach by scheduling luck, produced exactly: the
    // holder ahead publishes and finishes its ticket after this attempt last
    // read the target and before its next election pass. The next election
    // elects this attempt — and being elected must mean reading what the
    // finished holder published, never a second recovery over it.
    let cleanups = 0;
    let elections = 0;
    const adapters = createEmbeddedAdapters(root, {
      *beforeRecoveryCleanup(): Operation<void> {
        cleanups += 1;
      },
      *beforeRecoveryElection(): Operation<void> {
        elections += 1;
        if (elections === 2) {
          yield* rm(target, { recursive: true, force: true });
          yield* until(cp(donorTree, target, { recursive: true }));
          yield* until(writeFile(join(claims, "0", "done"), ""));
        }
      },
    });

    const entry = adapters.executablePath("codex");
    yield* adapters.materialize("codex");

    expect(elections).toBeGreaterThanOrEqual(2);
    expect(cleanups).toBe(0);
    expect(yield* exists(entry)).toBe(true);
    expect(yield* until(readFile(entry))).toEqual(
      yield* until(readFile(join(donorTree, "node_modules", CODEX_PACKAGE, "dist", "index.js"))),
    );
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
