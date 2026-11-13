import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  scoped,
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
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
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
import { retainedSession } from "../src/session-store.ts";
import { createAcpxProvider } from "../src/provider.ts";
import {
  Agent,
  agentIdentityComponents,
  installAgentComponents,
  useNormalizedOutput,
  configurationOf,
} from "@executablemd/core";
import type { AgentPromptEvent, Session } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { createLaunchCoordinator } from "../../core/src/agent/launch-coordinator.ts";
import { openSessionRequest } from "../../core/src/agent/session-request.ts";
import { useFlatWorld } from "./helpers.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import { applySessionConfiguration } from "../src/session-configuration.ts";
import { checkpointFromResult } from "../src/checkpoint.ts";
import { consumeTurn } from "../src/events.ts";
import { makeRecord } from "./helpers.ts";
import {
  J as AcpClient,
  c as LiveSessionCheckpoint,
  l as runPromptTurn,
} from "../vendor/acpx/generated/queue-owner-runtime-ucHvXJ33.js";

import { STANDARD_AGENT_SOURCE, world } from "./released-peer.ts";
import { _ as ProcessDescendants } from "../vendor/acpx/generated/ipc-CQUNQ8QQ.js";

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

describe("Session information", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("SI: standard public configured sessions retain loading identity through close and load", function* () {
    const current = yield* world(true);
    yield* writeTextFile(current.agent, STANDARD_AGENT_SOURCE);
    const sessionKey = "public-standard";
    let held: Session | undefined;
    let hostCalls = 0;
    let started = 0;
    function* run(existing: boolean, text: string) {
      return yield* scoped(function* () {
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
                  return { sessionKey, cwd: current.dir, state: existing ? "existing" : "new" };
                },
                *recordSessionIdentity(_details, identity) {
                  expect((yield* retainedSession(current.store, sessionKey))?.acpSessionId).toBe(
                    identity.acpSessionId,
                  );
                  expect(identity.agentSessionId).toBe(undefined);
                  expect(started).toBe(existing ? 1 : 0);
                  hostCalls++;
                },
              },
            }),
          },
        });
        let resolved: Session | undefined;
        yield* Agent.around({
          *session(args, next) {
            const session = yield* next(...args);
            resolved = session;
            if (!existing) {
              held = session;
              expect(session.identity).toBe(undefined);
              const before = yield* retainedSession(current.store, sessionKey);
              for (let i = 0; i < 10; i++) {
                expect(JSON.parse(JSON.stringify(session)).identity).toBe(undefined);
                expect({ ...session }.identity).toBe(undefined);
              }
              expect(yield* retainedSession(current.store, sessionKey)).toEqual(before);
              expect(before).toBe(undefined);
              expect(hostCalls).toBe(0);
            } else {
              expect(session.identity).toEqual(held?.identity);
            }
            return session;
          },
          *prompt(args, next) {
            const source = yield* next(...args);
            return {
              *[Symbol.iterator]() {
                const subscription = yield* source;
                return {
                  *next() {
                    const event = yield* subscription.next();
                    if (!event.done && event.value.type === "started") {
                      started++;
                      expect(hostCalls).toBeGreaterThan(existing ? 1 : 0);
                      expect(event.value.session).toBe(resolved);
                      expect(configurationOf(event.value.session)).toEqual({
                        model: "selected",
                        effort: "xhigh",
                      });
                      expect(event.value.session.identity).toEqual({
                        kind: "acpx.acpSessionId",
                        value: "fixed-session",
                      });
                      expect(event.value.session.agentSessionId).toBe(undefined);
                      expect(Object.isFrozen(event.value.session.identity)).toBe(true);
                      const admissions = hostCalls;
                      const io = { ...current.storeCalls };
                      const history = journal.snapshot();
                      for (let i = 0; i < 10; i++) {
                        expect(JSON.parse(JSON.stringify(event.value.session)).identity).toEqual(
                          held?.identity,
                        );
                        expect({ ...event.value.session }.agentSessionId).toBe(undefined);
                      }
                      expect(hostCalls).toBe(admissions);
                      expect(current.storeCalls).toEqual(io);
                      expect(journal.snapshot()).toEqual(history);
                    }
                    return event;
                  },
                };
              },
            };
          },
        });
        const doc = join(current.dir, "standard.md");
        yield* writeTextFile(
          doc,
          `<Agent name="scribe"><Session name="review" model="selected" effort="xhigh"><Prompt text="${text}" /></Session></Agent>`,
        );
        yield* useNormalizedOutput();
        const journal = new InMemoryStream();
        const execution = yield* executeInstalled({ path: doc, stream: journal }, [
          { components: agentIdentityComponents() },
        ]);
        const output = yield* execution.output;
        while (!(yield* output.next()).done) {}
        return { result: yield* execution, history: journal.snapshot() };
      });
    }
    expect((yield* run(false, "marker")).result.ok).toBe(true);
    const saved = held?.identity;
    expect(saved).toEqual({ kind: "acpx.acpSessionId", value: "fixed-session" });
    const before = yield* until(current.store.load(sessionKey));
    const methods = yield* readTextFile(join(current.dir, "methods.jsonl"));
    expect(
      methods
        .trim()
        .split("\n")
        .map((line) => methodReport.parse(JSON.parse(line)).method),
    ).toEqual([
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
    ]);
    for (let i = 0; i < 10; i++) {
      expect(held?.identity).toBe(saved);
      expect(JSON.parse(JSON.stringify(held)).identity).toEqual(saved);
      expect({ ...held }.identity).toBe(saved);
    }
    expect(yield* readTextFile(join(current.dir, "methods.jsonl"))).toBe(methods);
    const continued = yield* run(true, "recall-fail");
    expect(continued.result.ok).toBe(false);
    expect(JSON.stringify(continued.history)).toContain("answer:recall-fail:marker");
    expect(held?.identity).toBe(saved);
    const after = yield* until(current.store.load(sessionKey));
    expect(after?.acpSessionId).toBe(before?.acpSessionId);
    expect(after?.messages.slice(0, before?.messages.length)).toEqual(before?.messages);
    const delta = (yield* readTextFile(join(current.dir, "methods.jsonl"))).slice(methods.length);
    const reports = delta
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => methodReport.parse(JSON.parse(line)));
    expect(reports.filter((report) => report.method === "session/load")).toEqual([
      expect.objectContaining({ sessionId: "fixed-session" }),
    ]);
    expect(reports.filter((report) => report.method === "session/prompt")).toEqual([
      expect.objectContaining({ sessionId: "fixed-session", text: "recall-fail" }),
    ]);
    const names = reports.map((report) => report.method);
    expect(names).toEqual([
      "session/load",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(started).toBe(2);
  });
});

describe(
  "Unconfirmed Session information",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("a real strong first attempt without acceptance exposes no identity or started event", function* () {
      const current = yield* world(true);
      let retained = 0;
      yield* installAgentComponents({
        defaultAgent: "scribe",
        rootProvider: {
          options: { defaultAgent: "scribe", permissionMode: "deny-all" },
          factory: createAcpxProvider({
            sessionStore: current.store,
            agentRegistry: current.registry,
            nativeAdapters: {
              scribe: {
                launcher: "scribe",
                identity: "provider-returned",
                acceptance: "first-turn-acceptance",
                resume: () => [],
              },
            },
            advertiseNativeLaunch: [],
            advertiseClientNativeAttachment: [],
            *agentCwd() {
              return current.dir;
            },
            sessions: {
              *requestSession() {
                return { sessionKey: "unconfirmed", cwd: current.dir, state: "new" };
              },
              *recordSessionIdentity() {
                retained++;
              },
            },
          }),
        },
      });
      let session: Session | undefined;
      const events: AgentPromptEvent[] = [];
      yield* Agent.around({
        *session(args, next) {
          session = yield* next(...args);
          expect(session.identity).toBe(undefined);
          return session;
        },
        *prompt(args, next) {
          const source = yield* next(...args);
          return {
            *[Symbol.iterator]() {
              const subscription = yield* source;
              return {
                *next() {
                  const event = yield* subscription.next();
                  if (!event.done) {
                    events.push(event.value);
                  }
                  return event;
                },
              };
            },
          };
        },
      });
      const doc = join(current.dir, "uncertain.md");
      yield* writeTextFile(
        doc,
        '<Agent name="scribe"><Session name="uncertain" model="selected"><Prompt text="no-accept" /></Session></Agent>',
      );
      const execution = yield* executeInstalled({ path: doc, stream: new InMemoryStream() }, [
        { components: agentIdentityComponents() },
      ]);
      const output = yield* execution.output;
      while (!(yield* output.next()).done) {}
      const result = yield* execution;
      expect(result.ok).toBe(false);
      expect(events.filter((event) => event.type === "started")).toEqual([]);
      expect(session?.identity).toBe(undefined);
      expect(retained).toBe(0);
      expect(yield* retainedSession(current.store, "unconfirmed")).toMatchObject({
        agentCommand: expect.any(String),
      });
      expect((yield* retainedSession(current.store, "unconfirmed"))?.agentSessionId).toBe(
        undefined,
      );
      const methods = yield* readTextFile(join(current.dir, "methods.jsonl"));
      expect(
        methods
          .trim()
          .split("\n")
          .map((line) => methodReport.parse(JSON.parse(line)).method)
          .filter((method) => method === "session/prompt"),
      ).toHaveLength(1);
    });
  },
);

describe(
  "released ACPX production consumers",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("workflow role deny lists and environment survive a cold session reopen", function* () {
      const current = yield* world();
      const controls = {
        disallowedTools: ["ScheduleWakeup"],
        env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
      };
      for (const reopened of [false, true]) {
        yield* scoped(function* () {
          const runtime = createAcpRuntime({
            cwd: current.dir,
            sessionStore: current.store,
            agentRegistry: current.registry,
            permissionMode: "deny-all",
          });
          yield* ensure(() => until(runtime.shutdown()));
          const handle = yield* until(
            runtime.ensureSession({
              sessionKey: "controlled-role",
              agent: "scribe",
              mode: "persistent",
              ...(reopened ? {} : { sessionOptions: controls }),
            }),
          );
          const turn = runtime.startTurn({
            handle,
            text: "hello",
            mode: "prompt",
            requestId: reopened ? "continued" : "initial",
          });
          for (const _event of yield* each(stream(turn.events))) {
            yield* each.next();
          }
          yield* until(turn.result);
          const record = yield* until(current.store.load("controlled-role"));
          expect(record?.acpx?.session_options?.disallowed_tools).toEqual(controls.disallowedTools);
          expect(record?.acpx?.session_options?.env).toEqual(controls.env);
        });
      }
    });

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
            nativeAdapters: {
              scribe: {
                launcher: "scribe",
                identity: "provider-returned",
                acceptance: "first-turn-acceptance",
                resume: () => [],
              },
            },
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

    it("1039 A1/A5: real protocol failure details reach the terminal Error", function* () {
      const current = yield* runtimeWorld();
      const turn = current.runtime.startTurn({
        handle: current.handle,
        text: "diagnostic",
        mode: "prompt",
        requestId: "actual-request",
      });
      const channel = createChannel<AgentPromptEvent, string>();
      const subscription = yield* channel;
      const consumer = yield* spawn(() =>
        consumeTurn(
          turn,
          { agent: "scribe", session: { sessionKey: "released", cwd: current.dir } },
          channel,
          () => {},
        ),
      );
      const events: AgentPromptEvent[] = [];
      let next = yield* subscription.next();
      while (!next.done) {
        events.push(next.value);
        next = yield* subscription.next();
      }
      yield* consumer;
      expect(next.value).toBe("answer:diagnostic");
      const terminal = events.find((event) => event.type === "terminal");
      const result = yield* until(turn.result);
      expect(result).toMatchObject({
        status: "failed",
        error: {
          origin: "runtime",
          acp: { code: -32041, details: "/work/project: adapter unavailable" },
        },
      });
      expect(JSON.stringify(result)).not.toContain("<redacted>");
      expect(terminal?.error?.message).toBe("Internal error");
      expect(
        terminal?.error && Reflect.get(terminal.error, "executablemd.agent.prompt-diagnostic"),
      ).toEqual({
        provider: "acp",
        operation: "session/prompt",
        stage: "runtime-turn",
        requestId: "actual-request",
        code: "RUNTIME",
        origin: "runtime",
        acp: {
          code: -32041,
          message: "Internal error",
          details: "/work/project: adapter unavailable",
        },
      });
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

const methodReport = z.object({
  method: z.string(),
  value: z.string().optional(),
  sessionId: z.string().optional(),
  text: z.string().optional(),
});

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

describe("verified native resume", { sanitizeOps: false, sanitizeResources: false }, () => {
  for (const operation of ["control", "prompt"]) {
    it(`checks the live identity again on a cold ${operation}`, function* () {
      const f = yield* explicitResumeWorld();
      yield* f.restart();
      const handle = yield* until(
        f.runtime.ensureSession({
          ...f.input,
          resumeSessionId: f.before.acpSessionId,
          expectedAgentSessionId: f.before.agentSessionId,
        }),
      );
      expect(yield* f.lifecycle()).toEqual(["session/new", "session/load"]);
      yield* until(f.runtime.close({ handle, reason: "force a cold client in the same runtime" }));
      yield* f.mark("different-native-identity");
      const before = (yield* f.reports()).length;
      if (operation === "control") {
        const [outcome] = yield* allSettled([
          until(f.runtime.setConfigOption({ handle, key: "model", value: "initial" })),
        ]);
        if (outcome.ok) {
          throw new Error("The cold configuration write was accepted");
        }
        expect(outcome.error).toMatchObject({ detailCode: "NATIVE_SESSION_IDENTITY_UNAVAILABLE" });
      } else {
        const result = yield* drainedResult(
          f.runtime.startTurn({ handle, text: "unsent", requestId: "refused", mode: "prompt" }),
        );
        expect(result).toMatchObject({
          status: "failed",
          error: { detailCode: "NATIVE_SESSION_IDENTITY_UNAVAILABLE" },
        });
      }
      expect((yield* f.reports()).slice(before).map((report) => report.method)).toEqual([
        "session/load",
      ]);
      const after = yield* until(f.store.load(f.input.sessionKey));
      assertProjection(f.before, after);
      expect(after?.agentSessionId).toBe(f.before.agentSessionId);
    });
  }
});

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

describe(
  "standard retained-session refusal",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    for (const failure of ["fail-load", "no-load", "unused-no-load"]) {
      it(`${failure} preserves conversation facts without replacement`, function* () {
        const current = yield* world(true);
        yield* writeTextFile(
          current.agent,
          STANDARD_AGENT_SOURCE.replace(
            'if (text !== "no-accept") update({sessionUpdate: "session_info_update", _meta: {"executablemd.session-materialization/v1": {state: "accepted"}}});',
            "",
          ),
        );
        const seed = createAcpRuntime({
          cwd: current.dir,
          sessionStore: current.store,
          agentRegistry: current.registry,
          permissionMode: "deny-all",
        });
        yield* ensure(() => until(seed.shutdown()));
        const sessionKey = "standard-" + randomUUID();
        const handle = yield* until(
          seed.ensureSession({ sessionKey, agent: "scribe", mode: "persistent" }),
        );
        if (failure !== "unused-no-load") {
          expect(
            (yield* drainedResult(
              seed.startTurn({ handle, text: "seed", mode: "prompt", requestId: "seed" }),
            )).status,
          ).toBe("completed");
        }
        yield* until(seed.shutdown());
        const before = yield* until(current.store.load(sessionKey));
        if (before === undefined) {
          throw new Error("missing seeded record");
        }
        const baseline = yield* readTextFile(join(current.dir, "methods.jsonl"));
        const flag = join(current.dir, failure === "unused-no-load" ? "no-load" : failure);
        yield* writeTextFile(flag, "enabled");
        const run = function* (text: string) {
          return yield* scoped(function* () {
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
                      return { sessionKey, cwd: current.dir, state: "existing" };
                    },
                    *recordSessionIdentity() {},
                  },
                }),
              },
            });
            const started: unknown[] = [];
            yield* Agent.around({
              *prompt(args, next) {
                const source = yield* next(...args);
                return {
                  *[Symbol.iterator]() {
                    const subscription = yield* source;
                    return {
                      *next() {
                        const event = yield* subscription.next();
                        if (!event.done && event.value.type === "started") {
                          started.push(event.value);
                        }
                        return event;
                      },
                    };
                  },
                };
              },
            });
            const doc = join(current.dir, "refusal.md");
            yield* writeTextFile(
              doc,
              `<Agent name="scribe"><Session name="review"><Prompt text="${text}" /></Session></Agent>`,
            );
            yield* useNormalizedOutput();
            const journal = new InMemoryStream();
            const execution = yield* executeInstalled({ path: doc, stream: journal }, [
              { components: agentIdentityComponents() },
            ]);
            const output = yield* execution.output;
            while (!(yield* output.next()).done) {}
            return { result: yield* execution, history: journal.snapshot(), started };
          });
        };
        const refused = yield* run("must not send");
        expect(refused.result.ok).toBe(false);
        expect(refused.started).toEqual([]);
        const recorded = refused.history.find(
          (event) => event.type === "yield" && event.description.type === "agent_prompt",
        );
        expect(recorded).toMatchObject({
          result: {
            status: "ok",
            value: {
              status: "failed",
              text: "",
              error: { message: expect.stringContaining("Name a different <Session>") },
            },
          },
        });
        const delta = (yield* readTextFile(join(current.dir, "methods.jsonl"))).slice(
          baseline.length,
        );
        const methods = delta
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => methodReport.parse(JSON.parse(line)).method);
        expect(methods).toEqual(failure === "fail-load" ? ["session/load"] : []);
        const after = yield* until(current.store.load(sessionKey));
        if (after === undefined) {
          throw new Error("record disappeared");
        }
        for (const field of [
          "acpSessionId",
          "agentSessionId",
          "agentCommand",
          "cwd",
          "createdAt",
          "sessionMaterialization",
          "acpx",
        ] satisfies (keyof AcpSessionRecord)[]) {
          expect(after[field]).toEqual(before[field]);
        }
        expect(after.sessionMaterialization).toBe(undefined);
        expect(after.agentSessionId).toBe(undefined);
        expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
        expect(after.messages.slice(before.messages.length)).toEqual([
          expect.objectContaining({
            User: expect.objectContaining({ content: [{ Text: "must not send" }] }),
          }),
        ]);
        yield* rm(flag);
        const recoveredBaseline = yield* readTextFile(join(current.dir, "methods.jsonl"));
        expect((yield* run("only the new prompt")).result.ok).toBe(true);
        const recoveredMethods = (yield* readTextFile(join(current.dir, "methods.jsonl")))
          .slice(recoveredBaseline.length)
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => methodReport.parse(JSON.parse(line)).method);
        expect(recoveredMethods).toEqual(["session/load", "session/prompt"]);
      });
    }
  },
);

const configWrite = z.object({
  pid: z.number(),
  method: z.string(),
  configId: z.string().optional(),
  value: z.string().optional(),
});

/**
 * An established persistent conversation whose backend settings outlive each
 * worker, configured afterwards through the default provider factory.
 */
function* coldConfigurationWorld(flags: readonly string[]) {
  const current = yield* world(true);
  const mark = (name: string) => writeTextFile(join(current.dir, name), "enabled");
  for (const flag of ["persist-settings", ...flags]) {
    yield* mark(flag);
  }
  yield* writeTextFile(
    join(current.dir, "settings.json"),
    JSON.stringify({ model: "initial", effort: "high" }),
  );
  const sessionKey = "configured-" + randomUUID();
  yield* scoped(function* () {
    const seed = createAcpRuntime({
      cwd: current.dir,
      sessionStore: current.store,
      agentRegistry: current.registry,
      permissionMode: "deny-all",
    });
    yield* ensure(() => until(seed.shutdown()));
    const handle = yield* until(
      seed.ensureSession({ sessionKey, agent: "scribe", mode: "persistent" }),
    );
    expect(
      (yield* drainedResult(
        seed.startTurn({ handle, text: "seed", mode: "prompt", requestId: "seed" }),
      )).status,
    ).toBe("completed");
  });
  const methodsAtSeed = (yield* readTextFile(join(current.dir, "methods.jsonl"))).length;
  const processesAtSeed = (yield* readTextFile(join(current.dir, "processes.jsonl"))).length;

  let requested = 0;
  const factory = createAcpxProvider({
    sessionStore: current.store,
    agentRegistry: current.registry,
    advertiseNativeLaunch: [],
    advertiseClientNativeAttachment: [],
    *agentCwd() {
      return current.dir;
    },
    sessions: {
      *requestSession() {
        requested++;
        return { sessionKey, cwd: current.dir, state: "existing" };
      },
      *recordSessionIdentity() {},
    },
  });
  const options = { defaultAgent: "scribe", permissionMode: "deny-all" } satisfies Parameters<
    typeof factory
  >[0];

  function* sharedProvider() {
    yield* useFlatWorld(current.dir);
    yield* factory(
      options,
      createLaunchCoordinator({}, () => []),
    );
    return function* session(configured: boolean) {
      const issuance = openSessionRequest(undefined, "review");
      if (configured) {
        issuance.configure({ model: "selected", effort: "xhigh" });
      }
      try {
        return yield* Agent.operations.session(issuance.request);
      } finally {
        issuance.close();
      }
    };
  }

  function* provider() {
    yield* installAgentComponents({
      defaultAgent: "scribe",
      rootProvider: { options, factory },
    });
    yield* useNormalizedOutput();
    return function* execute(body: string) {
      const doc = join(current.dir, `configured-${randomUUID()}.md`);
      yield* writeTextFile(doc, `<Agent name="scribe">${body}</Agent>`);
      const journal = new InMemoryStream();
      const execution = yield* executeInstalled({ path: doc, stream: journal }, [
        { components: agentIdentityComponents() },
      ]);
      const output = yield* execution.output;
      while (!(yield* output.next()).done) {}
      return { result: yield* execution, history: JSON.stringify(journal.snapshot()) };
    };
  }

  return {
    ...current,
    sessionKey,
    mark,
    provider,
    sharedProvider,
    requests: () => requested,
    /** Every write and attachment the backend received after seeding. */
    *methods() {
      return (yield* readTextFile(join(current.dir, "methods.jsonl")))
        .slice(methodsAtSeed)
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => configWrite.parse(JSON.parse(line)))
        .map((report) =>
          report.method === "session/set_config_option"
            ? `${report.configId}=${report.value}`
            : report.method,
        );
    },
    /** Each worker that attached to the conversation, with what it received. */
    *sessionWorkers() {
      const workers = new Map<number, string[]>();
      for (const line of (yield* readTextFile(join(current.dir, "methods.jsonl")))
        .slice(methodsAtSeed)
        .trim()
        .split("\n")
        .filter(Boolean)) {
        const report = configWrite.parse(JSON.parse(line));
        const methods = workers.get(report.pid) ?? [];
        methods.push(
          report.method === "session/set_config_option"
            ? `${report.configId}=${report.value}`
            : report.method,
        );
        workers.set(report.pid, methods);
      }
      return [...workers.values()];
    },
    /** Worker starts and exits after seeding, availability probes included. */
    *processes() {
      const events = (yield* readTextFile(join(current.dir, "processes.jsonl")))
        .slice(processesAtSeed)
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => z.object({ pid: z.number(), event: z.string() }).parse(JSON.parse(line)));
      return {
        started: events.filter((event) => event.event === "start").map((event) => event.pid),
        exited: events.filter((event) => event.event === "exit").map((event) => event.pid),
      };
    },
    *settings() {
      return z
        .object({ model: z.string(), effort: z.string() })
        .parse(JSON.parse(yield* readTextFile(join(current.dir, "settings.json"))));
    },
    *waitForRequest(count: number) {
      for (let attempt = 0; attempt < 2000; attempt++) {
        if (requested >= count) {
          return;
        }
        yield* sleep(5);
      }
      throw new Error(`the provider never received request ${count}`);
    },
    *waitFor(name: string) {
      for (let count = 0; count < 2000; count++) {
        if (yield* exists(join(current.dir, name))) {
          return;
        }
        yield* sleep(5);
      }
      throw new Error(`the backend never reached ${name}`);
    },
  };
}

const CONFIGURED =
  '<Session name="review" model="selected" effort="xhigh"><Prompt text="after" /></Session>';

describe(
  "one connection configures a resumed conversation",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("a refused dependent write that applied is restored model-first on the same worker", function* () {
      const current = yield* coldConfigurationWorld([
        "model-effort-ids",
        "hold-config-effort-selected",
        "refuse-config-effort-selected",
      ]);
      const before = yield* until(current.store.load(current.sessionKey));
      const execute = yield* current.provider();
      const run = yield* spawn(() => execute(CONFIGURED));
      // Torn down before `run`: a failed assertion must not leave it on the held write.
      yield* ensure(() => current.mark("release-config-effort-selected"));
      yield* current.waitFor("mutated-effort-selected");
      // The model write is durable before its dependent write is dispatched.
      const saved = yield* until(current.store.load(current.sessionKey));
      expect(saved?.acpx?.config_options?.find((option) => option.id === "model")).toMatchObject({
        currentValue: "selected",
      });
      expect(yield* current.methods()).toEqual([
        "session/load",
        "model=selected",
        "effort-selected=xhigh",
      ]);
      yield* current.mark("release-config-effort-selected");
      const refused = yield* run;
      expect(refused.result.ok).toBe(false);
      expect(refused.history).toContain("Controlled refusal of effort-selected after it applied");
      expect(refused.history).not.toContain("answer:after");
      // Model first, then effort through the selector the restored model reports.
      expect(yield* current.methods()).toEqual([
        "session/load",
        "model=selected",
        "effort-selected=xhigh",
        "model=initial",
        "effort-initial=high",
      ]);
      expect(yield* current.settings()).toEqual({ model: "initial", effort: "high" });
      expect(yield* current.sessionWorkers()).toHaveLength(1);
      const after = yield* until(current.store.load(current.sessionKey));
      expect(after?.acpx?.session_options?.model).toBe(before?.acpx?.session_options?.model);
      expect(after?.acpx?.desired_config_options).toEqual(before?.acpx?.desired_config_options);
      const workers = yield* current.processes();
      expect(workers.exited).toHaveLength(workers.started.length);
      expect(new Set(workers.exited)).toEqual(new Set(workers.started));
    });

    it("a cancelled attempt joins the held write before restoring and releasing", function* () {
      const current = yield* coldConfigurationWorld([
        "model-effort-ids",
        "hold-config-effort-selected",
      ]);
      const execute = yield* current.provider();
      const run = yield* spawn(() => execute(CONFIGURED));
      // Torn down before `run`: a failed assertion must not leave it on the held write.
      yield* ensure(() => current.mark("release-config-effort-selected"));
      yield* current.waitFor("mutated-effort-selected");
      let halted = false;
      const halting = yield* spawn(function* () {
        yield* run.halt();
        halted = true;
      });
      yield* sleep(300);
      // The write that may have landed holds restoration, the next operation and release.
      expect(halted).toBe(false);
      expect(yield* current.methods()).toEqual([
        "session/load",
        "model=selected",
        "effort-selected=xhigh",
      ]);
      const held = (yield* readTextFile(join(current.dir, "methods.jsonl")))
        .trim()
        .split("\n")
        .map((line) => configWrite.parse(JSON.parse(line)))
        .at(-1);
      expect((yield* current.processes()).exited).not.toContain(held?.pid);
      yield* current.mark("release-config-effort-selected");
      yield* halting;
      expect(halted).toBe(true);
      expect(yield* current.methods()).toEqual([
        "session/load",
        "model=selected",
        "effort-selected=xhigh",
        "model=initial",
        "effort-initial=high",
      ]);
      expect(yield* current.settings()).toEqual({ model: "initial", effort: "high" });
      expect(yield* current.sessionWorkers()).toHaveLength(1);
      const workers = yield* current.processes();
      expect(workers.exited).toHaveLength(workers.started.length);
      expect(new Set(workers.exited)).toEqual(new Set(workers.started));
    });

    it("unverifiable restoration fences a subsequent use in the same execution", function* () {
      const current = yield* coldConfigurationWorld([
        "model-effort-ids",
        "hold-config-effort-selected",
        "refuse-config-effort-selected",
      ]);
      const session = yield* current.sharedProvider();
      const run = yield* spawn(function* () {
        try {
          yield* session(true);
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });
      // Torn down before `run`: a failed assertion must not leave it on the held write.
      yield* ensure(() => current.mark("release-config-effort-selected"));
      yield* current.waitFor("mutated-effort-selected");
      yield* current.mark("refuse-all-config");
      yield* current.mark("release-config-effort-selected");
      const refused = yield* run;
      expect(refused).toContain("Controlled refusal of effort-selected after it applied");
      expect(refused).toContain("will not be used again during this run");
      const before = { ...current.storeCalls };
      try {
        yield* session(false);
        throw new Error("the fenced session returned");
      } catch (error) {
        expect(error).toMatchObject({
          message: expect.stringContaining("after a failed restoration"),
        });
      }
      expect(current.requests()).toBe(2);
      expect(current.storeCalls).toEqual(before);
      // One in-place attempt, then one exact reattachment with replay suppressed.
      expect(yield* current.sessionWorkers()).toEqual([
        ["session/load", "model=selected", "effort-selected=xhigh", "model=initial"],
        ["session/load"],
      ]);
      expect(yield* current.settings()).toEqual({ model: "selected", effort: "xhigh" });
      const workers = yield* current.processes();
      expect(workers.exited).toHaveLength(workers.started.length);
      expect(new Set(workers.exited)).toEqual(new Set(workers.started));
    });

    it("cancellation during close joins the worker before a queued successor can act", function* () {
      const current = yield* coldConfigurationWorld(["model-effort-ids"]);
      const close = AcpClient.prototype.close;
      const scope = yield* useScope();
      const entered = withResolvers<void>();
      const release = withResolvers<void>();
      let held = false;
      AcpClient.prototype.close = function () {
        if (!held && Reflect.get(this, "options").xmdStrictClose === true) {
          held = true;
          entered.resolve();
          return scope.run(() => release.operation).then(() => close.call(this));
        }
        return close.call(this);
      };
      yield* ensure(() => {
        AcpClient.prototype.close = close;
      });
      const session = yield* current.sharedProvider();
      const run = yield* spawn(() => session(true));
      yield* ensure(() => {
        release.resolve();
      });
      yield* entered.operation;
      const saved = yield* until(current.store.load(current.sessionKey));
      expect(saved?.acpx?.config_options?.map((option) => option.currentValue)).toEqual([
        "selected",
        "xhigh",
      ]);
      const workers = yield* current.processes();
      expect(workers.exited).not.toContain(workers.started.at(-1));

      let halted = false;
      let advanced = false;
      const halting = yield* spawn(function* () {
        yield* run.halt();
        halted = true;
      });
      const successor = yield* spawn(function* () {
        const result = yield* session(false);
        advanced = true;
        return result;
      });
      yield* ensure(() => {
        release.resolve();
      });
      yield* current.waitForRequest(2);
      expect(halted).toBe(false);
      expect(advanced).toBe(false);
      expect(yield* current.sessionWorkers()).toEqual([
        ["session/load", "model=selected", "effort-selected=xhigh"],
      ]);

      release.resolve();
      yield* halting;
      try {
        yield* run;
        throw new Error("the cancelled configuration returned");
      } catch (error) {
        expect(error).toMatchObject({ message: "halted" });
      }
      const next = yield* successor;
      expect(next.sessionKey).toBe(current.sessionKey);
      expect(yield* current.settings()).toEqual({ model: "initial", effort: "high" });
      expect(yield* current.sessionWorkers()).toEqual([
        ["session/load", "model=selected", "effort-selected=xhigh"],
        ["session/load", "model=initial", "effort-initial=high"],
      ]);
      const finished = yield* current.processes();
      expect(finished.exited).toHaveLength(finished.started.length);
      expect(new Set(finished.exited)).toEqual(new Set(finished.started));
    });

    it("retains a refused write and failed final save until the same checkpoint retries", function* () {
      const current = yield* coldConfigurationWorld(["refuse-config-effort"]);
      const close = AcpClient.prototype.close;
      const clients: unknown[] = [];
      AcpClient.prototype.close = function () {
        if (Reflect.get(this, "options").xmdStrictClose === true) {
          clients.push(this);
        }
        return close.call(this);
      };
      yield* ensure(() => {
        AcpClient.prototype.close = close;
      });
      const save = current.store.save;
      let failed = false;
      let retried = false;
      current.store.save = (record) => {
        if (clients.length === 1 && !failed) {
          failed = true;
          return Promise.reject(new Error("controlled final checkpoint failure"));
        }
        if (failed && clients.length === 1) {
          retried = true;
        }
        return save(record);
      };
      yield* ensure(() => {
        current.store.save = save;
      });
      const execute = yield* current.provider();
      const result = yield* execute(CONFIGURED);
      expect(result.result.ok).toBe(false);
      expect(result.history).toContain("Controlled refusal of effort after it applied");
      expect(result.history).toContain("controlled final checkpoint failure");
      expect(result.history).not.toContain("answer:after");
      expect(failed).toBe(true);
      expect(retried).toBe(true);
      expect(yield* current.sessionWorkers()).toEqual([
        ["session/load", "model=selected", "effort=xhigh", "model=initial", "effort=high"],
        ["session/load"],
      ]);
      expect(clients).toHaveLength(2);
      expect(clients[0]).not.toBe(clients[1]);
      expect(yield* current.settings()).toEqual({ model: "initial", effort: "high" });
    });

    it("strict close retains an unproved descendant observation on the same client", function* () {
      const current = yield* coldConfigurationWorld([]);
      const close = AcpClient.prototype.close;
      const unresolved = ProcessDescendants.prototype.hasUnresolvedOwnership;
      const attempts: unknown[] = [];
      AcpClient.prototype.close = function () {
        if (Reflect.get(this, "options").xmdStrictClose === true) {
          attempts.push(this);
        }
        return close.call(this);
      };
      ProcessDescendants.prototype.hasUnresolvedOwnership = function () {
        return attempts.length === 1 || unresolved.call(this);
      };
      yield* ensure(() => {
        AcpClient.prototype.close = close;
        ProcessDescendants.prototype.hasUnresolvedOwnership = unresolved;
      });
      const execute = yield* current.provider();
      const result = yield* execute(CONFIGURED);
      expect(result.result.ok).toBe(false);
      expect(result.history).toContain("descendant ownership could not be proved settled");
      expect(result.history).not.toContain("answer:after");
      expect(attempts).toHaveLength(3);
      expect(attempts[0]).toBe(attempts[1]);
      expect(attempts[1]).not.toBe(attempts[2]);
      expect(yield* current.sessionWorkers()).toEqual([
        ["session/load", "model=selected", "effort=xhigh"],
        ["session/load", "model=initial", "effort=high"],
      ]);
      const workers = yield* current.processes();
      expect(workers.exited).toHaveLength(workers.started.length);
      expect(new Set(workers.exited)).toEqual(new Set(workers.started));
    });

    it("a different native assertion refuses the exact load before changing durable state", function* () {
      const current = yield* coldConfigurationWorld([]);
      const before = yield* until(current.store.load(current.sessionKey));
      expect(before?.agentSessionId).toBe("native-fixed-session");
      yield* current.mark("different-native-identity");
      const execute = yield* current.provider();
      const refused = yield* execute(CONFIGURED);
      expect(refused.result.ok).toBe(false);
      expect(refused.history).toContain("The provider reopened a different native conversation.");
      expect(yield* current.methods()).toEqual(["session/load"]);
      const after = yield* until(current.store.load(current.sessionKey));
      expect(after?.agentSessionId).toBe(before?.agentSessionId);
      expect(after?.acpSessionId).toBe(before?.acpSessionId);
      expect(after?.messages).toEqual(before?.messages);
      expect(after?.acpx).toEqual(before?.acpx);
    });

    it("a legacy split refuses after mutation and restores through fresh original-model selectors", function* () {
      const current = yield* coldConfigurationWorld([
        "model-effort-ids",
        "legacy-config-model",
        "refuse-config-effort-selected",
      ]);
      const before = yield* until(current.store.load(current.sessionKey));
      expect(before?.acpx?.session_options?.model).toBeUndefined();
      const execute = yield* current.provider();
      const refused = yield* execute(CONFIGURED);
      expect(refused.result.ok).toBe(false);
      expect(refused.history).toContain("Controlled refusal of effort-selected after it applied");
      expect(refused.history).not.toContain("Restoring the prior configuration failed");
      expect(yield* current.sessionWorkers()).toEqual([
        ["session/load", "model=selected"],
        ["session/load", "effort-selected=xhigh", "model=initial"],
        ["session/load", "effort-initial=high"],
      ]);
      expect(yield* current.settings()).toEqual({ model: "initial", effort: "high" });
      const after = yield* until(current.store.load(current.sessionKey));
      expect(after?.acpx?.session_options?.model).toBeUndefined();
      expect(after?.acpx?.desired_config_options).toEqual(before?.acpx?.desired_config_options);

      yield* writeTextFile(
        join(current.dir, "settings.json"),
        JSON.stringify({ model: "gpt-5.6-luna", effort: "high" }),
      );
      const next = yield* execute(
        '<Session name="review"><Prompt text="unconfigured" /></Session>',
      );
      expect(next.history).toContain("answer:unconfigured");
      expect(yield* current.settings()).toEqual({ model: "gpt-5.6-luna", effort: "high" });
      expect((yield* current.sessionWorkers()).at(-1)).toEqual(["session/load", "session/prompt"]);
    });

    it("a legacy model acknowledgement settles once and effort continues ordinarily", function* () {
      const current = yield* coldConfigurationWorld(["legacy-config-model", "model-effort-ids"]);
      yield* current.mark("omit-native-identity");
      const execute = yield* current.provider();
      const configured = yield* execute(CONFIGURED);
      if (!configured.result.ok) {
        throw new Error(configured.history);
      }
      expect(configured.history).toContain("answer:after");
      expect(yield* current.methods()).toEqual([
        "session/load",
        "model=selected",
        "session/load",
        "effort-selected=xhigh",
        // The prompt worker's load replays the saved effort, as before.
        "session/load",
        "effort-selected=xhigh",
        "session/prompt",
      ]);
      expect(yield* current.settings()).toEqual({ model: "selected", effort: "xhigh" });
      const saved = yield* until(current.store.load(current.sessionKey));
      expect(saved?.agentSessionId).toBe("native-fixed-session");
    });

    it("both writes of one change share one worker", function* () {
      const current = yield* coldConfigurationWorld(["model-effort-ids"]);
      const execute = yield* current.provider();
      const configured = yield* execute(CONFIGURED);
      if (!configured.result.ok) {
        throw new Error(configured.history);
      }
      expect(yield* current.sessionWorkers()).toEqual([
        ["session/load", "model=selected", "effort-selected=xhigh"],
        // The prompt worker's load replays the saved effort, as before.
        ["session/load", "effort-selected=xhigh", "session/prompt"],
      ]);
      const workers = yield* current.processes();
      expect(workers.exited).toHaveLength(workers.started.length);
      expect(new Set(workers.exited)).toEqual(new Set(workers.started));
    });
  },
);
