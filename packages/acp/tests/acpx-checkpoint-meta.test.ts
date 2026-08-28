/**
 * Tier TC — the vendored ACPX checkpoint metadata
 * (packages/acp/vendor/acpx/PROVENANCE.md).
 *
 * An adapter names the turn it just completed on the ACP `PromptResponse._meta`
 * of that exact response. ACPX 0.12.0 read the response for its stop reason and
 * its usage and dropped the rest, so a consumer could not tell which turn a
 * completion was — the vendored copy carries that one value out.
 *
 * These tests speak real ACP to a real child. The agent command resolves to a
 * fake agent that answers JSON-RPC over stdio and returns metadata derived from
 * the prompt it was given, so what is proven is that the bytes an agent put on
 * a response reached the runtime's result — not that a function was called.
 *
 * The interleaved case is the load-bearing one. Two turns run at once and
 * neither is allowed to answer until both have been asked, so a runtime that
 * carried "the latest metadata" instead of this request's own would hand at
 * least one turn the other's name.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { all, ensure, spawn, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { createAcpRuntime } from "../src/acpx-runtime.ts";
import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeTurnResult,
  AcpSessionRecord,
  AcpSessionStore,
} from "../src/acpx-runtime.ts";
import { checkpointFromResult } from "../src/checkpoint.ts";

/**
 * A fake ACP agent, as a Node script.
 *
 * It answers the three requests a turn needs and refuses everything else the
 * way an agent without that capability would. Its prompt response carries
 * `_meta` built from the prompt text, so a test can state the exact bytes it
 * expects rather than that something arrived.
 *
 * `XMD_TC_BARRIER` and `XMD_TC_PARTIES` make it wait: it records that it has
 * been asked, then holds its answer until that many agents have been asked.
 * Each turn is its own child, so the barrier is a directory on disk — the only
 * thing these processes share.
 */
const AGENT_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const barrier = process.env.XMD_TC_BARRIER;
const parties = Number(process.env.XMD_TC_PARTIES ?? "1");
const meta = process.env.XMD_TC_META;

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function fail(id, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }) + "\\n",
  );
}

function arrived() {
  fs.writeFileSync(path.join(barrier, String(process.pid)), "");
  return fs.readdirSync(barrier).length;
}

function whenAllArrived(done) {
  if (arrived() >= parties) {
    done();
    return;
  }
  const timer = setInterval(() => {
    if (fs.readdirSync(barrier).length >= parties) {
      clearInterval(timer);
      done();
    }
  }, 10);
}

function promptText(request) {
  const blocks = (request.params && request.params.prompt) || [];
  return blocks.map((block) => (typeof block.text === "string" ? block.text : "")).join("");
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\\n");
    if (line.trim().length === 0) {
      continue;
    }
    handle(JSON.parse(line));
  }
});

function handle(request) {
  if (request.id === undefined) {
    return;
  }
  if (request.method === "initialize") {
    reply(request.id, {
      protocolVersion: request.params?.protocolVersion ?? 1,
      agentCapabilities: { loadSession: false, promptCapabilities: {} },
      authMethods: [],
    });
    return;
  }
  if (request.method === "session/new") {
    reply(request.id, { sessionId: "tc-" + process.pid });
    return;
  }
  if (request.method === "session/prompt") {
    const text = promptText(request);
    const answer = () =>
      reply(
        request.id,
        meta
          ? { stopReason: "end_turn", _meta: JSON.parse(meta.split("PROMPT").join(text)) }
          : { stopReason: "end_turn" },
      );
    if (barrier) {
      whenAllArrived(answer);
      return;
    }
    answer();
    return;
  }
  fail(request.id, "the fake agent does not implement " + request.method);
}
`;

interface World {
  dir: string;
  barrier: string;
  agent: string;
  registry: AcpAgentRegistry;
  store: AcpSessionStore;
}

function* useWorld(): Operation<World> {
  const dir = path.join(os.tmpdir(), `xmd-tc-${randomUUID()}`);
  const barrier = path.join(dir, "barrier");
  yield* ensureDir(barrier);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));

  const agent = path.join(dir, "fake-agent");
  yield* writeTextFile(agent, AGENT_SOURCE);
  yield* until(chmod(agent, 0o755));

  const records = new Map<string, AcpSessionRecord>();
  return {
    dir,
    barrier,
    agent,
    registry: { resolve: () => agent, list: () => ["fake"] },
    store: {
      load: (id) => Promise.resolve(records.get(id)),
      save: (record) => {
        records.set(record.acpxRecordId, record);
        return Promise.resolve();
      },
    },
  };
}

/**
 * `meta` is a JSON template. Every occurrence of `PROMPT` is replaced with the
 * prompt the agent was actually given, so a response that named the wrong turn
 * is visible as the wrong text rather than as a missing value. An empty
 * template makes the agent omit `_meta` altogether, which is what an adapter
 * that names no turns does.
 */
function runtimeFor(world: World, meta: string, parties?: number): AcpRuntime {
  return createAcpRuntime({
    cwd: world.dir,
    sessionStore: world.store,
    agentRegistry: world.registry,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    agentProcessEnv: {
      XMD_TC_META: meta,
      ...(parties === undefined
        ? {}
        : { XMD_TC_BARRIER: world.barrier, XMD_TC_PARTIES: String(parties) }),
    },
  });
}

function* promptOnce(
  world: World,
  runtime: AcpRuntime,
  sessionKey: string,
  text: string,
): Operation<AcpRuntimeTurnResult> {
  const handle = yield* until(
    runtime.ensureSession({
      sessionKey,
      agent: "fake",
      mode: "persistent",
      cwd: world.dir,
    }),
  );
  const turn = runtime.startTurn({
    handle,
    text,
    mode: "prompt",
    requestId: randomUUID(),
    timeoutMs: 20_000,
  });
  const result = yield* until(turn.result);
  yield* until(runtime.close({ handle, reason: "test" }));
  return result;
}

describe(
  "Tier TC — vendored ACPX checkpoint metadata",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("TC1: the response's own _meta reaches the completed result, byte for byte", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, '{"codex":{"turnId":"turn-PROMPT"},"quota":{"left":3}}');

      const result = yield* promptOnce(world, runtime, "tc-one", "alpha");

      expect(result.status).toBe("completed");
      // The whole value, not the part this package happens to recognize: the
      // runtime is a transport here, and a transport that edited what it
      // carried would be deciding something that is not its to decide.
      expect(result.status === "completed" ? result._meta : undefined).toEqual({
        codex: { turnId: "turn-alpha" },
        quota: { left: 3 },
      });
    });

    it("TC2: simultaneous turns each carry their own metadata", function* () {
      const world = yield* useWorld();
      // Neither agent answers until both have been asked, so both turns are in
      // flight at once. A runtime reading anything session-global rather than
      // this request's own response would cross them here.
      const runtime = runtimeFor(world, '{"codex":{"turnId":"turn-PROMPT"}}', 2);

      const first = yield* spawn(() => promptOnce(world, runtime, "tc-a", "alpha"));
      const second = yield* spawn(() => promptOnce(world, runtime, "tc-b", "beta"));
      const [alpha, beta] = yield* all([first, second]);

      expect(checkpointFromResult(alpha)).toEqual({
        provider: "codex",
        kind: "app-server-turn-id",
        value: "turn-alpha",
      });
      expect(checkpointFromResult(beta)).toEqual({
        provider: "codex",
        kind: "app-server-turn-id",
        value: "turn-beta",
      });
    });

    it("TC3: a response with no metadata completes and names no turn", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, "");

      const result = yield* promptOnce(world, runtime, "tc-none", "alpha");

      expect(result.status).toBe("completed");
      // Absent rather than present-and-empty: an adapter that said nothing has
      // said nothing, and a result carrying a `_meta` nobody sent would be this
      // runtime answering on its behalf.
      expect(result.status === "completed" ? "_meta" in result : true).toBe(false);
      expect(checkpointFromResult(result)).toBe(undefined);
    });

    it("TC4: metadata this build recognizes nothing in is carried and names no turn", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, '{"quota":{"left":3},"codex":{"other":"PROMPT"}}');

      const result = yield* promptOnce(world, runtime, "tc-foreign", "alpha");

      // Carried, because `_meta` is the adapter's own space and the runtime is
      // a transport. Recognized as nothing, because which keys name a turn is
      // this package's decision and neither of these does.
      expect(result.status === "completed" ? result._meta : undefined).toEqual({
        quota: { left: 3 },
        codex: { other: "alpha" },
      });
      expect(checkpointFromResult(result)).toBe(undefined);
    });
  },
);
