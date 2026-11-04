import { main, ensure, until, sleep, withResolvers } from "effection";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readTextFile } from "@effectionx/fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const [entry, root, mode] = process.argv.slice(2);
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
  const exited = withResolvers();
  const holderReady = withResolvers();
  const holderHeld = withResolvers();
  const sockets = new Set();
  const handlers = new Map();
  let server;
  let port;
  let openingSettled = false;
  let settingsDisposed = 0;
  let endedInputs = 0;
  const restores = [];
  const onConnection = (socket) => {
    sockets.add(socket);
    const onData = (data) => {
      if (data.toString().includes("ready")) {
        holderReady.resolve();
      }
      if (data.toString().includes("held")) {
        holderHeld.resolve();
      }
    };
    handlers.set(socket, onData);
    socket.on("data", onData);
  };
  const onExit = () => exited.resolve();
  let child;
  let outcome;
  const onClose = (code, signal) => {
    outcome = { code, signal };
    events.push("backend-close");
    closed.resolve();
  };
  yield* ensure(function* () {
    try {
      for (const socket of sockets) {
        socket.write("release\n");
        socket.end();
      }
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
      child?.off("exit", onExit);
      for (const [socket, handler] of handlers) {
        socket.off("data", handler);
        socket.destroy();
      }
      server?.off("connection", onConnection);
      server?.close();
      for (const restore of restores) {
        restore();
      }
      childProcess.spawn = nativeSpawn;
      syncBuiltinESMExports();
    }
  });
  if (mode === "gated") {
    server = createServer();
    server.on("connection", onConnection);
    const listening = withResolvers();
    server.listen(0, "127.0.0.1", () => listening.resolve());
    yield* listening.operation;
    port = server.address().port;
  }
  // The SDK custom-spawn seam delivers raw exit events; observe its default launcher unchanged.
  childProcess.spawn = (command, args, options) => {
    const spawned = nativeSpawn(command, args, options);
    if (
      command === process.env.CLAUDE_CODE_EXECUTABLE ||
      args?.includes(process.env.CLAUDE_CODE_EXECUTABLE)
    ) {
      child = spawned;
      child.on("close", onClose);
      child.on("exit", onExit);
    }
    return spawned;
  };
  syncBuiltinESMExports();
  const { ClaudeAcpAgent } = yield* until(
    import(pathToFileURL(join(dirname(entry), "lib.js")).href),
  );
  const { SettingsManager } = yield* until(
    import(pathToFileURL(join(dirname(entry), "settings.js")).href),
  );
  const { Pushable } = yield* until(import(pathToFileURL(join(dirname(entry), "utils.js")).href));
  const disposeSettings = SettingsManager.prototype.dispose;
  SettingsManager.prototype.dispose = function () {
    const result = disposeSettings.call(this);
    settingsDisposed++;
    return result;
  };
  restores.push(() => {
    SettingsManager.prototype.dispose = disposeSettings;
  });
  const endInput = Pushable.prototype.end;
  Pushable.prototype.end = function () {
    const result = endInput.call(this);
    endedInputs++;
    return result;
  };
  restores.push(() => {
    Pushable.prototype.end = endInput;
  });
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
              FAKE_CLAUDE_HELD_HELPER: mode === "gated" ? "0" : "1",
              ...(port ? { FAKE_CLAUDE_CLOSE_GATE_PORT: String(port) } : {}),
            },
          },
        },
      },
    })
    .then(
      () => {
        openingSettled = true;
        return { status: "returned" };
      },
      (error) => {
        openingSettled = true;
        return { status: "refused", message: error.message };
      },
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
  if (mode === "gated") {
    yield* holderReady.operation;
  }
  events.push("dispose-start");
  let returnedWhileHeld;
  let closedWhenDisposeReturned;
  let cleanupAtReturn;
  let returned = false;
  const disposal = agent.dispose().then(() => {
    returned = true;
    events.push("dispose-return");
    closedWhenDisposeReturned = outcome !== undefined;
    cleanupAtReturn = { openingSettled, settingsDisposed, endedInputs };
  });
  if (mode === "gated") {
    yield* exited.operation;
    for (const socket of sockets) {
      socket.write("check\n");
    }
    yield* holderHeld.operation;
    returnedWhileHeld = returned;
    for (const socket of sockets) {
      socket.write("release\n");
    }
  }
  yield* until(disposal);
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
      returnedWhileHeld,
      cleanupAtReturn,
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
