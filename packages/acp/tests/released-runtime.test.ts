import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  allSettled,
  createChannel,
  each,
  ensure,
  spawn,
  stream,
  until,
  useScope,
  withResolvers,
} from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpRuntime, resolveAgentCommand } from "../src/acpx-runtime.ts";
import type { AcpRuntime, AcpRuntimeOptions } from "../src/acpx-runtime.ts";
import { createAcpxSessionStore, retainedSession } from "../src/session-store.ts";
import { createAcpxProvider } from "../src/provider.ts";
import {
  agentIdentityComponents,
  installAgentComponents,
  useNormalizedOutput,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { applySessionConfiguration } from "../src/session-configuration.ts";
import { checkpointFromResult } from "../src/checkpoint.ts";
import { consumeTurn } from "../src/events.ts";
import { makeRecord } from "./helpers.ts";
import {
  c as LiveSessionCheckpoint,
  l as runPromptTurn,
} from "../vendor/acpx/generated/queue-owner-runtime-B0mPqOu4.js";

const AGENT_SOURCE = `
let sessionId;
let model = "initial";
let effort = "high";
const options = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model,
    options: ["initial", "selected"].map(value => ({value, name: value})) },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: effort,
    options: ["high", "xhigh"].map(value => ({value, name: value})) },
];
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => send({jsonrpc: "2.0", id, result});
const update = update => send({jsonrpc: "2.0", method: "session/update", params: {sessionId, update}});
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
function handle(request) {
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    reply(request.id, {protocolVersion: 1, agentCapabilities: {loadSession: true, promptCapabilities: {}}, authMethods: []});
  } else if (request.method === "session/new" || request.method === "session/load") {
    sessionId = request.params.sessionId ?? "session-" + process.pid;
    reply(request.id, {sessionId, configOptions: options(), _meta: {agentSessionId: "native-" + sessionId}});
  } else if (request.method === "session/set_config_option") {
    if (request.params.configId === "model") model = request.params.value;
    if (request.params.configId === "effort") effort = request.params.value;
    reply(request.id, {configOptions: options()});
  } else if (request.method === "session/prompt") {
    const text = request.params.prompt.map(block => block.text ?? "").join("");
    if (text !== "no-accept") update({sessionUpdate: "session_info_update", _meta: {"executablemd.session-materialization/v1": {state: "accepted"}}});
    update({sessionUpdate: "agent_message_chunk", content: {type: "text", text: "answer:" + text}});
    if (text === "fail") {
      send({jsonrpc: "2.0", id: request.id, error: {code: -32000, message: "backend refusal"}});
    } else {
      reply(request.id, {stopReason: text === "cancel" ? "cancelled" : "end_turn", _meta: {codex: {turnId: "turn-" + text}, opaque: {left: [3, null]}}});
    }
  } else {
    send({jsonrpc: "2.0", id: request.id, error: {code: -32601, message: "unsupported"}});
  }
}
`;

function* world() {
  const dir = join(tmpdir(), `xmd-released-${randomUUID()}`);
  yield* ensureDir(dir);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  const agent = join(dir, "agent with spaces.cjs");
  yield* writeTextFile(agent, AGENT_SOURCE);
  const registry = { resolve: () => ["node", agent], list: () => ["scribe"] };
  const store = createAcpxSessionStore(dir);
  return { dir, agent, registry, store };
}

function* runtimeWorld() {
  const current = yield* world();
  const runtime = createAcpRuntime({
    cwd: current.dir,
    sessionStore: current.store,
    agentRegistry: current.registry,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
  });
  yield* ensure(() => until(runtime.shutdown()));
  const handle = yield* until(
    runtime.ensureSession({
      sessionKey: "released",
      agent: "scribe",
      mode: "persistent",
    }),
  );
  return { ...current, runtime, handle };
}

describe(
  "released ACPX production consumers",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("the provider commits real first-turn acceptance before exposing output", function* () {
      const current = yield* world();
      const retained: string[] = [];
      yield* installAgentComponents({
        defaultAgent: "scribe",
        rootProvider: {
          options: { defaultAgent: "scribe", permissionMode: "deny-all" },
          factory: createAcpxProvider({
            sessionStore: current.store,
            agentRegistry: current.registry,
            advertiseNativeLaunch: [],
            advertiseClientNativeAttachment: [],
            *agentCwd() {
              return current.dir;
            },
            sessions: {
              *requestSession() {
                return { sessionKey: "provider", cwd: current.dir, state: "new" };
              },
              *recordSessionIdentity(_details, identity) {
                const saved = yield* retainedSession(current.store, "provider");
                expect(saved?.agentSessionId).toBe(identity.agentSessionId);
                expect(identity.agentSessionId).toMatch(/^native-session-/);
                retained.push(identity.agentSessionId ?? "absent");
              },
            },
          }),
        },
      });
      const doc = join(current.dir, "consumer.md");
      yield* writeTextFile(
        doc,
        '<Agent name="scribe"><Session name="review"><Prompt text="hello" /></Session></Agent>',
      );
      expect(yield* retainedSession(current.store, "provider")).toBe(undefined);
      yield* useNormalizedOutput();
      const journal = new InMemoryStream();
      const execution = yield* executeInstalled({ path: doc, stream: journal }, [
        { components: agentIdentityComponents() },
      ]);
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      expect(next.value).toContain("answer:hello");
      expect((yield* execution).ok).toBe(true);
      expect(retained).toHaveLength(1);
      const history = JSON.stringify(yield* journal.readAll());
      expect(history).toContain("answer:hello");
      expect(history).not.toContain('"opaque"');
      expect((yield* retainedSession(current.store, "provider"))?.agentCommand).toBe(
        resolveAgentCommand(current.registry, "scribe"),
      );
    });

    it("configuration refreshes the same retained conversation after reconnect", function* () {
      const current = yield* runtimeWorld();
      const options: AcpRuntimeOptions = {
        cwd: current.dir,
        sessionStore: current.store,
        agentRegistry: current.registry,
        permissionMode: "deny-all",
      };
      function configurationTarget(runtime: AcpRuntime) {
        return {
          agent: "scribe",
          sessionKey: "released",
          readStatus: () => until(runtime.getStatus!({ handle: current.handle })),
          *write(key: string, value: string) {
            yield* until(runtime.setConfigOption!({ handle: current.handle, key, value }));
          },
          markUnusable() {
            throw new Error("configuration restoration failed");
          },
        };
      }
      const first = yield* applySessionConfiguration(configurationTarget(current.runtime), {
        model: "selected",
        effort: "xhigh",
      });
      expect(first.model?.set.selected).toBe("selected");
      const identity = current.handle.agentSessionId;
      yield* until(current.runtime.close({ handle: current.handle, reason: "reconnect" }));
      const resumed = createAcpRuntime(options);
      yield* ensure(() => until(resumed.shutdown()));
      const handle = yield* until(
        resumed.ensureSession({ sessionKey: "released", agent: "scribe", mode: "persistent" }),
      );
      expect(handle.agentSessionId).toBe(identity);
      const configured = yield* applySessionConfiguration(configurationTarget(resumed), {
        model: "selected",
        effort: "xhigh",
      });
      expect(configured.model?.set.selected).toBe("selected");
      expect(configured.effort?.set.selected).toBe("xhigh");
    });

    it("only a completed real response carries a checkpoint through the production consumer", function* () {
      const current = yield* runtimeWorld();
      for (const text of ["hello", "cancel", "fail"]) {
        const turn = current.runtime.startTurn({
          handle: current.handle,
          text,
          mode: "prompt",
          requestId: text,
        });
        const channel = createChannel<import("@executablemd/core").AgentPromptEvent, string>();
        const subscription = yield* channel;
        const checkpoints: unknown[] = [];
        yield* spawn(() =>
          consumeTurn(
            turn,
            { agent: "scribe", session: { sessionKey: "released", cwd: current.dir } },
            channel,
            () => {},
            undefined,
            (_terminal, token) => {
              checkpoints.push(token);
            },
          ),
        );
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
        expect(next.value).toBe("answer:" + text);
        const result = yield* until(turn.result);
        expect(result.status).toBe(
          text === "hello" ? "completed" : text === "cancel" ? "cancelled" : "failed",
        );
        if (text === "hello") {
          expect(checkpoints).toEqual([
            { provider: "codex", kind: "app-server-turn-id", value: "turn-hello" },
          ]);
        } else {
          expect(checkpointFromResult(result)).toBe(undefined);
          expect(checkpoints).toEqual([]);
        }
      }
    });

    it("a final save failure keeps the returned reply inspectable and does not reprompt", function* () {
      const current = yield* world();
      let fail = true;
      const store = {
        load: current.store.load.bind(current.store),
        save(record: import("../src/acpx-runtime.ts").AcpSessionRecord) {
          if (fail && JSON.stringify(record.messages).includes("answer:once")) {
            return Promise.reject(
              Object.assign(new Error("injected completion save failure"), { code: "EIO" }),
            );
          }
          return current.store.save(record);
        },
      };
      const runtime = createAcpRuntime({
        cwd: current.dir,
        sessionStore: store,
        agentRegistry: current.registry,
        permissionMode: "deny-all",
      });
      yield* ensure(function* () {
        fail = false;
        yield* until(runtime.shutdown());
      });
      const handle = yield* until(
        runtime.ensureSession({ sessionKey: "save-failure", agent: "scribe", mode: "persistent" }),
      );
      const turn = runtime.startTurn({ handle, text: "once", mode: "prompt", requestId: "once" });
      let text = "";
      for (const event of yield* each(stream(turn.events))) {
        if (event.type === "text_delta") {
          text += event.text;
        }
        yield* each.next();
      }
      const result = yield* until(turn.result);
      expect(result.status).toBe("failed");
      expect(result.status === "failed" ? result.error.message : "").toContain(
        "injected completion save failure",
      );
      expect(text).toBe("answer:once");
      const [again] = yield* allSettled([until(turn.result)]);
      expect(again.ok && again.value).toEqual(result);
    });
  },
);

describe("released response recovery", () => {
  it("a checkpoint already waiting on a save cannot overtake materialization", function* () {
    const scope = yield* useScope();
    const firstEntered = withResolvers<void>();
    const firstRelease = withResolvers<void>();
    const promoting = withResolvers<void>();
    const promotionRelease = withResolvers<void>();
    let saves = 0;
    let held = false;
    let overlap = false;
    const checkpoint = new LiveSessionCheckpoint({
      save: () =>
        scope.run(function* () {
          saves++;
          if (held) {
            overlap = true;
          }
          if (saves === 1) {
            firstEntered.resolve();
            yield* firstRelease.operation;
          }
        }),
    });
    const first = checkpoint.checkpoint();
    yield* firstEntered.operation;
    const promotion = checkpoint.runMaterializationExclusive(() =>
      scope.run(function* () {
        held = true;
        promoting.resolve();
        yield* promotionRelease.operation;
        held = false;
      }),
    );
    const waiting = checkpoint.checkpoint();
    firstRelease.resolve();
    yield* promoting.operation;
    yield* until(first);
    promotionRelease.resolve();
    yield* until(promotion);
    yield* until(waiting);
    expect(overlap).toBe(false);
    expect(saves).toBe(2);
  });

  for (const responds of [true, false]) {
    it(
      responds
        ? "a response arriving during timeout drain retains its own metadata"
        : "a timeout without a response supplies no checkpoint",
      function* () {
        const scope = yield* useScope();
        const response = withResolvers<{
          stopReason: string;
          _meta: { codex: { turnId: string } };
        }>();
        const pending = scope.run(() => response.operation);
        const outcomes = yield* allSettled([
          until(
            runPromptTurn({
              client: {
                prompt: () => pending,
                waitForSessionUpdatesIdle() {
                  return scope.run(function* () {
                    if (responds) {
                      response.resolve({
                        stopReason: "end_turn",
                        _meta: { codex: { turnId: "recovered" } },
                      });
                      yield* pending;
                    }
                  });
                },
              },
              sessionId: "recovery",
              prompt: [],
              timeoutMs: 1,
              conversation: makeRecord("scribe", "/unused"),
              promptMessageId: "prompt",
            }),
          ),
        ]);
        const outcome = outcomes[0];
        if (responds) {
          if (!outcome.ok) {
            throw outcome.error;
          }
          expect(outcome.ok).toBe(true);
          if (outcome.ok) {
            expect(outcome.value).toMatchObject({
              source: "session",
              _meta: { codex: { turnId: "recovered" } },
            });
          }
        } else {
          expect(outcome.ok).toBe(false);
        }
      },
    );
  }
});
