/**
 * Tier TC — controller tests (specs/test-agent-spec.md §Controller and
 * worker): token auth, probe/scenario config, journal ack ordering,
 * on-demand Markdown reads/stats with a canonical filesystem boundary,
 * failure marks, instance isolation, connection revocation on unregister,
 * and teardown.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import {
  createSignal,
  each,
  ensure,
  race,
  scoped,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation } from "effection";
import { on, once } from "@effectionx/node";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { symlink } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { useTestAgentController } from "../src/controller.ts";
import {
  createLineSplitter,
  encodeMessage,
  parseControllerMessage,
  parseRoute,
} from "../src/protocol.ts";
import type { ControllerMessage, WorkerMessage } from "../src/protocol.ts";

interface TestClient {
  send(message: WorkerMessage): void;
  sendRaw(line: string): void;
  next(): Operation<ControllerMessage>;
  /** Resolves when the client socket closes (e.g. the controller revokes it). */
  closed: Operation<void>;
}

function* useClient(route: string): Operation<TestClient> {
  const parsed = parseRoute(route);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const { host, port } = parsed.message;
  const socket: Socket = connect(port, host);
  yield* ensure(() => {
    socket.destroy();
  });
  yield* race([
    once(socket, "connect"),
    (function* (): Operation<void> {
      const [error] = yield* once(socket, "error");
      throw error instanceof Error ? error : new Error(String(error));
    })(),
  ]);

  const messages = createSignal<ControllerMessage, undefined>();
  const splitter = createLineSplitter();
  yield* spawn(function* () {
    for (const [chunk] of yield* each(on<[Buffer]>(socket, "data"))) {
      for (const line of splitter.feed(chunk.toString("utf8"))) {
        const result = parseControllerMessage(line);
        if (result.ok) {
          messages.send(result.message);
        }
      }
      yield* each.next();
    }
  });
  const closedSignal = withResolvers<void>();
  yield* spawn(function* () {
    yield* once(socket, "close");
    messages.close(undefined);
    closedSignal.resolve();
  });

  const queue: ControllerMessage[] = [];
  const waiters: Array<(message: ControllerMessage) => void> = [];
  yield* spawn(function* () {
    for (const message of yield* each(messages)) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        queue.push(message);
      }
      yield* each.next();
    }
  });
  return {
    closed: closedSignal.operation,
    send(message) {
      socket.write(encodeMessage(message));
    },
    sendRaw(line) {
      socket.write(line + "\n");
    },
    *next() {
      const queued = queue.shift();
      if (queued) {
        return queued;
      }
      const arrival = withResolvers<ControllerMessage>();
      waiters.push(arrival.resolve);
      return yield* arrival.operation;
    },
  };
}

describe("Tier TC — controller", () => {
  it("TC1: probe attach configures probe mode; bad tokens are rejected", function* () {
    yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const parsed = parseRoute(controller.probeRoute);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }

      const client = yield* useClient(controller.probeRoute);
      client.send({ t: "attach", token: parsed.message.token, instance: "probe" });
      expect(yield* client.next()).toEqual({ t: "config", mode: "probe" });

      const intruder = yield* useClient(controller.probeRoute);
      intruder.send({ t: "attach", token: "wrong", instance: "probe" });
      const rejected = yield* intruder.next();
      expect(rejected.t).toBe("error");
    });
  });

  it("TC2: scenario attach serves config, ordered journal acks, reads, and stats", function* () {
    const dir = path.join(os.tmpdir(), `xmd-tc-${randomUUID()}`);
    yield* ensureDir(path.join(dir, "components"));
    try {
      yield* writeTextFile(path.join(dir, "components", "Helper.md"), "helper body\n");
      yield* writeTextFile(path.join(dir, "secret.ts"), "export {}\n");
      yield* scoped(function* () {
        const controller = yield* useTestAgentController();
        const instance = controller.registerInstance({
          doc: { path: "review.md", source: '<WhenPrompt template="hi" />' },
          scenarioDir: dir,
        });
        const parsed = parseRoute(instance.route);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
          return;
        }

        const client = yield* useClient(instance.route);
        client.send({ t: "attach", token: parsed.message.token, instance: instance.id });
        const config = yield* client.next();
        expect(config).toMatchObject({ t: "config", mode: "scenario" });
        if (config.t === "config" && config.mode === "scenario") {
          expect(config.doc.path).toBe("review.md");
          expect(config.journal).toEqual([]);
        }

        client.send({
          t: "journal",
          seq: 0,
          event: {
            type: "yield",
            coroutineId: "root.0",
            description: { type: "when_prompt", name: "when:review.md:1:1#0" },
            result: { status: "ok", value: { prompt: "hi", captures: {} } },
          },
        });
        expect(yield* client.next()).toEqual({ t: "ack", seq: 0 });
        expect(controller.instance(instance.id)?.journal.length).toBe(1);

        client.send({ t: "stat", path: "components/Helper.md" });
        expect(yield* client.next()).toEqual({
          t: "stat",
          path: "components/Helper.md",
          exists: true,
          isFile: true,
        });
        client.send({ t: "read", path: "components/Helper.md" });
        const read = yield* client.next();
        expect(read).toMatchObject({ t: "read", missing: false, source: "helper body\n" });

        // stat reports actual existence and file type — including .ts
        // candidates, whose handling belongs to the worker.
        client.send({ t: "stat", path: "secret.ts" });
        expect(yield* client.next()).toMatchObject({ t: "stat", exists: true, isFile: true });

        client.send({ t: "read", path: "../outside.md" });
        expect(yield* client.next()).toMatchObject({ t: "read", missing: true });

        client.send({ t: "turn-failure", kind: "mismatch", expected: "hi", actual: "bye" });
        client.send({
          t: "journal",
          seq: 5,
          event: { type: "close", coroutineId: "root", result: { status: "ok" } },
        });
        const outOfOrder = yield* client.next();
        expect(outOfOrder.t).toBe("error");
        expect(controller.instance(instance.id)?.failure).toEqual({
          kind: "mismatch",
          expected: "hi",
          actual: "bye",
        });
      });
    } finally {
      yield* rm(dir, { recursive: true, force: true });
    }
  });

  it("TC5: unregister revokes the active worker, discards state, and rejects new workers", function* () {
    yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const instance = controller.registerInstance({
        doc: { path: "hi.md", source: '<WhenPrompt template="hi" />' },
        scenarioDir: os.tmpdir(),
      });
      const parsed = parseRoute(instance.route);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      const client = yield* useClient(instance.route);
      client.send({ t: "attach", token: parsed.message.token, instance: instance.id });
      expect((yield* client.next()).t).toBe("config");
      client.send({
        t: "journal",
        seq: 0,
        event: { type: "close", coroutineId: "root", result: { status: "ok" } },
      });
      expect((yield* client.next()).t).toBe("ack");
      expect(controller.instance(instance.id)?.journal.length).toBe(1);

      // Unregister closes the active connection and only resolves once it
      // has ended, so the revoked worker cannot append, report, or read.
      let unregisterDone = false;
      const unregister = yield* spawn(function* () {
        yield* controller.unregisterInstance(instance.id);
        unregisterDone = true;
      });
      yield* client.closed;
      yield* unregister;
      expect(unregisterDone).toBe(true);
      expect(controller.instance(instance.id)).toBe(undefined);

      // A fresh worker for the same route is now rejected outright.
      const late = yield* useClient(instance.route);
      late.send({ t: "attach", token: parsed.message.token, instance: instance.id });
      expect((yield* late.next()).t).toBe("error");
    });
  });

  it("TC6: a second worker cannot attach to a live instance, and instances stay independent", function* () {
    yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const a = controller.registerInstance({
        doc: { path: "a.md", source: '<WhenPrompt template="a" />' },
        scenarioDir: os.tmpdir(),
      });
      const b = controller.registerInstance({
        doc: { path: "b.md", source: '<WhenPrompt template="b" />' },
        scenarioDir: os.tmpdir(),
      });
      const token = parseRoute(a.route);
      if (!token.ok) {
        return;
      }

      const clientA = yield* useClient(a.route);
      clientA.send({ t: "attach", token: token.message.token, instance: a.id });
      const configA = yield* clientA.next();
      expect(configA).toMatchObject({ t: "config", mode: "scenario" });
      if (configA.t === "config" && configA.mode === "scenario") {
        expect(configA.doc.path).toBe("a.md");
      }

      // A second concurrent worker for the same instance is refused.
      const intruder = yield* useClient(a.route);
      intruder.send({ t: "attach", token: token.message.token, instance: a.id });
      expect((yield* intruder.next()).t).toBe("error");

      const clientB = yield* useClient(b.route);
      clientB.send({ t: "attach", token: token.message.token, instance: b.id });
      expect((yield* clientB.next()).t).toBe("config");

      clientA.send({
        t: "journal",
        seq: 0,
        event: { type: "close", coroutineId: "root", result: { status: "ok" } },
      });
      expect((yield* clientA.next()).t).toBe("ack");
      clientB.send({ t: "turn-failure", kind: "mismatch", expected: "b", actual: "x" });
      // turn-failure has no reply; a stat round-trip is the barrier that
      // proves the failure was recorded before these assertions run.
      clientB.send({ t: "stat", path: "b.md" });
      expect((yield* clientB.next()).t).toBe("stat");

      // A prompt B failure never touches instance A's journal or failure.
      expect(controller.instance(a.id)?.journal.length).toBe(1);
      expect(controller.instance(a.id)?.failure).toBe(undefined);
      expect(controller.instance(b.id)?.journal.length).toBe(0);
      expect(controller.instance(b.id)?.failure).toMatchObject({ kind: "mismatch" });
    });
  });

  it("TC7: reads serve only in-root Markdown — .ts is stat-visible but unreadable, symlinks cannot escape", function* () {
    const dir = path.join(os.tmpdir(), `xmd-tc7-${randomUUID()}`);
    const outside = path.join(os.tmpdir(), `xmd-tc7-out-${randomUUID()}`);
    yield* ensureDir(dir);
    yield* ensureDir(outside);
    try {
      yield* writeTextFile(path.join(dir, "ok.md"), "in root\n");
      yield* writeTextFile(path.join(dir, "code.ts"), "export {}\n");
      yield* writeTextFile(path.join(outside, "secret.md"), "top secret\n");
      yield* until(symlink(path.join(outside, "secret.md"), path.join(dir, "escape.md")));

      yield* scoped(function* () {
        const controller = yield* useTestAgentController();
        const instance = controller.registerInstance({
          doc: { path: "root.md", source: '<WhenPrompt template="hi" />' },
          scenarioDir: dir,
        });
        const parsed = parseRoute(instance.route);
        if (!parsed.ok) {
          return;
        }
        const client = yield* useClient(instance.route);
        client.send({ t: "attach", token: parsed.message.token, instance: instance.id });
        expect((yield* client.next()).t).toBe("config");

        // A normal in-root Markdown read succeeds.
        client.send({ t: "read", path: "ok.md" });
        expect(yield* client.next()).toMatchObject({
          t: "read",
          missing: false,
          source: "in root\n",
        });

        // .ts is visible to stat (for the unsupported-TypeScript
        // diagnostic) but is never read.
        client.send({ t: "stat", path: "code.ts" });
        expect(yield* client.next()).toMatchObject({ t: "stat", exists: true, isFile: true });
        client.send({ t: "read", path: "code.ts" });
        expect(yield* client.next()).toMatchObject({ t: "read", missing: true });

        // A Markdown symlink whose target escapes the canonical root is
        // denied on both read and stat.
        client.send({ t: "read", path: "escape.md" });
        expect(yield* client.next()).toMatchObject({ t: "read", missing: true });
        client.send({ t: "stat", path: "escape.md" });
        expect(yield* client.next()).toMatchObject({ t: "stat", exists: false });
      });
    } finally {
      yield* rm(dir, { recursive: true, force: true });
      yield* rm(outside, { recursive: true, force: true });
    }
  });

  it("TC3: malformed lines and unknown instances are rejected", function* () {
    yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const parsed = parseRoute(controller.probeRoute);
      if (!parsed.ok) {
        return;
      }
      const malformed = yield* useClient(controller.probeRoute);
      malformed.sendRaw("{nope");
      expect((yield* malformed.next()).t).toBe("error");

      const unknown = yield* useClient(controller.probeRoute);
      unknown.send({ t: "attach", token: parsed.message.token, instance: "no-such-instance" });
      expect((yield* unknown.next()).t).toBe("error");
    });
  });

  it("TC4: controller teardown stops listening and closes active clients", function* () {
    yield* scoped(function* () {
      // The controller lives in its own task so the test can tear it down
      // on demand while the client (owned by this scope) survives to
      // observe the close.
      const routeStr = withResolvers<string>();
      const controllerTask = yield* spawn(function* () {
        yield* scoped(function* () {
          const controller = yield* useTestAgentController();
          routeStr.resolve(controller.probeRoute);
          yield* suspend();
        });
      });
      const routeString = yield* routeStr.operation;
      const parsed = parseRoute(routeString);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }

      const client = yield* useClient(routeString);
      client.send({ t: "attach", token: parsed.message.token, instance: "probe" });
      expect((yield* client.next()).t).toBe("config");

      yield* controllerTask.halt();
      // Teardown closed the still-attached client.
      yield* client.closed;

      // New connections are refused once the controller is gone.
      const socket = connect(parsed.message.port, parsed.message.host);
      const outcome = yield* race([
        (function* (): Operation<string> {
          yield* once(socket, "connect");
          socket.destroy();
          return "connected";
        })(),
        (function* (): Operation<string> {
          yield* once(socket, "error");
          return "refused";
        })(),
      ]);
      expect(outcome).toBe("refused");
    });
  });
});
