/**
 * The test-agent controller (specs/test-agent-spec.md §Controller and
 * worker): a localhost line-protocol server owned by the `<TestAgent>`
 * scope. It serves behavior documents, Markdown dependencies (reads
 * restricted to Markdown files whose canonical path stays inside the
 * scenario root), and behavior journals to workers, and records journal
 * appends and turn-failure diagnostics per scenario.
 *
 * Each scenario admits one worker connection at a time. Unregistering a
 * scenario — or tearing the controller down — revokes and awaits its active
 * connection before discarding state, so a revoked worker can no longer
 * append, report failures, or read.
 */

import { createContext, each, ensure, race, resource, until, withResolvers } from "effection";
import type { Context, Operation, WithResolvers } from "effection";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
// @effectionx/fs has no realpath, so canonical symlink resolution uses the
// node:fs/promises primitive directly.
import { realpath } from "node:fs/promises";
import { readTextFile, stat } from "@executablemd/runtime";
import type { NativeLaunchRequest } from "@executablemd/runtime";
import type { DurableEvent } from "@executablemd/durable-streams";
import { encodeMessage, formatRoute, parseWorkerMessage, PROBE_INSTANCE } from "./protocol.ts";
import type { ControllerMessage, WorkerMessage } from "./protocol.ts";
import { useLineServer } from "./net.ts";
import type { LineSocket } from "./net.ts";

/** What a scenario gives its harness: where its worker connects. */
export interface ScenarioHandle {
  route: string;
}

export interface TestAgentController {
  /**
   * Register a scenario as a resource. Its finalizer removes it from the
   * routing index, revokes and awaits any active worker, and clears its
   * journal and diagnostics — so ending the scenario's scope tears it down.
   */
  useScenario(options: {
    document: { path: string; source: string };
    rootDir: string;
  }): Operation<ScenarioHandle>;
}

/**
 * One provider-native session the agent created, and the instruction layer it
 * was created under.
 *
 * This is the agent's own account of a launch preparation. What XMD says it
 * sent lives in the durable launch record; what the agent received is this,
 * and the two being the same is what proves the prepared text crossed as a
 * session instruction layer rather than as a user message.
 */
export interface NativeSessionReport {
  scenarioId: string;
  nativeSessionId: string;
  systemPrompt?: string;
}

/** Where a harness collects those reports; unobserved by default. */
export const NativeSessionObserver: Context<((report: NativeSessionReport) => void) | undefined> =
  createContext<((report: NativeSessionReport) => void) | undefined>(
    "testAgent.nativeSessionObserver",
    undefined,
  );

/**
 * How a harness watches and steers the test agent's native UI.
 *
 * The launch itself is the document's to assert: it can see whether the
 * handoff completed and what a later prompt got back. What a document cannot
 * see is the argument vector and environment a child was handed — the two
 * surfaces prepared instructions must never appear on — or what happens when
 * that child exits badly. Both are supplied here.
 *
 * Unset by default, which is a native UI that starts nothing and exits
 * cleanly.
 */
export interface NativeLaunchHarness {
  /** Called with each launch request, before the child "runs". */
  record?(request: NativeLaunchRequest): void;
  /** How the native child exits. Defaults to a clean exit. */
  outcome?(): { exitCode?: number; signal?: string };
}

export const NativeLaunchObserver: Context<NativeLaunchHarness | undefined> = createContext<
  NativeLaunchHarness | undefined
>("testAgent.nativeLaunchObserver", undefined);

/** How a turn failed. Recorded against the scenario, never published. */
export interface ScenarioFailure {
  kind: "mismatch" | "exhausted" | "config";
  expected?: string;
  actual: string;
}

/**
 * Everything the controller keeps for one scenario. The journal and the
 * diagnostics are mutable and private to the package — a harness sees only the
 * handle.
 */
export interface ScenarioRecord extends ScenarioHandle {
  id: string;
  /** The real directory Markdown dependencies are served from. */
  rootDir: string;
  document: { path: string; source: string };
  journal: DurableEvent[];
  failure?: ScenarioFailure;
  fatal?: string;
  sessions: NativeSessionReport[];
  /**
   * The provider-native session identity this scenario asserts.
   *
   * The scenario owns it, not the worker process: a real agent keeps its own
   * durable session state, so a reconnect names the state it already had. A
   * per-process identity would make every reattach look like a replacement
   * session, which is the one thing a launch must never do.
   */
  nativeSessionId: string;
}

/**
 * The controller as the package uses it: the public operations plus the probe
 * route the provider registry needs and the record lookup the tests inspect.
 */
export interface TestAgentControllerInternals extends TestAgentController {
  probeRoute: string;
  /** The record behind the handle — the journal and diagnostics included. */
  useScenario(options: {
    document: { path: string; source: string };
    rootDir: string;
  }): Operation<ScenarioRecord>;
  getScenarioRecord(id: string): ScenarioRecord | undefined;
}

/** The single worker connection a scenario currently admits. */
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
function scenarioPath(scenario: ScenarioRecord, path: string): string | undefined {
  const virtual = isAbsolute(path) ? relative("/", path) : path;
  const real = resolve(scenario.rootDir, virtual);
  if (real !== scenario.rootDir && !real.startsWith(scenario.rootDir + sep)) {
    return undefined;
  }
  return real;
}

export function useTestAgentController(): Operation<TestAgentControllerInternals> {
  return resource(function* (provide) {
    const token = randomUUID();
    const observeSession = yield* NativeSessionObserver.get();
    const scenarios = new Map<string, ScenarioRecord>();
    const active = new Map<string, ActiveConnection>();
    const canonicalRoots = new Map<string, string>();

    // The canonical scenario root, resolving symlinks, memoized per
    // scenario. A dependency read/stat is served only when its canonical
    // path stays inside this root.
    function* canonicalRoot(scenario: ScenarioRecord): Operation<string> {
      const cached = canonicalRoots.get(scenario.id);
      if (cached !== undefined) {
        return cached;
      }
      let root: string;
      try {
        root = yield* until(realpath(scenario.rootDir));
      } catch {
        root = scenario.rootDir;
      }
      canonicalRoots.set(scenario.id, root);
      return root;
    }

    function* resolveContained(
      scenario: ScenarioRecord,
      path: string,
    ): Operation<string | undefined> {
      const real = scenarioPath(scenario, path);
      if (real === undefined) {
        return undefined;
      }
      const root = yield* canonicalRoot(scenario);
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
      let attached: ScenarioRecord | "probe" | undefined;
      for (const line of yield* each(connection.lines)) {
        const parsed = parseWorkerMessage(line);
        if (!parsed.ok) {
          send(connection, { t: "error", message: parsed.error.message });
          connection.end();
          return;
        }
        const message = parsed.value;
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
            const scenario = scenarios.get(message.instance);
            if (!scenario) {
              send(connection, { t: "error", message: `unknown scenario "${message.instance}"` });
              connection.end();
              return;
            }
            // One worker per scenario: a second concurrent attach is
            // refused so two workers never mutate the same journal.
            if (active.has(scenario.id)) {
              send(connection, {
                t: "error",
                message: `scenario "${scenario.id}" already has an active connection`,
              });
              connection.end();
              return;
            }
            const ended = withResolvers<void>();
            const registration: ActiveConnection = {
              revoke: revoke.resolve,
              closed: ended.operation,
            };
            active.set(scenario.id, registration);
            yield* ensure(() => {
              if (active.get(scenario.id) === registration) {
                active.delete(scenario.id);
              }
              ended.resolve();
            });
            attached = scenario;
            send(connection, {
              t: "config",
              mode: "scenario",
              doc: scenario.document,
              journal: scenario.journal,
              nativeSessionId: scenario.nativeSessionId,
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
      attached: ScenarioRecord | "probe",
      message: WorkerMessage,
    ): Operation<void> {
      if (attached === "probe") {
        send(connection, { t: "error", message: `probe workers may not send "${message.t}"` });
        connection.end();
        return;
      }
      // A worker whose scenario was unregistered mid-connection is cut off
      // here even before its socket finishes closing: nothing it sends
      // reaches the discarded journal, failure, or filesystem.
      if (scenarios.get(attached.id) !== attached) {
        send(connection, { t: "error", message: "scenario is no longer registered" });
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
          const failure: ScenarioFailure = { kind: message.kind, actual: message.actual };
          if (message.expected !== undefined) {
            failure.expected = message.expected;
          }
          // Record before acknowledging: the worker awaits this ack before
          // surfacing the ACP error, so the diagnostic is already observable
          // once that error is seen.
          attached.failure = failure;
          send(connection, { t: "recorded" });
          return;
        }
        case "session": {
          // Deliberately unanswered. The worker's controller channel is one
          // ordered request/reply queue shared with journal commits, and a
          // reply nobody is reading — or one read by whoever asks next — is
          // how a turn and a session report deadlock each other. The worker
          // already knows this identity: it came with the scenario config.
          const report: NativeSessionReport = {
            scenarioId: attached.id,
            nativeSessionId: attached.nativeSessionId,
          };
          if (message.systemPrompt !== undefined) {
            report.systemPrompt = message.systemPrompt;
          }
          attached.sessions.push(report);
          observeSession?.(report);
          return;
        }
        case "fatal": {
          attached.fatal = message.message;
          send(connection, { t: "recorded" });
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

    // A scenario is a resource: setup adds it to the routing index; its
    // finalizer removes it from the index, revokes and awaits its active
    // worker, and always clears its state. The index maps are lookups only —
    // membership owns no lifecycle, so ending a scenario's scope is the only
    // way it is torn down.
    function useScenario(options: {
      document: { path: string; source: string };
      rootDir: string;
    }): Operation<ScenarioRecord> {
      return resource(function* (provide) {
        const id = randomUUID();
        const scenario: ScenarioRecord = {
          id,
          route: formatRoute({ host: "127.0.0.1", port, token, instance: id }),
          rootDir: resolve(options.rootDir),
          document: options.document,
          journal: [],
          sessions: [],
          nativeSessionId: `native-${randomUUID()}`,
        };
        scenarios.set(id, scenario);
        yield* ensure(function* () {
          // Remove from the routing index first so in-flight messages are
          // rejected and no new worker can attach.
          scenarios.delete(id);
          try {
            const registration = active.get(id);
            if (registration) {
              registration.revoke();
              yield* registration.closed;
            }
          } finally {
            // Always clear state — even if worker revocation failed.
            scenario.journal.length = 0;
            scenario.sessions.length = 0;
            scenario.failure = undefined;
            scenario.fatal = undefined;
            canonicalRoots.delete(id);
          }
        });
        yield* provide(scenario);
      });
    }

    yield* provide({
      probeRoute: formatRoute({ host: "127.0.0.1", port, token, instance: PROBE_INSTANCE }),
      useScenario,
      getScenarioRecord(id) {
        return scenarios.get(id);
      },
    });
  });
}
