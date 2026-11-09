#!/usr/bin/env node
/**
 * A minimal ACP agent that records every request it receives.
 *
 * Enough of the protocol for ACPX to create, load and prompt one session; each
 * request's method and params are appended to `WIRE_LOG`, so a case can state
 * exactly which metadata reached the agent on `session/new` and `session/load`.
 */
const fs = require("node:fs");

const LOG = process.env.WIRE_LOG;
let buffer = "";
let sessions = 0;

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line.trim()) {
      continue;
    }
    const message = JSON.parse(line);
    if (typeof message.method !== "string" || message.id === undefined) {
      continue;
    }
    if (LOG) {
      fs.appendFileSync(
        LOG,
        JSON.stringify({ method: message.method, params: message.params }) + "\n",
      );
    }
    if (message.method === "initialize") {
      reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    } else if (message.method === "session/new") {
      sessions += 1;
      reply(message.id, { sessionId: `wire-${process.pid}-${sessions}` });
    } else if (message.method === "session/prompt") {
      reply(message.id, { stopReason: "end_turn" });
    } else {
      reply(message.id, {});
    }
  }
});
process.stdin.on("end", () => process.exit(0));
