import { main, ensure, until, sleep, withResolvers } from "effection";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readTextFile } from "@effectionx/fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const [entry, root] = process.argv.slice(2);
const log = join(root, "backend.log");

main(function* () {
  const updates = [];
  const events = [];
  let agent;
  const nativeSpawn = childProcess.spawn;
  const client = {
    sessionUpdate(update) {
      updates.push(update);
      return Promise.resolve();
    },
  };
  const closed = withResolvers();
  let child;
  let outcome;
  const onClose = (code, signal) => {
    outcome = { code, signal };
    events.push("backend-close");
    closed.resolve();
  };
  yield* ensure(function* () {
    try {
      if (agent) {
        yield* until(agent.dispose());
      }
      if (child) {
        if (outcome === undefined) {
          child.kill();
        }
        yield* closed.operation;
      }
    } finally {
      child?.off("close", onClose);
      childProcess.spawn = nativeSpawn;
      syncBuiltinESMExports();
    }
  });
  // The SDK custom-spawn seam delivers raw exit events; observe its default launcher unchanged.
  childProcess.spawn = (command, args, options) => {
    const spawned = nativeSpawn(command, args, options);
    if (
      command === process.env.CLAUDE_CODE_EXECUTABLE ||
      args?.includes(process.env.CLAUDE_CODE_EXECUTABLE)
    ) {
      child = spawned;
      child.on("close", onClose);
    }
    return spawned;
  };
  syncBuiltinESMExports();
  const { ClaudeAcpAgent } = yield* until(
    import(pathToFileURL(join(dirname(entry), "lib.js")).href),
  );
  agent = new ClaudeAcpAgent(client, { log() {}, error() {} });
  yield* until(agent.initialize({ protocolVersion: 1, clientCapabilities: {} }));
  const opening = agent
    .newSession({
      cwd: root,
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            env: {
              FAKE_CLAUDE_LOG: log,
              FAKE_CLAUDE_CONFIRMATION: "held",
              FAKE_CLAUDE_HELD_HELPER: "1",
            },
          },
        },
      },
    })
    .then(
      () => ({ status: "returned" }),
      (error) => ({ status: "refused", message: error.message }),
    );
  let ready = false;
  while (!ready) {
    try {
      ready = (yield* readTextFile(log)).includes('"control_request"');
    } catch {
      // Startup has not created the backend log yet.
    }
    if (!ready) {
      yield* sleep(10);
    }
  }
  events.push("dispose-start");
  yield* until(agent.dispose());
  events.push("dispose-return");
  const closedWhenDisposeReturned = outcome !== undefined;
  const result = yield* until(opening);
  if (child === undefined) {
    throw new Error("the SDK backend spawn was not observed");
  }
  yield* closed.operation;
  const entries = (yield* readTextFile(log))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  console.log(
    JSON.stringify({
      events,
      outcome,
      closedWhenDisposeReturned,
      result,
      updates,
      helperClosed: entries.some(
        (record) => record.event === "helper-close" && record.code === 0 && record.signal === null,
      ),
      userMessages: entries.filter((record) => record.raw?.type === "user").length,
      remainingSessions: Object.keys(agent.sessions).length,
    }),
  );
});
