import { createSignal, race, scoped, sleep, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { z } from "zod";
import type { ReplLiveScreen } from "../repl/live-screen.ts";
import { useReplScreen } from "../repl/screen.ts";
import type { ReplScreenEvent } from "../repl/screen.ts";
import { ReplTerminal } from "../repl/terminal.ts";
import { Descriptor, Reply, SidekickTransport } from "../sidekick-acp/protocol.ts";
import type { Wire } from "../sidekick-acp/protocol.ts";
import { childAddressPath } from "./host.ts";

import { UiSize, physical, applied, incoming, presentation } from "./ui-schema.ts";

export function serveChildUi(
  wire: Wire,
  view: ReplLiveScreen,
  initial: z.infer<typeof UiSize>,
  id: number,
): Operation<void> {
  return scoped(function* () {
    const events = createSignal<ReplScreenEvent, void>();
    const source = yield* events;
    let size = initial;
    let sequence = 0;
    let waiting: { sequence: number; settle(value: z.infer<typeof applied>): void } | undefined;
    let leased = false;
    const reader = yield* spawn(function* () {
      while (true) {
        const event = incoming.parse(yield* wire.receive());
        if (event.kind === "applied") {
          if (waiting === undefined || waiting.sequence !== event.sequence) {
            throw new Error("The UI acknowledgement names no outstanding presentation.");
          }
          if (size.columns !== event.size.columns || size.rows !== event.size.rows) {
            size = event.size;
            events.send({ kind: "resize", size });
          }
          waiting.settle(event);
          waiting = undefined;
        } else {
          if (event.kind === "resize") {
            size = event.size;
          }
          events.send(event);
          if (event.kind === "eof") {
            return;
          }
        }
      }
    });
    yield* view.connect({
      *size() {
        if (!leased) {
          leased = true;
          yield* wire.send({ id, kind: "value", value: { leased: true } });
        }
        return size;
      },
      *present(bytes, dimensions) {
        const expected = dimensions ?? size;
        const answer = withResolvers<z.infer<typeof applied>>();
        sequence += 1;
        waiting = { sequence, settle: answer.resolve };
        yield* wire.send(
          presentation.parse({ kind: "frame", sequence, size: expected, bytes: Array.from(bytes) }),
        );
        const result = yield* race([
          answer.operation,
          (function* (): Operation<never> {
            yield* sleep(5000);
            throw new Error("The UI did not apply its outstanding frame within five seconds.");
          })(),
        ]);
        if (
          !result.applied ||
          result.size.columns !== expected.columns ||
          result.size.rows !== expected.rows
        ) {
          const refusal = new Error("The terminal resized before applying the presentation.");
          refusal.name = "ReplStaleFrameError";
          throw refusal;
        }
      },
      events() {
        return {
          *[Symbol.iterator]() {
            return source;
          },
        };
      },
    });
    yield* reader.halt();
    yield* wire.send({ id, kind: "value", value: { detached: true } });
  });
}

export function attachChildUi(sessionId: string): Operation<void> {
  return scoped(function* () {
    const path = yield* childAddressPath(sessionId);
    const { descriptor, wire } = yield* (yield* SidekickTransport.expect()).connect(path);
    if (descriptor.owner !== sessionId) {
      throw new Error("The live association belongs to another XMD child.");
    }
    yield* wire.send({ id: 0, request: { method: "hello", descriptor } });
    const hello = Reply.parse(yield* wire.receive());
    if (
      hello.id !== 0 ||
      hello.kind !== "value" ||
      JSON.stringify(Descriptor.parse(hello.value)) !== JSON.stringify(descriptor)
    ) {
      throw new Error("The exact live child handshake was refused.");
    }
    if (!(yield* ReplTerminal.operations.interactive())) {
      throw new Error("An interactive child attachment requires a terminal.");
    }
    const size = yield* ReplTerminal.operations.size();
    yield* wire.send({ id: 1, request: { method: "ui", size } });
    const lease = Reply.parse(yield* wire.receive());
    if (lease.kind === "error") {
      throw new Error(lease.error);
    }
    if (
      lease.id !== 1 ||
      lease.kind !== "value" ||
      !z
        .object({ leased: z.literal(true) })
        .strict()
        .safeParse(lease.value).success
    ) {
      throw new Error("The child did not grant this UI a lease.");
    }
    const screen = yield* useReplScreen();
    let inputEnded = false;
    yield* spawn(function* () {
      const input = yield* screen.events();
      while (true) {
        const next = yield* input.next();
        const event = next.done ? { kind: "eof" } : next.value;
        inputEnded = next.done || event.kind === "eof";
        yield* wire.send(physical.parse(event));
        if (next.done || next.value.kind === "eof") {
          return;
        }
      }
    });
    while (true) {
      const raw = yield* wire.receive();
      const end = Reply.safeParse(raw);
      if (end.success) {
        if (end.data.kind === "error") {
          throw new Error(end.data.error);
        }
        return;
      }
      const frame = presentation.parse(raw);
      const now = yield* screen.size();
      let applied = now.columns === frame.size.columns && now.rows === frame.size.rows;
      if (applied) {
        yield* screen.present(Uint8Array.from(frame.bytes));
        const after = yield* screen.size();
        applied = after.columns === frame.size.columns && after.rows === frame.size.rows;
      }
      if (!inputEnded) {
        yield* wire.send({
          kind: "applied",
          sequence: frame.sequence,
          size: yield* screen.size(),
          applied,
        });
      }
    }
  });
}
