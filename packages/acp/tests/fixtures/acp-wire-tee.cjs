#!/usr/bin/env node
/**
 * Runs the ACP agent at `argv[2]` unchanged and appends each session request
 * it receives to `ACP_WIRE_TEE_LOG`, so a case can state the metadata that
 * reached a real adapter.
 */
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const LOG = process.env.ACP_WIRE_TEE_LOG;
const agent = spawn(process.execPath, [process.argv[2]], { stdio: ["pipe", "inherit", "inherit"] });
let buffer = "";
process.stdin.on("data", (chunk) => {
  agent.stdin.write(chunk);
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (LOG && typeof message.method === "string" && message.method.startsWith("session/")) {
      fs.appendFileSync(
        LOG,
        JSON.stringify({ method: message.method, meta: message.params?._meta }) + "\n",
      );
    }
  }
});
process.stdin.on("end", () => agent.stdin.end());
agent.on("exit", (code) => process.exit(code ?? 0));
