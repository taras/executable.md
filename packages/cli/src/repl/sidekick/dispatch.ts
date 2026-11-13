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
import type { RecoveryDecisionRecord } from "./recovery-record.ts";

export const SidekickOrigin = createContext<MessageOrigin>("executablemd.repl.sidekick-origin", {
  kind: "ui",
});

export interface MessageReservation {
  readonly instruction?: Instruction;
}
export interface ConfigurationReservation {
  readonly kind: "inspect" | "save" | "replace" | "recover";
  readonly conversation: string | undefined;
  task: Task<void> | undefined;
  readonly instruction?: Instruction;
}

export function createSidekickAdmission() {
  let message: MessageReservation | undefined;
  let configuration: ConfigurationReservation | undefined;
  let pending = 0;
  function occupied(
    kind: "message" | "inspect" | "save" | "replace" | "recover",
  ): string | undefined {
    if ((kind === "replace" || kind === "inspect") && pending > 0) {
      return "remove waiting Sidekick messages before changing or inspecting the conversation.";
    }
    if (kind !== "save" && kind !== "replace" && kind !== "recover" && message !== undefined) {
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
      instruction?: Instruction,
    ): Result<ConfigurationReservation> {
      const reason = occupied(kind);
      if (reason !== undefined) {
        return Err(new Error(reason));
      }
      const held: ConfigurationReservation = { kind, conversation, task: undefined, instruction };
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
  cancel(reason?: "human"): Operation<void>;
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
  send(
    text: string,
    instruction?: Instruction,
    recoveryCurrent?: () => boolean,
  ): Operation<Result<SidekickExchange>>;
  readonly current: SidekickExchange | undefined;
  readonly queue: SidekickQueueSnapshot;
  hold(): void;
  resume(): Operation<Result<void>>;
  follow(reference: SidekickMessageReference): Result<SidekickExchange>;
}

export function* useSidekickDispatch(options: {
  owner: SidekickOwner;
  todoEligible?: () => boolean;
  admission: SidekickAdmission;
  execution: string;
  workspace: string;
  changed(): void;
  /**
   * Settle and retain the complete unresolved Submit set before a waiting
   * instruction is bound past a human Stop. Without it such an instruction
   * stays refused.
   */
  reconcile?(): Operation<
    Result<
      | void
      | readonly {
          readonly intent: {
            readonly response: string;
            readonly order: number;
          };
        }[]
    >
  >;
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
  interface Prepared {
    readonly reservation: MessageReservation;
    readonly recovery: NonNullable<SidekickMessageOptions["recovery"]>;
  }
  interface Pending {
    readonly row: SidekickPendingMessage;
    readonly stop: number | undefined;
    start(): void;
    activate(running: Running, prepared?: Prepared): Result<Activated>;
    dispose(): void;
  }
  const pending: Pending[] = [];
  const STOPPED = Object.freeze({
    kind: "stopped" as const,
    reason: "Stopped. Resume queue to continue.",
  });
  let held: SidekickQueueSnapshot["held"] = owner.humanStop === undefined ? undefined : STOPPED;
  let preparing:
    | { readonly entry: Pending; task: Task<void> | undefined; withdraw(): void }
    | undefined;
  let explicitRecovery = false;
  let live = true;
  let sequence = 0;
  let association = owner.reading.ok ? owner.reading.value.active : undefined;
  function updated(): void {
    admission.pending(pending.length);
    options.changed();
  }
  function eligible(item: { readonly stop: number | undefined } | undefined): boolean {
    return item?.stop !== undefined && owner.humanStop?.at === item.stop;
  }
  function guard(head?: { readonly stop: number | undefined }): Result<void> {
    if (!live) {
      return Err(new Error("The Sidekick dispatch owner has ended."));
    }
    const reading = owner.reading;
    if (!reading.ok) {
      return reading;
    }
    if (!eligible(head) && owner.recoveryPending) {
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
    if (
      !live ||
      current !== undefined ||
      preparing !== undefined ||
      explicitRecovery ||
      held !== undefined ||
      pending.length === 0
    ) {
      return;
    }
    const ready = guard(pending[0]);
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
      held = STOPPED;
      updated();
    },
    *resume() {
      if (explicitRecovery) {
        return Err(new Error("The Sidekick is preparing a recovery message."));
      }
      const ready = guard(pending[0]);
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
    *send(text, instruction, recoveryCurrent): Operation<Result<SidekickExchange>> {
      if (explicitRecovery) {
        return Err(new Error("The Sidekick is preparing a recovery message."));
      }
      const origin = Object.freeze({ ...(yield* SidekickOrigin.expect()) });
      if (origin.kind === "todo" && options.todoEligible?.() !== true) {
        return Err(
          new Error("TODO changes remain pending until another independently eligible prompt."),
        );
      }
      if (recoveryCurrent !== undefined && !owner.recoveryPending) {
        return Err(new Error("The recovery message is no longer current."));
      }
      const recover =
        origin.kind === "ui" &&
        instruction?.from === "composer" &&
        recoveryCurrent !== undefined &&
        owner.recoveryPending;
      const stop =
        origin.kind === "ui" && instruction?.from !== "saved" && held?.kind === "stopped"
          ? owner.humanStop?.at
          : undefined;
      if (!recover) {
        const ready = guard({ stop });
        if (!ready.ok) {
          return ready;
        }
        if (held?.kind === "failure") {
          return Err(new Error(held.reason));
        }
      }
      if (text.trim().length === 0 || (origin.kind === "acp" && origin.attachment.length === 0)) {
        return Err(new Error("A Sidekick dispatch requires text and an identified origin."));
      }
      if (new TextEncoder().encode(text).length > 65536) {
        return Err(new Error("A Sidekick message may contain at most 65536 UTF-8 bytes."));
      }
      if (!recover && pending.length >= 16) {
        return Err(
          new Error("The Sidekick queue is full (16 waiting messages). Remove one before sending."),
        );
      }
      const agent = owner.agent;
      const selected = owner.reading;
      const conversation = selected.ok ? selected.value.active : undefined;
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
        *cancel(reason?: "human"): Operation<void> {
          const binding = preparing?.entry === entry ? preparing : undefined;
          if (state === "queued" && binding !== undefined) {
            binding.withdraw();
            if (binding.task !== undefined) {
              yield* binding.task;
            }
          }
          if (state === "queued") {
            dispose();
            if (binding !== undefined) {
              advance();
            }
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
            yield* owner.stop(reason);
          }
          if (running?.task !== undefined) {
            yield* running.task;
          }
        },
      };
      const entry: Pending = {
        row: Object.freeze({ key: `pending-${++sequence}`, text, exchange }),
        stop,
        dispose,
        activate(family: Running, prepared?: Prepared): Result<Activated> {
          const now = owner.reading;
          if (
            !now.ok ||
            (recover
              ? now.value.active !== conversation
              : (conversation ?? association) !== undefined &&
                now.value.active !== (conversation ?? association)) ||
            owner.agent !== agent
          ) {
            if (prepared !== undefined) {
              admission.releaseMessage(prepared.reservation);
            }
            held = Object.freeze({
              kind: "failure",
              reason: "The selected Sidekick conversation changed before dispatch.",
            });
            updated();
            return Err(new Error(held.reason));
          }
          const reserved =
            prepared === undefined
              ? admission.messageReservation(captured)
              : Ok(prepared.reservation);
          if (!reserved.ok) {
            held = Object.freeze({ kind: "failure", reason: reserved.error.message });
            updated();
            return reserved;
          }
          const index = pending.indexOf(entry);
          if (index !== -1) {
            pending.splice(index, 1);
          }
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
              ...(prepared === undefined
                ? {}
                : {
                    recovery: prepared.recovery,
                    acknowledgeRecovery: recover,
                  }),
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
          if (eligible(entry)) {
            prepare();
          } else {
            launch(undefined);
          }
        },
      };
      // Bound while still waiting at the head, so a refusal leaves it there and
      // sends nothing.
      function prepare(): void {
        const reserved = admission.messageReservation(captured);
        if (!reserved.ok) {
          held = Object.freeze({ kind: "failure", reason: reserved.error.message });
          updated();
          return;
        }
        let withdrawn = false;
        const bound = () => live && !withdrawn && pending[0] === entry && eligible(entry);
        const marker: NonNullable<typeof preparing> = {
          entry,
          task: undefined,
          withdraw() {
            withdrawn = true;
          },
        };
        preparing = marker;
        marker.task = root.run(function* (): Operation<void> {
          let prepared: Result<{
            readonly decision: RecoveryDecisionRecord;
            readonly account: string;
          }> = Err(new Error("The stopped conversation changed before dispatch."));
          let returned = false;
          try {
            prepared = yield* bindContinuation(bound);
            returned = true;
          } finally {
            if (preparing === marker) {
              preparing = undefined;
            }
            if (!returned) {
              live = false;
              admission.releaseMessage(reserved.value);
            }
          }
          if (!prepared.ok || !bound()) {
            admission.releaseMessage(reserved.value);
            if (live && !withdrawn && pending.includes(entry)) {
              held = Object.freeze({
                kind: "failure",
                reason: prepared.ok
                  ? "The stopped conversation changed before dispatch."
                  : prepared.error.message,
              });
            }
            updated();
            return;
          }
          launch({
            reservation: reserved.value,
            recovery: { decision: prepared.value.decision, account: prepared.value.account },
          });
        });
      }
      function bindContinuation(bound: () => boolean): Operation<Result<Prepared["recovery"]>> {
        return scoped(function* (): Operation<Result<Prepared["recovery"]>> {
          const review = yield* owner.reviewRecovery();
          if (!review.ok) {
            return review;
          }
          if (options.reconcile === undefined) {
            return Err(new Error("Submit reconciliation is unavailable to this dispatch."));
          }
          const reconciled = yield* options.reconcile();
          if (!reconciled.ok) {
            return reconciled;
          }
          if (!bound()) {
            return Err(new Error("The stopped conversation changed before dispatch."));
          }
          const resolved = new Set(
            (reconciled.value ?? []).map((one) => `${one.intent.response}\0${one.intent.order}`),
          );
          return yield* owner.prepareContinuation(
            text,
            { current: bound },
            {
              ...review.value,
              controls: review.value.controls.filter(
                (one) => !resolved.has(`${one.response}\0${one.order}`),
              ),
            },
          );
        });
      }
      function launch(prepared: Prepared | undefined): Result<void> {
        const family: Running = { task: undefined, stopped: false, finish() {}, publish() {} };
        const first = entry.activate(family, prepared);
        if (!first.ok) {
          return first;
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
              const checked =
                recover && prepared !== undefined
                  ? owner.reading
                  : guard(prepared === undefined ? undefined : entry);
              if (!checked.ok) {
                return checked;
              }
              const selected = owner.reading;
              if (!selected.ok) {
                return selected;
              }
              if (
                (recover
                  ? selected.value.active !== conversation
                  : (conversation ?? association) !== undefined &&
                    selected.value.active !== (conversation ?? association)) ||
                owner.agent !== agent
              ) {
                return Err(
                  new Error("The selected Sidekick conversation changed before dispatch."),
                );
              }
              const sent = yield* owner.message(first.value.text, {
                ...first.value.options,
                *advance(settled) {
                  if (
                    recover ||
                    family.stopped ||
                    !live ||
                    held !== undefined ||
                    pending.length === 0 ||
                    eligible(pending[0])
                  ) {
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
        return Ok(undefined);
      }
      if (recover) {
        if (!selected.ok) {
          return selected;
        }
        if (explicitRecovery || preparing !== undefined || admission.configuration !== undefined) {
          return Err(new Error("The Sidekick is already doing something you asked for."));
        }
        explicitRecovery = true;
        held = STOPPED;
        const previous = current;
        updated();
        const bound = () =>
          live &&
          recoveryCurrent() &&
          owner.reading.ok &&
          owner.reading.value.active === conversation;
        try {
          if (previous !== undefined) {
            yield* previous.completion;
          }
          if (!bound()) {
            return Err(new Error("The recovery message or conversation changed before dispatch."));
          }
          const reservation = admission.messageReservation(captured);
          if (!reservation.ok) {
            return reservation;
          }
          let activated = false;
          try {
            const prepared = yield* bindContinuation(bound);
            if (!prepared.ok) {
              return prepared;
            }
            if (!bound()) {
              return Err(
                new Error("The recovery message or conversation changed before dispatch."),
              );
            }
            const launched = launch({ reservation: reservation.value, recovery: prepared.value });
            if (!launched.ok) {
              return launched;
            }
            activated = true;
            if (pending.length === 0 && held === STOPPED) {
              held = undefined;
            }
            return Ok(exchange);
          } finally {
            if (!activated) {
              admission.releaseMessage(reservation.value);
            }
          }
        } finally {
          explicitRecovery = false;
          updated();
        }
      }
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
