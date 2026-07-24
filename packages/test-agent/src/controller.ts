/**
 * The test-agent controller (specs/test-agent-spec.md §Controller and
 * worker): a localhost TCP server owned by the `<TestAgent>` scope. It
 * serves behavior documents, Markdown dependencies (reads restricted to
 * Markdown files whose canonical path stays inside the scenario root),
 * and behavior journals to workers, and records journal appends and
 * turn-failure diagnostics per scenario instance.
 *
 * Each instance admits one worker connection at a time. Unregistering an
 * instance — or tearing the controller down — closes and awaits its
 * active connection before discarding state, so a revoked worker can no
 * longer append, report failures, or read.
 */

import { createSignal, each, ensure, resource, spawn, until, withResolvers } from "effection";
import { on, once } from "@effectionx/node";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
// @effectionx/fs has no realpath, so canonical symlink resolution uses the
// node:fs/promises primitive directly.
import { realpath } from "node:fs/promises";
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
  /**
   * Drop an instance: close and await any active worker connection, then
   * discard its private behavior journal and diagnostics.
   */
  unregisterInstance(id: string): Operation<void>;
}

/** The single worker connection an instance currently admits. */
interface ActiveConnection {
  close(): void;
  closed: Operation<void>;
}

function send(socket: Socket, message: ControllerMessage): void {
  socket.write(encodeMessage(message));
}

/**
 * Map a worker's virtual path onto the scenario directory. Workers see a
 * virtual root at the scenario directory; anything resolving outside it
 * lexically is answered as missing rather than surfaced as an error, so
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

/** Owns a worker socket: hands it to the caller, destroys it on teardown. */
function useSocket(socket: Socket): Operation<Socket> {
  return resource(function* (provide) {
    yield* ensure(() => {
      socket.destroy();
    });
    yield* provide(socket);
  });
}

export function useTestAgentController(): Operation<TestAgentController> {
  return resource(function* (provide) {
    const token = randomUUID();
    const instances = new Map<string, ScenarioInstance>();
    const active = new Map<string, ActiveConnection>();
    const canonicalRoots = new Map<string, string>();
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

    // The canonical scenario root, resolving symlinks, memoized per
    // instance. A dependency read/stat is served only when its canonical
    // path stays inside this root.
    function* canonicalRoot(instance: ScenarioInstance): Operation<string> {
      const cached = canonicalRoots.get(instance.id);
      if (cached !== undefined) {
        return cached;
      }
      let root: string;
      try {
        root = yield* until(realpath(instance.scenarioDir));
      } catch {
        root = instance.scenarioDir;
      }
      canonicalRoots.set(instance.id, root);
      return root;
    }

    function* resolveContained(
      instance: ScenarioInstance,
      path: string,
    ): Operation<string | undefined> {
      const real = scenarioPath(instance, path);
      if (real === undefined) {
        return undefined;
      }
      const root = yield* canonicalRoot(instance);
      let canonical: string;
      try {
        canonical = yield* until(realpath(real));
      } catch {
        // A path that does not exist has no symlink to escape through, so
        // the lexical containment check above is sufficient.
        return real;
      }
      if (canonical !== root && !canonical.startsWith(root + sep)) {
        return undefined;
      }
      return canonical;
    }

    function* handleConnection(rawSocket: Socket): Operation<void> {
      const socket = yield* useSocket(rawSocket);
      const lines = createSignal<string, undefined>();
      const splitter = createLineSplitter();
      yield* spawn(function* () {
        for (const [chunk] of yield* each(on<[Buffer]>(socket, "data"))) {
          for (const line of splitter.feed(chunk.toString("utf8"))) {
            lines.send(line);
          }
          yield* each.next();
        }
      });
      yield* spawn(function* () {
        yield* once(socket, "close");
        lines.close(undefined);
      });
      yield* spawn(function* () {
        yield* once(socket, "error");
        lines.close(undefined);
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
            // One worker per instance: a second concurrent attach is
            // refused so two workers never mutate the same journal.
            if (active.has(instance.id)) {
              send(socket, {
                t: "error",
                message: `instance "${instance.id}" already has an active connection`,
              });
              socket.end();
              break;
            }
            const ended = withResolvers<void>();
            const connection: ActiveConnection = {
              close: () => socket.destroy(),
              closed: ended.operation,
            };
            active.set(instance.id, connection);
            yield* ensure(() => {
              if (active.get(instance.id) === connection) {
                active.delete(instance.id);
              }
              ended.resolve();
            });
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
      // A worker whose instance was unregistered mid-connection is cut off
      // here even before its socket finishes closing: nothing it sends
      // reaches the discarded journal, failure, or filesystem.
      if (instances.get(attached.id) !== attached) {
        send(socket, { t: "error", message: "instance is no longer registered" });
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
          // Reads serve Markdown dependencies only. A .ts candidate is
          // never read — its existence is surfaced through stat so the
          // worker can emit the unsupported-TypeScript diagnostic.
          if (!message.path.endsWith(".md")) {
            send(socket, { t: "read", path: message.path, missing: true });
            return;
          }
          const real = yield* resolveContained(attached, message.path);
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
          const real = yield* resolveContained(attached, message.path);
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
      *unregisterInstance(id) {
        const existing = instances.get(id);
        if (!existing) {
          return;
        }
        // Remove the instance first so any in-flight message is rejected,
        // then close and await the active connection before clearing state.
        instances.delete(id);
        const connection = active.get(id);
        if (connection) {
          connection.close();
          yield* connection.closed;
        }
        existing.journal.length = 0;
        existing.failure = undefined;
        existing.fatal = undefined;
        canonicalRoots.delete(id);
      },
    });
  });
}
