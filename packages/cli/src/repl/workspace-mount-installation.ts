import { admitReplRepositoryHistory } from "./repositories/admission.ts";
import { cwd } from "@executablemd/runtime";
import type { Operation, Result } from "effection";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { WorkspaceMountTable } from "../workspace-mounts.ts";
import { useEntryFileRecorder } from "./file-recorder.ts";
import type { EntryFileCalls } from "./file-recorder.ts";
import { createMountPolicy } from "./mount-files.ts";
import type { AwaitedMountPolicy } from "./mount-files.ts";
import type { ReplLocalValue } from "./repositories/records.ts";

export interface MountFileEntry {
  readonly files: EntryFileCalls;
  readonly policy: AwaitedMountPolicy;
}
export function workspaceMountInstallation(
  mounts: WorkspaceMountTable,
  access?: () => MountFileEntry,
): ExecutionInstallation {
  mounts = Object.freeze(mounts.map((pair) => Object.freeze({ ...pair })));
  let entry: MountFileEntry | undefined;
  return {
    admissions: [
      function* (events: readonly DurableEvent[]) {
        if (access === undefined || entry === undefined) {
          yield* admitReplRepositoryHistory(events);
        }
        if (entry !== undefined) {
          yield* entry.policy.admit(events);
        }
      },
    ],
    *filesystem(deliver) {
      if (access !== undefined) {
        entry = access();
      } else {
        const directory = yield* cwd();
        const policy = yield* createMountPolicy(mounts, directory);
        const files = yield* useEntryFileRecorder(
          function* (_operation, request, perform, authored): Operation<Result<ReplLocalValue>> {
            yield* policy.guard();
            if (authored !== undefined) {
              const replay = yield* policy.replay(authored, request);
              if (replay !== undefined) {
                return yield* replay;
              }
            }
            if (authored !== undefined) {
              return yield* policy.record(authored, request, perform, {
                kind: "external-mapped-read",
              });
            }
            return yield* perform();
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
