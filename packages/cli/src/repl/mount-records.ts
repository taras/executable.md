import { Ok } from "effection";
import { parseJson } from "@executablemd/core";
import { z } from "zod";
import { posix, win32 } from "node:path";
import { canonicalJson } from "@executablemd/workflow";
import type { Operation } from "effection";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { StaleInputError } from "@executablemd/durable-streams";
import { admitDocumentHostPath, authoredOperation } from "@executablemd/core/host";
import type { AuthoredFileOperation, DirectoryFrame } from "@executablemd/core/host";
import { digest, parseReplLocalRecord, replLocalFingerprint } from "./repositories/records.ts";

export const MOUNT_FILE = "repl_mount_file/v1";
const text = z.string().min(1);
const pair = z.object({ target: text, source: text }).strict();
const namespace = z.enum(["document", "host"]);
const authored = z
  .object({
    occurrence: text,
    form: z.enum(["self-closing", "paired"]),
    path: z.string(),
    directory: text,
    namespace,
    destination: text,
  })
  .strict();
const binding = z
  .object({
    pathStyle: z.enum(["posix", "win32"]),
    selected: pair,
    enclosing: z
      .object({ authoredDirectory: text, actualDirectory: text, namespace, pair: pair.nullable() })
      .strict(),
    destination: z.object({ authored: text, actual: text }).strict(),
  })
  .strict();
const coverage = z.union([
  z.object({ kind: z.literal("external-mapped-read") }).strict(),
  z
    .object({
      kind: z.literal("existing"),
      owner: z.enum(["checkout", "session", "placement"]),
      root: text,
      target: text,
    })
    .strict(),
]);
const shape = z
  .object({
    version: z.literal(1),
    operation: z.enum(["file-read", "dir-ensure"]),
    authored,
    authoredFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    binding,
    physical: z.unknown(),
    coverage,
  })
  .strict();
export type MountBinding = z.infer<typeof binding>;
export type MountCoverage = z.infer<typeof coverage>;
export type MountRecord = z.infer<typeof shape>;
export class MountRecordError extends StaleInputError {
  override name = "MountRecordError";
  constructor() {
    super("The saved mounted filesystem operation does not describe this authored occurrence.");
  }
}
export function mountAuthored(input: AuthoredFileOperation): z.infer<typeof authored> {
  return {
    occurrence: input.occurrence,
    form: input.form,
    path: input.path,
    directory: input.directory,
    namespace: input.namespace,
    destination: input.destination,
  };
}
export function mountFingerprint(
  input: Pick<MountRecord, "operation" | "authored">,
): Operation<string> {
  return digest({ version: 1, operation: input.operation, authored: { ...input.authored } });
}
export function mountName(input: Pick<MountRecord, "operation" | "authoredFingerprint">): string {
  return canonicalJson([
    "executablemd.repl.mount-file",
    1,
    input.operation,
    input.authoredFingerprint,
  ]);
}
function within(style: "posix" | "win32", root: string, target: string): boolean {
  const host = style === "win32" ? win32 : posix;
  const relative = host.relative(root, target);
  return (
    !host.isAbsolute(relative) &&
    !relative.split(host.sep).includes("..") &&
    host.resolve(root, relative) === host.resolve(target)
  );
}
export function parseMountEnvelope(value: unknown): MountRecord {
  const parsed = shape.safeParse(value);
  if (!parsed.success) {
    throw new MountRecordError();
  }
  return parsed.data;
}
export function* parseMountRecord(value: unknown, name?: string): Operation<MountRecord> {
  const record = parseMountEnvelope(value);
  const physical = parseReplLocalRecord(record.physical);
  const b = record.binding;
  const a = record.authored;
  const host = b.pathStyle === "win32" ? win32 : posix;
  const frame: DirectoryFrame = { ...b.enclosing, interpreting: true };
  const expected = authoredOperation(record.operation, a.occurrence, a.path, frame);
  if (
    canonicalJson(mountAuthored(expected)) !== canonicalJson(a) ||
    record.authoredFingerprint !== (yield* mountFingerprint(record)) ||
    (name !== undefined && mountName(record) !== name) ||
    physical === undefined ||
    physical.operation !== record.operation ||
    physical.fingerprint !== (yield* replLocalFingerprint(physical)) ||
    b.destination.authored !== a.destination ||
    b.enclosing.namespace !== a.namespace ||
    a.form !== (record.operation === "file-read" ? "self-closing" : "paired")
  ) {
    throw new MountRecordError();
  }
  const normalizeTarget = (target: string) =>
    target.startsWith("/") &&
    !target.startsWith("//") &&
    !/[\\\0:]/.test(target) &&
    !target.split("/").includes("..") &&
    target !== "/" &&
    posix.normalize(target) === target;
  if (
    !normalizeTarget(b.selected.target) ||
    !host.isAbsolute(b.selected.source) ||
    host.resolve(b.selected.source) !== b.selected.source
  ) {
    throw new MountRecordError();
  }
  const enclosingPair = b.enclosing.pair;
  if (enclosingPair !== null) {
    if (
      !normalizeTarget(enclosingPair.target) ||
      !host.isAbsolute(enclosingPair.source) ||
      host.resolve(enclosingPair.source) !== enclosingPair.source
    ) {
      throw new MountRecordError();
    }
    const enclosing = admitDocumentHostPath(
      b.pathStyle,
      b.enclosing.authoredDirectory,
      b.enclosing.authoredDirectory,
      b.enclosing.authoredDirectory,
      enclosingPair.source,
      enclosingPair.target,
      host,
    );
    if (!enclosing.ok || enclosing.value !== b.enclosing.actualDirectory) {
      throw new MountRecordError();
    }
  }
  if (enclosingPair === null) {
    const actual =
      b.enclosing.namespace === "host"
        ? Ok(host.resolve(b.enclosing.authoredDirectory))
        : admitDocumentHostPath(
            b.pathStyle,
            b.enclosing.authoredDirectory,
            b.enclosing.authoredDirectory,
            b.enclosing.authoredDirectory,
            host.parse(b.enclosing.actualDirectory).root,
            "/",
            host,
          );
    if (!actual.ok || actual.value !== host.resolve(b.enclosing.actualDirectory)) {
      throw new MountRecordError();
    }
  }
  const actual = admitDocumentHostPath(
    b.pathStyle,
    a.path,
    a.namespace === "document" ? a.directory : "/",
    a.destination,
    b.selected.source,
    b.selected.target,
    host,
  );
  if (
    !actual.ok ||
    actual.value !== b.destination.actual ||
    physical.request.cwd !== b.enclosing.actualDirectory ||
    (record.operation === "dir-ensure"
      ? physical.request.path !== actual.value
      : physical.request.path !== a.path) ||
    (record.operation === "file-read" &&
      (a.namespace !== "document" ||
        enclosingPair === null ||
        canonicalJson(enclosingPair) !== canonicalJson(b.selected) ||
        host.isAbsolute(a.path) ||
        !within(
          b.pathStyle,
          b.enclosing.actualDirectory,
          host.resolve(b.enclosing.actualDirectory, a.path),
        ) ||
        host.resolve(b.enclosing.actualDirectory, a.path) !== actual.value))
  ) {
    throw new MountRecordError();
  }
  if (record.operation === "dir-ensure" && record.coverage.kind !== "existing") {
    throw new MountRecordError();
  }
  if (
    record.coverage.kind === "existing" &&
    (record.coverage.target !== actual.value ||
      !host.isAbsolute(record.coverage.root) ||
      !within(b.pathStyle, record.coverage.root, actual.value))
  ) {
    throw new MountRecordError();
  }
  return record;
}
export function* admitMountRecords(events: readonly DurableEvent[]): Operation<void> {
  for (const event of events) {
    if (event.type === "yield" && event.description.type.startsWith("repl_mount_file/")) {
      if (event.description.type !== MOUNT_FILE) {
        throw new MountRecordError();
      }
      if (event.result.status !== "ok") {
        throw new MountRecordError();
      }
      yield* parseMountRecord(event.result.value, event.description.name);
    }
  }
}
export function mountRecordJson(record: MountRecord): Json {
  const physical = record.physical;
  if (physical === undefined) {
    throw new MountRecordError();
  }
  return parseJson(record);
}
