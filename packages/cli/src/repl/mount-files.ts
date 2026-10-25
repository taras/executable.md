import { Ok } from "effection";
import type { Operation, Result } from "effection";
import { cwd, platform } from "@executablemd/runtime";
import type { FilePathInput } from "@executablemd/runtime";
import { DurableContext, createDurableOperation } from "@executablemd/durable-streams";
import type {
  DurableEvent,
  Json,
  LiveDurableOperationCoordinator,
} from "@executablemd/durable-streams";
import { posix, win32 } from "node:path";
import { canonicalJson } from "@executablemd/workflow";
import { admitDocumentHostPath } from "@executablemd/core/host";
import type {
  AuthoredFileOperation,
  DirectoryFrame,
  PreparedDirectory,
} from "@executablemd/core/host";
import type { WorkspaceMountTable } from "../workspace-mounts.ts";
import {
  localOperationCoordinator,
  recordedLocalOperation,
  localRecordName,
} from "./repositories/deno/local.ts";
import {
  parseReplLocalRecord,
  replLocalFingerprint,
  replLocalRecordJson,
  REPL_REPOSITORY_LOCAL,
} from "./repositories/records.ts";
import type { ReplLocalValue } from "./repositories/records.ts";
import {
  admitMountRecords,
  mountAuthored,
  mountFingerprint,
  mountName,
  mountRecordJson,
  MountRecordError,
  parseMountEnvelope,
  parseMountRecord,
  MOUNT_FILE,
} from "./mount-records.ts";
import type { MountBinding, MountCoverage, MountRecord } from "./mount-records.ts";

const coordinator: LiveDurableOperationCoordinator = {
  *run(execute, publish, activate, provenance, abandoned) {
    if (abandoned.entry !== undefined || abandoned.steppedOver) {
      throw activate(new MountRecordError());
    }
    return yield* localOperationCoordinator.run(execute, publish, activate, provenance, abandoned);
  },
};
export type AwaitedMountPolicy = ReturnType<typeof mountPolicy>;
export function* createMountPolicy(
  mounts: WorkspaceMountTable,
  directory?: string,
): Operation<AwaitedMountPolicy> {
  const captured = directory ?? (yield* cwd());
  const pathStyle = (yield* platform()).os === "win32" ? "win32" : "posix";
  return mountPolicy(mounts, captured, pathStyle);
}
export function mountPolicy(
  mounts: WorkspaceMountTable,
  directory: string,
  pathStyle: "posix" | "win32",
) {
  const host = pathStyle === "win32" ? win32 : posix;
  const root: DirectoryFrame = Object.freeze({
    authoredDirectory: directory,
    actualDirectory: directory,
    namespace: "host",
    interpreting: false,
  });
  let hasHistory = false;
  const select = (destination: string) =>
    mounts.find((pair) => destination === pair.target || destination.startsWith(pair.target + "/"));
  function prepareDirectory(
    a: AuthoredFileOperation,
    enclosing: DirectoryFrame,
  ): Result<PreparedDirectory> {
    const namespace = a.path.startsWith("/")
      ? "document"
      : /^[A-Za-z]:[\\/]/.test(a.path)
        ? "host"
        : enclosing.namespace;
    const selected = namespace === "document" ? select(a.destination) : undefined;
    const interpreting =
      namespace === "document" && (selected !== undefined || enclosing.interpreting);
    if (interpreting) {
      const actual = admitDocumentHostPath(
        pathStyle,
        a.path,
        a.namespace === "document" ? a.directory : "/",
        a.destination,
        selected?.source ?? host.parse(directory).root,
        selected?.target ?? "/",
        host,
      );
      if (!actual.ok) {
        return actual;
      }
      return Ok({
        request: Object.freeze({ cwd: enclosing.actualDirectory, path: actual.value }),
        candidate: Object.freeze({
          authoredDirectory: a.destination,
          actualDirectory: actual.value,
          namespace,
          interpreting,
          ...(selected === undefined ? {} : { selectedPair: selected }),
        }),
      });
    }
    const actual = a.path.startsWith("/")
      ? a.path
      : `${enclosing.actualDirectory.replace(/\/$/, "")}/${a.path}`;
    return Ok({
      request: Object.freeze({ cwd: enclosing.actualDirectory, path: a.path }),
      candidate: Object.freeze({
        authoredDirectory: a.destination,
        actualDirectory: actual,
        namespace,
        interpreting: false,
      }),
    });
  }
  function bindingFor(a: AuthoredFileOperation, request: FilePathInput): MountBinding | undefined {
    const selected = select(a.destination);
    if (selected === undefined) {
      return undefined;
    }
    const enclosingPair = a.namespace === "document" ? select(a.directory) : undefined;
    if (
      a.operation === "file-read" &&
      (a.namespace !== "document" ||
        enclosingPair === undefined ||
        enclosingPair.source !== selected.source ||
        enclosingPair.target !== selected.target ||
        host.isAbsolute(a.path))
    ) {
      return undefined;
    }
    const destination = admitDocumentHostPath(
      pathStyle,
      a.path,
      a.namespace === "document" ? a.directory : "/",
      a.destination,
      selected.source,
      selected.target,
      host,
    );
    if (!destination.ok) {
      return undefined;
    }
    if (enclosingPair !== undefined) {
      const enclosing = admitDocumentHostPath(
        pathStyle,
        a.directory,
        a.directory,
        a.directory,
        enclosingPair.source,
        enclosingPair.target,
        host,
      );
      if (!enclosing.ok || enclosing.value !== request.cwd) {
        return undefined;
      }
    }
    if (
      a.operation === "dir-ensure"
        ? request.path !== destination.value
        : host.resolve(request.cwd, request.path) !== destination.value
    ) {
      return undefined;
    }
    return {
      pathStyle,
      selected: { ...selected },
      enclosing: {
        authoredDirectory: a.directory,
        actualDirectory: request.cwd,
        namespace: a.namespace,
        pair: enclosingPair ?? null,
      },
      destination: { authored: a.destination, actual: destination.value },
    };
  }
  function* guard(): Operation<void> {
    const ctx = yield* DurableContext.expect();
    if (hasHistory && ctx.replayIndex.abandonedHistory(ctx.coroutineId)) {
      throw new MountRecordError();
    }
  }
  function* consume(
    expected: AuthoredFileOperation,
    record: MountRecord,
  ): Operation<Result<ReplLocalValue>> {
    const restored: unknown = yield createDurableOperation<Json>(
      { type: MOUNT_FILE, name: mountName(record) },
      function* (): Operation<Json> {
        throw new MountRecordError();
      },
      { coordinator },
    );
    const parsed = yield* parseMountRecord(restored, mountName(record));
    if (canonicalJson(parsed.authored) !== canonicalJson(mountAuthored(expected))) {
      throw new MountRecordError();
    }
    const physical = parseReplLocalRecord(parsed.physical);
    if (physical === undefined) {
      throw new MountRecordError();
    }
    return physical.outcome;
  }
  return {
    root,
    prepareDirectory,
    pathStyle,
    *admit(events: readonly DurableEvent[]): Operation<void> {
      hasHistory = events.some(
        (event) => event.type === "yield" && event.description.type.startsWith("repl_mount_file/"),
      );
      yield* admitMountRecords(events);
      for (const event of events) {
        if (
          event.type === "yield" &&
          event.description.type === MOUNT_FILE &&
          event.result.status === "ok"
        ) {
          const record = yield* parseMountRecord(event.result.value, event.description.name);
          if (record.binding.pathStyle !== pathStyle) {
            throw new MountRecordError();
          }
        }
      }
    },
    guard,
    *replay(
      a: AuthoredFileOperation,
      request: FilePathInput,
    ): Operation<Operation<Result<ReplLocalValue>> | undefined> {
      yield* guard();
      const ctx = yield* DurableContext.expect();
      const pending = ctx.replayIndex.peekYield(ctx.coroutineId);
      if (pending?.description.type === REPL_REPOSITORY_LOCAL) {
        const name = yield* localRecordName({ operation: a.operation, request });
        if (pending.description.name === name) {
          return recordedLocalOperation({
            operation: a.operation,
            request,
            perform: function* (): Operation<Result<ReplLocalValue>> {
              throw new MountRecordError();
            },
          });
        }
        const old =
          pending.result.status === "ok" ? parseReplLocalRecord(pending.result.value) : undefined;
        if (
          a.operation === "dir-ensure" &&
          old?.operation === "dir-ensure" &&
          bindingFor(a, request) !== undefined
        ) {
          throw new MountRecordError();
        }
      }
      if (pending === undefined || !pending.description.type.startsWith("repl_mount_file/")) {
        return undefined;
      }
      if (pending.description.type !== MOUNT_FILE || pending.result.status !== "ok") {
        throw new MountRecordError();
      }
      const envelope = parseMountEnvelope(pending.result.value);
      if (
        envelope.operation !== a.operation ||
        canonicalJson(envelope.authored) !== canonicalJson(mountAuthored(a)) ||
        envelope.authoredFingerprint !==
          (yield* mountFingerprint({ operation: a.operation, authored: mountAuthored(a) }))
      ) {
        throw new MountRecordError();
      }
      const record = yield* parseMountRecord(pending.result.value, pending.description.name);
      if (
        record.binding.pathStyle !== pathStyle ||
        (a.operation === "dir-ensure" &&
          !mounts.some((pair) => pair.target === record.binding.selected.target))
      ) {
        throw new MountRecordError();
      }
      return consume(a, record);
    },
    *record(
      a: AuthoredFileOperation,
      request: FilePathInput,
      perform: () => Operation<Result<ReplLocalValue>>,
      coverage: MountCoverage,
    ): Operation<Result<ReplLocalValue>> {
      yield* guard();
      const binding = bindingFor(a, request);
      if (
        binding === undefined ||
        (a.operation === "dir-ensure" && coverage.kind !== "existing") ||
        (coverage.kind === "existing" && coverage.target !== binding.destination.actual)
      ) {
        return coverage.kind === "existing"
          ? yield* recordedLocalOperation({ operation: a.operation, request, perform })
          : yield* perform();
      }
      const fingerprint = yield* mountFingerprint({
        operation: a.operation,
        authored: mountAuthored(a),
      });
      const physicalFingerprint = yield* replLocalFingerprint({ operation: a.operation, request });
      const name = mountName({ operation: a.operation, authoredFingerprint: fingerprint });
      const value: unknown = yield createDurableOperation<Json>(
        { type: MOUNT_FILE, name },
        function* () {
          const outcome = yield* perform();
          const record: MountRecord = {
            version: 1,
            operation: a.operation,
            authored: mountAuthored(a),
            authoredFingerprint: fingerprint,
            binding,
            coverage,
            physical: replLocalRecordJson({
              operation: a.operation,
              fingerprint: physicalFingerprint,
              request,
              outcome,
            }),
          };
          yield* parseMountRecord(record, name);
          return mountRecordJson(record);
        },
        { coordinator },
      );
      const parsed = yield* parseMountRecord(value, name);
      const physical = parseReplLocalRecord(parsed.physical);
      if (physical === undefined) {
        throw new MountRecordError();
      }
      return physical.outcome;
    },
  };
}
