/**
 * Tier TC — controller tests (specs/test-agent-spec.md §Controller and
 * worker): token auth, probe/scenario config, journal ack ordering,
 * on-demand dependency reads/stats, failure marks, and teardown.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { createSignal, each, ensure, scoped, spawn, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { useTestAgentController } from "../src/controller.ts";
import type { TestAgentController } from "../src/controller.ts";
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
}

function* useClient(route: string): Operation<TestClient> {
  const parsed = parseRoute(route);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const { host, port } = parsed.message;
  const socket: Socket = connect(port, host);
  const messages = createSignal<ControllerMessage, undefined>();
  const splitter = createLineSplitter();
  socket.on("data", (chunk: Buffer) => {
    for (const line of splitter.feed(chunk.toString("utf8"))) {
      const result = parseControllerMessage(line);
      if (result.ok) {
        messages.send(result.message);
      }
    }
  });
  socket.on("close", () => messages.close(undefined));
  yield* ensure(() => {
    socket.destroy();
  });
  yield* until(
    new Promise<void>((resolvePromise, reject) => {
      socket.once("connect", () => resolvePromise());
      socket.once("error", reject);
    }),
  );
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
      return yield* until(
        new Promise<ControllerMessage>((resolvePromise) => {
          waiters.push(resolvePromise);
        }),
      );
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

  it("TC5: unregistering an instance discards its journal and rejects new workers", function* () {
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

      controller.unregisterInstance(instance.id);
      expect(controller.instance(instance.id)).toBe(undefined);

      const late = yield* useClient(instance.route);
      late.send({ t: "attach", token: parsed.message.token, instance: instance.id });
      expect((yield* late.next()).t).toBe("error");
    });
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

  it("TC4: the controller stops listening when its scope closes", function* () {
    let saved: TestAgentController | undefined;
    yield* scoped(function* () {
      saved = yield* useTestAgentController();
    });
    const parsed = parseRoute(saved!.probeRoute);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const outcome = yield* until(
      new Promise<string>((resolvePromise) => {
        const socket = connect(parsed.message.port, parsed.message.host);
        socket.once("connect", () => {
          socket.destroy();
          resolvePromise("connected");
        });
        socket.once("error", () => resolvePromise("refused"));
      }),
    );
    expect(outcome).toBe("refused");
  });
});
