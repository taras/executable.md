#!/usr/bin/env node
const fs = require("node:fs/promises");

const [method, identity, logPath] = process.argv.slice(2);
let buffer = "";
let previous = Promise.resolve();

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function handle(request) {
  return fs
    .appendFile(logPath, JSON.stringify({ pid: process.pid, ...request }) + "\n")
    .then(() => {
      if (request.id === undefined) {
        return;
      }
      if (request.method === "initialize") {
        reply(request.id, {
          protocolVersion: request.params.protocolVersion,
          agentCapabilities: {
            loadSession: method === "load",
            sessionCapabilities: method === "resume" ? { resume: {} } : {},
            promptCapabilities: {},
          },
          authMethods: [],
        });
        return;
      }
      if (request.method === "session/" + method) {
        reply(request.id, identity === "absent" ? {} : { _meta: { agentSessionId: identity } });
        return;
      }
      if (request.method === "session/prompt") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: request.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "continued" },
            },
          },
        });
        reply(request.id, { stopReason: "end_turn" });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "unsupported fixture operation" },
      });
    });
}

function failed(error) {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
  stop();
}

function data(chunk) {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) {
      const request = JSON.parse(line);
      previous = previous.then(() => handle(request)).catch(failed);
    }
    index = buffer.indexOf("\n");
  }
}

function stop() {
  process.stdin.off("data", data);
  process.stdin.off("end", stop);
  process.stdin.pause();
}

process.stdin.on("data", data);
process.stdin.on("end", stop);
