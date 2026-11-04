#!/usr/bin/env node
/**
 * A stand-in for the Claude Code CLI, for Tier EA.
 *
 * It speaks the Agent SDK's stream-json protocol: answer the control handshake,
 * then for each user message emit a replayed echo, one top-level assistant
 * message, a result, and an idle.
 *
 * The assistant message's uuid is derived from the `--session-id` the adapter
 * launched this process with, so a test can state the exact identity the CLI
 * emitted. That is also what separates interleaved sessions: two sessions are
 * two processes with two session ids, and an adapter reading a session-global
 * "last assistant message" crosses them.
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const LOG = process.env.FAKE_CLAUDE_LOG;

/** The session this CLI was launched for, as the adapter named it. */
const SESSION =
  process.argv
    .find((argument) => argument.startsWith("--session-id="))
    ?.slice("--session-id=".length) ??
  process.argv.find((argument) => argument.startsWith("--resume="))?.slice("--resume=".length) ??
  "fake-session";

/** What a test expects back, built from that session and nothing else. */
const UUID = `uuid:${SESSION}`;

function log(entry) {
  if (LOG) {
    fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
  }
}

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

if (process.env.FAKE_CLAUDE_EXIT_STDERR) {
  process.stderr.write("native-close-tail", () => process.exit(7));
  return;
}
log({ argv: process.argv.slice(2) });
process.on("exit", () => log({ event: "exit", pid: process.pid }));

emit({
  type: "system",
  subtype: "init",
  session_id: SESSION,
  tools: [],
  mcp_servers: [],
  model: "fake-model",
  permissionMode: "default",
  slash_commands: [],
  apiKeySource: "none",
  cwd: process.cwd(),
  output_style: "default",
  uuid: crypto.randomUUID(),
});

const confirmation = process.env.FAKE_CLAUDE_CONFIRMATION ?? "success";
if (process.env.FAKE_CLAUDE_CLOSE_GATE_PORT) {
  spawn(process.execPath, [require("node:path").join(__dirname, "claude-stdout-holder.mjs")], {
    env: process.env,
    stdio: ["ignore", process.stdout, "ignore"],
  }).unref();
  process.stdin.on("end", () => process.exit(0));
}
if (confirmation === "held" && process.env.FAKE_CLAUDE_HELD_HELPER === "1") {
  let helper;
  const onEnd = () => helper.stdin.end();
  const onHelperClose = (code, signal) => {
    log({ event: "helper-close", code, signal });
    helper.off("close", onHelperClose);
    process.stdin.off("end", onEnd);
    process.exit(0);
  };
  process.stdin.on("end", onEnd);
  helper = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: "pipe" });
  helper.on("close", onHelperClose);
}
function confirm() {
  if (confirmation === "absent" || confirmation === "held") {
    return;
  }
  if (confirmation === "stream-error" || confirmation === "missing-history") {
    process.exit(2);
  }
  emit({
    type: "system",
    subtype: "hook_response",
    hook_id: "internal",
    hook_name: "opaque lifecycle label",
    hook_event: confirmation === "wrong-event" ? "Stop" : "SessionStart",
    stdout: "",
    stderr: "",
    output: "",
    exit_code: confirmation === "failed" ? 1 : 0,
    outcome: confirmation === "failed" ? "error" : "success",
    uuid: crypto.randomUUID(),
    session_id: confirmation === "mismatch" ? "other-conversation" : SESSION,
  });
  if (confirmation === "conflicting" && process.env.FAKE_CLAUDE_CONFLICT_AT !== "context-request") {
    emit({
      type: "system",
      subtype: "hook_response",
      hook_id: "internal",
      hook_name: "opaque",
      hook_event: "SessionStart",
      stdout: "",
      stderr: "",
      output: "",
      exit_code: 0,
      outcome: "success",
      uuid: crypto.randomUUID(),
      session_id: "other-conversation",
    });
  }
}
confirm();

function usage() {
  return {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

let buffer = "";
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
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    log({ raw: message });

    // The SDK opens with a control handshake and will not send a turn until it
    // is answered.
    if (message.type === "control_request") {
      if (
        confirmation === "conflicting" &&
        process.env.FAKE_CLAUDE_CONFLICT_AT === "context-request" &&
        message.request?.subtype === "get_context_usage"
      ) {
        log({ event: "conflict-at-context-request" });
        emit({
          type: "system",
          subtype: "hook_response",
          hook_id: "internal",
          hook_name: "opaque",
          hook_event: "SessionStart",
          stdout: "",
          stderr: "",
          output: "",
          exit_code: 0,
          outcome: "success",
          uuid: crypto.randomUUID(),
          session_id: "other-conversation",
        });
        // Only Query failure releases this lookup, so setup cannot outrun the contradiction.
        continue;
      }
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {
            commands: [],
            agents: [],
            output_style: "default",
            available_output_styles: ["default"],
            models: [
              {
                value: "fake-model",
                resolvedModel: "fake-model",
                displayName: "Fake",
                description: "a stand-in",
                isDefault: true,
              },
            ],
            account: { email: "fake@example.test", organization: null, subscription: null },
            hooks_applied: true,
          },
        },
      });
      if (["absent", "wrong-event"].includes(confirmation)) {
        process.exit(0);
      }
      continue;
    }
    if (message.type !== "user") {
      continue;
    }

    // Echo the user message back, the way the CLI replays a queued turn.
    emit({ ...message, session_id: SESSION, isReplay: true, parent_tool_use_id: null });

    // The answer, carrying the uuid a client must be able to resume from.
    emit({
      type: "assistant",
      parent_tool_use_id: null,
      error: null,
      uuid: UUID,
      session_id: SESSION,
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "fake-model",
        content: [{ type: "text", text: "answered", citations: null }],
        stop_reason: "end_turn",
        stop_sequence: null,
        container: null,
        usage: usage(),
      },
    });

    emit({
      type: "result",
      subtype: "success",
      stop_reason: null,
      is_error: false,
      result: "answered",
      errors: [],
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      usage: usage(),
      modelUsage: {},
      permission_denials: [],
      uuid: crypto.randomUUID(),
      session_id: SESSION,
    });

    emit({ type: "system", subtype: "session_state_changed", state: "idle", session_id: SESSION });
  }
});
