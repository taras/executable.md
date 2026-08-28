/**
 * Drive the *built* npm package, from Node, for Tier ANP.
 *
 * Imports the dnt-emitted `embedded-adapters` entrypoint — not the source
 * module — materializes its embedded snapshot, launches the adapter it wrote,
 * and completes a real ACP exchange against the fake provider.
 *
 * A separate process rather than an import into the test, because what an npm
 * package is *for* is being consumed by Node: running it that way is the claim,
 * and it keeps the assertion independent of whichever runtime the suite is
 * executing under.
 *
 * Prints one line per observation, which the test parses.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { run } from "effection";

const [pkg, fakeCodex] = process.argv.slice(2);
const { createEmbeddedAdapters } = await import(join(pkg, "esm", "embedded-adapters.js"));

const root = await mkdtemp(join(tmpdir(), "xmd-npm-"));
try {
  const adapters = createEmbeddedAdapters(join(root, "adapters"));
  await run(() => adapters.materialize("codex"));
  const entry = adapters.executablePath("codex");
  console.log("MATERIALIZED", entry.includes(adapters.identity("codex").split("+")[1]));

  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, CODEX_PATH: fakeCodex },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  // Plain object rather than a Map: one short-lived driver process, one
  // exchange, and the repository forbids module-scoped registries.
  const pending = Object.create(null);
  let next = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
      if (!line.trim()) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending[message.id]) {
        const settle = pending[message.id];
        delete pending[message.id];
        settle(message);
      } else if (message.id !== undefined && message.method) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\n");
      }
    }
  });

  const request = (method, params) => {
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
      pending[id] = (message) => {
        clearTimeout(timer);
        if (message.error) {
          reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        } else {
          resolve(message.result);
        }
      };
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const session = await request("session/new", { cwd: root, mcpServers: [] });
  const response = await request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "hello" }],
  });
  console.log("SESSION", session.sessionId);
  console.log("CHECKPOINT", JSON.stringify(response._meta?.codex));
  child.kill();
} finally {
  await rm(root, { recursive: true, force: true });
}
