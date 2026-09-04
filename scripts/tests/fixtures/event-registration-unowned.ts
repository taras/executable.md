/**
 * Listeners whose lifetime is the process or the page, installed where no
 * Effection scope owns them. A standalone fixture program lives exactly as
 * long as its listeners do; there is nothing to release them from.
 */
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import process from "node:process";

const handle = () => {};

process.on("SIGINT", handle);
globalThis.addEventListener("unhandledrejection", handle);

export function serveForTheProcessLifetime() {
  const server = createServer();
  server.on("connection", handle);
  return server;
}

export function waitForReady(emitter: EventEmitter): Promise<void> {
  return new Promise((resolve) => {
    emitter.on("ready", () => resolve());
  });
}

export function subscribeForThePageLifetime() {
  const target = new EventTarget();
  target.addEventListener("ready", handle);
}
