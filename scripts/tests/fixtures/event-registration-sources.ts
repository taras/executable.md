/** One unpaired subscription per source family the rule recognizes. */
import type { Operation } from "effection";
import { EventEmitter } from "node:events";
import { spawn as spawnChild } from "node:child_process";
import { createServer as createNetServer, connect } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import process from "node:process";

const handle = () => {};

export function* fromAConstructor(): Operation<void> {
  const emitter = new EventEmitter();
  emitter.on("ready", handle);
}

export function* fromAFactory(): Operation<void> {
  const server = createNetServer();
  server.on("connection", handle);
}

export function* fromAConnection(): Operation<void> {
  const socket = connect(1234, "localhost");
  socket.on("data", handle);
}

export function* fromAnHttpServer(): Operation<void> {
  const server = createHttpServer();
  server.on("request", handle);
}

export function* fromAChildStream(): Operation<void> {
  const child = spawnChild("cat", []);
  child.stdout.on("data", handle);
}

export function* fromAStream(): Operation<void> {
  const stream = new PassThrough();
  stream.on("data", handle);
}

export function* fromAnAlias(): Operation<void> {
  const emitter = new EventEmitter();
  const alias = emitter;
  alias.on("ready", handle);
}

export function* fromAnAnnotatedParameter(request: IncomingMessage): Operation<void> {
  request.on("data", handle);
}

export function* fromAnAnnotatedReadable(stream: Readable): Operation<void> {
  stream.on("data", handle);
}

export function* fromTheProcessGlobal(): Operation<void> {
  process.on("SIGINT", handle);
}

export function* fromAProcessStream(): Operation<void> {
  process.stdin.on("data", handle);
}

class Bus extends EventEmitter {
  *listen(): Operation<void> {
    this.on("ready", handle);
  }
}

export const bus = new Bus();

export function* fromAnEmitterSubclass(): Operation<void> {
  const own = new Bus();
  own.on("ready", handle);
}

/** A structural surface the file declares, paired the way the policy requires. */
export interface InputStream {
  on(event: "data", listener: () => void): unknown;
  off(event: "data", listener: () => void): unknown;
}

export function* fromAStructuralInterface(stream: InputStream): Operation<void> {
  stream.on("data", handle);
}

export function* fromAnXhr(): Operation<void> {
  const request = new XMLHttpRequest();
  request.addEventListener("load", handle);
}

export function* fromAnAbortSignal(): Operation<void> {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", handle);
}

export function* fromADomGlobal(): Operation<void> {
  globalThis.addEventListener("unhandledrejection", handle);
}

export function* fromAWorker(): Operation<void> {
  const worker = new Worker("./worker.js");
  worker.addEventListener("message", handle);
}
