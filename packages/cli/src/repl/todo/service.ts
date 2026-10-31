import {
  createContext,
  createSignal,
  ensure,
  Err,
  Ok,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  withResolvers,
} from "effection";
import type { Operation, Result, Stream } from "effection";
import {
  API,
  FilesInvariantError,
  parseFilesFailure,
  parseFileWriteFailure,
  parseFileWriteSuccess,
} from "@executablemd/runtime";
import { applyTodoDiff, parseTodo, todoDiff, TodoEditError } from "./document.ts";
import type { TodoDocument, TodoItem } from "./document.ts";
import { captureTodoSource } from "./source.ts";
import { TodoSourceError } from "./source.ts";
import { Agent } from "@executablemd/core";

interface TodoObservation {
  readonly origin: "human" | "sidekick";
  readonly diff: string;
  readonly items: readonly TodoItem[];
}

interface TodoService {
  readonly current: Result<TodoDocument>;
  readonly changes: Stream<void, never>;
  readonly pending: readonly TodoObservation[];
  read(): Operation<TodoDocument>;
  apply(patch: string): Operation<readonly TodoItem[]>;
  save(opening: string, replacement: string): Operation<readonly TodoItem[]>;
  refresh(): Operation<void>;
  installPrompt(): Operation<void>;
  finishPrompt(succeeded: boolean): void;
  readonly recovery: boolean;
}

export const Todo = createContext<TodoService | undefined>("executablemd.cli.repl.todo", undefined);

export function* useTodo(workspace: string): Operation<TodoService> {
  const service = yield* resource<TodoService>(function* (provide) {
    const source = yield* captureTodoSource();
    const changes = createSignal<void, never>();
    const pending: TodoObservation[] = [];
    let current: Result<TodoDocument> = Ok(parseTodo(""));
    let observed: string | undefined;
    let live = true;
    let recovery = false;
    let prompting: readonly TodoObservation[] | undefined;
    let writing = false;
    const waiting: Array<{ owning: boolean; ready: ReturnType<typeof withResolvers<void>> }> = [];
    yield* ensure(() => {
      live = false;
    });

    function ordered<T>(work: () => Operation<T>): Operation<T> {
      return scoped(function* () {
        if (!live) {
          throw new TodoEditError("The TODO session has closed.");
        }
        const turn = { owning: false, ready: withResolvers<void>() };
        yield* ensure(() => {
          if (turn.owning) {
            const next = waiting.shift();
            if (next === undefined) {
              writing = false;
            } else {
              next.owning = true;
              next.ready.resolve();
            }
          } else {
            const at = waiting.indexOf(turn);
            if (at >= 0) {
              waiting.splice(at, 1);
            }
          }
        });
        if (writing) {
          waiting.push(turn);
          yield* turn.ready.operation;
        }
        writing = true;
        turn.owning = true;
        return yield* work();
      });
    }

    function* read(): Operation<TodoDocument> {
      const result = yield* source.read(workspace);
      let text: string;
      if (result.ok) {
        text = result.value;
      } else if (parseFilesFailure(result.error)?.reason === "missing") {
        text = "";
      } else {
        throw result.error;
      }
      const document = parseTodo(text);
      if (observed !== text || !current.ok) {
        observed = text;
        current = Ok(document);
        changes.send();
      }
      return document;
    }

    function* refresh(): Operation<void> {
      yield* ordered(function* () {
        try {
          yield* read();
        } catch (error) {
          if (
            !(error instanceof TodoEditError) &&
            !(error instanceof TodoSourceError) &&
            parseFilesFailure(error) === undefined
          ) {
            throw error;
          }
          const failure = error instanceof Error ? error : new Error(String(error));
          const changed = current.ok || current.error.message !== failure.message;
          current = Err(failure);
          observed = undefined;
          if (changed) {
            changes.send();
          }
        }
      });
    }

    function* commit(
      before: TodoDocument,
      next: TodoDocument,
      origin: TodoObservation["origin"],
    ): Operation<readonly TodoItem[]> {
      if (before.source === next.source) {
        return before.items;
      }
      yield* scoped(function* () {
        yield* API.Fs.around({
          writeTextFile: ([path, text], next) => issued(() => next(path, text)),
          rename: ([from, to], next) => issued(() => next(from, to)),
          remove: ([path, options], next) => issued(() => next(path, options)),
          ensureDir: ([path], next) => issued(() => next(path)),
        });
        const result = yield* API.Files.operations.writeTextFile({
          cwd: workspace,
          path: "todo.md",
          content: next.source,
        });
        if (!result.ok) {
          const failure = parseFileWriteFailure(result.error);
          if (failure?.target === "commit-unknown") {
            throw new TodoEditError(
              "todo.md replacement completion is unknown. Read its current contents before another edit.",
              { cause: result.error },
            );
          }
          throw result.error;
        }
        if (parseFileWriteSuccess(result.value) === undefined) {
          throw new FilesInvariantError("protocol");
        }
      });
      current = Ok(next);
      observed = next.source;
      pending.push(
        Object.freeze({ origin, diff: todoDiff(before.source, next.source), items: next.items }),
      );
      changes.send();
      return next.items;
    }

    const service: TodoService = {
      get current() {
        return current;
      },
      get pending() {
        return Object.freeze([...pending]);
      },
      get recovery() {
        return recovery;
      },
      changes,
      read: () => ordered(read),
      apply: (patch) =>
        ordered(function* () {
          const before = yield* read();
          return yield* commit(before, applyTodoDiff(before, patch), "sidekick");
        }),
      save: (opening, replacement) =>
        ordered(function* () {
          const before = yield* read();
          if (before.source !== opening) {
            throw new TodoEditError(
              "todo.md changed while this editor was open. Reopen the task and edit again.",
            );
          }
          return yield* commit(before, parseTodo(replacement), "human");
        }),
      refresh,
      finishPrompt(succeeded) {
        if (succeeded && prompting !== undefined) {
          pending.splice(0, prompting.length);
          recovery = false;
        } else if (!succeeded) {
          recovery = true;
        }
        prompting = undefined;
      },
      *installPrompt(): Operation<void> {
        yield* Agent.around({
          *prompt([text, options], next) {
            return resource(function* (provide) {
              const selected = [...pending];
              prompting = selected;
              let succeeded = false;
              yield* ensure(() => {
                if (!succeeded) {
                  recovery = true;
                }
              });
              const context = recovery
                ? "Current TODO checklist (fresh recovery state):\n" +
                  JSON.stringify((yield* service.read()).items)
                : selected.length === 0
                  ? ""
                  : "Committed TODO changes (in commit order):\n" +
                    JSON.stringify(selected.map(({ origin, diff }) => ({ origin, diff })));
              const stream = yield* next(context === "" ? text : text + "\n\n" + context, options);
              const subscription = yield* stream;
              yield* provide({
                *next() {
                  const event = yield* subscription.next();
                  if (event.done) {
                    succeeded = true;
                  }
                  return event;
                },
              });
            });
          },
        });
      },
    };
    yield* refresh();
    yield* spawn(function* () {
      while (true) {
        yield* sleep(250);
        yield* refresh();
      }
    });
    yield* provide(service);
  });
  yield* Todo.set(service);
  return service;
}

function issued<T>(work: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    const result = withResolvers<Result<T>>();
    const armed = withResolvers<void>();
    let started = false;
    // Native Fs operations may settle after cancellation. Their one call runs
    // in owned teardown so cancellation joins it before the Files phase advances.
    const worker = yield* spawn(function* () {
      yield* ensure(function* () {
        if (!started) {
          return;
        }
        try {
          result.resolve(Ok(yield* work()));
        } catch (error) {
          result.resolve(Err(error instanceof Error ? error : new Error(String(error))));
        }
      });
      armed.resolve();
      yield* suspend();
    });
    yield* armed.operation;
    started = true;
    yield* worker.halt();
    const settled = yield* result.operation;
    if (!settled.ok) {
      throw settled.error;
    }
    return settled.value;
  });
}
