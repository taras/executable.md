/**
 * The test-agent controller (specs/test-agent-spec.md §Controller and
 * worker): a localhost TCP server owned by the `<TestAgent>` scope. It
 * serves behavior documents, Markdown dependencies (reads and stats,
 * traversal-safe beneath each scenario's directory), and behavior
 * journals to workers, and records journal appends and turn-failure
 * diagnostics per scenario instance.
 */

import { createSignal, each, ensure, resource, spawn } from "effection";
import { once } from "@effectionx/node";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readTextFile, stat } from "@executablemd/runtime";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  createLineSplitter,
  encodeMessage,
  formatRoute,
  parseWorkerMessage,
  PROBE_INSTANCE,
} from "./protocol.ts";
import type { ControllerMessage, WorkerMessage } from "./protocol.ts";

export interface InstanceFailure {
  kind: "mismatch" | "exhausted" | "config";
  expected?: string;
  actual: string;
}

export interface ScenarioInstance {
  id: string;
  route: string;
  /** The real directory Markdown dependencies are served from. */
  scenarioDir: string;
  doc: { path: string; source: string };
  journal: DurableEvent[];
  failure?: InstanceFailure;
  fatal?: string;
}

export interface TestAgentController {
  probeRoute: string;
  registerInstance(config: {
    doc: { path: string; source: string };
    scenarioDir: string;
  }): ScenarioInstance;
  instance(id: string): ScenarioInstance | undefined;
  /** Drop an instance and discard its private behavior journal. */
  unregisterInstance(id: string): void;
}

function send(socket: Socket, message: ControllerMessage): void {
  socket.write(encodeMessage(message));
}

/**
 * Map a worker's virtual path onto the scenario directory. Workers see
 * a virtual root at the scenario directory; anything resolving outside
 * it is answered as missing rather than surfaced as an error, so
 * component fallback continues normally.
 */
function scenarioPath(instance: ScenarioInstance, path: string): string | undefined {
  const virtual = isAbsolute(path) ? relative("/", path) : path;
  const real = resolve(instance.scenarioDir, virtual);
  if (real !== instance.scenarioDir && !real.startsWith(instance.scenarioDir + sep)) {
    return undefined;
  }
  return real;
}

export function useTestAgentController(): Operation<TestAgentController> {
  return resource(function* (provide) {
    const token = randomUUID();
    const instances = new Map<string, ScenarioInstance>();
    const server = createServer();
    const connections = createSignal<Socket, undefined>();
    server.on("connection", (socket) => connections.send(socket));

    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    yield* listening;
    const address = server.address();
    if (!address || typeof address !== "object") {
      throw new Error("test-agent controller: unexpected server address");
    }
    const port = address.port;

    yield* ensure(() => {
      connections.close(undefined);
      server.close();
    });

    function* handleConnection(socket: Socket): Operation<void> {
      const lines = createSignal<string, undefined>();
      const splitter = createLineSplitter();
      socket.on("data", (chunk: Buffer) => {
        for (const line of splitter.feed(chunk.toString("utf8"))) {
          lines.send(line);
        }
      });
      socket.on("close", () => lines.close(undefined));
      socket.on("error", () => lines.close(undefined));
      yield* ensure(() => {
        socket.destroy();
      });

      let attached: ScenarioInstance | "probe" | undefined;
      for (const line of yield* each(lines)) {
        const parsed = parseWorkerMessage(line);
        if (!parsed.ok) {
          send(socket, { t: "error", message: parsed.error });
          socket.end();
          break;
        }
        const message = parsed.message;
        if (attached === undefined) {
          if (message.t !== "attach" || message.token !== token) {
            send(socket, { t: "error", message: "unauthorized or out-of-order attach" });
            socket.end();
            break;
          }
          if (message.instance === PROBE_INSTANCE) {
            attached = "probe";
            send(socket, { t: "config", mode: "probe" });
          } else {
            const instance = instances.get(message.instance);
            if (!instance) {
              send(socket, { t: "error", message: `unknown instance "${message.instance}"` });
              socket.end();
              break;
            }
            attached = instance;
            send(socket, {
              t: "config",
              mode: "scenario",
              doc: instance.doc,
              journal: instance.journal,
            });
          }
          yield* each.next();
          continue;
        }
        yield* handleMessage(socket, attached, message);
        yield* each.next();
      }
    }

    function* handleMessage(
      socket: Socket,
      attached: ScenarioInstance | "probe",
      message: WorkerMessage,
    ): Operation<void> {
      if (attached === "probe") {
        send(socket, { t: "error", message: `probe workers may not send "${message.t}"` });
        socket.end();
        return;
      }
      switch (message.t) {
        case "journal": {
          if (message.seq !== attached.journal.length) {
            send(socket, {
              t: "error",
              message: `journal out of order: expected seq ${attached.journal.length}, got ${message.seq}`,
            });
            socket.end();
            return;
          }
          attached.journal.push(message.event);
          send(socket, { t: "ack", seq: message.seq });
          return;
        }
        case "read": {
          const real = scenarioPath(attached, message.path);
          if (real === undefined) {
            send(socket, { t: "read", path: message.path, missing: true });
            return;
          }
          const existing = yield* stat(real);
          if (!existing.exists || !existing.isFile) {
            send(socket, { t: "read", path: message.path, missing: true });
            return;
          }
          const source = yield* readTextFile(real);
          send(socket, { t: "read", path: message.path, source, missing: false });
          return;
        }
        case "stat": {
          const real = scenarioPath(attached, message.path);
          if (real === undefined) {
            send(socket, { t: "stat", path: message.path, exists: false, isFile: false });
            return;
          }
          const existing = yield* stat(real);
          send(socket, {
            t: "stat",
            path: message.path,
            exists: existing.exists,
            isFile: existing.isFile,
          });
          return;
        }
        case "turn-failure": {
          const failure: InstanceFailure = { kind: message.kind, actual: message.actual };
          if (message.expected !== undefined) {
            failure.expected = message.expected;
          }
          attached.failure = failure;
          return;
        }
        case "fatal": {
          attached.fatal = message.message;
          return;
        }
        case "attach": {
          send(socket, { t: "error", message: "duplicate attach" });
          socket.end();
          return;
        }
      }
    }

    yield* spawn(function* () {
      for (const socket of yield* each(connections)) {
        yield* spawn(() => handleConnection(socket));
        yield* each.next();
      }
    });

    yield* provide({
      probeRoute: formatRoute({ host: "127.0.0.1", port, token, instance: PROBE_INSTANCE }),
      registerInstance(config) {
        const id = randomUUID();
        const instance: ScenarioInstance = {
          id,
          route: formatRoute({ host: "127.0.0.1", port, token, instance: id }),
          scenarioDir: resolve(config.scenarioDir),
          doc: config.doc,
          journal: [],
        };
        instances.set(id, instance);
        return instance;
      },
      instance(id) {
        return instances.get(id);
      },
      unregisterInstance(id) {
        const existing = instances.get(id);
        if (existing) {
          existing.journal.length = 0;
          instances.delete(id);
        }
      },
    });
  });
}
