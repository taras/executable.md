import { createSignal, ensure, race, scoped, spawn, useScope, withResolvers } from "effection";
import type { Operation, Scope, Stream, Task } from "effection";
import type { ReplScreen, ReplScreenEvent } from "./screen.ts";
import type { ReplTerminalSize } from "./terminal.ts";

interface Connection {
  readonly scope: Scope;
  readonly screen: ReplScreen;
  readonly work: Set<Task<unknown>>;
  active: boolean;
  end(): void;
}

export interface ReplLiveScreen {
  readonly screen: ReplScreen;
  readonly generation: number;
  readonly connected: boolean;
  connect(screen: ReplScreen): Operation<void>;
  detach(): void;
  accepts(event: ReplScreenEvent): boolean;
  draw<T>(render: () => Operation<T>): Operation<T | undefined>;
}

export function* useReplLiveScreen(): Operation<ReplLiveScreen> {
  const events = createSignal<ReplScreenEvent, void>();
  const incoming = yield* events;
  let current: Connection | undefined;
  let generation = 0;
  let lastSize: ReplTerminalSize = { columns: 120, rows: 30 };
  const sources = new WeakMap<ReplScreenEvent, Connection>();
  function report(held: Connection, event: ReplScreenEvent): void {
    sources.set(event, held);
    events.send(event);
  }

  const screen: ReplScreen = {
    *size() {
      return lastSize;
    },
    *present(bytes, size) {
      const held = current;
      if (held === undefined || !held.active) {
        throw new Error("The interactive child view detached before presentation.");
      }
      try {
        yield* held.screen.present(bytes, size);
      } catch (error) {
        if (!(error instanceof Error && error.name === "ReplStaleFrameError")) {
          held.end();
        }
        throw error;
      }
    },
    events(): Stream<ReplScreenEvent, void> {
      return {
        *[Symbol.iterator]() {
          return incoming;
        },
      };
    },
  };

  return {
    screen,
    get generation() {
      return generation;
    },
    get connected() {
      return current !== undefined;
    },
    detach() {
      current?.end();
    },
    accepts(event) {
      return current !== undefined && current.active && sources.get(event) === current;
    },
    connect(terminal): Operation<void> {
      return scoped(function* () {
        if (current !== undefined) {
          throw new Error("This child already has an interactive UI attached. Detach it first.");
        }
        const ended = withResolvers<void>();
        const held: Connection = {
          scope: yield* useScope(),
          screen: terminal,
          work: new Set(),
          active: true,
          end() {
            held.active = false;
            ended.resolve();
          },
        };
        yield* ensure(function* () {
          held.end();
          for (const task of held.work) {
            yield* task.halt();
          }
          if (current === held) {
            current = undefined;
          }
          events.send({ kind: "resize", size: lastSize });
        });
        current = held;
        generation += 1;
        try {
          lastSize = yield* terminal.size();
          report(held, { kind: "resize", size: lastSize });
          const reader = yield* spawn(function* () {
            const source = yield* terminal.events();
            while (true) {
              const next = yield* source.next();
              if (next.done || next.value.kind === "eof") {
                held.end();
                return;
              }
              if (held.active) {
                if (next.value.kind === "resize") {
                  lastSize = next.value.size;
                }
                report(held, next.value);
              }
            }
          });
          yield* race([ended.operation, reader]);
        } finally {
          held.end();
        }
      });
    },
    *draw<T>(render: () => Operation<T>): Operation<T | undefined> {
      const held = current;
      if (held === undefined) {
        return undefined;
      }
      const task = held.scope.run(render);
      held.work.add(task);
      try {
        const value = yield* task;
        return held.active && current === held ? value : undefined;
      } catch (error) {
        if (held.active) {
          throw error;
        }
        return undefined;
      } finally {
        held.work.delete(task);
      }
    },
  };
}
