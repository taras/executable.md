/**
 * Tier TC — controller tests (specs/test-agent-spec.md §Controller and
 * worker): token auth, probe/scenario config, journal ack ordering,
 * on-demand Markdown reads/stats with a canonical filesystem boundary,
 * failure marks, instance isolation, connection revocation on unregister,
 * and teardown.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { race, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { once } from "@effectionx/node";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { symlink } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { useTestAgentController } from "../src/controller.ts";
import type { ScenarioInstance } from "../src/controller.ts";
import { useLineClient } from "../src/net.ts";
import { encodeMessage, parseControllerMessage, parseRoute } from "../src/protocol.ts";
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
  const client = yield* useLineClient<ControllerMessage>(
    parsed.message.host,
    parsed.message.port,
    (line) => {
      const result = parseControllerMessage(line);
      return result.ok ? result.message : undefined;
    },
  );
  return {
    closed: client.closed,
    send: (message) => client.send(encodeMessage(message)),
    sendRaw: (line) => client.send(line + "\n"),
    next: () => client.next(),
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
        const instance = yield* controller.useInstance({
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
        expect((yield* client.next()).t).toBe("recorded");
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

  it("TC5: ending an instance's scope revokes its worker, removes routing, and rejects new workers", function* () {
    yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const ready = withResolvers<{ route: string; token: string; id: string }>();
      const release = withResolvers<void>();
      // The instance lives in its own task, ended on demand; the controller
      // outlives it so a late worker can still be rejected.
      const instanceTask = yield* spawn(function* () {
        const instance = yield* controller.useInstance({
          doc: { path: "hi.md", source: '<WhenPrompt template="hi" />' },
          scenarioDir: os.tmpdir(),
        });
        const parsed = parseRoute(instance.route);
        if (!parsed.ok) {
          return;
        }
        ready.resolve({ route: instance.route, token: parsed.message.token, id: instance.id });
        yield* release.operation;
      });
      const info = yield* ready.operation;

      const client = yield* useClient(info.route);
      client.send({ t: "attach", token: info.token, instance: info.id });
      expect((yield* client.next()).t).toBe("config");
      client.send({
        t: "journal",
        seq: 0,
        event: { type: "close", coroutineId: "root", result: { status: "ok" } },
      });
      expect((yield* client.next()).t).toBe("ack");
      expect(controller.instance(info.id)?.journal.length).toBe(1);

      // Ending the instance's scope revokes its worker and clears its state.
      release.resolve();
      yield* instanceTask;
      yield* client.closed;
      expect(controller.instance(info.id)).toBe(undefined);

      // A fresh worker for the now-unregistered instance is rejected.
      const late = yield* useClient(info.route);
      late.send({ t: "attach", token: info.token, instance: info.id });
      expect((yield* late.next()).t).toBe("error");
    });
  });

  it("TC6: a second worker cannot attach to a live instance, and instances stay independent", function* () {
    yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const a = yield* controller.useInstance({
        doc: { path: "a.md", source: '<WhenPrompt template="a" />' },
        scenarioDir: os.tmpdir(),
      });
      const b = yield* controller.useInstance({
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
      // The recorded ack is the barrier: the controller records the failure
      // before acknowledging it, so the assertions below never race.
      expect((yield* clientB.next()).t).toBe("recorded");

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
        const instance = yield* controller.useInstance({
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

  it("TC4: halting the controller task tears the instance down before the controller", function* () {
    yield* scoped(function* () {
      // One task owns the controller and THEN the instance, so on halt the
      // instance finalizer runs before the controller/server teardown. The
      // worker client lives in this scope to observe the revocation.
      const ready = withResolvers<{
        route: string;
        token: string;
        port: number;
        host: string;
        instance: ScenarioInstance;
      }>();
      const task = yield* spawn(function* () {
        const controller = yield* useTestAgentController();
        const instance = yield* controller.useInstance({
          doc: { path: "hi.md", source: '<WhenPrompt template="hi" />' },
          scenarioDir: os.tmpdir(),
        });
        const parsed = parseRoute(instance.route);
        if (!parsed.ok) {
          return;
        }
        ready.resolve({
          route: instance.route,
          token: parsed.message.token,
          port: parsed.message.port,
          host: parsed.message.host,
          instance,
        });
        yield* suspend();
      });
      const info = yield* ready.operation;

      const client = yield* useClient(info.route);
      client.send({ t: "attach", token: info.token, instance: info.instance.id });
      expect((yield* client.next()).t).toBe("config");
      client.send({
        t: "journal",
        seq: 0,
        event: { type: "close", coroutineId: "root", result: { status: "ok" } },
      });
      expect((yield* client.next()).t).toBe("ack");
      expect(info.instance.journal.length).toBe(1);

      yield* task.halt();
      // The instance finalizer revoked the worker before the server closed;
      // the retained instance shows its state cleared.
      yield* client.closed;
      expect(info.instance.journal.length).toBe(0);
      expect(info.instance.failure).toBe(undefined);

      // The listener is gone too.
      const socket = connect(info.port, info.host);
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
