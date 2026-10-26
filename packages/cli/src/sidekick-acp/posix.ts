import { action, createSignal, ensure, resource, scoped, until, useScope } from "effection";
import type { Operation } from "effection";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdtemp, open, realpath, rmdir, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { Descriptor, MAILBOX, MAX_DESCRIPTOR, MAX_FRAME, SidekickTransport } from "./protocol.ts";
import type { Wire } from "./protocol.ts";

function useFile(
  path: string,
  flags: number | string,
  mode?: number,
  remember?: (stat: Stats) => void,
): Operation<FileHandle> {
  return resource(function* (provide) {
    let opening: Promise<FileHandle> | undefined;
    yield* ensure(function* () {
      if (opening !== undefined) {
        let file: FileHandle;
        try {
          file = yield* until(opening);
        } catch {
          return;
        }
        if (remember !== undefined) {
          yield* until(
            file
              .stat()
              .then(remember)
              .finally(() => file.close()),
          );
        } else {
          yield* until(file.close());
        }
      }
    });
    opening = open(path, flags, mode);
    yield* provide(yield* until(opening));
  });
}
function closeSocket(socket: Socket): Operation<void> {
  return action<void>((resolve) => {
    if (socket.closed) {
      resolve();
      return () => {};
    }
    const closed = () => resolve();
    socket.on("close", closed);
    socket.destroy();
    return () => socket.off("close", closed);
  });
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function* removeOwned(path: string, identity: Stats | undefined): Operation<void> {
  if (identity === undefined) {
    return;
  }
  try {
    if (same(identity, yield* until(lstat(path)))) {
      yield* until(unlink(path));
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}
function* privateDirectory(path: string, uid: number, exact: boolean): Operation<Stats> {
  if (!isAbsolute(path) || (yield* until(realpath(path))) !== resolve(path)) {
    throw new Error("The attachment directory must be absolute and contain no symlink.");
  }
  const stat = yield* until(lstat(path));
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & (exact ? 0o077 : 0o022)) !== 0) {
    throw new Error("The attachment requires an owner-controlled private directory.");
  }
  return stat;
}
function* readDescriptor(path: string, uid: number): Operation<Descriptor> {
  if (!isAbsolute(path)) {
    throw new Error("The attachment file must be absolute.");
  }
  yield* privateDirectory(dirname(path), uid, false);
  const before = yield* until(lstat(path));
  if (
    !before.isFile() ||
    before.uid !== uid ||
    (before.mode & 0o777) !== 0o600 ||
    before.size > MAX_DESCRIPTOR
  ) {
    throw new Error("The attachment file must be a private regular file of at most 16 KiB.");
  }
  // The open descriptor, rather than a second path read, fences symlink replacement.
  const text = yield* scoped(function* () {
    const file = yield* useFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const actual = yield* until(file.stat());
    if (!same(before, actual)) {
      throw new Error("The attachment file changed during its read.");
    }
    return yield* until(file.readFile({ encoding: "utf8" }));
  });
  if (
    !same(before, yield* until(lstat(path))) ||
    new TextEncoder().encode(text).length > MAX_DESCRIPTOR
  ) {
    throw new Error("The attachment file changed during its read.");
  }
  const descriptor = Descriptor.parse(JSON.parse(text));
  yield* privateDirectory(dirname(descriptor.socket), uid, true);
  const socket = yield* until(lstat(descriptor.socket));
  if (!socket.isSocket() || socket.uid !== uid || Buffer.byteLength(descriptor.socket) > 100) {
    throw new Error("The attachment socket is invalid.");
  }
  return descriptor;
}
function useWire(socket: Socket): Operation<Wire> {
  return resource(function* (provide) {
    const wake = createSignal<void, never>();
    const changed = yield* wake;
    const frames: unknown[] = [];
    let bytes = Buffer.alloc(0);
    let ended = socket.destroyed || socket.readableEnded;
    let failure: Error | undefined;
    const close = () => {
      ended = true;
      wake.send();
    };
    const failed = () => {
      failure = new Error("The attachment transport ended.");
      socket.destroy();
      close();
    };
    const data = (chunk: Uint8Array) => {
      if (ended) {
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      while (true) {
        const at = bytes.indexOf(10);
        if (at < 0) {
          break;
        }
        if (at > MAX_FRAME || frames.length >= MAILBOX) {
          failed();
          return;
        }
        try {
          frames.push(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, at))),
          );
        } catch {
          failed();
          return;
        }
        bytes = bytes.subarray(at + 1);
        wake.send();
      }
      if (bytes.length > MAX_FRAME) {
        failed();
      }
    };
    yield* ensure(() => closeSocket(socket));
    try {
      socket.on("data", data);
      socket.on("end", close);
      socket.on("close", close);
      socket.on("error", failed);
      socket.resume();
      yield* provide({
        *receive() {
          while (frames.length === 0) {
            if (failure !== undefined) {
              throw failure;
            }
            if (ended) {
              throw new Error("The attachment observer disconnected.");
            }
            yield* changed.next();
          }
          return frames.shift();
        },
        *send(frame) {
          const text = JSON.stringify(frame) + "\n";
          if (ended || Buffer.byteLength(text) > MAX_FRAME || socket.writableLength > MAX_FRAME) {
            socket.destroy();
            throw new Error("The attachment observer exceeded its output bound.");
          }
          yield* action<void>((resolve, reject) => {
            socket.write(text, (error) =>
              error ? reject(new Error("The attachment write failed.")) : resolve(),
            );
            return () => {};
          });
        },
        close() {
          socket.destroy();
        },
      });
    } finally {
      socket.off("data", data);
      socket.off("end", close);
      socket.off("close", close);
      socket.off("error", failed);
      socket.destroy();
    }
  });
}
export function* usePosixSidekickTransport(
  platform: string,
  createDirectory: (prefix: string) => Promise<string> = mkdtemp,
): Operation<void> {
  const uid = process.getuid?.();
  yield* SidekickTransport.set({
    supported: () => platform !== "win32" && uid !== undefined,
    identify: randomUUID,
    publish(path, binding) {
      return resource(function* (provide) {
        if (platform === "win32" || uid === undefined) {
          throw new Error("Sidekick ACP requires a same-user POSIX Unix socket.");
        }
        if (!isAbsolute(path)) {
          throw new Error("The attachment file must be absolute.");
        }
        yield* privateDirectory(dirname(path), uid, false);
        try {
          yield* until(lstat(path));
          throw new Error("The attachment file already exists.");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
        const acquisitions: Promise<unknown>[] = [];
        function retain<T>(pending: Promise<T>, adopt: (value: T) => void): Operation<T> {
          const owned = pending.then((value) => {
            adopt(value);
            return value;
          });
          acquisitions.push(owned);
          return until(owned);
        }
        let directory: string | undefined;
        let directoryAcquisition: Promise<string> | undefined;
        let directoryIdentity: Stats | undefined;
        let socketIdentity: Stats | undefined;
        let descriptorIdentity: Stats | undefined;
        let stage: string | undefined;
        let stageIdentity: Stats | undefined;
        let server: Server | undefined;
        const sockets = new Set<Socket>();
        const connections = yield* useScope();
        const pending: Socket[] = [];
        const wake = createSignal<void, never>();
        const changed = yield* wake;
        let listenerFailure: Error | undefined;
        const serverFailed = () => {
          listenerFailure = new Error("The attachment listener failed.");
          wake.send();
        };
        const connected = (socket: Socket) => {
          sockets.add(socket);
          connections.run(function* () {
            yield* ensure(() => closeSocket(socket));
            yield* action<void>((resolve) => {
              const closed = () => {
                const at = pending.indexOf(socket);
                if (at >= 0) {
                  pending.splice(at, 1);
                }
                resolve();
              };
              const failed = () => {
                socket.destroy();
              };
              socket.on("close", closed);
              socket.on("error", failed);
              return () => {
                socket.off("close", closed);
                socket.off("error", failed);
                sockets.delete(socket);
              };
            });
          });
          if (pending.length >= MAILBOX) {
            socket.destroy();
            return;
          }
          socket.pause();
          pending.push(socket);
          wake.send();
        };
        yield* ensure(function* () {
          yield* until(Promise.allSettled(acquisitions));
          if (directoryAcquisition !== undefined) {
            yield* until(directoryAcquisition);
          }
          for (const socket of sockets.keys()) {
            yield* closeSocket(socket);
          }
          if (server !== undefined) {
            server.off("connection", connected);
            const held = server;
            yield* action<void>((resolve) => {
              held.close(() => resolve());
              return () => {};
            });
          }
          yield* removeOwned(path, descriptorIdentity);
          if (stage !== undefined) {
            yield* removeOwned(stage, stageIdentity);
          }
          if (directory !== undefined) {
            yield* removeOwned(join(directory, "s"), socketIdentity);
            try {
              if (
                directoryIdentity !== undefined &&
                same(directoryIdentity, yield* until(lstat(directory)))
              ) {
                yield* until(rmdir(directory));
              }
            } catch (error) {
              if (
                !(
                  error instanceof Error &&
                  "code" in error &&
                  (error.code === "ENOENT" || error.code === "ENOTEMPTY")
                )
              ) {
                throw error;
              }
            }
          }
        });
        try {
          const temp = yield* until(realpath(tmpdir()));
          // Cancellation must join creation and identity before removing the owned directory.
          directoryAcquisition = createDirectory(join(temp, "xsk-")).then((created) => {
            directory = created;
            return lstat(created).then((identity) => {
              directoryIdentity = identity;
              return created;
            });
          });
          directory = yield* until(directoryAcquisition);
          yield* until(chmod(directory, 0o700));
          const socketPath = join(directory, "s");
          if (Buffer.byteLength(socketPath) > 100) {
            throw new Error("The Sidekick socket path exceeds this host's bound.");
          }
          const descriptor = Descriptor.parse({
            version: 1,
            transport: "unix",
            socket: socketPath,
            ...binding,
            cwd: yield* until(realpath(binding.cwd)),
          });
          if (Buffer.byteLength(JSON.stringify(descriptor)) > MAX_DESCRIPTOR) {
            throw new Error("The attachment descriptor exceeds 16 KiB.");
          }
          server = createServer(connected);
          server.on("error", serverFailed);
          yield* action<void>((resolve, reject) => {
            const error = () => reject(new Error("The Sidekick listener could not start."));
            server!.on("error", error);
            server!.listen(socketPath, () => resolve());
            return () => server?.off("error", error);
          });
          socketIdentity = yield* retain(lstat(socketPath), (value) => {
            socketIdentity = value;
          });
          stage = join(dirname(path), ".sidekick-" + randomUUID());
          const stagingPath = stage;
          yield* scoped(function* () {
            const file = yield* useFile(stagingPath, "wx", 0o600, (value) => {
              stageIdentity = value;
            });
            stageIdentity = yield* until(file.stat());
            yield* until(file.writeFile(JSON.stringify(descriptor)));
          });
          yield* retain(link(stage, path), () => {
            descriptorIdentity = stageIdentity;
          });
          yield* removeOwned(stage, stageIdentity);
          stageIdentity = undefined;
          yield* provide({
            descriptor,
            *accept() {
              while (pending.length === 0) {
                if (listenerFailure !== undefined) {
                  throw listenerFailure;
                }
                yield* changed.next();
              }
              const socket = pending.shift();
              if (socket === undefined) {
                throw new Error("The attachment connection ended.");
              }
              return useWire(socket);
            },
          });
        } finally {
          // Only the error handler comes off here. The connection handler is
          // what tracks an accepted socket, and this block runs before the
          // teardown below has closed the listener — so detaching it here
          // leaves a window in which the listener still accepts a peer that
          // nothing tracks or destroys, and `close()` then waits for a socket
          // no owner holds. That teardown takes it off synchronously, in the
          // statement before `close()`.
          server?.off("error", serverFailed);
        }
      });
    },
    connect(path) {
      return resource(function* (provide) {
        if (platform === "win32" || uid === undefined) {
          throw new Error("Sidekick ACP requires a same-user POSIX Unix socket.");
        }
        const descriptor = yield* readDescriptor(path, uid);
        let socket: Socket | undefined;
        yield* ensure(function* () {
          if (socket !== undefined) {
            yield* closeSocket(socket);
          }
        });
        socket = createConnection(descriptor.socket);
        try {
          const wire = yield* useWire(socket);
          yield* provide({ descriptor, wire });
        } finally {
          socket.destroy();
        }
      });
    },
    stdio() {
      return resource(function* (provide) {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        let finished = false;
        const flowing = process.stdin.readableFlowing;
        const input = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
          cancel() {
            finished = true;
          },
        });
        const output = new WritableStream<Uint8Array>({
          write(bytes) {
            return new Promise<void>((resolve, reject) => {
              process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
            });
          },
        });
        const data = (bytes: Uint8Array) => {
          if (!finished) {
            controller?.enqueue(new Uint8Array(bytes));
          }
        };
        const end = () => {
          finished = true;
          try {
            controller?.close();
          } catch {
            /* already closed */
          }
        };
        const error = () => {
          finished = true;
          try {
            controller?.error(new Error("Protocol input failed."));
          } catch {
            /* already closed */
          }
        };
        try {
          process.stdin.on("data", data);
          process.stdin.on("end", end);
          process.stdin.on("error", error);
          yield* provide({ input, output });
        } finally {
          finished = true;
          process.stdin.off("data", data);
          process.stdin.off("end", end);
          process.stdin.off("error", error);
          if (flowing !== true) {
            process.stdin.pause();
          }
        }
      });
    },
  });
}
