import { hostFileAccessReason, filesFailure, fileWriteFailure } from "@executablemd/runtime";
import type { HostFilesAccess } from "@executablemd/runtime";
import { Err } from "effection";
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
import {
  localRecordName,
  retainedResultAhead,
  recordedLocalOperation,
} from "./repositories/deno/local.ts";
import { API, Permissions } from "@executablemd/runtime";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface MountFileEntry {
  readonly files: EntryFileCalls;
  readonly policy: AwaitedMountPolicy;
}
export function workspaceMountInstallation(
  mounts: WorkspaceMountTable,
  access?: () => MountFileEntry,
  limits?: HostFilesAccess,
  ownedDirectory?: string,
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
          function* (operation, request, perform, authored): Operation<Result<ReplLocalValue>> {
            yield* policy.guard();
            if (authored !== undefined) {
              const replay = yield* policy.replay(authored, request);
              if (replay !== undefined) {
                return yield* replay;
              }
            }
            const name = yield* localRecordName({ operation, request });
            if (yield* retainedResultAhead(name)) {
              return yield* recordedLocalOperation({ operation, request, perform });
            }
            const roots = [
              ...(ownedDirectory === undefined ? [] : [ownedDirectory]),
              ...(limits === undefined ? [] : [limits.project, limits.assets, limits.components]),
            ];
            const permitted =
              roots.length === 0 ||
              ((yield* Permissions.operations.files(
                operation === "file-read" ? "read" : "write",
              )) &&
                (operation !== "dir-ensure" ||
                  !isAbsolute(request.path) ||
                  (yield* Permissions.operations.files("absolute"))));
            const reason = permitted
              ? yield* hostFileAccessReason(
                  limits,
                  operation === "file-read"
                    ? "read"
                    : operation === "file-write"
                      ? "write"
                      : operation === "file-delete"
                        ? "delete"
                        : "ensure-directory",
                  request,
                )
              : "permission-denied";
            if (reason !== undefined) {
              return Err(
                operation === "file-write"
                  ? fileWriteFailure({ phase: "resolution", reason })
                  : filesFailure({
                      operation:
                        operation === "file-read"
                          ? "read"
                          : operation === "file-delete"
                            ? "delete"
                            : "ensure-directory",
                      phase: "resolution",
                      reason,
                    }),
              );
            }
            if (roots.length > 0) {
              const directory = (yield* API.Fs.operations.realpath(request.cwd)) ?? request.cwd;
              const target = isAbsolute(request.path)
                ? resolve(
                    (yield* API.Fs.operations.realpath(dirname(request.path))) ??
                      dirname(request.path),
                    basename(request.path),
                  )
                : resolve(directory, request.path);
              for (const directory of roots) {
                const root = (yield* API.Fs.operations.realpath(directory)) ?? resolve(directory);
                const suffix = relative(root, target);
                if (
                  suffix === "" ||
                  (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep))
                ) {
                  return authored === undefined
                    ? yield* recordedLocalOperation({ operation, request, perform })
                    : yield* policy.record(authored, request, perform, {
                        kind: "existing",
                        owner: "session",
                        root,
                        target,
                      });
                }
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
