/**
 * Tier NR — an established V3 conversation crosses the real ACPX reconnect.
 * The backend is controlled JSON-RPC, not a replacement runtime: the fixture
 * can answer resume/load with an identity other than the one requested.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { Agent } from "@executablemd/core";
import type { AgentProviderAuthority, ExecutableBuildBindingV1 } from "@executablemd/core";
import { createAcpxProvider } from "../src/provider.ts";
import type { AcpxSessionIdentity, AcpxSessionPlacement } from "../src/provider.ts";
import { createAcpRuntime } from "../src/acpx-runtime.ts";
import { k as AcpClient } from "../vendor/acpx/generated/live-checkpoint-ClPCSdrW.js";
import type { AcpRuntimeOptions, AcpSessionRecord, AcpSessionStore } from "../src/acpx-runtime.ts";
import { bindsBuild, nativeAdapterFor, nativeCapabilityPolicy } from "../src/native-launch.ts";
import { createMemorySessionRouteStore } from "../src/session-route.ts";
import type {
  AgentSessionRoute,
  AgentSessionRouteStore,
  AgentSessionRouteV3,
} from "../src/session-route.ts";
import { deriveSessionKey, resolveSessionPlacement } from "../src/session-key.ts";
import {
  answered,
  createFakeObserver,
  makeCoordinator,
  makeRecord,
  makeRegistry,
  useFlatWorld,
} from "./helpers.ts";
import type { CoordinatorHarness, FakeObserverHarness } from "./helpers.ts";

const NATIVE_ID = "native-conversation-A";
const ACP_ID = "acp-arrangement-A";
const CONTINUATION = "Continue this existing conversation.";
const HISTORICAL_BINDING: ExecutableBuildBindingV1 = {
  schema: "executable-build.v1",
  reportedVersion: "codex-cli 0.153.2",
  executableDigest: { algorithm: "sha256", value: "a".repeat(64) },
};
const AUTHORITY: AgentProviderAuthority = {
  sessionIdentity() {
    throw new Error("this regression issues no component placement");
  },
  checkpoint() {
    throw new Error("this regression issues no workflow checkpoint");
  },
  *perform() {
    throw new Error("a continuation must not materialize or launch");
  },
  *refuse() {
    throw new Error("a continuation must not produce a launch record");
  },
};

interface World {
  dir: string;
  command: string;
  log: string;
  key: string;
  route: AgentSessionRouteV3;
  routes: AgentSessionRouteStore;
  store: AcpSessionStore;
  records: Map<string, AcpSessionRecord>;
  saves: AcpSessionRecord[];
  coordinator: CoordinatorHarness;
  observer: FakeObserverHarness;
  runtimeOptions: AcpRuntimeOptions[];
  routePublications: AgentSessionRoute[];
  establishments: { placement: AcpxSessionPlacement; identity: AcpxSessionIdentity }[];
}

function codex() {
  const adapter = nativeAdapterFor("codex");
  if (!adapter || !bindsBuild(adapter) || adapter.identity !== "provider-returned") {
    throw new Error("the built-in Codex adapter must carry its bound protocol");
  }
  return adapter;
}

function* world(method: "resume" | "load", identity: string): Operation<World> {
  const dir = join(tmpdir(), `xmd-native-reconnect-${randomUUID()}`);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  yield* ensureDir(dir);
  const log = join(dir, "backend.jsonl");
  const fixture = fileURLToPath(new URL("./fixtures/native-reconnect-agent.cjs", import.meta.url));
  const command = ["node", fixture, method, identity, log]
    .map((part) => JSON.stringify(part))
    .join(" ");
  const key = deriveSessionKey(command, dir);
  const record: AcpSessionRecord = {
    ...makeRecord(command, dir),
    acpxRecordId: key,
    acpSessionId: ACP_ID,
    agentSessionId: NATIVE_ID,
    closed: true,
  };
  const records = new Map([[key, record]]);
  const saves: AcpSessionRecord[] = [];
  const store: AcpSessionStore = {
    load: (id) => Promise.resolve(structuredClone(records.get(id))),
    save: (value) => {
      const retained = structuredClone(value);
      records.set(value.acpxRecordId, retained);
      saves.push(retained);
      return Promise.resolve();
    },
  };
  const route: AgentSessionRouteV3 = {
    schema: "session-route.v3",
    route: "acp-first",
    provider: "acpx",
    agent: command,
    sessionKey: key,
    executableBinding: HISTORICAL_BINDING,
  };
  const retainedRoutes = createMemorySessionRouteStore();
  yield* retainedRoutes.publish(route);
  const routePublications: AgentSessionRoute[] = [];
  const routes: AgentSessionRouteStore = {
    read: retainedRoutes.read,
    *publish(candidate) {
      routePublications.push(structuredClone(candidate));
      return yield* retainedRoutes.publish(candidate);
    },
  };
  return {
    dir,
    command,
    log,
    key,
    route,
    routes,
    store,
    records,
    saves,
    coordinator: makeCoordinator(),
    runtimeOptions: [],
    routePublications,
    establishments: [],
    observer: createFakeObserver({
      path: "/live/codex-9.2.1",
      digest: "b".repeat(64),
      metadata: {
        help: answered(
          "Codex CLI\n\nUsage: codex [OPTIONS] [PROMPT]\n\nCommands:\n  resume  Resume a previous interactive session\n",
        ),
        "resume-help": answered(
          "Resume a previous interactive session\n\nUsage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]\n\nArguments:\n  [SESSION_ID]\n          Session id (UUID) or session name. UUIDs take precedence if it parses.\n  [PROMPT]\n          Optional user prompt\n",
        ),
        version: answered("codex-cli 9.2.1"),
      },
    }),
  };
}

function* install(space: World, observeEstablishment = false): Operation<void> {
  yield* useFlatWorld(space.dir);
  const adapter = codex();
  const factory = createAcpxProvider({
    createRuntime(options) {
      space.runtimeOptions.push(options);
      return createAcpRuntime(options);
    },
    sessionStore: space.store,
    agentRegistry: makeRegistry({ codex: space.command }),
    advertiseNativeLaunch: ["codex"],
    advertiseClientNativeAttachment: [],
    advertiseProviderNativeContinuation: ["codex"],
    nativeCapabilityPolicy: nativeCapabilityPolicy({ platform: "darwin", architecture: "arm64" }),
    nativeAdapters: {
      codex: { ...adapter, binding: { ...adapter.binding, adapterCommand: space.command } },
    },
    executableObserver: space.observer.observer,
    coordinator: space.coordinator.coordinator,
    routeStore: space.routes,
    ...(observeEstablishment
      ? {
          sessions: {
            place: () => resolveSessionPlacement(space.store, space.command, space.dir),
            *established(placement: AcpxSessionPlacement, identity: AcpxSessionIdentity) {
              space.establishments.push(structuredClone({ placement, identity }));
            },
          },
        }
      : {}),
  });
  yield* factory({ defaultAgent: "codex", permissionMode: "deny-all" }, AUTHORITY);
}

function* prompt(): Operation<void> {
  yield* scoped(function* () {
    const stream = yield* Agent.operations.prompt(CONTINUATION);
    const subscription = yield* stream;
    let next = yield* subscription.next();
    while (!next.done) {
      if (next.value.type === "terminal" && next.value.error !== undefined) {
        throw next.value.error;
      }
      next = yield* subscription.next();
    }
    expect(next.value).toBe("continued");
  });
}

interface Request {
  method: string;
  pid: number;
  params?: unknown;
}

function* requests(space: World): Operation<Request[]> {
  const text = yield* readTextFile(space.log);
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (
        !value ||
        typeof value !== "object" ||
        !("method" in value) ||
        typeof value.method !== "string" ||
        !("pid" in value) ||
        typeof value.pid !== "number"
      ) {
        throw new Error("unreadable fixture request");
      }
      return {
        method: value.method,
        pid: value.pid,
        ...("params" in value ? { params: value.params } : {}),
      };
    });
}

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return true;
    }
    throw error;
  }
}

function* unchanged(space: World): Operation<void> {
  expect(yield* space.routes.read(space.route)).toEqual(space.route);
  expect(space.records.get(space.key)?.agentSessionId).toBe(NATIVE_ID);
  expect(space.records.get(space.key)?.acpSessionId).toBe(ACP_ID);
  expect(space.saves.every((record) => record.agentSessionId === NATIVE_ID)).toBe(true);
  expect(space.saves.every((record) => record.sessionMaterialization === undefined)).toBe(true);
  expect(space.records.size).toBe(1);
}

describe(
  "Tier NR — exact native identity at real ACPX reconnect",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("NR3: refused reconnect with failed client cleanup keeps recovery ownership", function* () {
      const space = yield* world("resume", "native-conversation-B");
      const close = AcpClient.prototype.close;
      const held = new Set<InstanceType<typeof AcpClient>>();
      let closeAttempts = 0;
      let refusal: unknown;
      let cleanupFailure: unknown;
      yield* ensure(function* () {
        AcpClient.prototype.close = close;
        for (const client of held) {
          yield* until(close.call(client));
        }
      });
      AcpClient.prototype.close = function (this: InstanceType<typeof AcpClient>) {
        closeAttempts += 1;
        held.add(this);
        throw new Error("controlled client cleanup could not prove quiescence");
      };
      try {
        yield* scoped(function* () {
          yield* install(space);
          try {
            yield* prompt();
          } catch (error) {
            refusal = error;
          }
        });
      } catch (error) {
        cleanupFailure = error;
      }
      expect(refusal).toBeDefined();
      expect(cleanupFailure).toBeDefined();
      expect(closeAttempts).toBeGreaterThan(0);
      expect(held.size).toBe(1);
      expect(space.coordinator.events).toEqual(["owned", "released-active"]);
      const received = yield* requests(space);
      expect(received.map((request) => request.method)).toEqual(["initialize", "session/resume"]);
      expect(received.every((request) => !gone(request.pid))).toBe(true);
      yield* unchanged(space);
      AcpClient.prototype.close = close;
      for (const client of held) {
        yield* until(close.call(client));
      }
      held.clear();
      expect(received.every((request) => gone(request.pid))).toBe(true);
      let nextOwner: unknown;
      try {
        yield* scoped(function* () {
          yield* install(space);
          yield* prompt();
        });
      } catch (error) {
        nextOwner = error;
      }
      expect(nextOwner).toMatchObject({ name: "AgentSessionRecoveryRequired" });
      expect(space.coordinator.acquisitions.map((entry) => entry.outcome)).toEqual([
        "granted",
        "recovery-required",
      ]);
      expect(yield* requests(space)).toEqual(received);
    });

    it("NR6: eager Session refusal with failed client cleanup retains recovery ownership", function* () {
      const space = yield* world("resume", "native-conversation-B");
      const close = AcpClient.prototype.close;
      const held = new Set<InstanceType<typeof AcpClient>>();
      let closeAttempts = 0;
      let returned = false;
      let refusal: unknown;
      let cleanupFailure: unknown;
      yield* ensure(function* () {
        AcpClient.prototype.close = close;
        for (const client of held) {
          yield* until(close.call(client));
        }
      });
      AcpClient.prototype.close = function (this: InstanceType<typeof AcpClient>) {
        closeAttempts += 1;
        held.add(this);
        throw new Error("controlled eager client cleanup could not prove quiescence");
      };
      try {
        yield* scoped(function* () {
          yield* install(space, true);
          try {
            yield* Agent.operations.session();
            returned = true;
          } catch (error) {
            refusal = error;
          }
        });
      } catch (error) {
        cleanupFailure = error;
      }
      expect(returned).toBe(false);
      expect(refusal).toBeDefined();
      expect(cleanupFailure).toBeDefined();
      expect(closeAttempts).toBeGreaterThan(0);
      expect(held.size).toBe(1);
      expect(space.coordinator.events).toEqual(["owned", "released-active"]);
      expect(space.establishments).toEqual([]);
      expect(space.routePublications).toEqual([]);
      const received = yield* requests(space);
      expect(received.map((request) => request.method)).toEqual(["initialize", "session/resume"]);
      expect(received[1]?.params).toMatchObject({ sessionId: ACP_ID });
      expect(received.every((request) => !gone(request.pid))).toBe(true);
      expect(space.records.get(space.key)?.messages).toEqual([]);
      yield* unchanged(space);
      AcpClient.prototype.close = close;
      for (const client of held) {
        yield* until(close.call(client));
      }
      held.clear();
      expect(received.every((request) => gone(request.pid))).toBe(true);
      let nextOwner: unknown;
      try {
        yield* scoped(function* () {
          yield* install(space, true);
          yield* Agent.operations.session();
        });
      } catch (error) {
        nextOwner = error;
      }
      expect(nextOwner).toMatchObject({ name: "AgentSessionRecoveryRequired" });
      expect(space.coordinator.acquisitions.map((entry) => entry.outcome)).toEqual([
        "granted",
        "recovery-required",
      ]);
      expect(space.establishments).toEqual([]);
      expect(space.routePublications).toEqual([]);
      expect(yield* requests(space)).toEqual(received);
    });

    for (const method of ["resume", "load"]) {
      if (method !== "resume" && method !== "load") {
        throw new Error("unexpected fixture method");
      }
      for (const identity of ["native-conversation-B", "absent"]) {
        it(`NR1: ${method} returning ${identity} refuses before a prompt or identity update`, function* () {
          const space = yield* world(method, identity);
          let refusal: unknown;
          yield* scoped(function* () {
            yield* install(space);
            try {
              yield* prompt();
            } catch (error) {
              refusal = error;
            }
          });
          expect(refusal).toMatchObject({
            name: "AttachmentRefused",
            failure: { class: "identity-unavailable" },
          });
          const received = yield* requests(space);
          expect(received.map((request) => request.method)).toEqual([
            "initialize",
            `session/${method}`,
          ]);
          expect(received[1]?.params).toMatchObject({ sessionId: ACP_ID });
          expect(received.every((request) => gone(request.pid))).toBe(true);
          expect(space.coordinator.events).toEqual(["owned", "quiesced", "released-idle"]);
          expect(space.records.get(space.key)?.messages).toEqual([]);
          yield* unchanged(space);
        });

        it(`NR4: eager Session ${method} returning ${identity} refuses before returning or publishing`, function* () {
          const space = yield* world(method, identity);
          let returned = false;
          let refusal: unknown;
          yield* scoped(function* () {
            yield* install(space, true);
            try {
              yield* Agent.operations.session();
              returned = true;
            } catch (error) {
              refusal = error;
            }
          });
          expect(returned).toBe(false);
          expect(refusal).toMatchObject({
            name: "AttachmentRefused",
            failure: { class: "identity-unavailable" },
          });
          const received = yield* requests(space);
          expect(received.map((request) => request.method)).toEqual([
            "initialize",
            `session/${method}`,
          ]);
          expect(received[1]?.params).toMatchObject({ sessionId: ACP_ID });
          expect(received.every((request) => gone(request.pid))).toBe(true);
          expect(space.coordinator.events).toEqual(["owned", "quiesced", "released-idle"]);
          expect(space.establishments).toEqual([]);
          expect(space.routePublications).toEqual([]);
          expect(space.records.get(space.key)?.messages).toEqual([]);
          yield* unchanged(space);
        });
      }

      it(`NR5: eager Session ${method} confirms A with a newer compatible executable without prompting`, function* () {
        const space = yield* world(method, NATIVE_ID);
        yield* scoped(function* () {
          yield* install(space, true);
          const session = yield* Agent.operations.session();
          expect(session).toMatchObject({
            sessionKey: space.key,
            cwd: space.dir,
            agentSessionId: NATIVE_ID,
          });
          expect(space.establishments).toEqual([
            {
              placement: { sessionKey: space.key, cwd: space.dir, state: "established" },
              identity: { acpxRecordId: space.key, agentSessionId: NATIVE_ID },
            },
          ]);
        });
        const received = yield* requests(space);
        expect(received.map((request) => request.method)).toEqual([
          "initialize",
          `session/${method}`,
        ]);
        expect(received[1]?.params).toMatchObject({ sessionId: ACP_ID });
        expect(received.every((request) => gone(request.pid))).toBe(true);
        expect(space.runtimeOptions.map((options) => options.agentProcessEnv?.CODEX_PATH)).toEqual([
          "/live/codex-9.2.1",
        ]);
        expect(space.coordinator.events).toEqual(["owned", "quiesced", "released-idle"]);
        expect(space.routePublications).toEqual([]);
        expect(space.records.get(space.key)?.messages).toEqual([]);
        yield* unchanged(space);
      });

      it(`NR2: ${method} preserves A across a compatible executable change without creating or materializing`, function* () {
        const space = yield* world(method, NATIVE_ID);
        yield* scoped(function* () {
          yield* install(space);
          yield* prompt();
        });
        const received = yield* requests(space);
        expect(received.map((request) => request.method)).toEqual([
          "initialize",
          `session/${method}`,
          "session/prompt",
        ]);
        expect(received[2]?.params).toMatchObject({
          sessionId: ACP_ID,
          prompt: [{ type: "text", text: CONTINUATION }],
        });
        expect(received.every((request) => gone(request.pid))).toBe(true);
        expect(space.runtimeOptions.map((options) => options.agentProcessEnv?.CODEX_PATH)).toEqual([
          "/live/codex-9.2.1",
        ]);
        expect(space.coordinator.events).toEqual(["owned", "quiesced", "released-idle"]);
        yield* unchanged(space);
      });
    }
  },
);
