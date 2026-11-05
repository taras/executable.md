import { ensure, until, withResolvers, scoped } from "effection";
import { rm } from "@effectionx/fs";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

export function* inspectClaudeRuntime(root, runtime) {
  const paths = yield* until(readdir(dirname(dirname(dirname(root))), { recursive: true }));
  const forbidden = paths.filter((path) =>
    /(?:^|\/)node_modules\/@anthropic-ai\/claude-agent-sdk(?:\/|$|-)/.test(path),
  );
  if (forbidden.length) {
    throw new Error(`Unused SDK installed: ${forbidden.join(", ")}`);
  }
  for (const [path, hash] of Object.entries(runtime)) {
    const bytes = yield* until(readFile(join(root, path)));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== hash) {
      throw new Error(`Runtime mismatch ${path}: ${actual} != ${hash}`);
    }
  }
}

export function packagedClaudeExchange(createEmbeddedAdapters, fake, runtime) {
  return scoped(function* () {
    const root = yield* until(mkdtemp(join(tmpdir(), "xmd-packaged-claude-")));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const adapters = createEmbeddedAdapters(join(root, "adapters"));
    yield* adapters.materialize("claude");
    const entry = adapters.executablePath("claude");
    yield* inspectClaudeRuntime(dirname(dirname(entry)), runtime);
    const closed = withResolvers();
    let child;
    let outcome;
    const pending = new Map();
    const updates = [];
    let buffer = "";
    const onClose = (code, signal) => {
      for (const reply of pending.values()) {
        reply.reject(new Error(`Adapter closed before replying (${code}/${signal})`));
      }
      outcome = { code, signal };
      closed.resolve(outcome);
    };
    const onError = (error) => {
      for (const reply of pending.values()) {
        reply.reject(error);
      }
    };
    const onData = (bytes) => {
      buffer += bytes.toString();
      for (;;) {
        const at = buffer.indexOf("\n");
        if (at < 0) {
          break;
        }
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.method === "session/update") {
          updates.push(message.params);
        } else if (message.method && message.id !== undefined) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\n");
        } else if (pending.has(message.id)) {
          const reply = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) {
            reply.reject(new Error(JSON.stringify(message.error)));
          } else {
            reply.resolve(message.result);
          }
        }
      }
    };
    yield* ensure(function* () {
      if (child) {
        try {
          if (!outcome) {
            child.stdin.end();
          }
          yield* closed.operation;
        } finally {
          child.off("close", onClose);
          child.off("error", onError);
          child.stdout.off("data", onData);
        }
      }
    });
    child = spawn(process.execPath, [entry], {
      cwd: root,
      env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake },
      stdio: ["pipe", "pipe", "inherit"],
    });
    child.on("close", onClose);
    child.on("error", onError);
    child.stdout.on("data", onData);
    let id = 0;
    function* request(method, params) {
      const reply = withResolvers();
      pending.set(++id, reply);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return yield* reply.operation;
    }
    yield* request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const session = yield* request("session/new", { cwd: root, mcpServers: [] });
    const response = yield* request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    const uuid = response._meta?.claudeCode?.assistantMessageUuid;
    const accepted = updates.some(
      (item) =>
        item.sessionId === session.sessionId &&
        item.update?._meta?.["executablemd.session-materialization/v1"]?.state === "accepted",
    );
    if (
      uuid !== `uuid:${session.sessionId}` ||
      !accepted ||
      !JSON.stringify(updates).includes("answered")
    ) {
      throw new Error(
        `Packaged exchange did not preserve identity/acceptance: ${JSON.stringify({ uuid, accepted, updates })}`,
      );
    }
    child.stdin.end();
    const close = yield* closed.operation;
    if (close.code !== 0 || close.signal !== null) {
      throw new Error(`Adapter close failed: ${JSON.stringify(close)}`);
    }
    return { uuid, accepted, answered: true, originalSdkAbsent: true };
  });
}
