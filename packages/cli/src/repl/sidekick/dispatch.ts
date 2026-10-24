import { createContext, createSignal, ensure, Err, Ok, scoped, spawn, useScope, withResolvers } from "effection";
import type { Operation, Result, Subscription, Task } from "effection";
import { API } from "@executablemd/runtime";
import type { Instruction } from "./gate.ts";
import type { MessageOrigin } from "./history.ts";
import { SidekickOwnerError } from "./owner.ts";
import type { SidekickOwner, SidekickTurn } from "./owner.ts";

export const SidekickOrigin = createContext<MessageOrigin>("executablemd.repl.sidekick-origin", { kind: "ui" });

export interface MessageReservation { readonly instruction?: Instruction }
export interface ConfigurationReservation {
  readonly kind: "inspect" | "save" | "replace";
  readonly conversation: string | undefined;
  task: Task<void> | undefined;
}

export function createSidekickAdmission() {
  let message: MessageReservation | undefined;
  let configuration: ConfigurationReservation | undefined;
  function occupied(kind: "message" | "inspect" | "save" | "replace"): string | undefined {
    if (kind !== "save" && kind !== "replace" && message !== undefined) {
      return "the Sidekick is already working on a message.";
    }
    if (configuration === undefined) { return undefined; }
    if (kind === "save" && configuration.kind === "save") {
      return "the Sidekick is already saving a setting.";
    }
    return "the Sidekick is already doing something you asked for.";
  }
  return {
    get message() { return message; },
    get configuration() { return configuration; },
    occupied,
    messageReservation(instruction?: Instruction): Result<MessageReservation> {
      const reason = occupied("message");
      if (reason !== undefined) { return Err(new Error(reason)); }
      const held = Object.freeze({ ...(instruction === undefined ? {} : { instruction }) });
      message = held;
      return Ok(held);
    },
    releaseMessage(held: MessageReservation): void { if (message === held) { message = undefined; } },
    configure(kind: ConfigurationReservation["kind"], conversation: string | undefined): Result<ConfigurationReservation> {
      const reason = occupied(kind);
      if (reason !== undefined) { return Err(new Error(reason)); }
      const held: ConfigurationReservation = { kind, conversation, task: undefined };
      configuration = held;
      return Ok(held);
    },
    releaseConfiguration(held: ConfigurationReservation): void {
      if (configuration === held) { configuration = undefined; }
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
  readonly message: SidekickMessageReference | undefined;
  readonly reading: SidekickOwner["reading"];
  readonly live: SidekickOwner["live"];
  readonly preview: SidekickOwner["previewing"];
  readonly terminal: Result<SidekickTurn> | undefined;
}
export interface SidekickExchange {
  readonly snapshot: SidekickDispatchSnapshot;
  readonly completion: Operation<Result<SidekickTurn>>;
  observe(): Operation<{ readonly snapshot: SidekickDispatchSnapshot; readonly changes: Subscription<SidekickDispatchSnapshot, never> }>;
  cancel(): Operation<void>;
}
export interface SidekickDispatch {
  send(text: string, instruction?: Instruction): Operation<Result<SidekickExchange>>;
  readonly current: SidekickExchange | undefined;
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
  let live = true;
  yield* ensure(function* () { live = false; messages.clear(); });
  return {
    get current() { return current; },
    follow(reference): Result<SidekickExchange> {
      if (!live) { return Err(new Error("The Sidekick dispatch owner has ended.")); }
      const exchange = messages.get(reference.id);
      const saved = exchange?.snapshot.message;
      return exchange !== undefined && saved?.execution === reference.execution && saved.conversation === reference.conversation
        ? Ok(exchange) : Err(new Error("This live owner has no established association for that message."));
    },
    *send(text, instruction): Operation<Result<SidekickExchange>> {
      if (!live) { return Err(new Error("The Sidekick dispatch owner has ended.")); }
      const origin = Object.freeze({ ...(yield* SidekickOrigin.expect()) });
      if (text.trim().length === 0 || origin.kind === "acp" && origin.attachment.length === 0) {
        return Err(new Error("A Sidekick dispatch requires text and an identified origin."));
      }
      const selected = owner.reading;
      if (!selected.ok) { return selected; }
      const conversation = selected.value.active;
      const agent = owner.agent;
      const reserved = admission.messageReservation(instruction);
      if (!reserved.ok) { return reserved; }
      const held = reserved.value;
      const answer = withResolvers<Result<SidekickTurn>>();
      const changed = createSignal<SidekickDispatchSnapshot, never>();
      let message: SidekickMessageReference | undefined;
      let terminal: Result<SidekickTurn> | undefined;
      let completed: SidekickDispatchSnapshot | undefined;
      let stopped = false;
      let producer: Task<void>;
      function snapshot(): SidekickDispatchSnapshot {
        return completed ?? Object.freeze({ origin, message, reading: owner.reading, live: owner.live, preview: owner.previewing, terminal });
      }
      function publish(): void { changed.send(snapshot()); options.changed(); }
      const exchange: SidekickExchange = {
        get snapshot() { return snapshot(); },
        completion: answer.operation,
        *observe() {
          const changes = yield* changed;
          return { snapshot: snapshot(), changes };
        },
        *cancel(): Operation<void> {
          if (terminal !== undefined) { return; }
          if (!stopped && current === exchange) {
            stopped = true;
            yield* owner.stop();
          }
          yield* producer;
        },
      };
      current = exchange;
      producer = root.run(function* (): Operation<void> {
        let result: Result<SidekickTurn> = Err(new SidekickOwnerError("The Sidekick exchange was cancelled."));
        try {
          yield* API.Env.around({ *cwd() { return options.workspace; } });
          result = yield* scoped(function* (): Operation<Result<SidekickTurn>> {
            const changes = yield* owner.changes;
            yield* spawn(function* () {
              while (true) { yield* changes.next(); publish(); }
            });
            if (stopped) { return Err(new SidekickOwnerError("The Sidekick exchange was cancelled before sending.")); }
            const now = owner.reading;
            if (!now.ok) { return now; }
            if (now.value.active !== conversation || owner.agent !== agent) {
              return Err(new Error("The selected Sidekick conversation changed before dispatch."));
            }
            const sent = yield* owner.message(text, {
              origin,
              saved(conversation, id) {
                message = Object.freeze({ execution: options.execution, conversation, id });
                messages.set(id, exchange);
                publish();
              },
            });
            if (sent.ok && sent.value.failure !== undefined) {
              return Err(new SidekickOwnerError(sent.value.failure, sent.value));
            }
            return sent;
          });
        } catch (error) {
          result = Err(error instanceof Error ? error : new Error(String(error)));
        } finally {
          terminal = result;
          completed = snapshot();
          admission.releaseMessage(held);
          if (current === exchange) { current = undefined; }
          publish();
          answer.resolve(result);
        }
      });
      return Ok(exchange);
    },
  };
}
