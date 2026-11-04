import { ensure } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpxSessionStore } from "../src/session-store.ts";

export const AGENT_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const controlDirectory = process.argv[2];
let sessionId;
let model = "initial";
let effort = "high";
let remembered = "";
const options = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model,
    options: ["initial", "selected", "gpt-5.6-luna"].map(value => ({value, name: value})) },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: effort,
    options: ["high", "xhigh"].map(value => ({value, name: value})) },
];
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => send({jsonrpc: "2.0", id, result});
const update = update => send({jsonrpc: "2.0", method: "session/update", params: {sessionId, update}});
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
function handle(request) {
  if (!controlDirectory || !request.method.startsWith("session/")) return respond(request);
  fs.appendFile(path.join(controlDirectory, "methods.jsonl"), JSON.stringify({method: request.method, value: request.params?.value, sessionId: request.params?.sessionId, text: request.params?.prompt?.map(block => block.text ?? "").join("")}) + "\\n", error => {
    if (error) throw error;
    const name = request.method === "session/load" ? "load" : request.method === "session/prompt" ? "prompt" : undefined;
    if (!name) return respond(request);
    fs.access(path.join(controlDirectory, "hold-" + name), error => {
      if (error) return respond(request);
      const wait = () => fs.access(path.join(controlDirectory, "release-" + name), error => {
        if (error) setTimeout(wait, 5);
        else respond(request);
      });
      wait();
    });
  });
}
function respond(request) {
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    const initialize = () => fs.access(controlDirectory ? path.join(controlDirectory, "no-load") : "", error => reply(request.id, {protocolVersion: 1, agentCapabilities: {loadSession: Boolean(error), promptCapabilities: {}}, authMethods: []}));
    if (process.env.XMD_RELEASE_ENV_LOG) {
      require("node:fs").writeFile(process.env.XMD_RELEASE_ENV_LOG, JSON.stringify({
        bound: process.env.CLAUDE_CODE_EXECUTABLE ?? null,
        auth: process.env.XMD_TEST_AUTH ?? null,
      }), error => { if (error) throw error; initialize(); });
    } else initialize();
  } else if (request.method === "session/new" || request.method === "session/load") {
    sessionId = request.params.sessionId ?? (controlDirectory ? "fixed-session" : "session-" + process.pid);
    const loaded = () => {
      const ready = () => reply(request.id, {sessionId, configOptions: options(), _meta: {agentSessionId: "native-" + sessionId}});
      if (controlDirectory && request.method === "session/load") {
        fs.readFile(path.join(controlDirectory, "remembered"), "utf8", (_error, text) => { remembered = text ?? ""; ready(); });
      } else ready();
    };
    if (controlDirectory && request.method === "session/load") {
      fs.access(path.join(controlDirectory, "fail-load"), error => {
        if (error) loaded();
        else send({jsonrpc: "2.0", id: request.id, error: {code: -32603, message: "Controlled cold load failure"}});
      });
    } else loaded();
  } else if (request.method === "session/set_config_option") {
    if (request.params.configId === "model") model = request.params.value;
    if (request.params.configId === "effort") effort = request.params.value;
    reply(request.id, {configOptions: options()});
  } else if (request.method === "session/prompt") {
    const text = request.params.prompt.map(block => block.text ?? "").join("");
    const answer = () => {
    if (text !== "no-accept") update({sessionUpdate: "session_info_update", _meta: {"executablemd.session-materialization/v1": {state: "accepted"}}});
    update({sessionUpdate: "agent_message_chunk", content: {type: "text", text: "answer:" + text + (text === "recall-fail" ? ":" + remembered : "")}});
    if (text === "diagnostic") {
      send({jsonrpc: "2.0", id: request.id, error: {code: -32041, message: "Internal error", data: {details: "/work/project: adapter unavailable", authorization: "<redacted>"}}});
    } else if (text === "fail" || text === "recall-fail") {
      send({jsonrpc: "2.0", id: request.id, error: {code: -32000, message: "backend refusal"}});
    } else {
      reply(request.id, {stopReason: text === "cancel" ? "cancelled" : "end_turn", _meta: {codex: {turnId: "turn-" + text}, opaque: {left: [3, null]}}});
    }
    };
    if (controlDirectory && text === "marker") {
      fs.writeFile(path.join(controlDirectory, "remembered"), text, error => { if (error) throw error; answer(); });
    } else answer();
  } else {
    send({jsonrpc: "2.0", id: request.id, error: {code: -32601, message: "unsupported"}});
  }
}
`;

export function* world(trace = false) {
  const dir = join(tmpdir(), `xmd-released-${randomUUID()}`);
  yield* ensureDir(dir);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  const agent = join(dir, "agent with spaces.cjs");
  yield* writeTextFile(agent, AGENT_SOURCE);
  const registry = {
    resolve: () => ["node", agent, ...(trace ? [dir] : [])],
    list: () => ["scribe"],
  };
  const store = createAcpxSessionStore(dir);
  const storeCalls = { load: 0, save: 0 };
  const load = store.load.bind(store);
  const save = store.save.bind(store);
  store.load = (key) => {
    storeCalls.load++;
    return load(key);
  };
  store.save = (record) => {
    storeCalls.save++;
    return save(record);
  };
  return { dir, agent, registry, store, storeCalls };
}
