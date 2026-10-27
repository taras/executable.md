import { ensure, Err, Ok, scoped, until, type Operation, type Result } from "effection";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AgentSessionBusy,
  AgentSessionRecoveryRequired,
  AgentSessionOwnershipError,
  agentSessionKeyDigest,
  parseAgentSessionOwnership,
  serializeAgentSessionOwnership,
} from "./agent-session-coordinator.ts";
import type {
  AgentSessionCoordinator,
  AgentSessionForceRecoveryReceipt,
  AgentSessionHost,
  AgentSessionOwnershipRecord,
} from "./agent-session-coordinator.ts";

export interface AgentSessionHostFile {
  read(bytes: Uint8Array): Promise<number | null>;
  write(bytes: Uint8Array): Promise<number>;
  tryLock(exclusive: boolean): Promise<boolean>;
  unlock(): Promise<void>;
  sync(): Promise<void>;
  close(): void;
}

export interface AgentSessionHostIO {
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<unknown>;
  open(path: string, options: Record<string, boolean | number>): Promise<AgentSessionHostFile>;
  rename(from: string, to: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
}

type HostCall = (...args: unknown[]) => unknown;
function callable(host: object, name: string): HostCall | undefined {
  const member: unknown = Reflect.get(host, name);
  if (typeof member !== "function") {
    return undefined;
  }
  return (...args) => Reflect.apply(member, host, args);
}

function file(value: unknown): AgentSessionHostFile {
  if (typeof value !== "object" || value === null) {
    throw new Error("host returned no file");
  }
  const read = callable(value, "read");
  const write = callable(value, "write");
  const tryLock = callable(value, "tryLock");
  const unlock = callable(value, "unlock");
  const sync = callable(value, "sync");
  const close = callable(value, "close");
  if (!read || !write || !tryLock || !unlock || !sync || !close) {
    throw new Error("host lacks ownership file operations");
  }
  return {
    read: (bytes) =>
      Promise.resolve(read(bytes)).then((n) => {
        if (n === null || typeof n === "number") {
          return n;
        }
        throw new Error("invalid host read");
      }),
    write: (bytes) =>
      Promise.resolve(write(bytes)).then((n) => {
        if (typeof n === "number") {
          return n;
        }
        throw new Error("invalid host write");
      }),
    tryLock: (exclusive) => Promise.resolve(tryLock(exclusive)).then((v) => v === true),
    unlock: () => Promise.resolve(unlock()).then(() => {}),
    sync: () => Promise.resolve(sync()).then(() => {}),
    close: () => {
      close();
    },
  };
}

/** Native IO is exported only here so host tests can gate the real operations. */
export function createDenoAgentSessionHostIO(): AgentSessionHostIO | undefined {
  const host: unknown = Reflect.get(globalThis, "Deno");
  if (typeof host !== "object" || host === null) {
    return undefined;
  }
  const mkdir = callable(host, "mkdir");
  const open = callable(host, "open");
  const rename = callable(host, "rename");
  const remove = callable(host, "remove");
  if (!mkdir || !open || !rename || !remove) {
    return undefined;
  }
  return {
    mkdir: (path, options) => Promise.resolve(mkdir(path, options)),
    open: (path, options) => Promise.resolve(open(path, options)).then(file),
    rename: (from, to) => Promise.resolve(rename(from, to)),
    remove: (path) => Promise.resolve(remove(path)),
  };
}

export function hasDenoAgentSessionCoordinator(): boolean {
  return createDenoAgentSessionHostIO() !== undefined;
}

function missing(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "NotFound" || Reflect.get(error, "code") === "ENOENT")
  );
}

function error(code: ConstructorParameters<typeof AgentSessionOwnershipError>[0], cause?: unknown) {
  return new AgentSessionOwnershipError(code, { cause });
}

/** Settlement stays inside the caller's resource lifetime, including late answers. */
function pending<T>(start: () => Promise<T>, adopt: (value: T) => void = () => {}): Operation<T> {
  return scoped(function* () {
    let call: Promise<Result<T>> | undefined;
    let consumed = false;
    yield* ensure(function* () {
      if (!consumed && call) {
        const result = yield* until(call);
        consumed = true;
        if (!result.ok) {
          throw result.error;
        }
        adopt(result.value);
      }
    });
    call = start().then(
      (value) => Ok(value),
      (cause: unknown) =>
        Err(cause instanceof Error ? cause : new Error("host IO failed", { cause })),
    );
    const result = yield* until(call);
    consumed = true;
    if (!result.ok) {
      throw result.error;
    }
    adopt(result.value);
    return result.value;
  });
}

const MAX_OWNERSHIP_RECORD_BYTES = 65536;
const digestPattern = /^[0-9a-f]{64}$/;
const revision = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function createDenoAgentSessionHost(root: string): AgentSessionHost | undefined {
  const io = createDenoAgentSessionHostIO();
  return io ? createAgentSessionHostFromIO(root, io) : undefined;
}

export function createDenoAgentSessionCoordinator(
  root: string,
): AgentSessionCoordinator | undefined {
  return createDenoAgentSessionHost(root)?.coordinator;
}

export function createAgentSessionHostFromIO(
  root: string,
  io: AgentSessionHostIO,
): AgentSessionHost {
  const occupied = new Set<string>();
  const leases = join(root, "leases");
  const ownership = join(root, "ownership");
  const recordPath = (digest: string) => join(ownership, `${digest}.json`);

  function read(digest: string) {
    return scoped(function* () {
      let handle: AgentSessionHostFile | undefined;
      yield* ensure(() => {
        handle?.close();
      });
      try {
        yield* pending(
          () => io.open(recordPath(digest), { read: true }),
          (value) => {
            handle = value;
          },
        );
      } catch (cause) {
        if (missing(cause)) {
          throw error("not-found");
        }
        throw error("io-failure", cause);
      }
      if (!handle) {
        throw error("io-failure");
      }
      const opened = handle;
      const bytes = new Uint8Array(MAX_OWNERSHIP_RECORD_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const n = yield* pending(() => opened.read(bytes.subarray(length)));
        if (n === null) {
          break;
        }
        if (n <= 0 || n > bytes.length - length) {
          throw error("record-invalid");
        }
        length += n;
      }
      if (length > MAX_OWNERSHIP_RECORD_BYTES) {
        throw error("record-invalid");
      }
      const raw = bytes.subarray(0, length);
      let record: AgentSessionOwnershipRecord | undefined;
      try {
        record = parseAgentSessionOwnership(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
        );
      } catch (cause) {
        throw error("record-invalid", cause);
      }
      if (!record || record.keyDigest !== digest) {
        throw error("record-invalid");
      }
      return { keyDigest: digest, recordRevision: revision(raw), record };
    });
  }

  function publish(digest: string, record: AgentSessionOwnershipRecord) {
    return scoped(function* () {
      const bytes = new TextEncoder().encode(serializeAgentSessionOwnership(record));
      if (bytes.length > MAX_OWNERSHIP_RECORD_BYTES) {
        throw error("record-invalid");
      }
      const destination = recordPath(digest);
      const staging = `${destination}.${randomUUID()}.staging`;
      let staged: AgentSessionHostFile | undefined;
      let directory: AgentSessionHostFile | undefined;
      let created = false;
      let renameStarted = false;
      let replaced = false;
      let synced = false;
      let syncStarted = false;
      let firstFailure: unknown;
      yield* ensure(function* () {
        try {
          staged?.close();
          staged = undefined;
          if (replaced && !synced && !syncStarted) {
            if (!directory) {
              yield* pending(
                () => io.open(ownership, { read: true }),
                (value) => {
                  directory = value;
                },
              );
            }
            if (!directory) {
              throw error("publication-unknown");
            }
            const opened = directory;
            syncStarted = true;
            yield* pending(
              () => opened.sync(),
              () => {
                synced = true;
              },
            );
          }
        } catch (cause) {
          if (firstFailure === undefined) {
            throw error(renameStarted ? "publication-unknown" : "io-failure", cause);
          }
        } finally {
          directory?.close();
        }
        if (created && !replaced) {
          try {
            yield* pending(() => io.remove(staging));
          } catch (cause) {
            if (!missing(cause) && firstFailure === undefined) {
              throw error("io-failure", cause);
            }
          }
        }
      });
      try {
        yield* pending(
          () => io.open(staging, { write: true, createNew: true, mode: 0o600 }),
          (value) => {
            staged = value;
            created = true;
          },
        );
        if (!staged) {
          throw error("io-failure");
        }
        const opened = staged;
        let offset = 0;
        while (offset < bytes.length) {
          const n = yield* pending(() => opened.write(bytes.subarray(offset)));
          if (n <= 0 || n > bytes.length - offset) {
            throw error("io-failure");
          }
          offset += n;
        }
        yield* pending(() => opened.sync());
        opened.close();
        staged = undefined;
        renameStarted = true;
        yield* pending(
          () => io.rename(staging, destination),
          () => {
            replaced = true;
          },
        );
        yield* pending(
          () => io.open(ownership, { read: true }),
          (value) => {
            directory = value;
          },
        );
        if (!directory) {
          throw error("publication-unknown");
        }
        const dir = directory;
        syncStarted = true;
        yield* pending(
          () => dir.sync(),
          () => {
            synced = true;
          },
        );
      } catch (cause) {
        firstFailure = cause;
        throw error(renameStarted ? "publication-unknown" : "io-failure", cause);
      }
    });
  }

  function exclusive<T>(digest: string, body: () => Operation<T>): Operation<T> {
    return scoped(function* () {
      let claimed = false;
      let handle: AgentSessionHostFile | undefined;
      let locked = false;
      yield* ensure(function* () {
        try {
          if (handle && locked) {
            const opened = handle;
            yield* pending(() => opened.unlock());
          }
        } finally {
          handle?.close();
          if (claimed) {
            occupied.delete(digest);
          }
        }
      });
      if (occupied.has(digest)) {
        throw error("busy");
      }
      occupied.add(digest);
      claimed = true;
      yield* pending(() => io.mkdir(leases, { recursive: true, mode: 0o700 }));
      yield* pending(() => io.mkdir(ownership, { recursive: true, mode: 0o700 }));
      yield* pending(
        () =>
          io.open(join(leases, `${digest}.lease`), {
            read: true,
            write: true,
            create: true,
            mode: 0o600,
          }),
        (value) => {
          handle = value;
        },
      );
      if (!handle) {
        throw error("io-failure");
      }
      const opened = handle;
      yield* pending(
        () => opened.tryLock(true),
        (value) => {
          locked = value;
        },
      );
      if (!locked) {
        throw error("busy");
      }
      return yield* body();
    });
  }

  return {
    coordinator: {
      coordinate(key, owner, body) {
        return scoped(function* () {
          const digest = agentSessionKeyDigest(key);
          try {
            return yield* exclusive(digest, function* () {
              let retained: AgentSessionOwnershipRecord | undefined;
              try {
                retained = (yield* read(digest)).record;
              } catch (cause) {
                if (!(cause instanceof AgentSessionOwnershipError) || cause.code !== "not-found") {
                  if (
                    cause instanceof AgentSessionOwnershipError &&
                    cause.code === "record-invalid"
                  ) {
                    throw new AgentSessionRecoveryRequired(
                      "the retained ownership record is invalid",
                    );
                  }
                  throw cause;
                }
              }
              if (retained?.state === "active") {
                const observed = yield* read(digest);
                return Err(
                  new AgentSessionRecoveryRequired(
                    `session ownership requires recovery; inspect with xmd session ownership --key-digest ${digest} --json; explicit recovery requires --expect ${observed.recordRevision} --force`,
                    { keyDigest: digest, recordRevision: observed.recordRevision },
                  ),
                );
              }
              const active: AgentSessionOwnershipRecord = {
                keyDigest: digest,
                state: "active",
                ownerKind: owner.kind,
                operationId: owner.operationId,
                release: "none",
                lastForcedRecovery: retained?.lastForcedRecovery ?? null,
              };
              yield* publish(digest, active);
              let quiesced = false;
              yield* ensure(function* () {
                if (quiesced) {
                  yield* publish(digest, { ...active, state: "idle", release: "quiesced" });
                }
              });
              return Ok(
                yield* body({
                  quiesced() {
                    quiesced = true;
                  },
                }),
              );
            });
          } catch (cause) {
            if (cause instanceof AgentSessionOwnershipError && cause.code === "busy") {
              return Err(new AgentSessionBusy("another live owner holds this session"));
            }
            if (cause instanceof AgentSessionOwnershipError && cause.code === "record-invalid") {
              return Err(cause);
            }
            throw cause;
          }
        });
      },
    },
    ownershipAdministration: {
      *inspectOwnership(digest) {
        if (!digestPattern.test(digest)) {
          return Err(error("record-invalid"));
        }
        try {
          return Ok(yield* read(digest));
        } catch (cause) {
          return Err(
            cause instanceof AgentSessionOwnershipError ? cause : error("io-failure", cause),
          );
        }
      },
      *forceRecoverOwnership(request) {
        if (
          request.force !== true ||
          !digestPattern.test(request.keyDigest) ||
          !digestPattern.test(request.expectedRevision)
        ) {
          return Err(error("record-invalid"));
        }
        try {
          const receipt = yield* exclusive(request.keyDigest, function* () {
            const old = yield* read(request.keyDigest);
            if (old.recordRevision !== request.expectedRevision) {
              throw error("stale-expectation");
            }
            if (old.record.state !== "active") {
              throw error("not-recovery-required");
            }
            const recoveryId = randomUUID();
            const record: AgentSessionOwnershipRecord = {
              keyDigest: request.keyDigest,
              state: "idle",
              ownerKind: old.record.ownerKind,
              operationId: old.record.operationId,
              release: "forced",
              lastForcedRecovery: {
                recoveryId,
                abandonedOwnerKind: old.record.ownerKind,
                abandonedOperationId: old.record.operationId,
                expectedRevision: request.expectedRevision,
                backendQuiescenceProved: false,
                interruptedOutcome: "unknown",
              },
            };
            yield* publish(request.keyDigest, record);
            const receipt: AgentSessionForceRecoveryReceipt = {
              keyDigest: request.keyDigest,
              previousRecordRevision: request.expectedRevision,
              recordRevision: revision(
                new TextEncoder().encode(serializeAgentSessionOwnership(record)),
              ),
              recoveryId,
              release: "forced",
              backendQuiescenceProved: false,
              interruptedOutcome: "unknown",
              providerRequestSent: false,
            };
            return receipt;
          });
          return Ok(receipt);
        } catch (cause) {
          return Err(
            cause instanceof AgentSessionOwnershipError ? cause : error("io-failure", cause),
          );
        }
      },
    },
  };
}
