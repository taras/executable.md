import { admitReplRepositoryHistory } from "./repositories/admission.ts";
import { cwd } from "@executablemd/runtime";
import type { Operation, Result } from "effection";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type { DurableEvent } from "@executablemd/durable-streams";
import { posix, win32 } from "node:path";
import type { WorkspaceMountTable } from "../workspace-mounts.ts";
import { useEntryFileRecorder } from "./file-recorder.ts";
import type { EntryFileCalls } from "./file-recorder.ts";
import { createMountPolicy } from "./mount-files.ts";
import type { AwaitedMountPolicy } from "./mount-files.ts";
import { recordedLocalOperation } from "./repositories/deno/local.ts";
import type { ReplLocalValue } from "./repositories/records.ts";
import { MountRecordError } from "./mount-records.ts";

export interface MountFileEntry {
  readonly files: EntryFileCalls;
  readonly policy: AwaitedMountPolicy;
}
export function workspaceMountInstallation(
  mounts: WorkspaceMountTable,
  workspace?: string,
  access?: () => MountFileEntry,
): ExecutionInstallation {
  mounts = Object.freeze(mounts.map((pair) => Object.freeze({ ...pair })));
  let entry: MountFileEntry | undefined;
  return {
    admissions: [
      function* (events: readonly DurableEvent[]) {
        if (entry === undefined) {
          throw new MountRecordError();
        }
        if (access === undefined) {
          yield* admitReplRepositoryHistory(events);
        }
        yield* entry.policy.admit(events);
      },
    ],
    *filesystem(deliver) {
      if (access !== undefined) {
        entry = access();
      } else {
        const directory = yield* cwd();
        const policy = yield* createMountPolicy(mounts, directory);
        const files = yield* useEntryFileRecorder(
          function* (operation, request, perform, authored): Operation<Result<ReplLocalValue>> {
            yield* policy.guard();
            if (authored !== undefined) {
              const replay = yield* policy.replay(authored, request);
              if (replay !== undefined) {
                return yield* replay;
              }
            }
            const host = policy.pathStyle === "win32" ? win32 : posix;
            const target = host.resolve(request.cwd, request.path);
            const relative = workspace === undefined ? undefined : host.relative(workspace, target);
            const covered =
              relative !== undefined &&
              !host.isAbsolute(relative) &&
              !relative.split(host.sep).includes("..");
            if (authored !== undefined) {
              return yield* policy.record(
                authored,
                request,
                perform,
                covered && workspace !== undefined
                  ? { kind: "existing", owner: "session", root: workspace, target }
                  : { kind: "external-mapped-read" },
              );
            }
            return covered
              ? yield* recordedLocalOperation({ operation, request, perform })
              : yield* perform();
          },
        );
        entry = { files, policy };
      }
      const held = entry;
      deliver({
        root: held.policy.root,
        prepareDirectory: held.policy.prepareDirectory,
        *read(authored, request) {
          return yield* held.files.read(authored, request);
        },
        *ensure(authored, request) {
          return yield* held.files.ensure(authored, request);
        },
      });
    },
  };
}
