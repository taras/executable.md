/**
 * Tier CX — `xmd agent options` against a real agent (issue #828).
 *
 * The command is run as a command: a separate `xmd` process, speaking ACP over
 * stdio to a separate agent process. The agent is a script this suite writes,
 * so what it advertises is fixed and what it was asked is recorded — which is
 * how "one session, no prompt, closed" is observed rather than asserted about a
 * fake standing in for the transport.
 *
 * The unit suites beside this one state the grammar and the exact renderings.
 * What only a subprocess can show is what actually reached an agent, and what
 * the command left behind on the filesystem when it finished.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { chmod, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { runCli } from "@executablemd/test-support/launch";

interface World {
  /** Where the command runs, and where nothing of it should be left. */
  dir: string;
  /** An isolated HOME, so machine-wide state is this case's to inspect. */
  home: string;
  /** The agent's own record of every method it was asked, in order. */
  log: string;
  /** The path that is also this agent's name. */
  agent: string;
}

/**
 * The choices this agent advertises, and the one thing it does with a write.
 *
 * Effort choices belong to a model here as they do for a real agent: selecting
 * the mini model narrows them. That is what makes "the command refreshed after
 * the write" observable in the output rather than only in the log.
 */
const AGENT_SOURCE = (log: string, options: string): string =>
  [
    "#!/usr/bin/env node",
    'const { appendFileSync } = require("node:fs");',
    `const record = (line) => appendFileSync(${JSON.stringify(log)}, line + "\\n");`,
    `const advertised = ${options};`,
    "const state = JSON.parse(JSON.stringify(advertised));",
    "const configOptions = () => (state.length === 0 ? undefined : state);",
    "function result(message) {",
    '  if (message.method === "initialize") {',
    "    return { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] };",
    "  }",
    '  if (message.method === "session/new") {',
    '    const answer = { sessionId: "stub-session-1" };',
    "    const options = configOptions();",
    "    if (options) { answer.configOptions = options; }",
    "    return answer;",
    "  }",
    '  if (message.method === "session/set_config_option") {',
    "    const { configId, value } = message.params ?? {};",
    "    const selector = state.find((entry) => entry.id === configId);",
    "    if (!selector) { return { configOptions: state }; }",
    "    const offered = selector.options.flatMap((entry) =>",
    "      entry.group === undefined ? [entry.value] : entry.options.map((member) => member.value),",
    "    );",
    "    if (!offered.includes(value)) { return { configOptions: state }; }",
    "    selector.currentValue = value;",
    '    if (configId === "model" && value === "gpt-5.4-mini") {',
    '      const effort = state.find((entry) => entry.id === "effort");',
    '      if (effort) { effort.options = [{ value: "low", name: "Low" }]; effort.currentValue = "low"; }',
    "    }",
    "    return { configOptions: state };",
    "  }",
    "  return {};",
    "}",
    'process.stdin.setEncoding("utf8");',
    'let buffer = "";',
    'process.stdin.on("data", (chunk) => {',
    "  buffer += chunk;",
    "  let index;",
    '  while ((index = buffer.indexOf("\\n")) !== -1) {',
    "    const line = buffer.slice(0, index);",
    "    buffer = buffer.slice(index + 1);",
    "    if (line.trim().length === 0) { continue; }",
    "    let message;",
    "    try { message = JSON.parse(line); } catch { continue; }",
    "    if (message.method !== undefined) {",
    "      const params = message.params ?? {};",
    "      const detail = params.configId === undefined ? '' : ` ${params.configId}=${params.value}`;",
    "      record(message.method + detail);",
    "    }",
    "    if (message.id === undefined) { continue; }",
    '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: result(message) }) + "\\n");',
    "  }",
    "});",
    'process.stdin.on("end", () => { record("closed"); process.exit(0); });',
    "",
  ].join("\n");

/** Both selectors, one of them grouped, as an ACP agent advertises them. */
const ADVERTISED = JSON.stringify([
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "gpt-5.4",
    options: [
      { value: "gpt-5.4", name: "GPT-5.4", description: "the current one" },
      { group: "mini", name: "Small", options: [{ value: "gpt-5.4-mini", name: "GPT-5.4 Mini" }] },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    type: "select",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
]);

/**
 * A string only this agent knows, carried on the payload it answers with.
 *
 * It stands in for whatever a real agent might have in the parts of a response
 * this command does not understand — a token, a path, somebody's prompt. A
 * diagnostic that repeats an unreadable payload repeats all of it.
 */
const PLANTED = "cx8-planted-secret-8f2c";

/**
 * A selector this command recognizes and cannot read.
 *
 * Recognized is the point: `category: "model"` is how the model selector is
 * found, so this is not an agent that advertises nothing — it is an agent whose
 * model selector arrives without the one thing a selector is.
 */
const MALFORMED = JSON.stringify([
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "gpt-5.4",
    sessionToken: PLANTED,
  },
]);

function* useWorld<T>(options: string, body: (world: World) => Operation<T>): Operation<T> {
  const root = path.join(os.tmpdir(), `xmd-cx-${randomUUID()}`);
  const world: World = {
    dir: path.join(root, "work"),
    home: path.join(root, "home"),
    log: path.join(root, "asked.log"),
    agent: path.join(root, "acp-agent"),
  };
  yield* ensureDir(world.dir);
  yield* ensureDir(world.home);
  return yield* scoped(function* () {
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* writeTextFile(world.agent, AGENT_SOURCE(world.log, options));
    yield* until(chmod(world.agent, 0o755));
    return yield* body(world);
  });
}

function env(world: World, extra: Record<string, string> = {}) {
  return { cwd: world.dir, env: { HOME: world.home, ...extra } };
}

/** Every method the agent was asked, in order, across both its processes. */
function* asked(world: World): Operation<string[]> {
  const text = yield* readTextFile(world.log);
  return text.split("\n").filter((line) => line.length > 0);
}

/**
 * What the command left where a run would leave something.
 *
 * `work` is the directory it ran in, where a journal would be. `xmd` is where
 * this host materializes adapters, and `nativeSessions` is where it maps a
 * machine-wide agent session — neither of which an inspection may create.
 * A missing directory reads as the empty list it describes.
 */
function* leftBehind(world: World): Operation<{
  work: string[];
  xmd: string[];
  nativeSessions: string[];
}> {
  const listing = (target: string): Operation<string[]> => until(readdir(target).catch(() => []));
  return {
    work: yield* listing(world.dir),
    xmd: yield* listing(path.join(world.home, ".xmd")),
    nativeSessions: yield* listing(path.join(world.home, ".acpx", "xmd-native-sessions")),
  };
}

describe(
  "Tier CX — xmd agent options against an agent",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  () => {
    it("CX1: one session, no prompt, closed — and nothing of the run left behind", function* () {
      const result = yield* useWorld(ADVERTISED, function* (world) {
        const run = yield* runCli(["agent", "options", world.agent], env(world)).join();
        return { run, asked: yield* asked(world), left: yield* leftBehind(world) };
      });

      expect(result.run.code).toBe(0);
      // Exactly one conversation was created, and nothing was said in it. The
      // availability probe is its own process, which is why `initialize` appears
      // twice and `session/new` once.
      expect(result.asked.filter((line) => line === "session/new")).toEqual(["session/new"]);
      expect(result.asked.filter((line) => line.startsWith("session/prompt"))).toEqual([]);
      expect(result.asked.filter((line) => line.startsWith("session/set_config_option"))).toEqual(
        [],
      );
      // Closed: the agent saw its input end rather than being left running.
      expect(result.asked.at(-1)).toBe("closed");
      // No document ran, so no journal — and nothing of this command is retained
      // where a run retains a durable session or a machine-session mapping. What
      // the provider keeps of its own history is the provider's business and is
      // deliberately not asserted here.
      expect(result.left.work).toEqual([]);
      expect(result.left.xmd).toEqual([]);
      expect(result.left.nativeSessions).toEqual([]);
    });

    it("CX2: the text a person reads is the agent's own order and grouping", function* () {
      const result = yield* useWorld(ADVERTISED, function* (world) {
        const run = yield* runCli(["agent", "options", world.agent], env(world)).join();
        return { run, agent: world.agent };
      });

      expect(result.run.stdout).toBe(
        [
          `Agent: ${result.agent}`,
          "Selected model: gpt-5.4",
          "",
          "Models",
          "  gpt-5.4  GPT-5.4 — the current one (selected)",
          "  Group mini  Small",
          "    gpt-5.4-mini  GPT-5.4 Mini",
          "",
          "Effort levels for gpt-5.4",
          "  low     Low",
          "  medium  Medium (selected)",
          "  high    High",
          "",
        ].join("\n"),
      );
    });

    it("CX3: --model is applied, verified, and its own effort choices reported", function* () {
      const result = yield* useWorld(ADVERTISED, function* (world) {
        const run = yield* runCli(
          ["agent", "options", world.agent, "--model", "gpt-5.4-mini", "--json"],
          env(world),
        ).join();
        return { run, asked: yield* asked(world) };
      });

      expect(result.run.code).toBe(0);
      // One write, for the setting that was named, and the command read the
      // agent again afterwards — which is the only way the narrowed effort
      // choices below could be the ones it reports.
      expect(result.asked.filter((line) => line.startsWith("session/set_config_option"))).toEqual([
        "session/set_config_option model=gpt-5.4-mini",
      ]);
      expect(result.asked.filter((line) => line.startsWith("session/prompt"))).toEqual([]);
      const reported = JSON.parse(result.run.stdout);
      expect(reported.version).toBe(1);
      expect(reported.model.selected).toBe("gpt-5.4-mini");
      expect(reported.effort).toEqual({
        selected: "low",
        options: [{ id: "low", name: "Low", description: null, group: null }],
      });
    });

    it("CX4: with no agent named, the one an `xmd run` would use is asked", function* () {
      const result = yield* useWorld(ADVERTISED, function* (world) {
        const run = yield* runCli(
          ["agent", "options"],
          env(world, { DEFAULT_AGENT_NAME: world.agent }),
        ).join();
        return { run, agent: world.agent, asked: yield* asked(world) };
      });

      expect(result.run.code).toBe(0);
      expect(result.run.stdout).toContain(`Agent: ${result.agent}`);
      expect(result.asked.filter((line) => line === "session/new").length).toBe(1);
    });

    it("CX5: an agent that advertises nothing says so rather than printing nothing", function* () {
      const result = yield* useWorld("[]", function* (world) {
        const run = yield* runCli(["agent", "options", world.agent], env(world)).join();
        return { run, agent: world.agent, asked: yield* asked(world) };
      });

      expect(result.run.code).toBe(0);
      expect(result.run.stdout).toBe(
        [
          `Agent: ${result.agent}`,
          "",
          `Model choices are unavailable for ${result.agent}.`,
          "",
          "Effort choices are unavailable for the current model.",
          "",
        ].join("\n"),
      );
      expect(result.asked.filter((line) => line.startsWith("session/prompt"))).toEqual([]);
    });

    it("CX6: a model this agent does not offer is refused, and nothing is printed", function* () {
      const result = yield* useWorld(ADVERTISED, function* (world) {
        const run = yield* runCli(
          ["agent", "options", world.agent, "--model", "gpt-x", "--json"],
          env(world),
        ).join();
        return {
          run,
          agent: world.agent,
          asked: yield* asked(world),
          left: yield* leftBehind(world),
        };
      });

      expect(result.run.code).toBe(1);
      expect(result.run.stderr).toContain(
        `Unknown model "gpt-x" for agent "${result.agent}".\nAvailable options are: gpt-5.4, gpt-5.4-mini`,
      );
      // No partial answer: half of this command's JSON is not JSON.
      expect(result.run.stdout).toBe("");
      // Refused before any write, and the conversation was still given up.
      expect(result.asked.filter((line) => line.startsWith("session/set_config_option"))).toEqual(
        [],
      );
      expect(result.asked.at(-1)).toBe("closed");
      expect(result.left.work).toEqual([]);
      expect(result.left.nativeSessions).toEqual([]);
    });

    it("CX7: the help says what asking costs before anyone asks", function* () {
      const result = yield* useWorld(ADVERTISED, function* (world) {
        const run = yield* runCli(["agent", "options", "--help"], env(world)).join();
        // No log file at all: help starts no agent, so the script never ran.
        return { run, started: yield* until(readdir(path.dirname(world.log))) };
      });

      expect(result.run.code).toBe(0);
      expect(result.started.includes("asked.log")).toBe(false);
      expect(result.run.stdout).toContain("may keep that empty conversation in its own history");
      expect(result.run.stdout).toContain("xmd agent options codex --model gpt-5.4 --json");
    });

    it("CX8: a malformed answer is refused whole, and says nothing the agent sent", function* () {
      const result = yield* useWorld(MALFORMED, function* (world) {
        const run = yield* runCli(["agent", "options", world.agent, "--json"], env(world)).join();
        return { run, asked: yield* asked(world), left: yield* leftBehind(world) };
      });

      expect(result.run.code).toBe(1);
      // Not half a document: an answer this command could not read is no
      // answer, so the reader is given nothing to parse.
      expect(result.run.stdout).toBe("");
      expect(result.run.stderr).toContain("advertises no list of choices");
      // What the agent sent is the agent's, and an unreadable payload is the
      // last thing to repeat into a terminal or a log: it is untrusted text of
      // unknown length that may carry anything at all.
      expect(result.run.stderr).not.toContain(PLANTED);
      expect(result.run.stderr).not.toContain("currentValue");
      // Nothing was written to a conversation this command could not describe,
      // and the conversation was still given up.
      expect(result.asked.filter((line) => line.startsWith("session/set_config_option"))).toEqual(
        [],
      );
      expect(result.asked.filter((line) => line.startsWith("session/prompt"))).toEqual([]);
      expect(result.asked.at(-1)).toBe("closed");
      expect(result.left.work).toEqual([]);
      expect(result.left.xmd).toEqual([]);
      expect(result.left.nativeSessions).toEqual([]);
    });
  },
);
