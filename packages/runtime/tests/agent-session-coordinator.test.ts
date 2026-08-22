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
import { until } from "effection";
import type { Operation } from "effection";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  agentSessionKeyDigest,
  createDenoAgentSessionCoordinator,
  hasDenoAgentSessionCoordinator,
  parseAgentSessionOwnership,
} from "@executablemd/runtime";
import type { AgentSessionKey } from "@executablemd/runtime";

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
function* holder(root: string, key: AgentSessionKey): Operation<{ kill: () => void }> {
  const child = new Deno.Command(Deno.execPath(), {
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
    kill: () => {
      child.kill("SIGKILL");
      child.stderr.cancel().catch(() => {});
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

    child.kill();
  });

  it("CO4: a killed owner leaves a tombstone the released lock does not clear", function* () {
    // The reason ownership is two mechanisms. The kernel ends the lock when the
    // process dies, which is right; it does not end the record, which is also
    // right — nothing here can say what that owner had already done.
    const root = yield* useTempDirectory("xmd-co-");
    const child = yield* holder(root, KEY);
    expect(yield* retained(root, KEY)).toMatchObject({ state: "active" });

    child.kill();

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
      "operationId",
      "ownerKind",
      "schema",
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
    expect((raised as Error).name).toBe("AgentSessionRecoveryRequired");
  });
});
