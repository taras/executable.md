/**
 * Tier DV — Devin through the production run path
 * (specs/acp-client-spec.md §Session lifetime).
 *
 * Everything else about invocation-scoped sessions is decided in process, where
 * a fake runtime stands in for ACPX. Two things cannot be: that `devin` on this
 * machine's `PATH` is started as exactly `devin acp`, and that ACPX's own
 * Windsurf compatibility shim then speaks the protocol Devin's backend expects.
 * Both live behind a command string and a child process, so this tier runs the
 * real CLI and puts a real executable named `devin` where it will find it.
 *
 * The executable is an ACP agent of this suite's own: it refuses any argument
 * vector other than `acp`, speaks ndJSON JSON-RPC over stdio, and records the
 * structural facts each connection carried. It costs nothing, needs no
 * credential, and reaches no network.
 *
 * The fixture's source is written here rather than kept beside the test,
 * because nothing else consumes it and a fixture two files describe is one
 * neither of them owns.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { until } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { chmod, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { stat } from "@executablemd/runtime";

/** The Deno source entrypoint, which is the `xmd` this suite runs. */
const ENTRYPOINT = fileURLToPath(new URL("../src/deno.ts", import.meta.url));

/**
 * The ACP agent this suite installs as `devin`.
 *
 * Written as a module the child runs directly, so nothing about the suite's own
 * imports, configuration or lock file reaches it. It answers the four requests
 * ACPX makes, sends the two messages Devin's compatibility shim exists for, and
 * appends one JSON line per connection to a report file.
 *
 * Its reply carries a token minted once per process. That is what makes a
 * second Prompt's answer depend on having reached the same live child: a token
 * can only be repeated by the process that minted it.
 */
const FAKE_AGENT = String.raw`
const report = Deno.env.get("DEVIN_FAKE_REPORT");
const argv = Deno.args;

// Exactly "acp", and nothing else. The bare command is Devin's interactive CLI,
// and a host that ran it would be starting a program that speaks no protocol.
if (argv.length !== 1 || argv[0] !== "acp") {
  Deno.writeTextFileSync(report, JSON.stringify({ kind: "refused", argv }) + "\n", {
    append: true,
  });
  console.error("this agent runs only as: devin acp");
  Deno.exit(64);
}

const token = crypto.randomUUID();
const connection = {
  kind: "connection",
  token,
  prompts: [],
  diagnostics: null,
  clientInfo: null,
  clientCapabilities: null,
};
let turns = 0;

// Appended after every observation rather than once at the end. A child that is
// killed mid-connection still leaves what it had seen, and the reader takes the
// last snapshot each token wrote.
function record() {
  Deno.writeTextFileSync(report, JSON.stringify(connection) + "\n", { append: true });
}

const encoder = new TextEncoder();
function send(message) {
  Deno.stdout.writeSync(encoder.encode(JSON.stringify(message) + "\n"));
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

const DIAGNOSTICS_ID = 1000;

function handle(message) {
  // The client's answer to the one request this agent makes. Read from the same
  // loop as everything else: an agent that waited for it inline would stop
  // reading its own input and never see the reply.
  if (message.id === DIAGNOSTICS_ID && message.method === undefined) {
    connection.diagnostics = message.result ?? null;
    record();
    return;
  }
  switch (message.method) {
    case "initialize": {
      connection.clientInfo = message.params?.clientInfo ?? null;
      connection.clientCapabilities = message.params?.clientCapabilities ?? null;
      record();
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        authMethods: [],
      });
      // The two things ACPX's Devin shim exists for: a diagnostics request only
      // a Windsurf-identified client answers, and vendor traffic a client is
      // expected to ignore rather than fail on.
      send({
        jsonrpc: "2.0",
        id: DIAGNOSTICS_ID,
        method: "_cognition.ai/request_diagnostics",
        params: {},
      });
      send({ jsonrpc: "2.0", method: "_cognition.ai/telemetry", params: { seen: true } });
      return;
    }
    case "session/new": {
      // Devin reports a display title and no provider-native conversation
      // identity. Both are stated here, so a run that promoted either into
      // durable state would be visible.
      respond(message.id, {
        sessionId: "devin-session-" + token,
        _meta: { "cognition.ai/title": "Release review" },
      });
      return;
    }
    case "session/prompt": {
      turns += 1;
      const text = (message.params?.prompt ?? [])
        .map((block) => (typeof block?.text === "string" ? block.text : ""))
        .join("");
      connection.prompts.push(text.slice(0, 24));
      record();
      // The token is minted once per process, so a second turn can only repeat
      // it by having reached the same live child.
      const reply = turns === 1 ? "MARK " + token : "AGAIN " + token;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: reply },
          },
        },
      });
      respond(message.id, {
        stopReason: "end_turn",
        _meta: { "cognition.ai/userMessageId": "user-message-" + turns },
      });
      return;
    }
    case "session/cancel":
      return;
    default: {
      if (message.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "method not found: " + message.method },
        });
      }
    }
  }
}

const decoder = new TextDecoder();
let buffered = "";
for await (const chunk of Deno.stdin.readable) {
  buffered += decoder.decode(chunk, { stream: true });
  let newline = buffered.indexOf("\n");
  while (newline >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line.length > 0) {
      handle(JSON.parse(line));
    }
    newline = buffered.indexOf("\n");
  }
}
`;

/** A document that takes two turns in one Devin session. */
const DOCUMENT = [
  "# Two turns in one live Devin session",
  "",
  '<Agent name="devin">',
  '<Session name="review">',
  "",
  '<Prompt as="first">',
  "Say the marker.",
  "</Prompt>",
  "",
  '<Prompt as="second">',
  "Say it again.",
  "</Prompt>",
  "",
  "</Session>",
  "</Agent>",
  "",
  "<Output>",
  "first={first}",
  "second={second}",
  "</Output>",
  "",
].join("\n");

/**
 * A document whose Session and Prompt name one Devin two different ways.
 *
 * ACPX resolves an unknown agent name to the name itself, so `devin acp` and
 * `devin` reach the same child through the same command — but this host
 * declares only the canonical `devin` invocation-scoped, because a lifetime is
 * never inferred from a command. Nothing about this is contrived: it is what a
 * document that writes the raw command produces.
 */
const MIXED_LIFETIME_DOCUMENT = [
  "# One Devin, named two ways",
  "",
  '<Agent name="devin acp">',
  '<Session name="review">',
  "",
  '<Prompt as="reply" agent="devin">',
  "Say the marker.",
  "</Prompt>",
  "",
  "</Session>",
  "</Agent>",
  "",
  "<Output>",
  "reply={reply}",
  "</Output>",
  "",
].join("\n");

/** One connection the fake agent reported, reduced to what a case may read. */
interface Connection {
  kind: string;
  token: string;
  prompts: string[];
  diagnostics: unknown;
  clientInfo: { name?: string; version?: string } | null;
  clientCapabilities?: { _meta?: Record<string, unknown> } | null;
  argv?: string[];
}

interface Harness {
  /** The directory the CLI is invoked from, and the document lives in. */
  work: string;
  /** The home this invocation reads and writes provider state under. */
  home: string;
  /** Where the fake agent appends what each connection carried. */
  report: string;
  environment: Record<string, string>;
}

function* useDevinHarness(): Operation<Harness> {
  // Canonical, so what this fixture names and what a child reports are one
  // string on a platform whose temporary root is a symlink.
  const root = yield* until(realpath(yield* useTempDirectory("xmd-devin-")));
  const bin = join(root, "bin");
  const work = join(root, "work");
  const home = join(root, "home");
  for (const directory of [bin, work, home]) {
    yield* ensureDir(directory);
  }
  const agent = join(root, "devin-agent.mjs");
  const report = join(root, "connections.jsonl");
  yield* writeTextFile(agent, FAKE_AGENT);
  yield* writeTextFile(join(work, "document.md"), DOCUMENT);
  yield* writeTextFile(join(work, "mixed-lifetime.md"), MIXED_LIFETIME_DOCUMENT);

  // The paths are written into the shim rather than read from its environment:
  // what a spawned agent inherits is ACPX's business, and a fixture that
  // depended on it would be testing that instead.
  const shim = [
    "#!/bin/sh",
    `exec ${JSON.stringify(process.execPath)} run --allow-all --quiet --no-config ` +
      `${JSON.stringify(agent)} "$@"`,
    "",
  ].join("\n");
  const devin = join(bin, "devin");
  yield* writeTextFile(devin, shim);
  yield* until(chmod(devin, 0o755));

  return {
    work,
    home,
    report,
    environment: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      // A home of this invocation's own, which is where ACPX would keep a
      // durable session record — so "nothing durable names Devin" is a claim
      // about a directory this suite created and can read.
      HOME: home,
      DEVIN_FAKE_REPORT: report,
      // Stated rather than inherited from `HOME`: the module cache belongs to
      // the machine, and a child pointed at an empty home would refetch the
      // whole dependency graph over the network.
      DENO_DIR: denoDirectory(),
    },
  };
}

/**
 * The module cache this machine resolves through.
 *
 * Asked of Deno rather than derived from a platform rule, because the answer
 * differs by platform and by whether `DENO_DIR` is set, and a fixture that
 * guessed wrong would fail as a network error.
 */
function denoDirectory(): string {
  const configured = process.env.DENO_DIR;
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  const info = spawnSync(process.execPath, ["info", "--json"], { encoding: "utf8" });
  const reported: unknown = JSON.parse(typeof info.stdout === "string" ? info.stdout : "{}");
  if (
    typeof reported === "object" &&
    reported !== null &&
    "denoDir" in reported &&
    typeof reported.denoDir === "string"
  ) {
    return reported.denoDir;
  }
  throw new Error("this runtime reported no module cache directory");
}

interface Invocation {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** One `xmd run`, exactly as an operator would type it. */
function runXmd(harness: Harness, args: readonly string[]): Invocation {
  const outcome = spawnSync(process.execPath, ["run", "--allow-all", ENTRYPOINT, ...args], {
    cwd: harness.work,
    env: harness.environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: outcome.status,
    stdout: typeof outcome.stdout === "string" ? outcome.stdout : "",
    stderr: typeof outcome.stderr === "string" ? outcome.stderr : "",
  };
}

/**
 * What each connection had seen by the time it stopped writing.
 *
 * The agent appends a snapshot per observation, so the last line a token wrote
 * is the whole of what that connection carried. Grouping by token is also what
 * separates the availability probe's child — which is closed before it can read
 * the client's answer — from the one that served the turns.
 */
function* connections(harness: Harness): Operation<Connection[]> {
  const found = yield* stat(harness.report);
  if (!found.exists) {
    return [];
  }
  const text = yield* readTextFile(harness.report);
  const latest = new Map<string, Connection>();
  const refusals: Connection[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry: Connection = JSON.parse(line);
    if (entry.kind === "refused") {
      refusals.push(entry);
      continue;
    }
    latest.set(entry.token, entry);
  }
  return [...refusals, ...latest.values()];
}

/**
 * The failure each retained Prompt recorded, in order.
 *
 * The journal is where a Prompt's outcome is written down, so it says why a run
 * failed even when nothing printed the reason. Read as text and parsed per
 * line, because a trace is one JSON record per line.
 */
function* promptFailures(journal: string): Operation<string[]> {
  const text = yield* readTextFile(journal);
  const messages: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const event: unknown = JSON.parse(line);
    const value = reachInto(event, ["description", "type"]);
    if (value !== "agent_prompt") {
      continue;
    }
    const message = reachInto(event, ["result", "value", "error", "message"]);
    if (typeof message === "string") {
      messages.push(message);
    }
  }
  return messages;
}

/** One nested member, or nothing. Parsed rather than asserted: a journal is data. */
function reachInto(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = Reflect.get(current, key);
  }
  return current;
}

/** Every marker the run reported, in order. */
function markers(stdout: string): string[] {
  return [...stdout.matchAll(/(?:MARK|AGAIN) ([0-9a-f-]{36})/g)].map((match) => match[1]!);
}

describe("Tier DV — Devin through the production run path", () => {
  it("DV1: one invocation runs `devin acp` and keeps one live conversation across two Prompts", function* () {
    const harness = yield* useDevinHarness();

    const first = runXmd(harness, ["run", "document.md", "--default-agent", "devin"]);
    expect(`${first.status}: ${first.stderr}`).toBe("0: ");

    // Both Prompts came back, and the second repeated the token the first
    // minted — which only the process that minted it can do. One session, one
    // live child, two turns.
    const seen = markers(first.stdout);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(first.stdout).toContain("first=MARK ");
    expect(first.stdout).toContain("second=AGAIN ");

    const reported = yield* connections(harness);
    // Nothing was ever started with another argument vector. The agent refuses
    // anything but `acp` and records that it did, so an empty list here is the
    // absence of a refusal rather than the absence of a run.
    expect(reported.filter((entry) => entry.kind === "refused")).toEqual([]);
    expect(reported).not.toEqual([]);
    // Windsurf, because that is the client identity Devin's backend expects,
    // and the capability that makes the diagnostics exchange legal. Every
    // connection carries it, the availability probe's included.
    for (const entry of reported) {
      expect(entry.clientInfo?.name).toBe("windsurf");
      expect(typeof entry.clientInfo?.version).toBe("string");
      expect(entry.clientCapabilities?._meta).toMatchObject({
        "cognition.ai/requestDiagnostics": true,
      });
    }
    // The connection that served the turns is the one that stayed open long
    // enough to read the client's answer: an empty object, exactly as ACPX's
    // shim replies. The vendor notification sent beside it failed nothing.
    const prompting = reported.filter((entry) => entry.prompts.length > 0);
    expect(prompting).toHaveLength(1);
    expect(prompting[0]!.diagnostics).toEqual({});
    expect(prompting[0]!.prompts).toHaveLength(2);
    expect(prompting[0]!.token).toBe(seen[0]);

    // A second invocation, same directory and same home: a fresh conversation
    // rather than a continuation, because nothing about the first was retained.
    const second = runXmd(harness, ["run", "document.md", "--default-agent", "devin"]);
    expect(`${second.status}: ${second.stderr}`).toBe("0: ");
    const later = markers(second.stdout);
    expect(later).toHaveLength(2);
    expect(later[0]).toBe(later[1]);
    expect(later[0]).not.toBe(seen[0]);
  });

  it("DV2: nothing durable names Devin, and an ordinary journal is this run's trace", function* () {
    const harness = yield* useDevinHarness();

    const journal = join(harness.work, "trace.jsonl");
    const outcome = runXmd(harness, [
      "run",
      "document.md",
      "--default-agent",
      "devin",
      "--journal",
      journal,
    ]);
    expect(`${outcome.status}: ${outcome.stderr}`).toBe("0: ");

    // ACPX's durable store lives beneath the home this invocation was given,
    // and a session it retained is a file in it. A durable agent does write one
    // there — Tier AI's mixed case is the other side of this comparison, taken
    // in process where both lifetimes can be watched at once.
    const stored = join(harness.home, ".acpx", "sessions");
    const records: string[] = [];
    if ((yield* stat(stored)).exists) {
      for (const entry of yield* until(readdir(stored))) {
        records.push(yield* readTextFile(join(stored, entry)));
      }
    }
    expect(records).toEqual([]);

    // The journal was created and holds this invocation's own Prompt trace.
    // It is a trace, not continuation state: the second run below creates a
    // new one and starts a new conversation all the same.
    expect((yield* stat(journal)).exists).toBe(true);
    const trace = yield* readTextFile(journal);
    expect(trace).toContain("Prompt");

    const before = markers(outcome.stdout)[0];
    const again = runXmd(harness, [
      "run",
      "document.md",
      "--default-agent",
      "devin",
      "--journal",
      join(harness.work, "second.jsonl"),
    ]);
    expect(`${again.status}: ${again.stderr}`).toBe("0: ");
    expect(markers(again.stdout)[0]).not.toBe(before);
  });

  it("DV3: a Session and a Prompt naming one Devin two ways fails closed", function* () {
    const harness = yield* useDevinHarness();

    const journal = join(harness.work, "mixed.jsonl");
    const outcome = runXmd(harness, ["run", "mixed-lifetime.md", "--journal", journal]);

    // The Session is placed under the raw command name, which this host serves
    // durably; the Prompt names the canonical one, which it serves for the
    // invocation only. One command, one child, two lifetimes — and continuing
    // that placement would have run a Devin turn as a durable session.
    expect(outcome.status).not.toBe(0);

    // Why it failed, from the record rather than from what a terminal printed:
    // a run that failed for some other reason would satisfy the exit status.
    const failures = yield* promptFailures(journal);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('agent "devin" (invocation sessions)');
    expect(failures[0]).toContain("(durable sessions)");

    // No turn reached the agent: the refusal is ahead of the ensure.
    const reported = yield* connections(harness);
    expect(reported.filter((entry) => entry.prompts.length > 0)).toEqual([]);

    // And nothing durable was written for either name.
    const stored = join(harness.home, ".acpx", "sessions");
    const records: string[] = [];
    if ((yield* stat(stored)).exists) {
      for (const entry of yield* until(readdir(stored))) {
        records.push(yield* readTextFile(join(stored, entry)));
      }
    }
    expect(records).toEqual([]);
  });
});
