import { ensure, Err, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { readFile } from "node:fs/promises";
import { API } from "@executablemd/runtime";
import { TodoSource, TodoSourceError } from "./repl/todo/source.ts";

export function* installTodoSource(): Operation<void> {
  yield* TodoSource.set({ read: readTodoSource });
}

function readTodoSource(workspace: string): Operation<Result<string>> {
  return scoped(function* () {
    let undecodable = false;
    yield* API.Fs.around({
      readTextFile: ([path]) =>
        scoped(function* () {
          // The text helper replaces malformed UTF-8; native bytes are needed to refuse it.
          let issued: ReturnType<typeof readFile> | undefined;
          yield* ensure(function* () {
            if (issued !== undefined) {
              yield* until(issued.then(ignore, ignore));
            }
          });
          const pending = readFile(path);
          issued = pending;
          const bytes = yield* until(pending);
          try {
            return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          } catch (error) {
            undecodable = true;
            throw error;
          }
        }),
    });
    const result = yield* API.Files.operations.readTextFile({ cwd: workspace, path: "todo.md" });
    if (!result.ok && undecodable) {
      return Err(
        new TodoSourceError(
          "todo.md is not valid UTF-8. Repair its UTF-8 encoding and read it again.",
          { cause: result.error },
        ),
      );
    }
    return result;
  });
}

function ignore(): undefined {
  return undefined;
}
