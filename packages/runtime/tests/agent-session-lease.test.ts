/**
 * Tier LS — exclusive live ownership of one logical session
 * (specs/native-agent-session-launch-spec.md §Live ownership lease).
 *
 * These take real advisory locks on real files, because every property under
 * test is a kernel property: what a second holder sees, what a scope closing
 * releases, and what happens to a lock whose process died. A stubbed lock
 * would prove the stub.
 *
 * The crash case runs a genuinely separate process and kills it, since the
 * whole reason for choosing an advisory lock over a pid file is that nothing
 * in this process has to notice the death for the lock to go.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { hasDenoSessionLease, installDenoSessionLease, SessionLease } from "@executablemd/runtime";

const KEY = "a".repeat(64);
const HOLDER = fileURLToPath(new URL("./fixtures/session-lease-holder.ts", import.meta.url));

function* acquire(root: string, key = KEY): Operation<string> {
  yield* installDenoSessionLease(root);
  return yield* SessionLease.operations.acquire(key);
}

/** A child that holds the lease and reports, then waits to be killed. */
function* holder(root: string): Operation<{ kill: () => void }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", HOLDER, root, KEY],
    stdout: "piped",
    stderr: "piped",
    cwd: process.cwd(),
  }).spawn();

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("lease:")) {
    const chunk = yield* until(reader.read());
    if (chunk.done) {
      break;
    }
    seen += decoder.decode(chunk.value, { stream: true });
  }
  yield* until(reader.cancel());
  if (!seen.includes("lease:acquired")) {
    const failure = yield* until(new Response(child.stderr).text());
    throw new Error(`the lease holder never acquired: ${seen}${failure}`);
  }
  return {
    kill: () => {
      child.kill("SIGKILL");
      child.stderr.cancel().catch(() => {});
    },
  };
}

describe("Tier LS — the session lease", () => {
  it("LS1: this host installs a kernel-backed implementation", function* () {
    expect(hasDenoSessionLease()).toBe(true);
  });

  it("LS2: without an installed implementation the answer is unavailable", function* () {
    // Not "free". A host that cannot ask has no idea whether someone owns the
    // session, and treating silence as availability is how two owners happen.
    expect(yield* SessionLease.operations.acquire(KEY)).toBe("unavailable");
  });

  it("LS3: one scope acquires, and a second holder is refused rather than queued", function* () {
    const root = yield* useTempDirectory("xmd-ls-");
    yield* scoped(function* () {
      expect(yield* acquire(root)).toBe("acquired");
      // A separate handle on the same sidecar, which is what another process
      // has. Refusal is immediate: nothing here waits for the first holder.
      yield* scoped(function* () {
        expect(yield* acquire(root)).toBe("busy");
      });
    });
  });

  it("LS4: the lease is released when its scope closes, and the sidecar stays", function* () {
    const root = yield* useTempDirectory("xmd-ls-");
    yield* scoped(function* () {
      expect(yield* acquire(root)).toBe("acquired");
    });

    // Released, so the next asker gets it.
    yield* scoped(function* () {
      expect(yield* acquire(root)).toBe("acquired");
    });
    // And the file is still there. Unlinking it would let a later process
    // create a fresh one and lock that instead — two locks on one name.
    const entries = yield* until(readdir(join(root, "leases")));
    expect(entries.filter((entry) => entry.endsWith(".lease"))).toHaveLength(1);
  });

  it("LS7: cancelling the task that owns a lease releases it, and the sidecar stays", function* () {
    // The third way a lease ends. LS4 closes a scope on its own terms and LS6
    // kills the process; this is the one in between — an owner interrupted
    // while it still believed it held the session. Cancellation has to leave
    // the lock released, or a cancelled `xmd` would lock the reader out of
    // their own session until they rebooted.
    const root = yield* useTempDirectory("xmd-ls-");
    const holding = withResolvers<void>();

    const owner = yield* spawn(() =>
      scoped(function* () {
        expect(yield* acquire(root)).toBe("acquired");
        holding.resolve();
        yield* suspend();
      }),
    );
    yield* holding.operation;

    // Really held while that task runs, so what the halt below releases is a
    // lock that existed rather than one that was never taken.
    yield* scoped(function* () {
      expect(yield* acquire(root)).toBe("busy");
    });

    yield* owner.halt();

    yield* scoped(function* () {
      expect(yield* acquire(root)).toBe("acquired");
    });
    // Released by teardown, not by unlinking: the sidecar a later owner locks
    // has to be the same file, or two processes lock two files of one name.
    const entries = yield* until(readdir(join(root, "leases")));
    expect(entries.filter((entry) => entry.endsWith(".lease"))).toHaveLength(1);
  });

  it("LS5: different sessions do not contend", function* () {
    const root = yield* useTempDirectory("xmd-ls-");
    yield* scoped(function* () {
      expect(yield* acquire(root, "a".repeat(64))).toBe("acquired");
      yield* scoped(function* () {
        expect(yield* acquire(root, "b".repeat(64))).toBe("acquired");
      });
    });
  });

  it("LS6: a killed owner's lease is released by the kernel, and its sidecar survives", function* () {
    // The reason this is an advisory lock and not a pid file. Nothing in this
    // process observes the death, runs a timeout, or decides the owner is
    // stale — the lock is simply gone because the process holding it is.
    const root = yield* useTempDirectory("xmd-ls-");
    const child = yield* holder(root);

    yield* scoped(function* () {
      expect(yield* acquire(root)).toBe("busy");
    });

    child.kill();
    // Poll rather than sleep on a fixed delay: what is being waited for is the
    // kernel releasing a lock, which has no advertised latency.
    let recovered: string = "busy";
    for (let attempt = 0; attempt < 200 && recovered !== "acquired"; attempt += 1) {
      yield* scoped(function* () {
        recovered = yield* acquire(root);
      });
    }

    expect(recovered).toBe("acquired");
    const entries = yield* until(readdir(join(root, "leases")));
    expect(entries.filter((entry) => entry.endsWith(".lease"))).toHaveLength(1);
  });
});
