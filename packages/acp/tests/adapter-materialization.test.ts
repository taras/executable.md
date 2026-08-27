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
import {
  AdapterSnapshotError,
  createEmbeddedAdapters,
  embeddedAdapterIdentities,
  embeddedAdapterRegistry,
} from "../src/adapter-snapshots.ts";

function* useRoot(): Operation<string> {
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-am-")));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  return root;
}

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
    expect(yield* exists(adapters.command("codex").slice("node ".length))).toBe(true);
  });

  it("AM5: a marker naming another snapshot is damage, not a cache hit", function* () {
    const root = yield* useRoot();
    const adapters = createEmbeddedAdapters(root);
    const directory = join(root, digestOf("codex"));
    yield* ensureDir(directory);
    yield* writeTextFile(join(directory, ".xmd-adapter"), `${"0".repeat(64)}\n`);

    const refused = yield* refusal(() => adapters.materialize("codex"));

    expect(refused).toBeInstanceOf(AdapterSnapshotError);
    expect((refused as Error).message).toContain("rather than");
  });

  it("AM6: a real install materializes, verifies, and is idempotent", function* () {
    const root = yield* useRoot();
    const adapters = createEmbeddedAdapters(root);

    yield* adapters.materialize("codex");

    const entry = adapters.command("codex").slice("node ".length);
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
    expect(yield* exists(adapters.command("codex").slice("node ".length))).toBe(true);
  });
});
