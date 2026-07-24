/**
 * The test-agent controller (specs/test-agent-spec.md §Controller and
 * worker): a localhost line-protocol server owned by the `<TestAgent>`
 * scope. It serves behavior documents, Markdown dependencies (reads
 * restricted to Markdown files whose canonical path stays inside the
 * scenario root), and behavior journals to workers, and records journal
 * appends and turn-failure diagnostics per scenario instance.
 *
 * Each instance admits one worker connection at a time. Unregistering an
 * instance — or tearing the controller down — revokes and awaits its active
 * connection before discarding state, so a revoked worker can no longer
 * append, report failures, or read.
 */

import { each, ensure, race, resource, until, withResolvers } from "effection";
import type { Operation, WithResolvers } from "effection";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
// @effectionx/fs has no realpath, so canonical symlink resolution uses the
// node:fs/promises primitive directly.
import { realpath } from "node:fs/promises";
import { readTextFile, stat } from "@executablemd/runtime";
import type { DurableEvent } from "@executablemd/durable-streams";
import { encodeMessage, formatRoute, parseWorkerMessage, PROBE_INSTANCE } from "./protocol.ts";
import type { ControllerMessage, WorkerMessage } from "./protocol.ts";
import { useLineServer } from "./net.ts";
import type { LineSocket } from "./net.ts";

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
  /**
   * Register a scenario instance as a resource. Its finalizer removes it from
   * the routing index, revokes and awaits any active worker, and clears its
   * journal and diagnostics — so ending the instance's scope tears it down.
   */
  useInstance(config: {
    doc: { path: string; source: string };
    scenarioDir: string;
  }): Operation<ScenarioInstance>;
  instance(id: string): ScenarioInstance | undefined;
}

/** The single worker connection an instance currently admits. */
interface ActiveConnection {
  revoke(): void;
  closed: Operation<void>;
}

function send(connection: LineSocket, message: ControllerMessage): void {
  connection.send(encodeMessage(message));
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

export function useTestAgentController(): Operation<TestAgentController> {
  return resource(function* (provide) {
    const token = randomUUID();
    const instances = new Map<string, ScenarioInstance>();
    const active = new Map<string, ActiveConnection>();
    const canonicalRoots = new Map<string, string>();

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

    // The controller never spawns or touches a raw socket: it hands this
    // per-connection handler to the server adapter, which owns the accept
    // loop and the socket lifecycle.
    function* handleConnection(connection: LineSocket): Operation<void> {
      const revoke = withResolvers<void>();
      // Revocation cancels the serve loop; connection.closed covers an
      // abrupt worker disconnect that never ends the line stream. Either
      // way the server task's teardown then destroys the socket.
      yield* race([revoke.operation, connection.closed, serve(connection, revoke)]);
    }

    function* serve(connection: LineSocket, revoke: WithResolvers<void>): Operation<void> {
      let attached: ScenarioInstance | "probe" | undefined;
      for (const line of yield* each(connection.lines)) {
        const parsed = parseWorkerMessage(line);
        if (!parsed.ok) {
          send(connection, { t: "error", message: parsed.error });
          connection.end();
          return;
        }
        const message = parsed.message;
        if (attached === undefined) {
          if (message.t !== "attach" || message.token !== token) {
            send(connection, { t: "error", message: "unauthorized or out-of-order attach" });
            connection.end();
            return;
          }
          if (message.instance === PROBE_INSTANCE) {
            attached = "probe";
            send(connection, { t: "config", mode: "probe" });
          } else {
            const instance = instances.get(message.instance);
            if (!instance) {
              send(connection, { t: "error", message: `unknown instance "${message.instance}"` });
              connection.end();
              return;
            }
            // One worker per instance: a second concurrent attach is
            // refused so two workers never mutate the same journal.
            if (active.has(instance.id)) {
              send(connection, {
                t: "error",
                message: `instance "${instance.id}" already has an active connection`,
              });
              connection.end();
              return;
            }
            const ended = withResolvers<void>();
            const registration: ActiveConnection = {
              revoke: revoke.resolve,
              closed: ended.operation,
            };
            active.set(instance.id, registration);
            yield* ensure(() => {
              if (active.get(instance.id) === registration) {
                active.delete(instance.id);
              }
              ended.resolve();
            });
            attached = instance;
            send(connection, {
              t: "config",
              mode: "scenario",
              doc: instance.doc,
              journal: instance.journal,
            });
          }
          yield* each.next();
          continue;
        }
        yield* handleMessage(connection, attached, message);
        yield* each.next();
      }
    }

    function* handleMessage(
      connection: LineSocket,
      attached: ScenarioInstance | "probe",
      message: WorkerMessage,
    ): Operation<void> {
      if (attached === "probe") {
        send(connection, { t: "error", message: `probe workers may not send "${message.t}"` });
        connection.end();
        return;
      }
      // A worker whose instance was unregistered mid-connection is cut off
      // here even before its socket finishes closing: nothing it sends
      // reaches the discarded journal, failure, or filesystem.
      if (instances.get(attached.id) !== attached) {
        send(connection, { t: "error", message: "instance is no longer registered" });
        connection.end();
        return;
      }
      switch (message.t) {
        case "journal": {
          if (message.seq !== attached.journal.length) {
            send(connection, {
              t: "error",
              message: `journal out of order: expected seq ${attached.journal.length}, got ${message.seq}`,
            });
            connection.end();
            return;
          }
          attached.journal.push(message.event);
          send(connection, { t: "ack", seq: message.seq });
          return;
        }
        case "read": {
          // Reads serve Markdown dependencies only. A .ts candidate is
          // never read — its existence is surfaced through stat so the
          // worker can emit the unsupported-TypeScript diagnostic.
          if (!message.path.endsWith(".md")) {
            send(connection, { t: "read", path: message.path, missing: true });
            return;
          }
          const real = yield* resolveContained(attached, message.path);
          if (real === undefined) {
            send(connection, { t: "read", path: message.path, missing: true });
            return;
          }
          const existing = yield* stat(real);
          if (!existing.exists || !existing.isFile) {
            send(connection, { t: "read", path: message.path, missing: true });
            return;
          }
          const source = yield* readTextFile(real);
          send(connection, { t: "read", path: message.path, source, missing: false });
          return;
        }
        case "stat": {
          const real = yield* resolveContained(attached, message.path);
          if (real === undefined) {
            send(connection, { t: "stat", path: message.path, exists: false, isFile: false });
            return;
          }
          const existing = yield* stat(real);
          send(connection, {
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
          send(connection, { t: "error", message: "duplicate attach" });
          connection.end();
          return;
        }
      }
    }

    const server = yield* useLineServer("127.0.0.1", handleConnection);
    const port = server.port;

    // A scenario instance is a resource: setup adds it to the routing index;
    // its finalizer removes it from the index, revokes and awaits its active
    // worker, and always clears its state. The index maps are lookups only —
    // membership owns no lifecycle, so ending an instance's scope is the only
    // way it is torn down.
    function useInstance(config: {
      doc: { path: string; source: string };
      scenarioDir: string;
    }): Operation<ScenarioInstance> {
      return resource(function* (provide) {
        const id = randomUUID();
        const instance: ScenarioInstance = {
          id,
          route: formatRoute({ host: "127.0.0.1", port, token, instance: id }),
          scenarioDir: resolve(config.scenarioDir),
          doc: config.doc,
          journal: [],
        };
        instances.set(id, instance);
        yield* ensure(function* () {
          // Remove from the routing index first so in-flight messages are
          // rejected and no new worker can attach.
          instances.delete(id);
          try {
            const registration = active.get(id);
            if (registration) {
              registration.revoke();
              yield* registration.closed;
            }
          } finally {
            // Always clear state — even if worker revocation failed.
            instance.journal.length = 0;
            instance.failure = undefined;
            instance.fatal = undefined;
            canonicalRoots.delete(id);
          }
        });
        yield* provide(instance);
      });
    }

    yield* provide({
      probeRoute: formatRoute({ host: "127.0.0.1", port, token, instance: PROBE_INSTANCE }),
      useInstance,
      instance(id) {
        return instances.get(id);
      },
    });
  });
}
