import {
  content,
  formDispatcher,
  parseJson,
  packageDocumentation,
  contributeDocumentation,
} from "@executablemd/core";
import type { FunctionComponent, FunctionComponentDefinition, Json } from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import { createDurableOperation } from "@executablemd/durable-streams";
import { Err, Ok } from "effection";
import type { Operation } from "effection";
import type { ControlJournal, SidekickControl } from "../sidekick/controls.ts";
import { Todo } from "./service.ts";
import { TodoEditError } from "./document.ts";

const RETURNS = {
  type: "array",
  items: {
    type: "object",
    properties: { text: { type: "string" }, completed: { type: "boolean" } },
    required: ["text", "completed"],
    additionalProperties: false,
  },
};

const GENERATED = {
  "self-closing": {
    identity: "https://executable.md/components/repl/sidekick/todo/read",
    effect: "read",
  },
  paired: {
    identity: "https://executable.md/components/repl/sidekick/todo/write",
    effect: "write",
  },
} as const;

export function todoDeclaration(journal?: ControlJournal): IdentityComponent {
  return {
    name: "Sidekick.Todo",
    origin: "@executablemd/cli:repl/todo",
    props: { type: "object", properties: {}, additionalProperties: false },
    returns: RETURNS,
    forms: ["self-closing", "paired"],
    generated: GENERATED,
    description:
      'Read your session checklist with `<Sidekick.Todo as="items" />`. Apply a matching unified diff in its content to edit the same checklist.',
    as: "Required. Captures ordered items with text and completed fields.",
    context: "One fenced unified diff for todo.md.",
    factory: (claim) => todoBody(claim, journal),
  };
}

function todoBody(claim: IdentityClaimant, journal?: ControlJournal): FunctionComponent {
  function body(edit: boolean): FunctionComponent {
    return function* (_props, invocation): Operation<Json> {
      const name = yield* claim(invocation);
      const patch = edit ? patchBody(yield* content()) : undefined;
      const stored = yield createDurableOperation<Json>(
        { type: "session_todo", name, ...(patch === undefined ? {} : { diff: patch }) },
        function* () {
          const service = yield* Todo.get();
          if (service === undefined) {
            throw new TodoEditError("Sidekick.Todo requires an initialized live REPL session.");
          }
          const order =
            journal === undefined
              ? undefined
              : yield* journal.began({
                  component: "Sidekick.Todo",
                  arguments: patch === undefined ? {} : { diff: patch },
                });
          try {
            const items =
              patch === undefined ? (yield* service.read()).items : yield* service.apply(patch);
            const value = parseJson(items);
            if (journal !== undefined && order !== undefined) {
              yield* journal.settled(order, Ok(value), value);
            }
            return value;
          } catch (error) {
            if (journal !== undefined && order !== undefined) {
              yield* journal.settled(
                order,
                Err(error instanceof Error ? error : new Error(String(error))),
              );
            }
            throw error;
          }
        },
      );
      return parseJson(stored);
    };
  }
  return formDispatcher({ forms: "both", "self-closing": body(false), paired: body(true) });
}

function patchBody(source: string): string {
  const match = /^\s*(`{3,}|~{3,})(?:diff|patch)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*\s*$/.exec(
    source,
  );
  if (match === null || /^\s*(?:`{3,}|~{3,})/m.test(match[2])) {
    throw new TodoEditError("Sidekick.Todo requires exactly one fenced unified diff for todo.md.");
  }
  return match[2] + "\n";
}

export function todoControls(journal: ControlJournal): readonly SidekickControl[] {
  const declared = todoDeclaration(journal);
  const definition: FunctionComponentDefinition = {
    ...declared,
    kind: "function",
    fn: declared.factory(function* () {
      throw new TodoEditError("This descriptive Todo definition is not an execution.");
    }),
  };
  return [
    { name: declared.name, form: "self-closing", effect: "read", definition },
    { name: declared.name, form: "paired", effect: "write", definition },
  ];
}

export function* installTodoDocumentation(): Operation<void> {
  yield* contributeDocumentation(function* (read) {
    return yield* packageDocumentation(
      new URL("../../documents/sidekick/todo-components.md", import.meta.url),
      {
        owner: "@executablemd/cli:repl/todo",
        asset: "packages/cli/src/documents/sidekick/todo-components.md",
      },
      [todoDeclaration().name],
      read,
    );
  });
}
