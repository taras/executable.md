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
/**
 * Where a stateful case keeps each conversation's model and effort.
 *
 * Opt-in. Without it every control answers with the fixed `fake-model`
 * catalog and nothing persists, which is what the existing cases assume. With
 * it, a resumed process continues the model its conversation last ran — the way
 * the CLI restores a transcript — and a cold reconnect can be observed against
 * what the previous process actually ran.
 */
const STATE_DIR = process.env.FAKE_CLAUDE_STATE_DIR;

/** The session this CLI was launched for, as the adapter named it. */
const SESSION =
  process.argv
    .find((argument) => argument.startsWith("--session-id="))
    ?.slice("--session-id=".length) ??
  process.argv.find((argument) => argument.startsWith("--resume="))?.slice("--resume=".length) ??
  "fake-session";

/** What a test expects back, built from that session and nothing else. */
const UUID = `uuid:${SESSION}`;

const RESUMED = process.argv.some((argument) => argument.startsWith("--resume="));

/** The picker a stateful case offers: aliases resolve, exact ids name themselves. */
const CATALOG = STATE_DIR
  ? JSON.parse(
      process.env.FAKE_CLAUDE_MODELS ??
        JSON.stringify([
          {
            value: "default",
            resolvedModel: "claude-fable-5-1",
            displayName: "Default",
            description: "the account default",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
          {
            value: "fable",
            resolvedModel: "claude-fable-5-1",
            displayName: "Fable",
            description: "the latest Fable",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
          {
            value: "claude-fable-5",
            resolvedModel: "claude-fable-5",
            displayName: "Fable 5",
            description: "an exact model",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
          {
            value: "claude-sonnet-5-5",
            resolvedModel: "claude-sonnet-5-5",
            displayName: "Sonnet 5.5",
            description: "another exact model",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
        ]),
    )
  : [
      {
        value: "fake-model",
        resolvedModel: "fake-model",
        displayName: "Fake",
        description: "a stand-in",
        isDefault: true,
      },
    ];

function statePath() {
  return require("node:path").join(STATE_DIR, `${encodeURIComponent(SESSION)}.json`);
}

function argumentAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * The selection this process runs under.
 *
 * A resumed conversation continues what it last ran, whatever this launch was
 * asked for; a new one starts from `--model`, or the account default.
 */
const state = (() => {
  if (!STATE_DIR) {
    return { model: "fake-model", effort: undefined };
  }
  if (RESUMED && fs.existsSync(statePath())) {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  }
  return { model: argumentAfter("--model") ?? "default", effort: argumentAfter("--effort") };
})();

function persist() {
  if (STATE_DIR) {
    fs.writeFileSync(statePath(), JSON.stringify(state));
  }
}

/** The model a request actually reaches: an alias's resolution, or the exact id. */
function running() {
  if (!STATE_DIR) {
    return "fake-model";
  }
  const entry = CATALOG.find((model) => model.value === state.model);
  return entry?.resolvedModel ?? state.model;
}

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
log({ executable: process.argv[1], argv: process.argv.slice(2) });
if (STATE_DIR && !process.argv.includes("--version")) {
  persist();
  log({ event: "started", session: SESSION, resumed: RESUMED, model: state.model });
}
if (process.argv.includes("--version")) {
  console.log("Fake Claude Code 0.0.0");
  return;
}
process.on("exit", () => log({ event: "exit", pid: process.pid }));

emit({
  type: "system",
  subtype: "init",
  session_id: SESSION,
  tools: [],
  mcp_servers: [],
  model: running(),
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

/**
 * Answer the controls a stateful case observes, or leave the request alone.
 *
 * Model and effort writes change this conversation's persisted selection and
 * are logged by name, so a case can count exactly which ones a reconnect sent.
 * `get_context_usage` reports what the conversation actually runs.
 */
function answerStateful(message) {
  const request = message.request ?? {};
  const succeed = (response) =>
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response },
    });
  if (request.subtype === "set_model") {
    state.model = request.model ?? "default";
    persist();
    log({ control: "set_model", session: SESSION, model: state.model });
    succeed({});
    return true;
  }
  if (request.subtype === "apply_flag_settings") {
    if (request.settings && Object.hasOwn(request.settings, "effortLevel")) {
      state.effort = request.settings.effortLevel ?? undefined;
      persist();
      log({ control: "effort", session: SESSION, effort: state.effort ?? null });
    }
    succeed({});
    return true;
  }
  if (request.subtype === "get_context_usage") {
    log({ control: "get_context_usage", session: SESSION, model: running() });
    if (process.env.FAKE_CLAUDE_CONTEXT_USAGE === "fail") {
      emit({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: message.request_id,
          error: "context usage is unavailable",
        },
      });
      return true;
    }
    succeed({
      categories: [],
      totalTokens: 0,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 0,
      gridRows: [],
      model: process.env.FAKE_CLAUDE_CONTEXT_USAGE === "absent" ? undefined : running(),
    });
    return true;
  }
  return false;
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
      if (STATE_DIR && answerStateful(message)) {
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
            models: CATALOG,
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

    if (STATE_DIR) {
      log({ event: "prompt", session: SESSION, model: running(), effort: state.effort ?? null });
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
        model: running(),
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
      // A case may script the main loop's own result usage and the broader
      // per-model tally the SDK reports beside it.
      usage: process.env.FAKE_CLAUDE_RESULT_USAGE
        ? JSON.parse(process.env.FAKE_CLAUDE_RESULT_USAGE)
        : usage(),
      modelUsage: process.env.FAKE_CLAUDE_MODEL_USAGE
        ? JSON.parse(process.env.FAKE_CLAUDE_MODEL_USAGE)
        : {},
      permission_denials: [],
      uuid: crypto.randomUUID(),
      session_id: SESSION,
    });

    emit({ type: "system", subtype: "session_state_changed", state: "idle", session_id: SESSION });
  }
});
