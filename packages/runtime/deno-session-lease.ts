/**
 * The Deno advisory-lock implementation of the session lease.
 *
 * Installed by the Deno source and compiled entrypoints only. It is the same
 * crash-safety choice the workflow executor already makes, taken asynchronously
 * and at a runtime-named boundary: exclusivity is the kernel's, so a process
 * that dies — however it dies — releases its lease, while a durable route it
 * published stays authoritative for replay.
 *
 * The sidecar is empty and is never unlinked. Deleting it would let a second
 * process create a fresh file and lock that instead, which is two owners
 * holding two locks on one name; leaving it costs an empty file per session.
 * It holds no identity, path, instruction or transcript — the name is a digest
 * the caller supplies, and the contents are nothing at all.
 */

import { ensure, type Operation, resource, until } from "effection";
import { join } from "node:path";
import { SessionLease } from "./session-lease.ts";
import type { SessionLeaseOutcome } from "./session-lease.ts";

/**
 * The advisory-lock surface this adapter needs from its host.
 *
 * Named and parsed rather than imported, because this module is part of a
 * package Node and Bun also load. Reading the shape off the global and
 * checking it means an unsupported host installs nothing, instead of failing
 * on an import of a module that is not there.
 */
type HostCall = (...args: unknown[]) => unknown;

interface LeaseFile {
  tryLock(exclusive: boolean): Promise<unknown>;
  unlock(): Promise<unknown>;
  close(): void;
}

interface LeaseRuntime {
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<unknown>;
  open(
    path: string,
    options: { read: boolean; write: boolean; create: boolean; mode: number },
  ): Promise<unknown>;
}

/** One of the host's methods, bound to it, or nothing when it has no such method. */
function callable(host: object, name: string): HostCall | undefined {
  const member: unknown = Reflect.get(host, name);
  if (typeof member !== "function") {
    return undefined;
  }
  return (...args) => Reflect.apply(member, host, args);
}

/** The lease surface of an open file, or nothing when the host has none. */
function leaseFile(value: unknown): LeaseFile | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const tryLock = callable(value, "tryLock");
  const unlock = callable(value, "unlock");
  const close = callable(value, "close");
  if (!tryLock || !unlock || !close) {
    return undefined;
  }
  return {
    tryLock: (exclusive) => Promise.resolve(tryLock(exclusive)),
    unlock: () => Promise.resolve(unlock()),
    close: () => {
      close();
    },
  };
}

function leaseRuntime(): LeaseRuntime | undefined {
  if (!Reflect.has(globalThis, "Deno")) {
    return undefined;
  }
  const host: unknown = Reflect.get(globalThis, "Deno");
  if (typeof host !== "object" || host === null) {
    return undefined;
  }
  const mkdir = callable(host, "mkdir");
  const open = callable(host, "open");
  if (!mkdir || !open) {
    return undefined;
  }
  return {
    mkdir: (path, options) => Promise.resolve(mkdir(path, options)),
    open: (path, options) => Promise.resolve(open(path, options)),
  };
}

/** Whether this host can take a kernel-released advisory lock. */
export function hasDenoSessionLease(): boolean {
  return leaseRuntime() !== undefined;
}

/**
 * Install the advisory lease, resolving sidecars beneath `coordinatorRoot`.
 *
 * A host that is not Deno installs nothing, so the contextual default stands
 * and every client-native path refuses rather than proceeding unprotected.
 *
 * `@effectionx/fs` creates directories without a mode, and this one shares a
 * namespace with the durable route records, so the host primitive is adapted
 * here rather than leaving the coordinator root readable to other accounts.
 */
export function* installDenoSessionLease(coordinatorRoot: string): Operation<void> {
  const runtime = leaseRuntime();
  if (!runtime) {
    return;
  }
  yield* SessionLease.around({
    acquire([key]) {
      return resource<SessionLeaseOutcome>(function* (provide) {
        const directory = join(coordinatorRoot, "leases");
        yield* until(runtime.mkdir(directory, { recursive: true, mode: 0o700 }));
        const opened = yield* until(
          runtime.open(join(directory, `${key}.lease`), {
            read: true,
            write: true,
            create: true,
            mode: 0o600,
          }),
        );
        const file = leaseFile(opened);
        if (!file) {
          throw new Error("this host opened a file with no advisory-lock operations");
        }
        // Registered before the lock is taken: a halt between acquiring and
        // registering would leak the descriptor and, with it, the lock.
        let locked = false;
        yield* ensure(function* () {
          if (locked) {
            yield* until(file.unlock());
          }
          file.close();
        });

        locked = (yield* until(file.tryLock(true))) === true;
        yield* provide(locked ? "acquired" : "busy");
      });
    },
  });
}
