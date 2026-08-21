/**
 * Tier SL — `<Session.Launch>` and `Agent.launch()`
 * (specs/native-agent-session-launch-spec.md).
 *
 * Everything here drives `execute()` against a stub launch provider and a
 * controlled launcher, so what it asserts is what a document gets. The stub
 * goes through the real seam — it records each phase through
 * `AgentLaunchJournal` and asks the real `NativeLauncher` Api to run the
 * child — so the ordering, the retained records and the refusals are the
 * production ones, with only the provider's own product replaced.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { ensure, scoped, spawn, withResolvers } from "effection";
import type { Operation, Result, WithResolvers } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { LaunchResolution, resolvingLaunch } from "../src/agent/launch.ts";
import { parsePrepared, serializePrepared } from "../src/agent/launch-journal.ts";
import { execute } from "../src/execute.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type { Session } from "../src/agent/agent-api.ts";
import { AgentLaunchJournal } from "../src/agent/launch.ts";
import type { ExitedLaunchRecord, PreparedLaunchRecord } from "../src/agent/launch.ts";
import { installAgentComponents } from "../src/agent/components.ts";
import type { AgentProviderFactory } from "../src/agent/provider-api.ts";
import {
  API,
  installControlledLauncher,
  NATIVE_LAUNCHER_UNAVAILABLE,
  nativeLaunch,
  useHostFiles,
} from "@executablemd/runtime";
import type { NativeLaunchOutcome, NativeLaunchRequest } from "@executablemd/runtime";
import type { Json } from "../src/types.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A synthetic GitHub token, format-realistic and assembled here. */
const CANARY = ["ghp", "_", ALPHABET.slice(0, 36)].join("");

interface LaunchStub {
  factory: AgentProviderFactory;
  /** Every agent this provider was asked to resolve, in order. */
  agentLookups: (string | undefined)[];
  /** Resolutions that were *not* marked as a launch's own. */
  availabilityChecks: number;
  /** Instructions each *live* preparation received, in order. */
  preparations: string[];
  detaches: number;
  /** Live exit phases — one per native child this provider actually started. */
  exits: number;
  factoryActivations: number;
  nativeSessionId: string;
  /** Return a result without recording any phase. */
  fabricate?: boolean;
  /** Reach the native child without releasing ACP ownership first. */
  skipDetach?: boolean;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function createLaunchStub(overrides: Partial<LaunchStub> = {}): LaunchStub {
  const stub: LaunchStub = {
    agentLookups: [],
    availabilityChecks: 0,
    preparations: [],
    detaches: 0,
    exits: 0,
    factoryActivations: 0,
    nativeSessionId: "native-abc",
    ...overrides,
    factory: function* () {
      stub.factoryActivations++;
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *agent([name]) {
            stub.agentLookups.push(name);
            // What a provider that has to look at the world does here, and the
            // whole reason the signal exists: a bound agent's availability
            // costs an observation, so the provider defers it into `prepared`
            // rather than paying it on every replay.
            if (!(yield* LaunchResolution.get())) {
              stub.availabilityChecks += 1;
            }
            return name ?? "stub-agent";
          },
          // deno-lint-ignore require-yield
          *session([name]) {
            const session: Session = { sessionKey: `stub:${name ?? "default"}`, cwd: "/repo" };
            return session;
          },
          *launch([instructions, options]) {
            // Marked, as a provider's own launch resolution is: this runs
            // before the journal decides whether anything is performed.
            const agent = yield* resolvingLaunch(() => Agent.operations.agent(options?.agent));
            const sessionKey =
              typeof options?.session === "object"
                ? options.session.sessionKey
                : `stub:${options?.session ?? "default"}`;

            if (stub.fabricate) {
              // Structural data alone, from middleware that did no work.
              return {
                agent,
                session: { sessionKey, cwd: "/repo" },
                nativeSessionId: "invented",
                launcher: "stub",
              };
            }

            const prepared = yield* AgentLaunchJournal.operations.recordPreparation(
              // deno-lint-ignore require-yield
              function* (): Operation<PreparedLaunchRecord> {
                stub.preparations.push(instructions);
                return {
                  phase: "prepared",
                  agent,
                  sessionKey,
                  provider: "stub",
                  nativeSessionId: stub.nativeSessionId,
                  sessionState: "created",
                  instructionChannel: "stub.systemPrompt",
                  instructionReconciliation: "installed",
                  instructionsDigest: digest(instructions),
                  instructions,
                  cwd: "/repo",
                  additionalDirectories: [],
                  permissionMode: "deny-all",
                  launcher: "stub",
                  identityProvenance: "provider-returned",
                };
              },
            );

            if (!stub.skipDetach) {
              yield* AgentLaunchJournal.operations.recordDetach(
                // deno-lint-ignore require-yield
                function* () {
                  stub.detaches++;
                  return { phase: "detached" as const };
                },
              );
            }

            yield* AgentLaunchJournal.operations.recordExit(
              function* (): Operation<ExitedLaunchRecord> {
                stub.exits++;
                const outcome = yield* nativeLaunch({
                  command: ["stub-ui", "--resume", prepared.nativeSessionId],
                  cwd: prepared.cwd,
                });
                const exited: ExitedLaunchRecord = { phase: "exited" };
                if (outcome.exitCode !== undefined) {
                  exited.exitCode = outcome.exitCode;
                }
                if (outcome.signal !== undefined) {
                  exited.signal = outcome.signal;
                }
                return exited;
              },
            );

            return {
              agent: prepared.agent,
              session: { sessionKey: prepared.sessionKey, cwd: prepared.cwd },
              nativeSessionId: prepared.nativeSessionId,
              launcher: prepared.launcher,
            };
          },
        },
        { at: "min" },
      );
    },
  };
  return stub;
}

interface LauncherLog {
  reserved: number;
  flushed: number;
  requests: NativeLaunchRequest[];
  /** Every launcher event in order, so `flush` before `launch` is provable. */
  order: string[];
}

interface RunOptions {
  files?: Record<string, string>;
  stream?: InMemoryStream;
  stub?: LaunchStub;
  /** Omit to install the controlled launcher; false leaves the base one. */
  launcher?: false;
  outcome?: NativeLaunchOutcome;
  /** Blocks the native child until resolved; `arrived` fires when it starts. */
  hold?: WithResolvers<void>;
  arrived?: WithResolvers<void>;
  /** Refuse the terminal reservation, the way an already-held one does. */
  contendedTerminal?: boolean;
  secretDetection?: boolean;
}

interface Run {
  output: string;
  result: Result<Json>;
  stub: LaunchStub;
  launcher: LauncherLog;
  events: DurableEvent[];
}

function* runDoc(doc: string, options: RunOptions = {}): Operation<Run> {
  const stub = options.stub ?? createLaunchStub();
  const launcher: LauncherLog = { reserved: 0, flushed: 0, requests: [], order: [] };
  const stream = options.stream ?? new InMemoryStream();
  const dir = path.join(os.tmpdir(), `xmd-sl-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    for (const [name, source] of Object.entries(options.files ?? {})) {
      const target = path.join(dir, name);
      yield* ensureDir(path.dirname(target));
      yield* writeTextFile(target, source);
    }
    const docPath = path.join(dir, "doc.md");
    yield* writeTextFile(docPath, doc);
    // The document's own directory is the contextual cwd, so an authored
    // relative path resolves the way it would for someone running xmd there.
    yield* API.Env.around({
      // deno-lint-ignore require-yield
      *cwd() {
        return dir;
      },
    });
    yield* useHostFiles();

    if (options.launcher !== false) {
      yield* installControlledLauncher({
        onReserve: () => {
          launcher.reserved++;
          launcher.order.push("reserve");
          if (options.contendedTerminal) {
            throw new Error(
              "another <Session.Launch> already holds this run's terminal — one " +
                "native UI owns the terminal at a time",
            );
          }
        },
        onFlush: () => {
          launcher.flushed++;
          launcher.order.push("flush");
        },
        record: (request) => {
          launcher.requests.push(request);
          launcher.order.push("launch");
        },
        ...(options.hold
          ? {
              wait: (_request) =>
                (function* () {
                  options.arrived?.resolve();
                  yield* options.hold!.operation;
                })(),
            }
          : {}),
        outcome: () => options.outcome ?? { exitCode: 0 },
      });
    }

    yield* installAgentComponents({
      rootProvider: {
        factory: stub.factory,
        options: { defaultAgent: "stub-agent", permissionMode: "deny-all" },
      },
    });

    const execution = yield* execute({
      path: docPath,
      stream,
      componentDirs: [dir],
      ...(options.secretDetection === undefined
        ? {}
        : { secretDetection: options.secretDetection }),
    });
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    return {
      output: next.value,
      result: yield* execution,
      stub,
      launcher,
      events: yield* stream.readAll(),
    };
  });
}

/** Halt the document while the native child is still running. */
function* runInterrupted(
  doc: string,
  stream: InMemoryStream,
  stub: LaunchStub,
): Operation<LauncherLog> {
  const arrived = withResolvers<void>();
  const hold = withResolvers<void>();
  const launcher: LauncherLog = { reserved: 0, flushed: 0, requests: [], order: [] };
  const dir = path.join(os.tmpdir(), `xmd-sl-${randomUUID()}`);
  yield* ensureDir(dir);
  yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    const docPath = path.join(dir, "doc.md");
    yield* writeTextFile(docPath, doc);
    yield* scoped(function* () {
      yield* installControlledLauncher({
        onReserve: () => launcher.reserved++,
        onFlush: () => launcher.flushed++,
        record: (request) => launcher.requests.push(request),
        wait: () =>
          (function* () {
            arrived.resolve();
            yield* hold.operation;
          })(),
      });
      yield* installAgentComponents({
        rootProvider: {
          factory: stub.factory,
          options: { defaultAgent: "stub-agent", permissionMode: "deny-all" },
        },
      });
      const execution = yield* execute({ path: docPath, stream });
      yield* spawn(function* () {
        const subscription = yield* execution.output;
        let next = yield* subscription.next();
        while (!next.done) {
          next = yield* subscription.next();
        }
      });
      // Leaving this scope halts the execution with the child still live,
      // which is the state a crashed run leaves its journal in.
      yield* arrived.operation;
    });
  });
  return launcher;
}

function launchRecords(events: DurableEvent[]): { name: string; value: Json | undefined }[] {
  return events.flatMap((event) =>
    event.type === "yield" &&
    event.description.type === "agent_session_launch" &&
    event.result.status === "ok"
      ? [{ name: event.description.name, value: event.result.value }]
      : [],
  );
}

function preparedRecord(events: DurableEvent[]): Record<string, Json> {
  const prepared = launchRecords(events).find((record) => record.name.endsWith("/prepared"));
  if (!prepared || typeof prepared.value !== "object" || prepared.value === null) {
    throw new Error("no prepared launch record");
  }
  return prepared.value as Record<string, Json>;
}

const LAUNCH = "<Session.Launch>\nYou are the implementor.\n</Session.Launch>\n";

describe("Tier SL — native session launch", () => {
  it("SL1: without a provider the launch fails, and nothing is reserved or spawned", function* () {
    const launcher: LauncherLog = { reserved: 0, flushed: 0, requests: [], order: [] };
    const dir = path.join(os.tmpdir(), `xmd-sl-${randomUUID()}`);
    yield* ensureDir(dir);
    const result = yield* scoped(function* () {
      yield* ensure(() => rm(dir, { recursive: true, force: true }));
      const docPath = path.join(dir, "doc.md");
      yield* writeTextFile(docPath, LAUNCH);
      yield* installControlledLauncher({
        record: (request) => launcher.requests.push(request),
      });
      // Registered, but with no root provider: `prompt()` and `launch()` alike
      // fall through to the base handlers.
      yield* installAgentComponents();
      const execution = yield* execute({ path: docPath, stream: new InMemoryStream() });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      return yield* execution;
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("Agent.agent() has no provider");
    expect(launcher.requests.length).toBe(0);
  });

  it("SL2: a provider that answers prompt() does not thereby answer launch()", function* () {
    const dir = path.join(os.tmpdir(), `xmd-sl-${randomUUID()}`);
    yield* ensureDir(dir);
    const result = yield* scoped(function* () {
      yield* ensure(() => rm(dir, { recursive: true, force: true }));
      const docPath = path.join(dir, "doc.md");
      yield* writeTextFile(docPath, LAUNCH);
      yield* installControlledLauncher();
      yield* installAgentComponents({
        rootProvider: {
          // Answers agent/session/prompt and nothing else — the shape a
          // provider written before native launch existed still has.
          factory: function* () {
            yield* Agent.around(
              {
                // deno-lint-ignore require-yield
                *agent([name]) {
                  return name ?? "stub-agent";
                },
                // deno-lint-ignore require-yield
                *session([name]) {
                  return { sessionKey: `stub:${name ?? "default"}`, cwd: "/repo" };
                },
              },
              { at: "min" },
            );
          },
          options: { defaultAgent: "stub-agent", permissionMode: "deny-all" },
        },
      });
      const execution = yield* execute({ path: docPath, stream: new InMemoryStream() });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      return yield* execution;
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("Agent.launch() has no provider");
  });

  it("SL3: only the rendered body crosses as instructions, and the launch renders nothing", function* () {
    const run = yield* runDoc(
      [
        "# Repository Agents",
        "",
        "The implementor makes changes according to the approved plan.",
        "",
        "<Session.Launch>",
        "You are the repository implementor.",
        "",
        '<File path="role.md" />',
        "</Session.Launch>",
        "",
        "Afterwards the document continues.",
        "",
      ].join("\n"),
      { files: { "role.md": "Follow the approved plan.\n" } },
    );

    expect(run.result.ok ? "" : run.result.error.message).toBe("");
    expect(run.stub.preparations.length).toBe(1);
    const instructions = run.stub.preparations[0]!;
    expect(instructions).toContain("You are the repository implementor.");
    expect(instructions).toContain("Follow the approved plan.");
    // Prose around the element is documentation, not instructions.
    expect(instructions).not.toContain("The implementor makes changes");
    expect(instructions).not.toContain("Afterwards the document continues");
    // The element itself renders nothing; the surrounding prose is untouched.
    expect(run.output).toContain("Afterwards the document continues.");
    expect(run.output).not.toContain("You are the repository implementor.");
  });

  it("SL3b: a body that failed to render prepares nothing and launches nothing", function* () {
    const run = yield* runDoc(
      [
        "<Session.Launch>",
        "You are the implementor.",
        '<File path="absent.md" />',
        "</Session.Launch>",
        "",
      ].join("\n"),
    );

    expect(run.stub.preparations.length).toBe(0);
    expect(run.launcher.reserved).toBe(0);
    expect(run.launcher.requests.length).toBe(0);
    expect(run.output).toContain("cannot read");
  });

  it("SL4: an empty body is a valid launch that prepares no instructions", function* () {
    const run = yield* runDoc("<Session.Launch />\n");

    expect(run.result.ok).toBe(true);
    expect(run.stub.preparations).toEqual([""]);
  });

  it("SL5: the document surface is exactly agent and session", function* () {
    const run = yield* runDoc('<Session.Launch command="claude" />\n');

    expect(run.result.ok).toBe(false);
    expect(run.result.ok ? "" : run.result.error.message).toContain(
      "Prop validation failed for <Session.Launch />",
    );
    expect(run.stub.preparations.length).toBe(0);
    expect(run.launcher.requests.length).toBe(0);
  });

  it("SL6: a repository Session/Launch.md replaces the default", function* () {
    const run = yield* runDoc("<Session.Launch />\n", {
      files: { "Session/Launch.md": "the repository launch\n" },
      // The repository component never reaches a provider, so no launcher is
      // needed and none may be asked for.
    });

    expect(run.result.ok ? "" : run.result.error.message).toBe("");
    expect(run.output).toContain("the repository launch");
    expect(run.stub.preparations.length).toBe(0);
    expect(run.launcher.reserved).toBe(0);
  });

  it("SL7: the terminal is reserved and output flushed before the child starts", function* () {
    const run = yield* runDoc(LAUNCH);

    expect(run.result.ok).toBe(true);
    expect(run.launcher.order).toEqual(["reserve", "flush", "launch"]);
    expect(run.launcher.requests[0]?.command).toEqual([
      "stub-ui",
      "--resume",
      run.stub.nativeSessionId,
    ]);
  });

  it("SL8: a host with no launcher refuses before an agent is even resolved", function* () {
    const run = yield* runDoc(LAUNCH, { launcher: false });

    expect(run.result.ok).toBe(false);
    expect(run.result.ok ? "" : run.result.error.message).toContain(NATIVE_LAUNCHER_UNAVAILABLE);
    // Nothing was asked of the provider at all — not availability, not a
    // session, not a preparation — so no ownership could have moved.
    expect(run.stub.agentLookups.length).toBe(0);
    expect(run.stub.preparations.length).toBe(0);
    expect(run.stub.detaches).toBe(0);
  });

  it("SL22: a launch that cannot take the terminal never reaches the provider", function* () {
    // What a second launch meets while the first one's native UI still owns
    // the run's terminal. The reservation comes before the agent is resolved,
    // so contention there costs nothing: no availability question, no session,
    // no preparation, and nothing retained to resume from.
    const run = yield* runDoc(LAUNCH, { contendedTerminal: true });

    expect(run.result.ok).toBe(false);
    expect(run.result.ok ? "" : run.result.error.message).toContain(
      "already holds this run's terminal",
    );
    expect(run.launcher.reserved).toBe(1);
    expect(run.launcher.flushed).toBe(0);
    expect(run.stub.agentLookups.length).toBe(0);
    expect(run.stub.preparations.length).toBe(0);
    expect(run.stub.detaches).toBe(0);
    expect(run.launcher.requests).toEqual([]);
  });

  it("SL9: the durable record retains identity, channel, digest and authority", function* () {
    const run = yield* runDoc(LAUNCH);

    expect(run.result.ok).toBe(true);
    const record = preparedRecord(run.events);
    expect(record.phase).toBe("prepared");
    expect(record.nativeSessionId).toBe("native-abc");
    expect(record.provider).toBe("stub");
    expect(record.launcher).toBe("stub");
    expect(record.sessionState).toBe("created");
    expect(record.instructionChannel).toBe("stub.systemPrompt");
    // The body is retained exactly as it rendered, and the digest is of that
    // exact text — not of a tidied version of it.
    expect(record.instructions).toBe("\nYou are the implementor.\n");
    expect(record.instructionsDigest).toBe(digest("\nYou are the implementor.\n"));
    expect(record.additionalDirectories).toEqual([]);
    expect(record.permissionMode).toBe("deny-all");

    const names = launchRecords(run.events).map((entry) => entry.name);
    expect(names.some((name) => name.endsWith("/prepared"))).toBe(true);
    expect(names.some((name) => name.endsWith("/detached"))).toBe(true);
    expect(names.some((name) => name.endsWith("/exited"))).toBe(true);
  });

  it("SL10: a nonzero native exit fails the document and keeps the session facts", function* () {
    const run = yield* runDoc(LAUNCH, { outcome: { exitCode: 3 } });

    expect(run.result.ok).toBe(false);
    expect(run.result.ok ? "" : run.result.error.message).toContain("exited with status 3");
    // The provider session is not rolled back, and its identity is still what
    // a later run would resume.
    expect(preparedRecord(run.events).nativeSessionId).toBe("native-abc");
  });

  it("SL11: a signalled native exit fails the document", function* () {
    const run = yield* runDoc(LAUNCH, { outcome: { signal: "SIGTERM" } });

    expect(run.result.ok).toBe(false);
    expect(run.result.ok ? "" : run.result.error.message).toContain("terminated by SIGTERM");
  });

  it("SL12: a launch that never released ACP ownership is refused", function* () {
    const run = yield* runDoc(LAUNCH, { stub: createLaunchStub({ skipDetach: true }) });

    expect(run.result.ok).toBe(false);
    expect(run.result.ok ? "" : run.result.error.message).toContain(
      "launched without releasing its ACP session",
    );
  });

  it("SL13: a result nothing performed is not a launch", function* () {
    const run = yield* runDoc(LAUNCH, { stub: createLaunchStub({ fabricate: true }) });

    expect(run.result.ok).toBe(false);
    expect(run.result.ok ? "" : run.result.error.message).toContain(
      "returned a launch result without preparing a session",
    );
    expect(run.launcher.requests.length).toBe(0);
    expect(launchRecords(run.events).length).toBe(0);
  });

  it("SL14: full replay launches no process and never enters the provider", function* () {
    const stream = new InMemoryStream();
    const stub = createLaunchStub();
    const first = yield* runDoc(LAUNCH, { stream, stub });
    expect(first.result.ok).toBe(true);
    expect(first.stub.factoryActivations).toBe(1);
    expect(first.launcher.requests.length).toBe(1);

    const second = yield* runDoc(LAUNCH, { stream, stub });
    expect(second.result.ok).toBe(true);
    expect(second.output).toBe(first.output);
    // No provider factory, no preparation, no reservation, no child.
    expect(stub.factoryActivations).toBe(1);
    expect(stub.preparations.length).toBe(1);
    expect(second.launcher.reserved).toBe(0);
    expect(second.launcher.requests.length).toBe(0);
  });

  it("SL14b: a completed replay resolves no agent availability at the component boundary", function* () {
    // `<Session.Launch>` resolves its agent *before* installing the journal,
    // which is right for reporting a missing agent as an expansion failure and
    // wrong for a provider whose availability answer costs a look at the
    // world. A completed launch performs no phase, so a look taken here would
    // be taken on every replay of a launch that does nothing.
    const stream = new InMemoryStream();
    const stub = createLaunchStub();
    const first = yield* runDoc(LAUNCH, { stream, stub });
    expect(first.result.ok).toBe(true);
    // Even live, the launch's own resolution is marked, so the provider knows
    // to defer. Nothing else in the document asks for an agent.
    expect(stub.agentLookups.length).toBeGreaterThan(0);
    expect(stub.availabilityChecks).toBe(0);

    const second = yield* runDoc(LAUNCH, { stream, stub });

    expect(second.result.ok).toBe(true);
    // The agent is still resolved — the launch needs its name — but nothing
    // that costs an observation happens, on either run.
    expect(stub.availabilityChecks).toBe(0);
    expect(second.launcher.requests.length).toBe(0);
  });

  it("SL14c: the signal is narrowly scoped and does not leak past a resolution", function* () {
    // The other half of the contract. Only a launch's own resolution defers;
    // an agent asked for any other reason still gets the provider's full
    // availability answer, which is what makes an unavailable agent fail that
    // operation instead of quietly succeeding.
    expect(yield* LaunchResolution.get()).toBe(false);
    expect(yield* resolvingLaunch(() => LaunchResolution.get())).toBe(true);

    // And it is gone again afterwards, so a launch cannot leave every later
    // resolution in the document deferring too.
    yield* resolvingLaunch(function* () {
      return yield* LaunchResolution.get();
    });
    expect(yield* LaunchResolution.get()).toBe(false);
  });

  it("SL15: partial replay resumes the retained identity without preparing again", function* () {
    const stream = new InMemoryStream();
    const stub = createLaunchStub();

    const interrupted = yield* runInterrupted(LAUNCH, stream, stub);
    expect(interrupted.requests.length).toBe(1);
    expect(stub.preparations.length).toBe(1);
    expect(stub.detaches).toBe(1);
    // The child never exited, so no exit phase was retained.
    const afterCrash = yield* stream.readAll();
    const crashNames = launchRecords(afterCrash).map((entry) => entry.name);
    expect(crashNames.some((name) => name.endsWith("/prepared"))).toBe(true);
    expect(crashNames.some((name) => name.endsWith("/detached"))).toBe(true);
    expect(crashNames.some((name) => name.endsWith("/exited"))).toBe(false);

    const resumed = yield* runDoc(LAUNCH, { stream, stub });
    expect(resumed.result.ok).toBe(true);
    // Preparation and detach replayed; neither ran again, so no replacement
    // session was created.
    expect(stub.preparations.length).toBe(1);
    expect(stub.detaches).toBe(1);
    // The native UI reattached to the identity the first attempt retained.
    expect(resumed.launcher.requests.length).toBe(1);
    expect(resumed.launcher.requests[0]?.command).toEqual(["stub-ui", "--resume", "native-abc"]);
  });

  it("SL16: a credential in prepared instructions stops persistence and the handoff", function* () {
    const run = yield* runDoc(
      ["<Session.Launch>", `Use the token ${CANARY} to publish.`, "</Session.Launch>", ""].join(
        "\n",
      ),
    );

    expect(run.result.ok).toBe(false);
    // The provider was asked to prepare, but the record could not persist, so
    // ownership never moved and no child started.
    expect(run.stub.detaches).toBe(0);
    expect(run.launcher.requests.length).toBe(0);
    // Nothing carrying the value reached the journal.
    const serialized = JSON.stringify(run.events);
    expect(serialized).not.toContain(CANARY);
  });

  it("SL17: two launches in one document keep distinct durable identities", function* () {
    const run = yield* runDoc(
      [
        "<Session.Launch>",
        "first",
        "</Session.Launch>",
        "",
        "<Session.Launch>",
        "second",
        "</Session.Launch>",
        "",
      ].join("\n"),
    );

    expect(run.result.ok).toBe(true);
    expect(run.stub.preparations.map((text) => text.trim())).toEqual(["first", "second"]);
    const names = launchRecords(run.events)
      .map((entry) => entry.name)
      .filter((name) => name.endsWith("/prepared"));
    expect(names.length).toBe(2);
    expect(new Set(names).size).toBe(2);
  });

  it("SL19: a client-allocated record round-trips with the build it was bound to", function* () {
    const record: PreparedLaunchRecord = {
      phase: "prepared",
      agent: "claude",
      sessionKey: "session:main",
      provider: "acp",
      nativeSessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      sessionState: "created",
      instructionChannel: "acp.session.systemPrompt",
      instructionReconciliation: "installed",
      instructionsDigest: digest("body"),
      instructions: "body",
      cwd: "/repo",
      additionalDirectories: [],
      permissionMode: "deny-all",
      launcher: "claude",
      identityProvenance: "client-allocated",
      executableBinding: {
        schema: "executable-build.v1",
        reportedVersion: "2.1.235 (Claude Code)",
        executableDigest: { algorithm: "sha256", value: "a".repeat(64) },
      },
    };

    // Read back as written: a replay that recovered a different record would
    // resume a session under terms nobody agreed to.
    expect(parsePrepared(serializePrepared(record))).toEqual(record);
  });

  it("SL23: a session-busy refusal round-trips as its own class", function* () {
    // Contention is not breakage, and the class is what says so: a replay that
    // read it back as `unsupported-capability` would tell the reader the host
    // cannot do this at all, when what happened is that someone else was in
    // the session at that moment.
    const record: PreparedLaunchRecord = {
      phase: "prepared",
      agent: "claude",
      sessionKey: "session:main",
      provider: "acp",
      nativeSessionId: "",
      sessionState: "created",
      instructionChannel: "acp.session.systemPrompt",
      instructionReconciliation: "installed",
      instructionsDigest: "",
      instructions: "",
      cwd: "/repo",
      additionalDirectories: [],
      permissionMode: "deny-all",
      launcher: "claude",
      identityProvenance: "provider-returned",
      failure: { class: "session-busy", message: "another XMD owner is using it" },
    };

    expect(parsePrepared(serializePrepared(record))).toEqual(record);
  });

  it("SL20: an incomplete client allocation is refused rather than repaired", function* () {
    const complete: PreparedLaunchRecord = {
      phase: "prepared",
      agent: "claude",
      sessionKey: "session:main",
      provider: "acp",
      nativeSessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      sessionState: "created",
      instructionChannel: "acp.session.systemPrompt",
      instructionReconciliation: "installed",
      instructionsDigest: digest("body"),
      instructions: "body",
      cwd: "/repo",
      additionalDirectories: [],
      permissionMode: "deny-all",
      launcher: "claude",
      identityProvenance: "client-allocated",
      executableBinding: {
        schema: "executable-build.v1",
        reportedVersion: "2.1.235 (Claude Code)",
        executableDigest: { algorithm: "sha256", value: "a".repeat(64) },
      },
    };
    const written = serializePrepared(complete) as Record<string, unknown>;

    // There is no migration reader and no default. A record whose terms this
    // build cannot fully account for describes a session it must not resume,
    // and the safe answer to "which build was this?" is never a guess.
    const cases: Array<[string, unknown]> = [
      ["no provenance", { ...written, identityProvenance: undefined }],
      ["allocated with no binding", { ...written, executableBinding: undefined }],
      [
        "returned identity carrying a binding",
        {
          ...written,
          identityProvenance: "provider-returned",
        },
      ],
      [
        "an unknown binding schema",
        {
          ...written,
          executableBinding: { ...complete.executableBinding, schema: "executable-build.v2" },
        },
      ],
      [
        "a truncated digest",
        {
          ...written,
          executableBinding: {
            ...complete.executableBinding,
            executableDigest: { algorithm: "sha256", value: "abc" },
          },
        },
      ],
      [
        "an unrecognized digest algorithm",
        {
          ...written,
          executableBinding: {
            ...complete.executableBinding,
            executableDigest: { algorithm: "md5", value: "a".repeat(64) },
          },
        },
      ],
      [
        "an empty version",
        {
          ...written,
          executableBinding: { ...complete.executableBinding, reportedVersion: "" },
        },
      ],
    ];

    expect(cases.map(([name, value]) => [name, parsePrepared(value)])).toEqual(
      cases.map(([name]) => [name, undefined]),
    );
  });

  it("SL21: a provider-returned record stays valid with no binding at all", function* () {
    // The TestAgent shape, and every provider that owns its own session
    // lifetime: nothing to bind, and nothing missing.
    const record: PreparedLaunchRecord = {
      phase: "prepared",
      agent: "test-agent",
      sessionKey: "session:main",
      provider: "acp",
      nativeSessionId: "native-abc",
      sessionState: "created",
      instructionChannel: "acp.session.systemPrompt",
      instructionReconciliation: "installed",
      instructionsDigest: digest("body"),
      instructions: "body",
      cwd: "/repo",
      additionalDirectories: [],
      permissionMode: "deny-all",
      launcher: "test-agent",
      identityProvenance: "provider-returned",
    };

    expect(parsePrepared(serializePrepared(record))).toEqual(record);
  });

  it("SL18: the terminal lease is released once a launch is done", function* () {
    // Two sequential launches: the second reserving at all proves the first
    // gave the lease back, and a concurrent pair would have been refused.
    const run = yield* runDoc(
      ["<Session.Launch>a</Session.Launch>", "", "<Session.Launch>b</Session.Launch>", ""].join(
        "\n",
      ),
    );

    expect(run.result.ok).toBe(true);
    expect(run.launcher.reserved).toBe(2);
    expect(run.launcher.order).toEqual([
      "reserve",
      "flush",
      "launch",
      "reserve",
      "flush",
      "launch",
    ]);
  });
});
