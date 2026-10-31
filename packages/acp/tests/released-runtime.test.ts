import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  allSettled,
  createChannel,
  each,
  ensure,
  sleep,
  spawn,
  stream,
  until,
  useScope,
  withResolvers,
} from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createAcpRuntime, resolveAgentCommand } from "../src/acpx-runtime.ts";
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpSessionRecord,
} from "../src/acpx-runtime.ts";
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
const fs = require("node:fs");
const path = require("node:path");
const controlDirectory = process.argv[2];
let sessionId;
let model = "initial";
let effort = "high";
const options = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model,
    options: ["initial", "selected", "gpt-5.6-luna"].map(value => ({value, name: value})) },
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
  if (!controlDirectory || !request.method.startsWith("session/")) return respond(request);
  fs.appendFile(path.join(controlDirectory, "methods.jsonl"), JSON.stringify({method: request.method, value: request.params?.value}) + "\\n", error => {
    if (error) throw error;
    const name = request.method === "session/load" ? "load" : request.method === "session/prompt" ? "prompt" : undefined;
    if (!name) return respond(request);
    fs.access(path.join(controlDirectory, "hold-" + name), error => {
      if (error) return respond(request);
      const wait = () => fs.access(path.join(controlDirectory, "release-" + name), error => {
        if (error) setTimeout(wait, 5);
        else respond(request);
      });
      wait();
    });
  });
}
function respond(request) {
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    const initialize = () => reply(request.id, {protocolVersion: 1, agentCapabilities: {loadSession: true, promptCapabilities: {}}, authMethods: []});
    if (process.env.XMD_RELEASE_ENV_LOG) {
      require("node:fs").writeFile(process.env.XMD_RELEASE_ENV_LOG, JSON.stringify({
        bound: process.env.CLAUDE_CODE_EXECUTABLE ?? null,
        auth: process.env.XMD_TEST_AUTH ?? null,
      }), error => { if (error) throw error; initialize(); });
    } else initialize();
  } else if (request.method === "session/new" || request.method === "session/load") {
    sessionId = request.params.sessionId ?? (controlDirectory ? "fixed-session" : "session-" + process.pid);
    const loaded = () => reply(request.id, {sessionId, configOptions: options(), _meta: {agentSessionId: "native-" + sessionId}});
    if (controlDirectory && request.method === "session/load") {
      fs.access(path.join(controlDirectory, "fail-load"), error => {
        if (error) loaded();
        else send({jsonrpc: "2.0", id: request.id, error: {code: -32603, message: "Controlled cold load failure"}});
      });
    } else loaded();
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

function* world(trace = false) {
  const dir = join(tmpdir(), `xmd-released-${randomUUID()}`);
  yield* ensureDir(dir);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  const agent = join(dir, "agent with spaces.cjs");
  yield* writeTextFile(agent, AGENT_SOURCE);
  const registry = {
    resolve: () => ["node", agent, ...(trace ? [dir] : [])],
    list: () => ["scribe"],
  };
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
    it("released child environments are snapshots, isolated and absent from retained state", function* () {
      const current = yield* world();
      const parent = process.env.CLAUDE_CODE_EXECUTABLE;
      const auth = process.env.ACPX_AUTH_XMD_TEST_AUTH;
      yield* ensure(() => {
        if (auth === undefined) {
          delete process.env.ACPX_AUTH_XMD_TEST_AUTH;
        } else {
          process.env.ACPX_AUTH_XMD_TEST_AUTH = auth;
        }
      });
      process.env.ACPX_AUTH_XMD_TEST_AUTH = "protected-auth";
      const overlay = {
        CLAUDE_CODE_EXECUTABLE: "bound-first",
        XMD_TEST_AUTH: "overlay-auth",
        XMD_RELEASE_ENV_LOG: join(current.dir, "first-env.json"),
      };
      const first = createAcpRuntime({
        cwd: current.dir,
        sessionStore: current.store,
        agentRegistry: current.registry,
        permissionMode: "deny-all",
        agentProcessEnv: overlay,
      });
      yield* ensure(() => until(first.shutdown()));
      overlay.CLAUDE_CODE_EXECUTABLE = "mutated-after-construction";
      const handle = yield* until(
        first.ensureSession({
          sessionKey: "env-first",
          agent: "scribe",
          mode: "persistent",
          sessionOptions: {
            env: { CLAUDE_CODE_EXECUTABLE: "session-binding", XMD_TEST_AUTH: "session-auth" },
          },
        }),
      );
      const observed: unknown = JSON.parse(yield* readTextFile(overlay.XMD_RELEASE_ENV_LOG));
      expect(observed).toEqual({ bound: "bound-first", auth: "protected-auth" });
      const turn = first.startTurn({ handle, text: "hello", mode: "prompt", requestId: "env" });
      const events: AcpRuntimeEvent[] = [];
      for (const event of yield* each(stream(turn.events))) {
        events.push(event);
        yield* each.next();
      }
      yield* until(turn.result);
      const retained = JSON.stringify({
        record: yield* until(current.store.load("env-first")),
        status: yield* until(first.getStatus({ handle })),
        events,
      });
      expect(retained).not.toContain("bound-first");
      expect(retained).not.toContain("protected-auth");
      expect(retained).not.toContain("overlay-auth");
      expect(retained).not.toContain("XMD_RELEASE_ENV_LOG");
      for (const binding of ["bound-second", undefined]) {
        const log = join(current.dir, binding ?? "absent");
        const runtime = createAcpRuntime({
          cwd: current.dir,
          sessionStore: current.store,
          agentRegistry: current.registry,
          permissionMode: "deny-all",
          agentProcessEnvAllow: ["PATH", "SystemRoot", "WINDIR"],
          agentProcessEnv: {
            XMD_RELEASE_ENV_LOG: log,
            ...(binding === undefined ? {} : { CLAUDE_CODE_EXECUTABLE: binding }),
          },
        });
        yield* ensure(() => until(runtime.shutdown()));
        yield* until(
          runtime.ensureSession({
            sessionKey: binding ?? "env-absent",
            agent: "scribe",
            mode: "persistent",
          }),
        );
        expect(JSON.parse(yield* readTextFile(log))).toEqual({
          bound: binding ?? null,
          auth: "protected-auth",
        });
      }
      expect(process.env.CLAUDE_CODE_EXECUTABLE).toBe(parent);
    });

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
          if (result.status === "cancelled") {
            expect(result._meta).toEqual({
              codex: { turnId: "turn-cancel" },
              opaque: { left: [3, null] },
            });
          }
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

const methodReport = z.object({ method: z.string(), value: z.string().optional() });

function* explicitResumeWorld() {
  const current = yield* world(true);
  yield* writeTextFile(join(current.dir, "methods.jsonl"), "");
  const options: AcpRuntimeOptions = {
    cwd: current.dir,
    sessionStore: current.store,
    agentRegistry: current.registry,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
  };
  let runtime = createAcpRuntime(options);
  yield* ensure(function* () {
    yield* writeTextFile(join(current.dir, "release-load"), "release");
    yield* writeTextFile(join(current.dir, "release-prompt"), "release");
    yield* until(runtime.shutdown());
  });
  const input: AcpRuntimeEnsureInput = {
    sessionKey: "explicit",
    agent: "scribe",
    mode: "persistent",
    sessionOptions: { systemPrompt: "immutable instructions" },
  };
  const original = yield* until(runtime.ensureSession(input));
  yield* until(runtime.setConfigOption({ handle: original, key: "model", value: "gpt-5.6-luna" }));
  yield* until(runtime.setConfigOption({ handle: original, key: "effort", value: "xhigh" }));
  yield* until(runtime.close({ handle: original, reason: "cold reconnect" }));
  const before = yield* until(current.store.load(input.sessionKey));
  if (!before) {
    throw new Error("missing original record");
  }
  expect(before.acpx?.session_origin).toBe("new");
  expect(before.messages).toEqual([]);
  expect(before.acpx?.session_options?.model).toBe("gpt-5.6-luna");
  expect(before.acpx?.desired_config_options?.effort).toBe("xhigh");
  function* reports() {
    const text = yield* readTextFile(join(current.dir, "methods.jsonl"));
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => methodReport.parse(JSON.parse(line)));
  }
  return {
    ...current,
    input,
    original,
    before,
    get runtime() {
      return runtime;
    },
    reports,
    *lifecycle() {
      return (yield* reports())
        .map((report) => report.method)
        .filter((method) => ["session/new", "session/load"].includes(method));
    },
    mark: (name: string) => writeTextFile(join(current.dir, name), "enabled"),
    unmark: (name: string) => rm(join(current.dir, name), { force: true }),
    attach: () =>
      until(runtime.ensureSession({ ...input, resumeSessionId: original.backendSessionId })),
    *restart() {
      yield* until(runtime.shutdown());
      runtime = createAcpRuntime(options);
    },
    *waitFor(method: string) {
      for (let count = 0; count < 1000; count++) {
        if ((yield* reports()).some((report) => report.method === method)) {
          return;
        }
        yield* sleep(5);
      }
      throw new Error(`child did not receive ${method}`);
    },
  };
}

function assertProjection(before: AcpSessionRecord, after: AcpSessionRecord | undefined) {
  if (!after) {
    throw new Error("original projection disappeared");
  }
  expect(after.acpSessionId).toBe(before.acpSessionId);
  expect(after.createdAt).toBe(before.createdAt);
  expect(after.eventLog).toEqual(before.eventLog);
  expect(after.acpx?.session_options).toEqual(before.acpx?.session_options);
  expect(after.acpx?.session_options?.model).toBe("gpt-5.6-luna");
  expect(after.acpx?.desired_config_options?.effort).toBe("xhigh");
}

function* drainedResult(turn: AcpRuntimeTurn) {
  for (const _event of yield* each(stream(turn.events))) {
    yield* each.next();
  }
  return yield* until(turn.result);
}

describe(
  "vendored strict explicit resume",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    for (const operation of ["control", "prompt"]) {
      it(`same-record aliases refuse cold ${operation} replacement`, function* () {
        const f = yield* explicitResumeWorld();
        yield* f.restart();
        const handle = yield* f.attach();
        yield* until(f.runtime.close({ handle, reason: "strict alias remains strict" }));
        yield* until(f.runtime.ensureSession(f.input));
        yield* f.mark("fail-load");
        const controls = (yield* f.reports()).filter(
          (report) => report.method === "session/set_config_option",
        );
        if (operation === "control") {
          const [outcome] = yield* allSettled([
            until(
              f.runtime.setConfigOption({ handle: f.original, key: "model", value: "initial" }),
            ),
          ]);
          expect({ refused: !outcome.ok, lifecycle: yield* f.lifecycle() }).toEqual({
            refused: true,
            lifecycle: ["session/new", "session/load"],
          });
          if (!outcome.ok) {
            expect(outcome.error.message).toContain("could not be resumed");
          }
        } else {
          const result = yield* drainedResult(
            f.runtime.startTurn({
              handle,
              text: "must not send",
              requestId: "refused",
              mode: "prompt",
            }),
          );
          expect({ status: result.status, lifecycle: yield* f.lifecycle() }).toEqual({
            status: "failed",
            lifecycle: ["session/new", "session/load"],
          });
          if (result.status === "failed") {
            expect(result.error.message).toContain("could not be resumed");
          }
        }
        expect(yield* f.lifecycle()).toEqual(["session/new", "session/load"]);
        expect(
          (yield* f.reports()).filter((report) => report.method === "session/set_config_option"),
        ).toEqual(controls);
        expect((yield* f.reports()).some((report) => report.method === "session/prompt")).toBe(
          false,
        );
        const after = yield* until(f.store.load(f.input.sessionKey));
        assertProjection(f.before, after);
        if (operation === "control") {
          expect(after?.messages).toEqual([]);
          yield* f.unmark("fail-load");
          yield* f.restart();
          const next = yield* f.attach();
          expect(
            (yield* drainedResult(
              f.runtime.startTurn({
                handle: next,
                text: "after refusal",
                requestId: "after-refusal",
                mode: "prompt",
              }),
            )).status,
          ).toBe("completed");
          assertProjection(f.before, yield* until(f.store.load(f.input.sessionKey)));
          expect(yield* f.lifecycle()).toEqual(["session/new", "session/load", "session/load"]);
        } else {
          expect(JSON.stringify(after?.messages)).toContain("must not send");
        }
      });
    }

    it("cold exact reconnect replays omitted settings on the original projection", function* () {
      const f = yield* explicitResumeWorld();
      yield* f.restart();
      const handle = yield* f.attach();
      expect(
        (yield* drainedResult(
          f.runtime.startTurn({ handle, text: "continue", requestId: "continued", mode: "prompt" }),
        )).status,
      ).toBe("completed");
      expect((yield* until(f.runtime.getStatus({ handle }))).models?.currentModelId).toBe(
        "gpt-5.6-luna",
      );
      const after = yield* until(f.store.load(f.input.sessionKey));
      assertProjection(f.before, after);
      expect(
        after?.acpx?.config_options?.find((option) => option.id === "effort")?.currentValue,
      ).toBe("xhigh");
      expect(yield* f.lifecycle()).toEqual(["session/new", "session/load"]);
      expect(
        (yield* f.reports())
          .filter((report) => report.method === "session/set_config_option")
          .map((report) => report.value),
      ).toEqual(["gpt-5.6-luna", "xhigh", "gpt-5.6-luna", "xhigh"]);
    });

    it("an independent untargeted record retains its empty-record fallback", function* () {
      const f = yield* explicitResumeWorld();
      yield* f.attach();
      const other = yield* until(f.runtime.ensureSession({ ...f.input, sessionKey: "other" }));
      yield* until(f.runtime.close({ handle: other, reason: "cold reconnect" }));
      yield* f.mark("fail-load");
      yield* until(
        f.runtime.setConfigOption({ handle: other, key: "model", value: "gpt-5.6-luna" }),
      );
      expect(yield* f.lifecycle()).toEqual([
        "session/new",
        "session/new",
        "session/load",
        "session/new",
      ]);
    });

    it("explicit preparation permits a fresh untargeted arrangement", function* () {
      const f = yield* explicitResumeWorld();
      const handle = yield* f.attach();
      yield* until(f.runtime.prepareFreshSession({ handle }));
      const fresh = yield* until(f.runtime.ensureSession(f.input));
      yield* until(f.runtime.close({ handle: fresh, reason: "after explicit reset" }));
      yield* f.mark("fail-load");
      yield* until(
        f.runtime.setConfigOption({ handle: fresh, key: "model", value: "gpt-5.6-luna" }),
      );
      expect(yield* f.lifecycle()).toEqual([
        "session/new",
        "session/new",
        "session/load",
        "session/new",
      ]);
    });

    it("first strict attachment refuses unfinished untargeted work", function* () {
      const f = yield* explicitResumeWorld();
      yield* f.restart();
      yield* until(f.runtime.ensureSession(f.input));
      yield* f.mark("hold-load");
      yield* f.mark("fail-load");
      const control = yield* spawn(() =>
        allSettled([
          until(f.runtime.setConfigOption({ handle: f.original, key: "model", value: "initial" })),
        ]),
      );
      yield* f.waitFor("session/load");
      const [attachment] = yield* allSettled([f.attach()]);
      expect(attachment.ok).toBe(false);
      if (!attachment.ok) {
        expect(attachment.error.message).toContain("unfinished");
      }
      yield* f.mark("release-load");
      const [outcome] = yield* control;
      expect(outcome.ok).toBe(true);
      expect(yield* f.lifecycle()).toEqual(["session/new", "session/load", "session/new"]);
      yield* f.attach();
    });

    it("already strict compatible ensure remains available during a prompt", function* () {
      const f = yield* explicitResumeWorld();
      const handle = yield* f.attach();
      yield* f.mark("hold-prompt");
      const turn = f.runtime.startTurn({
        handle,
        text: "hold",
        requestId: "strict-active",
        mode: "prompt",
      });
      yield* until(turn.promptStarted);
      yield* f.waitFor("session/prompt");
      const alias = yield* f.attach();
      expect(alias.backendSessionId).toBe(handle.backendSessionId);
      yield* f.mark("release-prompt");
      expect((yield* drainedResult(turn)).status).toBe("completed");
      expect(yield* f.lifecycle()).toEqual(["session/new", "session/load"]);
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
