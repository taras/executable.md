import { createContext } from "effection";
import type { Operation, Result } from "effection";

interface TodoSourceReader {
  read(workspace: string): Operation<Result<string>>;
}

export const TodoSource = createContext<TodoSourceReader | undefined>(
  "executablemd.cli.repl.todo.source",
  undefined,
);

export class TodoSourceError extends Error {
  override name = "TodoSourceError";
}

export function* captureTodoSource(): Operation<TodoSourceReader> {
  const source = yield* TodoSource.get();
  if (source === undefined) {
    throw new TodoSourceError("todo.md has no strict source adapter installed.");
  }
  return source;
}
