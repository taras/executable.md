#!/usr/bin/env node
/**
 * A stand-in for `codex app-server`, for Tier EA.
 *
 * It answers the minimum an ACP adapter needs to reach a completed turn, and
 * names each turn `turn:<threadId>:<n>`. The name is the point: a test can state
 * the exact identity the App Server emitted and compare it with what the
 * adapter put on its ACP prompt response, rather than checking that something
 * arrived.
 *
 * Deriving the name from the thread is what makes interleaved sessions
 * separable — two threads produce two identities, and an adapter reading
 * anything session-global crosses them.
 */
const fs = require("node:fs");

const LOG = process.env.FAKE_CODEX_LOG;

function log(entry) {
  if (LOG) {
    fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

let threads = 0;

/** How many turns each thread has had. One process, one test, one counter. */
const turns = Object.create(null);

/** The identity this fake emits for one thread's next turn. */
function nextTurn(threadId) {
  const count = (turns[threadId] ?? 0) + 1;
  turns[threadId] = count;
  return `turn:${threadId}:${count}`;
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (line.trim().length === 0) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message);
  }
});

function handle(message) {
  log({ direction: "in", method: message.method, id: message.id, params: message.params });
  if (message.id === undefined) {
    return;
  }

  switch (message.method) {
    case "initialize":
      reply(message.id, { userAgent: { name: "fake-codex", version: "0.0.0" } });
      return;
    case "account/read":
      reply(message.id, { account: null });
      return;
    case "skills/list":
      reply(message.id, { data: [] });
      return;
    case "model/list":
      reply(message.id, {
        data: [
          {
            id: "fake-model",
            model: "fake-model",
            displayName: "Fake",
            description: null,
            supportedReasoningEfforts: [],
            isDefault: true,
            defaultReasoningEffort: null,
            defaultServiceTier: null,
          },
        ],
      });
      return;
    case "mcpServerStatus/list":
      reply(message.id, { data: [] });
      return;
    case "config/read":
      reply(message.id, { config: {} });
      return;
    case "thread/start": {
      threads += 1;
      const threadId = `thread-${threads}`;
      reply(message.id, {
        thread: { id: threadId },
        model: "fake-model",
        modelProvider: "fake",
        serviceTier: null,
        cwd: process.cwd(),
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { mode: "danger-full-access" },
        reasoningEffort: null,
        skills: [],
      });
      return;
    }
    case "turn/start": {
      const threadId = message.params?.threadId ?? "thread-1";
      const turnId = nextTurn(threadId);
      // Announce the turn, then complete it. This id is what the adapter must
      // report back on the ACP prompt response, unchanged.
      send({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId, turn: { id: turnId, status: "inProgress" } },
      });
      reply(message.id, { turn: { id: turnId, items: [], status: "inProgress", error: null } });
      // Held briefly so two prompts can be in flight at once, which is what
      // makes the interleaved case an actual overlap.
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, items: [], status: "completed", error: null },
          },
        });
      }, 60);
      return;
    }
    case "review/start": {
      // A review is a turn the App Server accepted, reached by its own request
      // rather than by `turn/start`. It answers with a turn on a review thread
      // of its own, which is what makes it a separate acceptance path.
      const threadId = message.params?.threadId ?? "thread-1";
      const reviewThreadId = `${threadId}-review`;
      const turnId = nextTurn(reviewThreadId);
      send({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: reviewThreadId, turn: { id: turnId, status: "inProgress" } },
      });
      reply(message.id, {
        reviewThreadId,
        turn: { id: turnId, items: [], status: "inProgress", error: null },
      });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            threadId: reviewThreadId,
            turn: { id: turnId, items: [], status: "completed", error: null },
          },
        });
      }, 60);
      return;
    }
    default:
      reply(message.id, {});
      return;
  }
}
