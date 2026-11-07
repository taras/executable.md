/**
 * The shared session checklist, as the Plugin a `repl` command selects.
 *
 * Everything this feature needs from a session arrives through the REPL's own
 * contribution surface: the service one live logical session owns, the
 * `Sidekick.Todo` declaration both surfaces read it through, and the content
 * composition one held conversation's turns carry. Selecting the value is what
 * makes those happen — nothing here runs at selection, and a command this
 * Plugin does not declare for contributes no declaration, no documentation and
 * no service at all.
 */

import type { Operation } from "effection";
import { Plugin } from "@executablemd/core/api";
import type { PluginInstallRequest } from "@executablemd/core/api";
import type { ReplPluginInstallation } from "../../repl-api.ts";
import { installTodoDocumentation, todoDeclaration } from "./component.ts";
import { Todo, useTodo } from "./service.ts";

/**
 * Whether this Plugin answers for a command.
 *
 * Written once, because `run-profile.ts` asks it to decide the selection and
 * `install` asks it again to decide the contribution: two spellings would be
 * two answers the moment either moved.
 */
export function todoPluginDeclaresFor(command: string): boolean {
  return command === "repl";
}

/** The checklist Plugin a `repl` command runs with. */
export const todoPlugin: Plugin = Plugin({
  name: "repl-todo",
  *install(request: PluginInstallRequest): Operation<ReplPluginInstallation | undefined> {
    if (!todoPluginDeclaresFor(request.command)) {
      return undefined;
    }
    yield* installTodoDocumentation();
    return {
      repl: {
        *initialize({ workspace }): Operation<void> {
          yield* useTodo(workspace);
        },
        components: [todoDeclaration()],
        *sidekick(): Operation<void> {
          // Initialization established the service before any conversation
          // opened, so its absence here is a setup order defect rather than a
          // session without a checklist — composing nothing would hide it.
          const todo = yield* Todo.get();
          if (todo === undefined) {
            throw new Error(
              "a Sidekick conversation opened before this session's TODO service was " +
                "initialized, so there is no checklist to compose its turns from.",
            );
          }
          yield* todo.installPrompt();
        },
      },
    };
  },
});
