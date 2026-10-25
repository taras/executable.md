import { Err, Ok, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { API, fileWriteSuccess, filesFailure } from "@executablemd/runtime";
import type { FilePathInput } from "@executablemd/runtime";
import { collect, Elicitation, inlineSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { DurableStream } from "@executablemd/durable-streams";
import { workspaceMountInstallation } from "../../src/repl/workspace-mount-installation.ts";
import type { WorkspaceMountTable } from "../../src/workspace-mounts.ts";

export interface MountTrace {
  reads: FilePathInput[];
  ensures: FilePathInput[];
  writes: unknown[];
  deletes: unknown[];
}
export const trace = (): MountTrace => ({ reads: [], ensures: [], writes: [], deletes: [] });
export function mountedRun(
  source: string,
  stream: DurableStream,
  mounts: WorkspaceMountTable,
  calls: MountTrace,
  options: {
    pause?: boolean;
    workspace?: string;
    refuseEnsure?: boolean;
    onRead?: (request: FilePathInput) => string;
    before?: () => Operation<void>;
  } = {},
): Operation<string> {
  return scoped(function* () {
    yield* API.Env.around(
      {
        *cwd() {
          return "/host";
        },
      },
      { at: "min" },
    );
    yield* API.Files.around(
      {
        *checkFilePath() {
          return Ok(undefined);
        },
        *readTextFile([input]) {
          calls.reads.push({ ...input });
          return Ok(options.onRead?.(input) ?? `${input.cwd}/${input.path}`);
        },
        *ensureDirectory([input]) {
          calls.ensures.push({ ...input });
          return options.refuseEnsure
            ? Err(
                filesFailure({
                  operation: "ensure-directory",
                  phase: "access",
                  reason: "permission-denied",
                }),
              )
            : Ok(undefined);
        },
        *writeTextFile([input]) {
          calls.writes.push({ ...input });
          return Ok(fileWriteSuccess("host-committed"));
        },
        *deleteFile([input]) {
          calls.deletes.push({ ...input });
          return Ok(undefined);
        },
        *globFiles() {
          return Ok([]);
        },
      },
      { at: "min" },
    );
    const paused = withResolvers<void>();
    yield* Elicitation.around({
      *elicit() {
        if (options.pause) {
          paused.resolve();
          return yield* suspend();
        }
        return {};
      },
    });
    if (options.before !== undefined) {
      yield* options.before();
    }
    const execution = yield* executeInstalled({ ...inlineSource(source), includes: [], stream }, [
      workspaceMountInstallation(mounts, options.workspace),
    ]);
    if (options.pause) {
      yield* spawn(() => collect(execution));
      yield* paused.operation;
      return "paused";
    }
    return String(yield* collect(execution));
  });
}
