/**
 * The Deno implementation of session ownership.
 *
 * Constructed at a runtime-named boundary and handed to a provider by the host
 * that built it. Shared modules never reach for it, and never ask what runtime
 * they are on.
 *
 * Exclusivity is the kernel's, and durability is the filesystem's, because the
 * two questions are different. The advisory lock answers "is another live
 * process in this session right now", which a crash correctly ends. The
 * ownership record answers "did the last owner prove it stopped", which a crash
 * must *not* end — so the record is written active before any provider work and
 * replaced with idle only after the body acknowledges quiescence. A process
 * that dies in between releases the lock and leaves the active record, and the
 * next owner refuses rather than inferring safety from a pid, an elapsed time,
 * an empty transcript, or the lock being free.
 *
 * A process-local occupancy table sits in front of both. Advisory locks are
 * per-process on some hosts, so two provider scopes in one process could
 * otherwise both believe they hold the same session.
 */

import { ensure, Err, Ok, type Operation, scoped, until } from "effection";
import type { Result } from "effection";
import { join } from "node:path";
import {
  AgentSessionBusy,
  agentSessionKeyDigest,
  AgentSessionRecoveryRequired,
  parseAgentSessionOwnership,
  serializeAgentSessionOwnership,
} from "./agent-session-coordinator.ts";
import type {
  AgentSessionCoordinator,
  AgentSessionKey,
  AgentSessionOwner,
  AgentSessionOwnership,
  AgentSessionOwnershipRecordV1,
} from "./agent-session-coordinator.ts";

type HostCall = (...args: unknown[]) => unknown;

/** One of the host's methods, bound to it, or nothing when it has none. */
function callable(host: object, name: string): HostCall | undefined {
  const member: unknown = Reflect.get(host, name);
  if (typeof member !== "function") {
    return undefined;
  }
  return (...args) => Reflect.apply(member, host, args);
}

/**
 * The filesystem surface this adapter needs, read off the host rather than
 * imported, so the module stays loadable where it is never constructed.
 */
interface CoordinatorHost {
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<unknown>;
  open(path: string, options: Record<string, boolean | number>): Promise<unknown>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string, options: { mode: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
}

interface HostFile {
  tryLock(exclusive: boolean): Promise<unknown>;
  unlock(): Promise<unknown>;
  sync(): Promise<unknown>;
  close(): void;
}

function hostFile(value: unknown): HostFile | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const tryLock = callable(value, "tryLock");
  const unlock = callable(value, "unlock");
  const sync = callable(value, "sync");
  const close = callable(value, "close");
  if (!tryLock || !unlock || !sync || !close) {
    return undefined;
  }
  return {
    tryLock: (exclusive) => Promise.resolve(tryLock(exclusive)),
    unlock: () => Promise.resolve(unlock()),
    sync: () => Promise.resolve(sync()),
    close: () => {
      close();
    },
  };
}

function coordinatorHost(): CoordinatorHost | undefined {
  if (!Reflect.has(globalThis, "Deno")) {
    return undefined;
  }
  const host: unknown = Reflect.get(globalThis, "Deno");
  if (typeof host !== "object" || host === null) {
    return undefined;
  }
  const names = ["mkdir", "open", "readTextFile", "writeTextFile", "rename", "remove"] as const;
  const calls: Record<string, HostCall> = {};
  for (const name of names) {
    const call = callable(host, name);
    if (!call) {
      return undefined;
    }
    calls[name] = call;
  }
  return {
    mkdir: (path, options) => Promise.resolve(calls.mkdir!(path, options)),
    open: (path, options) => Promise.resolve(calls.open!(path, options)),
    readTextFile: (path) =>
      Promise.resolve(calls.readTextFile!(path)).then((value: unknown) => String(value)),
    writeTextFile: (path, data, options) =>
      Promise.resolve(calls.writeTextFile!(path, data, options)),
    rename: (from, to) => Promise.resolve(calls.rename!(from, to)),
    remove: (path) => Promise.resolve(calls.remove!(path)),
  };
}

/** Whether this host can coordinate agent sessions at all. */
export function hasDenoAgentSessionCoordinator(): boolean {
  return coordinatorHost() !== undefined;
}

function isMissing(cause: unknown): boolean {
  return (
    (typeof cause === "object" && cause !== null && Reflect.get(cause, "code") === "ENOENT") ||
    (cause instanceof Error && cause.name === "NotFound")
  );
}

/**
 * Build the coordinator rooted at `root`.
 *
 * Returns nothing on a host with no such filesystem: a host that cannot answer
 * the ownership question installs no coordinator, and every advertised
 * provider-returned operation refuses.
 */
export function createDenoAgentSessionCoordinator(
  root: string,
): AgentSessionCoordinator | undefined {
  const found = coordinatorHost();
  if (!found) {
    return undefined;
  }
  const host: CoordinatorHost = found;
  // Sibling provider scopes in one process contend here before they contend in
  // the kernel, because an advisory lock does not always separate them.
  const occupied = new Set<string>();

  function* readOwnership(path: string): Operation<AgentSessionOwnershipRecordV1 | undefined> {
    const text = yield* until(
      host.readTextFile(path).catch((cause: unknown) => {
        if (isMissing(cause)) {
          return undefined;
        }
        throw cause;
      }),
    );
    if (text === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AgentSessionRecoveryRequired(
        "the retained agent session ownership record is not readable",
      );
    }
    const record = parseAgentSessionOwnership(parsed);
    if (!record) {
      throw new AgentSessionRecoveryRequired(
        "the retained agent session ownership record is not valid",
      );
    }
    return record;
  }

  /**
   * Replace the ownership record durably.
   *
   * Written whole, flushed, renamed over the destination, and the directory
   * flushed behind it — so a reader sees the old record or the new one, and a
   * crash cannot leave a half-written state that parses as something weaker.
   */
  function* publish(
    directory: string,
    destination: string,
    record: AgentSessionOwnershipRecordV1,
  ): Operation<void> {
    const staging = `${destination}.${record.operationId}.staging`;
    yield* until(
      host.writeTextFile(staging, serializeAgentSessionOwnership(record), { mode: 0o600 }),
    );
    const staged = hostFile(yield* until(host.open(staging, { read: true })));
    if (staged) {
      yield* until(staged.sync());
      staged.close();
    }
    yield* until(host.rename(staging, destination));
    const opened = hostFile(yield* until(host.open(directory, { read: true })));
    if (opened) {
      yield* until(opened.sync());
      opened.close();
    }
  }

  return {
    coordinate<T>(
      key: AgentSessionKey,
      owner: AgentSessionOwner,
      body: (ownership: AgentSessionOwnership) => Operation<T>,
    ): Operation<Result<T>> {
      // Scoped, not a resource: ownership has to end when the body ends. A
      // resource acquired in the caller's scope would hold the lock and the
      // active record until *that* scope closed, which is a different — and
      // much longer — lifetime than the work it protects.
      return scoped(function* (): Operation<Result<T>> {
        const digest = agentSessionKeyDigest(key);
        const leases = join(root, "leases");
        const ownership = join(root, "ownership");
        yield* until(host.mkdir(leases, { recursive: true, mode: 0o700 }));
        yield* until(host.mkdir(ownership, { recursive: true, mode: 0o700 }));
        const record = join(ownership, `${digest}.json`);

        if (occupied.has(digest)) {
          return Err(busy(key));
        }
        occupied.add(digest);
        yield* ensure(() => {
          occupied.delete(digest);
        });

        // Opened for the ownership scope and never unlinked: deleting it would
        // let a second process create a fresh file and lock that instead.
        const opened = hostFile(
          yield* until(
            host.open(join(leases, `${digest}.lease`), {
              read: true,
              write: true,
              create: true,
              mode: 0o600,
            }),
          ),
        );
        if (!opened) {
          throw new Error("this host opened a file with no advisory-lock operations");
        }
        let locked = false;
        yield* ensure(function* () {
          if (locked) {
            yield* until(opened.unlock());
          }
          opened.close();
        });
        locked = (yield* until(opened.tryLock(true))) === true;
        if (!locked) {
          return Err(busy(key));
        }

        const retained = yield* readOwnership(record);
        if (retained?.state === "active") {
          // The lock is free and the record is not. Whoever held it last never
          // said it had stopped, and nothing here can say it for them.
          return Err(
            new AgentSessionRecoveryRequired(
              `session "${key.sessionKey}" was left owned by an XMD process that did not ` +
                `finish. Nothing here can prove that owner stopped, so it stays owned until ` +
                `it is recovered deliberately.`,
            ),
          );
        }

        const active: AgentSessionOwnershipRecordV1 = {
          schema: "agent-session-ownership.v1",
          keyDigest: digest,
          state: "active",
          ownerKind: owner.kind,
          operationId: owner.operationId,
        };
        yield* publish(ownership, record, active);

        let quiesced = false;
        // Registered before the body runs, so an idle record is published on
        // every ordinary exit — and on none of the others.
        yield* ensure(function* () {
          if (!quiesced) {
            return;
          }
          yield* publish(ownership, record, { ...active, state: "idle" });
        });

        return Ok(
          yield* body({
            quiesced() {
              quiesced = true;
            },
          }),
        );
      });
    },
  };
}

function busy(key: AgentSessionKey): AgentSessionBusy {
  return new AgentSessionBusy(
    `another XMD owner is using session "${key.sessionKey}" — a native UI or a turn in ` +
      `another process holds it. Run this again once that owner exits.`,
  );
}
