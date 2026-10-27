/**
 * Tier CO — exclusive ownership of one agent session
 * (specs/native-agent-session-launch-spec.md §Ownership and concurrency).
 *
 * These take real advisory locks and write real records, because every property
 * under test is a property of the host: what a second holder sees, what a
 * second process sees, and what a crash leaves behind. A stubbed lock would
 * prove the stub.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { until, ensure, scoped, spawn, withResolvers, all } from "effection";
import type { Operation } from "effection";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  agentSessionKeyDigest,
  createDenoAgentSessionCoordinator,
  hasDenoAgentSessionCoordinator,
  createDenoAgentSessionHost,
  parseAgentSessionOwnership,
  AgentSessionOwnershipError,
} from "@executablemd/runtime";
import type { AgentSessionKey, AgentSessionOwnershipAdministration } from "@executablemd/runtime";

const KEY: AgentSessionKey = { provider: "acpx", agent: "scripted-cmd", sessionKey: "xmd:v1:main" };
const OTHER: AgentSessionKey = { ...KEY, sessionKey: "xmd:v1:elsewhere" };
const OWNER = fileURLToPath(new URL("./fixtures/agent-session-owner.ts", import.meta.url));

function coordinator(root: string) {
  const built = createDenoAgentSessionCoordinator(root);
  if (!built) {
    throw new Error("this host builds no coordinator");
  }
  return built;
}

function owner(kind: "session" | "prompt" | "native-launch", id: string) {
  return { kind, operationId: id };
}

/** The retained ownership record, read as another process would. */
function* retained(root: string, key: AgentSessionKey): Operation<unknown> {
  const file = join(root, "ownership", `${agentSessionKeyDigest(key)}.json`);
  const text = yield* until(readFile(file, "utf8").catch(() => undefined));
  return text === undefined ? undefined : parseAgentSessionOwnership(JSON.parse(text));
}

/** A child that owns `key` and reports when it is really holding it. */
function* holder(root: string, key: AgentSessionKey): Operation<{ kill: () => Operation<void> }> {
  let child: Deno.ChildProcess | undefined;
  let killed = false;
  yield* ensure(function* () {
    if (child) {
      if (!killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
      yield* until(child.status);
      try {
        yield* until(child.stderr.cancel());
      } catch {
        /* Already consumed. */
      }
    }
  });
  child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", OWNER, root, key.provider, key.agent, key.sessionKey],
    stdout: "piped",
    stderr: "piped",
    cwd: process.cwd(),
  }).spawn();

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("owner:")) {
    const chunk = yield* until(reader.read());
    if (chunk.done) {
      break;
    }
    seen += decoder.decode(chunk.value, { stream: true });
  }
  yield* until(reader.cancel());
  if (!seen.includes("owner:active")) {
    const failure = yield* until(new Response(child.stderr).text());
    throw new Error(`the owner never took the session: ${seen}${failure}`);
  }
  return {
    *kill() {
      if (child && !killed) {
        child.kill("SIGKILL");
        killed = true;
        yield* until(child.status);
      }
    },
  };
}

describe("Tier CO — the agent session coordinator", () => {
  it("CO1: this host coordinates, and a clean owner leaves the session idle", function* () {
    expect(hasDenoAgentSessionCoordinator()).toBe(true);
    const root = yield* useTempDirectory("xmd-co-");

    const outcome = yield* coordinator(root).coordinate(
      KEY,
      owner("native-launch", "op-1"),
      function* (ownership) {
        // Active while the body runs: that is what a later owner refuses on.
        expect(yield* retained(root, KEY)).toMatchObject({ state: "active" });
        ownership.quiesced();
        return "done";
      },
    );

    expect(outcome.ok && outcome.value).toBe("done");
    expect(yield* retained(root, KEY)).toMatchObject({
      state: "idle",
      ownerKind: "native-launch",
      operationId: "op-1",
    });
  });

  it("CO2: a second owner in this process is refused rather than queued", function* () {
    const root = yield* useTempDirectory("xmd-co-");
    const host = coordinator(root);

    const outcome = yield* host.coordinate(KEY, owner("prompt", "op-1"), function* (ownership) {
      // A sibling provider scope, which is what two `<AgentProvider>` regions
      // in one document are. An advisory lock alone does not separate them.
      const contended = yield* host.coordinate(
        KEY,
        owner("prompt", "op-2"),
        // deno-lint-ignore require-yield
        function* () {
          return "should not run";
        },
      );
      ownership.quiesced();
      return contended;
    });

    expect(outcome.ok).toBe(true);
    const contended = outcome.ok ? outcome.value : undefined;
    expect(contended?.ok).toBe(false);
    expect(contended?.ok === false && contended.error.name).toBe("AgentSessionBusy");
  });

  it("CO3: another Deno process contends on the same key, and not on another", function* () {
    const root = yield* useTempDirectory("xmd-co-");
    const child = yield* holder(root, KEY);

    const same = yield* coordinator(root).coordinate(
      KEY,
      owner("session", "op-2"),
      // deno-lint-ignore require-yield
      function* () {
        return "should not run";
      },
    );
    expect(same.ok).toBe(false);
    expect(same.ok === false && same.error.name).toBe("AgentSessionBusy");

    // A different session is a different natural key, and does not contend.
    const elsewhere = yield* coordinator(root).coordinate(
      OTHER,
      owner("session", "op-3"),
      function* (ownership) {
        ownership.quiesced();
        return "ran";
      },
    );
    expect(elsewhere.ok && elsewhere.value).toBe("ran");

    yield* child.kill();
  });

  it("CO4: a killed owner leaves a tombstone the released lock does not clear", function* () {
    // The reason ownership is two mechanisms. The kernel ends the lock when the
    // process dies, which is right; it does not end the record, which is also
    // right — nothing here can say what that owner had already done.
    const root = yield* useTempDirectory("xmd-co-");
    const child = yield* holder(root, KEY);
    expect(yield* retained(root, KEY)).toMatchObject({ state: "active" });

    yield* child.kill();

    let outcome = yield* coordinator(root).coordinate(
      KEY,
      owner("session", "op-2"),
      // deno-lint-ignore require-yield
      function* () {
        return "should not run";
      },
    );
    // Poll: what is being waited for is the kernel releasing a lock, which has
    // no advertised latency. The answer changes from busy to recovery-required
    // — never to success.
    for (
      let attempt = 0;
      attempt < 200 && !outcome.ok && outcome.error.name === "AgentSessionBusy";
      attempt += 1
    ) {
      outcome = yield* coordinator(root).coordinate(
        KEY,
        owner("session", "op-2"),
        // deno-lint-ignore require-yield
        function* () {
          return "should not run";
        },
      );
    }

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.name).toBe("AgentSessionRecoveryRequired");
    // Still owned, and still by the owner that died.
    expect(yield* retained(root, KEY)).toMatchObject({
      state: "active",
      operationId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("CO5: a body that never proves quiescence leaves ownership active", function* () {
    const root = yield* useTempDirectory("xmd-co-");

    const first = yield* coordinator(root).coordinate(
      KEY,
      owner("prompt", "op-1"),
      // deno-lint-ignore require-yield
      function* () {
        // Returns successfully, but never says the session can no longer be
        // acted on. That is a protocol failure, not a clean exit.
        return "left without acknowledging";
      },
    );
    expect(first.ok).toBe(true);

    const next = yield* coordinator(root).coordinate(
      KEY,
      owner("prompt", "op-2"),
      // deno-lint-ignore require-yield
      function* () {
        return "should not run";
      },
    );

    expect(next.ok).toBe(false);
    expect(next.ok === false && next.error.name).toBe("AgentSessionRecoveryRequired");
  });

  it("CO6: the namespace names sessions by digest and retains nothing else", function* () {
    const root = yield* useTempDirectory("xmd-co-");
    const canary = "You are the implementor, and this is the instruction layer.";
    const secret: AgentSessionKey = { ...KEY, sessionKey: `xmd:v1:${canary}` };

    yield* coordinator(root).coordinate(secret, owner("session", "op-1"), function* (ownership) {
      ownership.quiesced();
      return undefined;
    });

    const digest = agentSessionKeyDigest(secret);
    expect(yield* until(readdir(join(root, "leases")))).toEqual([`${digest}.lease`]);
    expect(yield* until(readdir(join(root, "ownership")))).toEqual([`${digest}.json`]);

    const file = join(root, "ownership", `${digest}.json`);
    const text = yield* until(readFile(file, "utf8"));
    // The key itself never lands: only its digest does.
    expect(text).not.toContain(canary);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "keyDigest",
      "lastForcedRecovery",
      "operationId",
      "ownerKind",
      "release",
      "state",
    ]);
    expect((yield* until(stat(file))).mode & 0o777).toBe(0o600);
    expect((yield* until(stat(join(root, "ownership")))).mode & 0o777).toBe(0o700);
  });

  it("CO7: a record this build cannot account for is never acted on", function* () {
    const root = yield* useTempDirectory("xmd-co-");
    yield* coordinator(root).coordinate(KEY, owner("session", "op-1"), function* (ownership) {
      ownership.quiesced();
      return undefined;
    });
    const file = join(root, "ownership", `${agentSessionKeyDigest(KEY)}.json`);
    yield* until(
      writeFile(file, JSON.stringify({ schema: "agent-session-ownership.v2", state: "idle" })),
    );

    let raised: unknown;
    try {
      yield* coordinator(root).coordinate(
        KEY,
        owner("session", "op-2"),
        // deno-lint-ignore require-yield
        function* () {
          return "should not run";
        },
      );
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(Error);
    expect(raised instanceof Error && raised.name).toBe("AgentSessionRecoveryRequired");
  });
});

import {
  createAgentSessionHostFromIO,
  createDenoAgentSessionHostIO,
} from "../deno-agent-session-coordinator.ts";
import type {
  AgentSessionHostIO,
  AgentSessionHostFile,
} from "../deno-agent-session-coordinator.ts";

function host(root: string) {
  const value = createDenoAgentSessionHost(root);
  if (!value) {
    throw new Error("Deno ownership host unavailable");
  }
  return value;
}
function* seed(root: string) {
  const value = host(root);
  yield* value.coordinator.coordinate(KEY, owner("prompt", "abandoned"), function* () {
    return undefined;
  });
  const inspected = yield* value.ownershipAdministration.inspectOwnership(
    agentSessionKeyDigest(KEY),
  );
  if (!inspected.ok) {
    throw inspected.error;
  }
  return { value, observed: inspected.value };
}
function* forced(
  admin: AgentSessionOwnershipAdministration,
  digest: string,
  expectedRevision: string,
) {
  return yield* admin.forceRecoverOwnership({ keyDigest: digest, expectedRevision, force: true });
}
function code(result: { ok: boolean; error?: Error }) {
  return result.error instanceof AgentSessionOwnershipError ? result.error.code : undefined;
}

function realIO() {
  const io = createDenoAgentSessionHostIO();
  if (!io) {
    throw new Error("Deno IO unavailable");
  }
  return io;
}

describe("Explicit ownership recovery", () => {
  it("FR1: inspection is byte exact, read-only, bounded and never provisions or locks", function* () {
    const root = yield* useTempDirectory("xmd-force-");
    const io = realIO();
    let locks = 0;
    let writes = 0;
    const probe: AgentSessionHostIO = {
      ...io,
      mkdir() {
        writes++;
        return Promise.reject(new Error("inspection mkdir"));
      },
      open(path, options) {
        return io.open(path, options).then((file) => ({
          ...file,
          tryLock(exclusive) {
            locks++;
            return file.tryLock(exclusive);
          },
        }));
      },
    };
    const admin = createAgentSessionHostFromIO(root, probe).ownershipAdministration;
    expect(code(yield* admin.inspectOwnership(agentSessionKeyDigest(KEY)))).toBe("not-found");
    expect(yield* until(readdir(root))).toEqual([]);
    const seeded = yield* seed(root);
    const path = join(root, "ownership", agentSessionKeyDigest(KEY) + ".json");
    const text = (yield* until(readFile(path, "utf8"))) + " \n";
    yield* until(writeFile(path, text));
    const result = yield* admin.inspectOwnership(agentSessionKeyDigest(KEY));
    expect(result.ok && result.value.recordRevision).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
    expect(yield* until(readFile(path, "utf8"))).toBe(text);
    expect(locks).toBe(0);
    expect(writes).toBe(0);
    for (const bytes of [
      new Uint8Array([255]),
      new TextEncoder().encode(" ".repeat(65537)),
      new TextEncoder().encode(
        JSON.stringify({ ...seeded.observed.record, keyDigest: agentSessionKeyDigest(OTHER) }),
      ),
    ]) {
      yield* until(writeFile(path, bytes));
      expect(code(yield* admin.inspectOwnership(agentSessionKeyDigest(KEY)))).toBe(
        "record-invalid",
      );
    }
  });

  it("R1: oversize UTF-8 publication refuses before staging and preserves readable ownership", function* () {
    const root = yield* useTempDirectory("xmd-force-size-");
    const io = realIO();
    let stagingCreates = 0;
    const guarded = createAgentSessionHostFromIO(root, {
      ...io,
      open(path, options) {
        if (options.createNew && path.endsWith(".staging")) {
          stagingCreates++;
        }
        return io.open(path, options);
      },
    });
    yield* guarded.coordinator.coordinate(KEY, owner("prompt", "a".repeat(40000)), function* () {
      return undefined;
    });
    const digest = agentSessionKeyDigest(KEY);
    const path = join(root, "ownership", digest + ".json");
    const before = yield* until(readFile(path));
    expect(before.byteLength).toBeLessThan(65536);
    const observed = yield* guarded.ownershipAdministration.inspectOwnership(digest);
    if (!observed.ok) {
      throw observed.error;
    }
    expect(observed.value.record).toMatchObject({
      state: "active",
      operationId: "a".repeat(40000),
    });
    const beforeStagingCreates = stagingCreates;
    const result = yield* forced(
      guarded.ownershipAdministration,
      digest,
      observed.value.recordRevision,
    );
    expect(code(result)).toBe("record-invalid");
    expect(stagingCreates).toBe(beforeStagingCreates);
    expect(yield* until(readFile(path))).toEqual(before);
    expect(yield* guarded.ownershipAdministration.inspectOwnership(digest)).toEqual(observed);
    expect(yield* until(readdir(join(root, "ownership")))).toEqual([digest + ".json"]);

    yield* guarded.coordinator.coordinate(OTHER, owner("session", "idle-owner"), function* (owned) {
      owned.quiesced();
      return undefined;
    });
    const otherDigest = agentSessionKeyDigest(OTHER);
    const idle = yield* guarded.ownershipAdministration.inspectOwnership(otherDigest);
    const otherPath = join(root, "ownership", otherDigest + ".json");
    const idleBytes = yield* until(readFile(otherPath));
    const beforeOrdinaryCreates = stagingCreates;
    let entered = false;
    const ordinary = yield* guarded.coordinator.coordinate(
      OTHER,
      owner("prompt", "é".repeat(40000)),
      function* () {
        entered = true;
        return undefined;
      },
    );
    expect(code(ordinary)).toBe("record-invalid");
    expect(entered).toBe(false);
    expect(stagingCreates).toBe(beforeOrdinaryCreates);
    expect(yield* until(readFile(otherPath))).toEqual(idleBytes);
    expect(yield* guarded.ownershipAdministration.inspectOwnership(otherDigest)).toEqual(idle);
    expect((yield* until(readdir(join(root, "ownership")))).sort()).toEqual(
      [digest + ".json", otherDigest + ".json"].sort(),
    );
  });

  it("FR2: force preserves its marker through ordinary ownership and keeps the lease inode", function* () {
    const root = yield* useTempDirectory("xmd-force-");
    const { value, observed } = yield* seed(root);
    const digest = observed.keyDigest;
    const lease = join(root, "leases", digest + ".lease");
    const inode = (yield* until(stat(lease))).ino;
    expect(code(yield* forced(value.ownershipAdministration, digest, "0".repeat(64)))).toBe(
      "stale-expectation",
    );
    const result = yield* forced(value.ownershipAdministration, digest, observed.recordRevision);
    expect(result.ok).toBe(true);
    const inspect = yield* value.ownershipAdministration.inspectOwnership(digest);
    if (!inspect.ok) {
      throw inspect.error;
    }
    expect(inspect.value.record).toMatchObject({
      state: "idle",
      release: "forced",
      ownerKind: "prompt",
      operationId: "abandoned",
      lastForcedRecovery: {
        expectedRevision: observed.recordRevision,
        backendQuiescenceProved: false,
        interruptedOutcome: "unknown",
      },
    });
    expect(parseAgentSessionOwnership(inspect.value.record)).toEqual(inspect.value.record);
    expect(result.ok && result.value.recordRevision).toBe(inspect.value.recordRevision);
    const marker = inspect.value.record.lastForcedRecovery;
    const next = yield* value.coordinator.coordinate(
      KEY,
      owner("session", "successor"),
      function* (owned) {
        const active = yield* value.ownershipAdministration.inspectOwnership(digest);
        expect(active.ok && active.value.record).toMatchObject({
          state: "active",
          release: "none",
          lastForcedRecovery: marker,
        });
        expect(
          code(yield* forced(value.ownershipAdministration, digest, observed.recordRevision)),
        ).toBe("busy");
        owned.quiesced();
        return true;
      },
    );
    expect(next.ok).toBe(true);
    const idle = yield* value.ownershipAdministration.inspectOwnership(digest);
    expect(idle.ok && idle.value.record).toMatchObject({
      state: "idle",
      release: "quiesced",
      operationId: "successor",
      lastForcedRecovery: marker,
    });
    expect(
      code(
        yield* forced(
          value.ownershipAdministration,
          digest,
          idle.ok ? idle.value.recordRevision : "",
        ),
      ),
    ).toBe("not-recovery-required");
    expect((yield* until(stat(lease))).ino).toBe(inode);
    for (const path of [lease, join(root, "ownership", digest + ".json")]) {
      expect((yield* until(stat(path))).mode & 0o777).toBe(0o600);
    }
    expect((yield* until(stat(join(root, "ownership")))).mode & 0o777).toBe(0o700);
    expect(yield* until(readdir(join(root, "ownership")))).toEqual([digest + ".json"]);
  });

  it("FR3: a real live holder stays busy; killed ownership still requires explicit matching force", function* () {
    const root = yield* useTempDirectory("xmd-force-");
    const child = yield* holder(root, KEY);
    const value = host(root);
    const digest = agentSessionKeyDigest(KEY);
    const observed = yield* value.ownershipAdministration.inspectOwnership(digest);
    if (!observed.ok) {
      throw observed.error;
    }
    expect(
      code(yield* forced(value.ownershipAdministration, digest, observed.value.recordRevision)),
    ).toBe("busy");
    const still = yield* value.ownershipAdministration.inspectOwnership(digest);
    expect(still).toEqual(observed);
    const other = yield* value.coordinator.coordinate(
      OTHER,
      owner("prompt", "elsewhere"),
      function* (owned) {
        owned.quiesced();
        return true;
      },
    );
    expect(other.ok).toBe(true);
    yield* child.kill();
    const refused = yield* value.coordinator.coordinate(
      KEY,
      owner("prompt", "no-force"),
      function* () {
        throw new Error("must not enter");
      },
    );
    expect(!refused.ok && refused.error.name).toBe("AgentSessionRecoveryRequired");
    expect(
      (yield* forced(value.ownershipAdministration, digest, observed.value.recordRevision)).ok,
    ).toBe(true);
    expect(
      (yield* value.coordinator.coordinate(KEY, owner("session", "after-force"), function* (owned) {
        owned.quiesced();
        return true;
      })).ok,
    ).toBe(true);
  });

  it("FR4: two real recovery processes elect at most one winner; the old expectation cannot reclaim a successor", function* () {
    const root = yield* useTempDirectory("xmd-force-");
    const { value, observed } = yield* seed(root);
    const children: Deno.ChildProcess[] = [];
    yield* ensure(function* () {
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch {}
        yield* until(child.status);
      }
    });
    for (let i = 0; i < 2; i++) {
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-all",
          OWNER,
          root,
          KEY.provider,
          KEY.agent,
          KEY.sessionKey,
          observed.recordRevision,
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      children.push(child);
    }
    const readers = children.map((c) => c.stdout.getReader());
    for (const reader of readers) {
      const ready = yield* until(reader.read());
      expect(new TextDecoder().decode(ready.value)).toBe("recovery:ready\n");
    }
    for (const child of children) {
      const writer = child.stdin.getWriter();
      yield* until(writer.write(new Uint8Array([1])));
      yield* until(writer.close());
    }
    const outputs = yield* all(
      readers.map((reader) =>
        (function* () {
          let text = "";
          while (true) {
            const chunk = yield* until(reader.read());
            if (chunk.done) {
              break;
            }
            text += new TextDecoder().decode(chunk.value);
          }
          return text;
        })(),
      ),
    );
    expect(outputs.filter((s) => s.includes('"ok":true')).length).toBe(1);
    yield* value.coordinator.coordinate(KEY, owner("prompt", "successor"), function* () {
      return undefined;
    });
    expect(
      code(
        yield* forced(value.ownershipAdministration, observed.keyDigest, observed.recordRevision),
      ),
    ).toBe("stale-expectation");
    const current = yield* value.ownershipAdministration.inspectOwnership(observed.keyDigest);
    expect(current.ok && current.value.record.operationId).toBe("successor");
    for (const child of children) {
      yield* until(child.status);
      yield* until(child.stderr.cancel());
    }
  });

  for (const phase of ["open", "tryLock", "write", "sync", "rename", "directory-sync"]) {
    it(`FR5: cancellation joins pending ${phase} before releasing occupancy or the lock`, function* () {
      const root = yield* useTempDirectory("xmd-force-");
      const { observed } = yield* seed(root);
      const io = realIO();
      const entered = withResolvers<void>();
      const released = Promise.withResolvers<void>();
      let gated = false;
      let unlocked = false;
      let synced = false;
      function gate<T>(start: () => Promise<T>): Promise<T> {
        gated = true;
        entered.resolve();
        return released.promise.then(start);
      }
      const wrapped: AgentSessionHostIO = {
        ...io,
        open(path, options) {
          const opening = io.open(path, options).then((f) => {
            const wrappedFile: AgentSessionHostFile = {
              ...f,
              tryLock(exclusive) {
                return !gated && phase === "tryLock"
                  ? gate(() => f.tryLock(exclusive))
                  : f.tryLock(exclusive);
              },
              write(bytes) {
                return !gated && phase === "write" ? gate(() => f.write(bytes)) : f.write(bytes);
              },
              sync() {
                if (path === join(root, "ownership")) {
                  const call = () =>
                    f.sync().then(() => {
                      synced = true;
                    });
                  return !gated && phase === "directory-sync" ? gate(call) : call();
                }
                return !gated && phase === "sync" ? gate(() => f.sync()) : f.sync();
              },
              unlock() {
                unlocked = true;
                return f.unlock();
              },
            };
            return wrappedFile;
          });
          return !gated && phase === "open" && path.endsWith(".lease")
            ? opening.then((f) => gate(() => Promise.resolve(f)))
            : opening;
        },
        rename(from, to) {
          return !gated && phase === "rename"
            ? gate(() => io.rename(from, to))
            : io.rename(from, to);
        },
      };
      const value = createAgentSessionHostFromIO(root, wrapped);
      const task = yield* spawn(() =>
        forced(value.ownershipAdministration, observed.keyDigest, observed.recordRevision),
      );
      yield* entered.operation;
      const halting = task.halt();
      const contested = yield* forced(
        value.ownershipAdministration,
        observed.keyDigest,
        observed.recordRevision,
      );
      expect(code(contested)).toBe("busy");
      expect(unlocked).toBe(false);
      if (["write", "sync", "rename", "directory-sync"].includes(phase)) {
        const crossHost = yield* forced(
          host(root).ownershipAdministration,
          observed.keyDigest,
          observed.recordRevision,
        );
        expect(code(crossHost)).toBe("busy");
      }
      released.resolve();
      yield* halting;
      expect(unlocked).toBe(phase !== "open" && phase !== "tryLock" ? true : phase === "tryLock");
      const current = yield* host(root).ownershipAdministration.inspectOwnership(
        observed.keyDigest,
      );
      if (!current.ok) {
        throw current.error;
      }
      if (phase === "rename" || phase === "directory-sync") {
        expect(current.value.record).toMatchObject({ state: "idle", release: "forced" });
        expect(synced).toBe(true);
      } else {
        expect(current.value.record).toEqual(observed.record);
      }
      expect(yield* until(readdir(join(root, "ownership")))).toEqual([
        observed.keyDigest + ".json",
      ]);
      const again = yield* forced(
        value.ownershipAdministration,
        observed.keyDigest,
        observed.recordRevision,
      );
      expect(code(again)).not.toBe("busy");
    });
  }

  for (const phase of ["write", "directory-sync"]) {
    it(`FR6: ${phase} failure retains first cause and reports publication uncertainty only after replacement`, function* () {
      const root = yield* useTempDirectory("xmd-force-");
      const { observed } = yield* seed(root);
      const io = realIO();
      let failed = false;
      const fault = new Error("fixture-owned IO fault");
      const wrapped: AgentSessionHostIO = {
        ...io,
        open(path, options) {
          return io.open(path, options).then((f) => ({
            ...f,
            write(bytes) {
              if (!failed && phase === "write") {
                failed = true;
                return Promise.reject(fault);
              }
              return f.write(bytes);
            },
            sync() {
              if (!failed && phase === "directory-sync" && path === join(root, "ownership")) {
                failed = true;
                return Promise.reject(fault);
              }
              return f.sync();
            },
          }));
        },
      };
      const result = yield* forced(
        createAgentSessionHostFromIO(root, wrapped).ownershipAdministration,
        observed.keyDigest,
        observed.recordRevision,
      );
      expect(code(result)).toBe(phase === "write" ? "io-failure" : "publication-unknown");
      expect(!result.ok && result.error.cause).toBe(fault);
      const current = yield* host(root).ownershipAdministration.inspectOwnership(
        observed.keyDigest,
      );
      if (!current.ok) {
        throw current.error;
      }
      expect(current.value.record.state).toBe(phase === "write" ? "active" : "idle");
      expect(yield* until(readdir(join(root, "ownership")))).toEqual([
        observed.keyDigest + ".json",
      ]);
    });
  }
});
