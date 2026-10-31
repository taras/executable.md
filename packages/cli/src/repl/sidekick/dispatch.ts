import {
  createContext,
  createSignal,
  ensure,
  Err,
  Ok,
  scoped,
  spawn,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Result, Subscription, Task } from "effection";
import { API } from "@executablemd/runtime";
import type { Instruction } from "./gate.ts";
import type { MessageOrigin } from "./history.ts";
import { SidekickOwnerError } from "./owner.ts";
import type { SidekickMessageOptions, SidekickOwner, SidekickTurn } from "./owner.ts";

export const SidekickOrigin = createContext<MessageOrigin>("executablemd.repl.sidekick-origin", {
  kind: "ui",
});

export interface MessageReservation {
  readonly instruction?: Instruction;
}
export interface ConfigurationReservation {
  readonly kind: "inspect" | "save" | "replace";
  readonly conversation: string | undefined;
  task: Task<void> | undefined;
}

export function createSidekickAdmission() {
  let message: MessageReservation | undefined;
  let configuration: ConfigurationReservation | undefined;
  let pending = 0;
  function occupied(kind: "message" | "inspect" | "save" | "replace"): string | undefined {
    if ((kind === "replace" || kind === "inspect") && pending > 0) {
      return "remove waiting Sidekick messages before changing or inspecting the conversation.";
    }
    if (kind !== "save" && kind !== "replace" && message !== undefined) {
      return "the Sidekick is already working on a message.";
    }
    if (configuration === undefined) {
      return undefined;
    }
    if (kind === "save" && configuration.kind === "save") {
      return "the Sidekick is already saving a setting.";
    }
    return "the Sidekick is already doing something you asked for.";
  }
  return {
    get message() {
      return message;
    },
    get configuration() {
      return configuration;
    },
    occupied,
    pending(count: number): void {
      pending = count;
    },
    messageReservation(instruction?: Instruction): Result<MessageReservation> {
      const reason = occupied("message");
      if (reason !== undefined) {
        return Err(new Error(reason));
      }
      const held = Object.freeze({ ...(instruction === undefined ? {} : { instruction }) });
      message = held;
      return Ok(held);
    },
    releaseMessage(held: MessageReservation): void {
      if (message === held) {
        message = undefined;
      }
    },
    configure(
      kind: ConfigurationReservation["kind"],
      conversation: string | undefined,
    ): Result<ConfigurationReservation> {
      const reason = occupied(kind);
      if (reason !== undefined) {
        return Err(new Error(reason));
      }
      const held: ConfigurationReservation = { kind, conversation, task: undefined };
      configuration = held;
      return Ok(held);
    },
    releaseConfiguration(held: ConfigurationReservation): void {
      if (configuration === held) {
        configuration = undefined;
      }
    },
  };
}
export type SidekickAdmission = ReturnType<typeof createSidekickAdmission>;

export interface SidekickMessageReference {
  readonly execution: string;
  readonly conversation: string;
  readonly id: string;
}
export interface SidekickDispatchSnapshot {
  readonly origin: MessageOrigin;
  readonly state: "queued" | "active" | "settled";
  readonly message: SidekickMessageReference | undefined;
  readonly reading: SidekickOwner["reading"];
  readonly live: SidekickOwner["live"];
  readonly preview: SidekickOwner["previewing"];
  readonly terminal: Result<SidekickTurn> | undefined;
}
export interface SidekickExchange {
  readonly snapshot: SidekickDispatchSnapshot;
  readonly completion: Operation<Result<SidekickTurn>>;
  observe(): Operation<{
    readonly snapshot: SidekickDispatchSnapshot;
    readonly changes: Subscription<SidekickDispatchSnapshot, never>;
  }>;
  cancel(): Operation<void>;
}
export interface SidekickPendingMessage {
  readonly key: string;
  readonly text: string;
  readonly exchange: SidekickExchange;
}
export interface SidekickQueueSnapshot {
  readonly pending: readonly SidekickPendingMessage[];
  readonly held:
    | { readonly kind: "stopped"; readonly reason: string }
    | { readonly kind: "failure"; readonly reason: string }
    | undefined;
}
export interface SidekickDispatch {
  send(text: string, instruction?: Instruction): Operation<Result<SidekickExchange>>;
  readonly current: SidekickExchange | undefined;
  readonly queue: SidekickQueueSnapshot;
  hold(): void;
  resume(): Operation<Result<void>>;
  follow(reference: SidekickMessageReference): Result<SidekickExchange>;
}

export function* useSidekickDispatch(options: {
  owner: SidekickOwner;
  admission: SidekickAdmission;
  execution: string;
  workspace: string;
  changed(): void;
}): Operation<SidekickDispatch> {
  const root = yield* useScope();
  const { owner, admission } = options;
  let current: SidekickExchange | undefined;
  const messages = new Map<string, SidekickExchange>();
  type Activated = { readonly text: string; readonly options: SidekickMessageOptions };
  interface Running {
    task: Task<void> | undefined;
    stopped: boolean;
    finish(result: Result<SidekickTurn>): void;
    publish(): void;
  }
  const pending: {
    row: SidekickPendingMessage;
    start(): void;
    activate(running: Running): Result<Activated>;
    dispose(): void;
  }[] = [];
  let held: SidekickQueueSnapshot["held"];
  let live = true;
  let sequence = 0;
  let association = owner.reading.ok ? owner.reading.value.active : undefined;
  function updated(): void {
    admission.pending(pending.length);
    options.changed();
  }
  function guard(): Result<void> {
    if (!live) {
      return Err(new Error("The Sidekick dispatch owner has ended."));
    }
    const reading = owner.reading;
    if (!reading.ok) {
      return reading;
    }
    if (reading.value.unestablished.some((one) => one.conversation === reading.value.active)) {
      return Err(
        new Error("This conversation holds feedback whose acceptance cannot be established."),
      );
    }
    if (admission.configuration !== undefined) {
      return Err(new Error("the Sidekick is already doing something you asked for."));
    }
    return Ok(undefined);
  }
  function advance(): void {
    if (!live || current !== undefined || held !== undefined || pending.length === 0) {
      return;
    }
    const ready = guard();
    if (!ready.ok) {
      held = Object.freeze({ kind: "failure", reason: ready.error.message });
      updated();
      return;
    }
    pending[0].start();
  }
  yield* ensure(function* () {
    live = false;
    while (pending.length > 0) {
      pending[0].dispose();
    }
    messages.clear();
  });
  return {
    get current() {
      return current;
    },
    get queue() {
      return Object.freeze({ pending: Object.freeze(pending.map((one) => one.row)), held });
    },
    hold() {
      if (current !== undefined) {
        held = Object.freeze({ kind: "stopped", reason: "Stopped. Resume queue to continue." });
        updated();
      }
    },
    *resume() {
      const ready = guard();
      if (!ready.ok) {
        return ready;
      }
      held = undefined;
      updated();
      advance();
      return Ok(undefined);
    },
    follow(reference): Result<SidekickExchange> {
      if (!live) {
        return Err(new Error("The Sidekick dispatch owner has ended."));
      }
      const exchange = messages.get(reference.id);
      const saved = exchange?.snapshot.message;
      return exchange !== undefined &&
        saved?.execution === reference.execution &&
        saved.conversation === reference.conversation
        ? Ok(exchange)
        : Err(new Error("This live owner has no established association for that message."));
    },
    *send(text, instruction): Operation<Result<SidekickExchange>> {
      const origin = Object.freeze({ ...(yield* SidekickOrigin.expect()) });
      const ready = guard();
      if (!ready.ok) {
        return ready;
      }
      if (held?.kind === "failure") {
        return Err(new Error(held.reason));
      }
      if (text.trim().length === 0 || (origin.kind === "acp" && origin.attachment.length === 0)) {
        return Err(new Error("A Sidekick dispatch requires text and an identified origin."));
      }
      if (new TextEncoder().encode(text).length > 65536) {
        return Err(new Error("A Sidekick message may contain at most 65536 UTF-8 bytes."));
      }
      if (pending.length >= 16) {
        return Err(
          new Error("The Sidekick queue is full (16 waiting messages). Remove one before sending."),
        );
      }
      const agent = owner.agent;
      const captured = instruction === undefined ? undefined : Object.freeze({ ...instruction });
      const answer = withResolvers<Result<SidekickTurn>>();
      const changed = createSignal<SidekickDispatchSnapshot, never>();
      let message: SidekickMessageReference | undefined;
      let terminal: Result<SidekickTurn> | undefined;
      let completed: SidekickDispatchSnapshot | undefined;
      let state: SidekickDispatchSnapshot["state"] = "queued";
      let stopped = false;
      let running: Running | undefined;
      function snapshot(): SidekickDispatchSnapshot {
        return (
          completed ??
          Object.freeze({
            origin,
            state,
            message,
            reading: owner.reading,
            live: state === "active" ? owner.live : undefined,
            preview: state === "active" ? owner.previewing : undefined,
            terminal,
          })
        );
      }
      function publish(): void {
        changed.send(snapshot());
        updated();
      }
      function settle(result: Result<SidekickTurn>): void {
        if (terminal !== undefined) {
          return;
        }
        const final = snapshot();
        state = "settled";
        terminal = result;
        completed = Object.freeze({ ...final, state, terminal });
        publish();
        answer.resolve(result);
      }
      function dispose(): void {
        const index = pending.indexOf(entry);
        if (index !== -1) {
          pending.splice(index, 1);
          settle(
            Err(new SidekickOwnerError("The Sidekick exchange was cancelled before sending.")),
          );
        }
      }
      const exchange: SidekickExchange = {
        get snapshot() {
          return snapshot();
        },
        completion: answer.operation,
        *observe() {
          const changes = yield* changed;
          return { snapshot: snapshot(), changes };
        },
        *cancel(): Operation<void> {
          if (state === "queued") {
            dispose();
            return;
          }
          if (terminal !== undefined) {
            return;
          }
          if (!stopped && current === exchange) {
            stopped = true;
            if (running !== undefined) {
              running.stopped = true;
            }
            yield* owner.stop();
          }
          if (running?.task !== undefined) {
            yield* running.task;
          }
        },
      };
      const entry = {
        row: Object.freeze({ key: `pending-${++sequence}`, text, exchange }),
        dispose,
        activate(family: Running): Result<Activated> {
          const now = owner.reading;
          if (
            !now.ok ||
            (association !== undefined && now.value.active !== association) ||
            owner.agent !== agent
          ) {
            held = Object.freeze({
              kind: "failure",
              reason: "The selected Sidekick conversation changed before dispatch.",
            });
            updated();
            return Err(new Error(held.reason));
          }
          const reserved = admission.messageReservation(captured);
          if (!reserved.ok) {
            held = Object.freeze({ kind: "failure", reason: reserved.error.message });
            updated();
            return reserved;
          }
          pending.splice(pending.indexOf(entry), 1);
          state = "active";
          current = exchange;
          running = family;
          family.publish = publish;
          family.finish = (result) => {
            admission.releaseMessage(reserved.value);
            if (current === exchange) {
              current = undefined;
            }
            settle(result);
          };
          publish();
          return Ok({
            text,
            options: {
              origin,
              saved(conversation, id) {
                association = conversation;
                message = Object.freeze({ execution: options.execution, conversation, id });
                messages.set(id, exchange);
                publish();
              },
            },
          });
        },
        start(): void {
          const family: Running = { task: undefined, stopped: false, finish() {}, publish() {} };
          const first = entry.activate(family);
          if (!first.ok) {
            return;
          }
          family.task = root.run(function* (): Operation<void> {
            let result: Result<SidekickTurn> = Err(
              new SidekickOwnerError("The Sidekick exchange was cancelled."),
            );
            let returned = false;
            try {
              result = yield* scoped(function* (): Operation<Result<SidekickTurn>> {
                yield* API.Env.around({
                  *cwd() {
                    return options.workspace;
                  },
                });
                const changes = yield* owner.changes;
                yield* spawn(function* () {
                  while (true) {
                    yield* changes.next();
                    family.publish();
                  }
                });
                if (family.stopped) {
                  return result;
                }
                const checked = guard();
                if (!checked.ok) {
                  return checked;
                }
                const selected = owner.reading;
                if (!selected.ok) {
                  return selected;
                }
                if (
                  (association !== undefined && selected.value.active !== association) ||
                  owner.agent !== agent
                ) {
                  return Err(
                    new Error("The selected Sidekick conversation changed before dispatch."),
                  );
                }
                const sent = yield* owner.message(first.value.text, {
                  ...first.value.options,
                  *advance(settled) {
                    if (family.stopped || !live || held !== undefined || pending.length === 0) {
                      return Ok(undefined);
                    }
                    const ready = guard();
                    if (!ready.ok) {
                      return ready;
                    }
                    family.finish(Ok(settled));
                    return pending[0].activate(family);
                  },
                });
                if (sent.ok && sent.value.failure !== undefined) {
                  return Err(new SidekickOwnerError(sent.value.failure, sent.value));
                }
                return sent;
              });
              returned = true;
            } catch (error) {
              // Thrown owner failures retain command authority rather than becoming resumable holds.
              result = Err(error instanceof Error ? error : new Error(String(error)));
              throw error;
            } finally {
              if (!returned) {
                live = false;
              } else if (!result.ok && !family.stopped && held === undefined) {
                held = Object.freeze({ kind: "failure", reason: result.error.message });
              }
              family.finish(result);
              advance();
            }
          });
        },
      };
      if (pending.length === 0 && current === undefined) {
        association = owner.reading.ok ? owner.reading.value.active : association;
      }
      pending.push(entry);
      publish();
      advance();
      return Ok(exchange);
    },
  };
}
