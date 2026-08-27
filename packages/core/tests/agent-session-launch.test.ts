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
import { ensure, scoped, spawn, until, withResolvers } from "effection";
import type { Operation, Result, WithResolvers } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { execute } from "../src/execute.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type { Session, SessionLaunchResult } from "../src/agent/agent-api.ts";
import type {
  ExecutableBuildBindingV1,
  ExitedLaunchRecord,
  IdentityProvenance,
  PreparedLaunchRecord,
} from "../src/agent/launch.ts";
import { sameExecutableBuild } from "../src/agent/launch.ts";
import { parsePrepared } from "../src/agent/launch-journal.ts";
import type { AgentLaunchRequest } from "../src/agent/launch-request.ts";
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
  /** Instructions each *live* preparation received, in order. */
  preparations: string[];
  detaches: number;
  /** Live exit phases — one per native child this provider actually started. */
  exits: number;
  factoryActivations: number;
  nativeSessionId: string;
  /** Return a result without recording any phase. */
  fabricate?: boolean;
  /** Report that ACP ownership could not be released. */
  detachRefused?: boolean;
  /** Who the prepared record says chose the identity. */
  identityProvenance?: IdentityProvenance;
  /** The build the prepared record says accepted that identity. */
  executableBinding?: ExecutableBuildBindingV1;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function createLaunchStub(overrides: Partial<LaunchStub> = {}): LaunchStub {
  const stub: LaunchStub = {
    agentLookups: [],
    preparations: [],
    detaches: 0,
    exits: 0,
    factoryActivations: 0,
    nativeSessionId: "native-abc",
    ...overrides,
    // The authority is the second argument because it is delivered, never
    // published: this stub is only able to author a phase because core installed
    // it and handed it one.
    factory: function* (_options, authority) {
      stub.factoryActivations++;
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *agent([name]) {
            stub.agentLookups.push(name);
            return name ?? "stub-agent";
          },
          // deno-lint-ignore require-yield
          *session([name]) {
            const session: Session = { sessionKey: `stub:${name ?? "default"}`, cwd: "/repo" };
            return session;
          },
          *launch([request]) {
            const agent = request.agent;
            const sessionKey =
              typeof request.session === "object"
                ? request.session.sessionKey
                : `stub:${request.session ?? "default"}`;

            if (stub.fabricate) {
              // Structural data alone, from a handler that did no work. The
              // route ignores returns, so this settles nothing.
              return;
            }

            let prepared: PreparedLaunchRecord | undefined;
            yield* authority.perform(request, {
              // deno-lint-ignore require-yield
              *prepare(): Operation<PreparedLaunchRecord> {
                stub.preparations.push(request.instructions);
                prepared = {
                  phase: "prepared",
                  agent,
                  sessionKey,
                  provider: "stub",
                  nativeSessionId: stub.nativeSessionId,
                  sessionState: "created",
                  instructionChannel: "stub.systemPrompt",
                  instructionReconciliation: "installed",
                  identityProvenance: stub.identityProvenance ?? "provider-returned",
                  instructionsDigest: digest(request.instructions),
                  instructions: request.instructions,
                  cwd: request.cwd,
                  additionalDirectories: [...request.additionalDirectories],
                  permissionMode: request.permissionMode,
                  launcher: "stub",
                };
                if (stub.executableBinding !== undefined) {
                  prepared.executableBinding = stub.executableBinding;
                }
                return prepared;
              },
              // deno-lint-ignore require-yield
              *detach() {
                stub.detaches++;
                if (stub.detachRefused) {
                  return {
                    phase: "detached" as const,
                    failure: {
                      class: "detach-failed",
                      message: "the provider launched without releasing its ACP session",
                    },
                  };
                }
                return { phase: "detached" as const };
              },
              *exit(accepted): Operation<ExitedLaunchRecord> {
                stub.exits++;
                const outcome = yield* nativeLaunch({
                  command: ["stub-ui", "--resume", accepted.nativeSessionId],
                  cwd: accepted.cwd,
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
            });
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
  /**
   * Run in a directory the caller owns, rather than a fresh one.
   *
   * A launch's durable identity and its retained cwd both name the document's
   * own directory, so a replay of an earlier attempt has to be the same
   * document — a second temp directory replays nothing and proves nothing.
   */
  dir?: string;
  files?: Record<string, string>;
  stream?: InMemoryStream;
  stub?: LaunchStub;
  /** Omit to install the controlled launcher; false leaves the base one. */
  launcher?: false;
  outcome?: NativeLaunchOutcome;
  /** Blocks the native child until resolved; `arrived` fires when it starts. */
  hold?: WithResolvers<void>;
  arrived?: WithResolvers<void>;
  /**
   * Public Agent middleware composed around the launch route.
   *
   * Installed the way a document's own middleware is — outside the provider,
   * on the public surface — so what these cases exercise is the surface a
   * handler actually reaches, not a seam the test invented.
   */
  intercept?: (
    request: AgentLaunchRequest,
    next: (request: AgentLaunchRequest) => Operation<unknown>,
  ) => Operation<unknown>;
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
  const owned = options.dir === undefined;
  const dir = options.dir ?? path.join(os.tmpdir(), `xmd-sl-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    if (owned) {
      yield* ensure(() => rm(dir, { recursive: true, force: true }));
    }
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
    if (options.intercept) {
      const intercept = options.intercept;
      yield* Agent.around({
        *launch([request], next) {
          // The route answers nothing, so whatever a handler returns is
          // discarded here exactly as the invocation discards it.
          yield* intercept(request, (routed) => next(routed));
        },
      });
    }

    const execution = yield* execute({
      path: docPath,
      stream,
      includes: [dir],
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
  dir: string,
): Operation<LauncherLog> {
  const arrived = withResolvers<void>();
  const hold = withResolvers<void>();
  const launcher: LauncherLog = { reserved: 0, flushed: 0, requests: [], order: [] };
  yield* ensureDir(dir);
  yield* scoped(function* () {
    const docPath = path.join(dir, "doc.md");
    yield* writeTextFile(docPath, doc);
    yield* scoped(function* () {
      // The same contextual cwd the resumed run has: a launch retains the
      // directory it was asked for, and a resume that asked for another one is
      // a different launch.
      yield* API.Env.around({
        // deno-lint-ignore require-yield
        *cwd() {
          return dir;
        },
      });
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

/** The failure class the retained preparation carries, if it carries one. */
function preparedFailure(events: DurableEvent[]): string | undefined {
  const failure = preparedRecord(events).failure;
  if (typeof failure !== "object" || failure === null || Array.isArray(failure)) {
    return undefined;
  }
  return typeof failure.class === "string" ? failure.class : undefined;
}

/** Which launch phases the journal retained, in order. */
function retainedPhases(events: DurableEvent[]): string[] {
  return launchRecords(events).map((entry) => entry.name.split("/").at(-1) ?? "");
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
    expect(result.ok ? "" : result.error.message).toContain(
      "no agent provider performed this launch",
    );
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
    const run = yield* runDoc(LAUNCH, { stub: createLaunchStub({ detachRefused: true }) });

    expect(run.result.ok).toBe(false);
    expect(run.result.ok ? "" : run.result.error.message).toContain(
      "launched without releasing its ACP session",
    );
    // Detach is durable before spawn, so a refusal there costs no child.
    expect(retainedPhases(run.events)).toEqual(["prepared", "detached"]);
    expect(run.stub.exits).toBe(0);
    expect(run.launcher.requests).toEqual([]);
  });

  it("SL13: a result nothing performed is not a launch", function* () {
    const run = yield* runDoc(LAUNCH, { stub: createLaunchStub({ fabricate: true }) });

    expect(run.result.ok).toBe(false);
    expect(run.result.ok ? "" : run.result.error.message).toContain(
      "no agent provider performed this launch",
    );
    expect(run.launcher.requests.length).toBe(0);
    // The refusal is the only phase: a replay resumes from what happened, not
    // from a launch nobody performed.
    expect(retainedPhases(run.events)).toEqual(["prepared"]);
    expect(preparedFailure(run.events)).toBe("unsupported-capability");
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

  it("SL15: partial replay resumes the retained identity without preparing again", function* () {
    const stream = new InMemoryStream();
    const stub = createLaunchStub();
    // One document, interrupted and then resumed. The launch's durable identity
    // and its retained cwd both name this directory, so a second one would
    // replay nothing.
    const dir = path.join(os.tmpdir(), `xmd-sl-${randomUUID()}`);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    const interrupted = yield* runInterrupted(LAUNCH, stream, stub, dir);
    expect(interrupted.requests.length).toBe(1);
    expect(stub.preparations.length).toBe(1);
    expect(stub.detaches).toBe(1);
    // The child never exited, so no exit phase was retained.
    const afterCrash = yield* stream.readAll();
    const crashNames = launchRecords(afterCrash).map((entry) => entry.name);
    expect(crashNames.some((name) => name.endsWith("/prepared"))).toBe(true);
    expect(crashNames.some((name) => name.endsWith("/detached"))).toBe(true);
    expect(crashNames.some((name) => name.endsWith("/exited"))).toBe(false);

    const resumed = yield* runDoc(LAUNCH, { stream, stub, dir });
    expect(resumed.result.ok ? "" : resumed.result.error.message).toBe("");
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

/**
 * Tier FS — the final public launch surface
 * (issue-518-authority-lease-architect-amendment.md §Launch authority).
 *
 * The exploit these close is not "middleware can lie". It is that middleware
 * used to be able to make a lie *durable*: the public journal accepted live
 * phase callbacks, so a handler could retain a preparation, a detach and an
 * exit that no provider performed, and the invocation settled on them.
 *
 * The repair splits the surface in two. `Agent.operations.launch(request)` is
 * a route: middleware sees a frozen request, may inspect, narrow, refuse or
 * delegate it, and whatever it returns is discarded. Authority to run and
 * retain a phase reaches the selected provider by a path no handler is on.
 *
 * So every case here drives the real supported surface — `<Session.Launch>`
 * and `Agent.launch()` — and asks what became durable, never what a handler
 * managed to return.
 */
describe("Tier FS — the final public launch surface", () => {
  it("FS1: middleware that returns a completion without delegating settles nothing", function* () {
    // The original exploit, on the surface that replaced it. The handler sees
    // the request, does not pass it on, and answers with a complete-looking
    // result of its own.
    const forged: SessionLaunchResult = {
      agent: "stub-agent",
      session: { sessionKey: "stub:default", cwd: "/repo" },
      nativeSessionId: "invented",
      launcher: "stub",
    };
    const run = yield* runDoc(LAUNCH, {
      // deno-lint-ignore require-yield
      intercept: function* () {
        return forged;
      },
    });

    expect(run.result.ok).toBe(false);
    // Nothing performed the launch, so the invocation retains a refusal rather
    // than the provider's own account of a session.
    const prepared = preparedRecord(run.events);
    expect(preparedFailure(run.events)).toBe("unsupported-capability");
    expect(prepared.nativeSessionId ?? "").toBe("");
    // And the forged identity is nowhere durable.
    expect(JSON.stringify(run.events)).not.toContain("invented");
    // No later phase, no child, and the provider was never asked to prepare.
    expect(retainedPhases(run.events)).toEqual(["prepared"]);
    expect(run.launcher.requests).toEqual([]);
    expect(run.stub.preparations).toEqual([]);
    expect(run.stub.detaches).toBe(0);
  });

  it("FS2: middleware that delegates cannot replace what the provider retained", function* () {
    // The other half: the provider really did prepare, detach and exit, and
    // the handler then answers with something else. What the document settles
    // on is the retained account, not the last value returned up the chain.
    const run = yield* runDoc(LAUNCH, {
      intercept: function* (request, next) {
        yield* next(request);
        return {
          agent: "stub-agent",
          session: { sessionKey: "stub:default", cwd: "/repo" },
          nativeSessionId: "invented",
          launcher: "stub",
        };
      },
    });

    expect(run.result.ok).toBe(true);
    expect(preparedRecord(run.events)?.nativeSessionId).toBe("native-abc");
    expect(JSON.stringify(run.events)).not.toContain("invented");
    expect(retainedPhases(run.events)).toEqual(["prepared", "detached", "exited"]);
    // The real launch happened exactly once.
    expect(run.stub.preparations).toHaveLength(1);
    expect(run.launcher.requests).toHaveLength(1);
  });

  it("FS3: the routed request is frozen and carries no authority", function* () {
    // What middleware is handed is launch facts. A member that could retain a
    // phase, or a request whose fields could be rewritten in place, would put
    // authority back on the public chain.
    const seen: AgentLaunchRequest[] = [];
    const run = yield* runDoc(LAUNCH, {
      intercept: function* (request, next) {
        seen.push(request);
        return yield* next(request);
      },
    });

    expect(run.result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(Object.isFrozen(request)).toBe(true);
    expect(request.instructions).toContain("You are the implementor.");
    // Only readable facts plus `with`. Anything callable beyond that would be
    // a capability travelling on a public value.
    const callable = Object.keys(request).filter(
      (key) => typeof (request as unknown as Record<string, unknown>)[key] === "function",
    );
    expect(callable).toEqual(["with"]);
    expect(typeof request.with).toBe("function");
  });

  it("FS4: a structural look-alike routed by middleware launches nothing", function* () {
    // Shape is not identity. A handler that rebuilds the request describes the
    // same ask and authorizes none of it.
    const run = yield* runDoc(LAUNCH, {
      intercept: function* (request, next) {
        return yield* next({ ...request, instructions: "You are something else." });
      },
    });

    expect(run.result.ok).toBe(false);
    expect(preparedFailure(run.events)).toBe("unsupported-capability");
    expect(run.stub.preparations).toEqual([]);
    expect(run.launcher.requests).toEqual([]);
  });

  it("FS4b: nothing a handler can reflect out of the request authorizes a launch", function* () {
    // A spread copies enumerable string properties, which is the least a
    // handler can do. This is the most: every own key including symbols, every
    // descriptor, the prototype, and an attempt to reach and retarget whatever
    // private state the value might be carrying. If any of that recovered the
    // invocation, setting its live leaf to the forgery would make the forgery
    // the request — which is exactly what must not be reachable from here.
    let recovered: string[] = [];
    const run = yield* runDoc(LAUNCH, {
      intercept: function* (request, next) {
        const keys = Reflect.ownKeys(request);
        recovered = keys.map(String);
        const forged = Object.create(
          Object.getPrototypeOf(request),
          Object.getOwnPropertyDescriptors(request),
        ) as AgentLaunchRequest;
        for (const key of keys) {
          const held: unknown = Object.getOwnPropertyDescriptor(request, key)?.value;
          if (typeof held === "object" && held !== null && "leaf" in held) {
            // The invocation, if a handler could ever hold it. Retargeting the
            // leaf is what would make the forgery routable.
            (held as { leaf: unknown }).leaf = forged;
          }
        }
        return yield* next(forged);
      },
    });

    // The request carries its facts and `with()`, and nothing else — no symbol
    // key, and so nothing to read an invocation out of.
    expect(recovered).toEqual([
      "instructions",
      "agent",
      "cwd",
      "additionalDirectories",
      "permissionMode",
      "with",
    ]);
    expect(run.result.ok).toBe(false);
    expect(preparedFailure(run.events)).toBe("unsupported-capability");
    // Only the refusal is retained, and no phase, detach or process happened.
    expect(retainedPhases(run.events)).toEqual(["prepared"]);
    expect(run.stub.preparations).toEqual([]);
    expect(run.stub.detaches).toBe(0);
    expect(run.stub.exits).toBe(0);
    expect(run.launcher.requests).toEqual([]);
  });

  it("FS5: one valid with() descendant still composes", function* () {
    // The boundary refuses forgeries without erasing composition: deriving a
    // narrower request from the live one is what middleware is *for*.
    const run = yield* runDoc(LAUNCH, {
      intercept: function* (request, next) {
        return yield* next(request.with({ instructions: "You are the reviewer." }));
      },
    });

    expect(run.result.ok).toBe(true);
    expect(run.stub.preparations).toEqual(["You are the reviewer."]);
    expect(preparedRecord(run.events)?.instructions).toBe("You are the reviewer.");
  });

  it("FS6: a superseded parent request is refused after with()", function* () {
    // `with()` supersedes its parent, so routing the original afterwards is
    // routing a request the invocation has already moved past.
    const run = yield* runDoc(LAUNCH, {
      intercept: function* (request, next) {
        request.with({ instructions: "You are the reviewer." });
        return yield* next(request);
      },
    });

    expect(run.result.ok).toBe(false);
    expect(preparedFailure(run.events)).toBe("unsupported-capability");
    expect(run.stub.preparations).toEqual([]);
  });

  it("FS7: delegating the same request twice performs one launch", function* () {
    const run = yield* runDoc(LAUNCH, {
      intercept: function* (request, next) {
        yield* next(request);
        return yield* next(request);
      },
    });

    expect(run.stub.preparations).toHaveLength(1);
    expect(run.launcher.requests).toHaveLength(1);
    expect(retainedPhases(run.events)).toEqual(["prepared", "detached", "exited"]);
  });

  it("FS8: core no longer publishes a launch journal to compose around", function* () {
    // The mechanism itself is gone, not hidden. A public phase journal is what
    // made the forgery durable, so its absence is part of the contract.
    const core = yield* until(import("../mod.ts"));

    expect(Object.keys(core)).not.toContain("AgentLaunchJournal");
    expect(Object.keys(core)).not.toContain("AgentLaunchJournalApi");
  });
});

/**
 * Tier PV — who chose the identity, read strictly
 * (specs/native-agent-session-launch-spec.md §Provider-native identity).
 *
 * A returned identity and a supplied one are both just a string in the record,
 * so nothing after the fact can tell them apart. The record has to say. This
 * tier is where that becomes true, and where the one compatibility inference —
 * a released format that could not have been client-allocated — is pinned to
 * the weaker claim.
 */
const BINDING: ExecutableBuildBindingV1 = {
  schema: "executable-build.v1",
  reportedVersion: "2.1.241 (Claude Code)",
  executableDigest: { algorithm: "sha256", value: "d".repeat(64) },
};

/** The same build as retained data, so a parser case starts from unknown. */
const BOUND: Record<string, Json> = {
  schema: "executable-build.v1",
  reportedVersion: "2.1.241 (Claude Code)",
  executableDigest: { algorithm: "sha256", value: "d".repeat(64) },
};

function prepared(overrides: Record<string, Json> = {}): Record<string, Json> {
  return {
    phase: "prepared",
    agent: "claude",
    sessionKey: "xmd:v1:a",
    provider: "acpx",
    nativeSessionId: "11111111-2222-3333-4444-555555555555",
    sessionState: "created",
    instructionChannel: "claude.systemPromptFile",
    instructionReconciliation: "installed",
    instructionsDigest: "a".repeat(64),
    instructions: "go",
    cwd: "/repo",
    additionalDirectories: [],
    permissionMode: "deny-all",
    launcher: "claude",
    ...overrides,
  };
}

/**
 * Run one launch to completion and then replay it, proving the second run
 * reaches no provider and starts no child whatever the first one retained.
 */
function* replayIsCold(retained: Partial<LaunchStub>): Operation<void> {
  const stream = new InMemoryStream();
  const stub = createLaunchStub(retained);
  const first = yield* runDoc(LAUNCH, { stream, stub });
  expect(first.result.ok ? "" : first.result.error.message).toBe("");
  expect(stub.factoryActivations).toBe(1);
  expect(first.launcher.requests.length).toBe(1);

  const second = yield* runDoc(LAUNCH, { stream, stub });
  expect(second.result.ok).toBe(true);
  expect(second.output).toBe(first.output);
  expect(stub.factoryActivations).toBe(1);
  expect(stub.preparations.length).toBe(1);
  expect(second.launcher.reserved).toBe(0);
  expect(second.launcher.requests.length).toBe(0);
}

describe("Tier PV — identity provenance", () => {
  const record = prepared;

  it("PV1: a released #518 record has no provenance and reads as provider-returned", function* () {
    // The one inference this parser makes, and it only ever infers the weaker
    // claim: client allocation did not exist in that released format, so a
    // record without the member cannot have been one.
    expect(parsePrepared(record())?.identityProvenance).toBe("provider-returned");
  });

  it("PV2: client allocation is explicit and round-trips unchanged", function* () {
    const parsed = parsePrepared(record({ identityProvenance: "client-allocated" }));
    expect(parsed?.identityProvenance).toBe("client-allocated");
    expect(parsed?.nativeSessionId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("PV3: an unknown provenance refuses rather than falling back", function* () {
    for (const value of ["inferred", "", "client_allocated", 1, null]) {
      expect([value, parsePrepared(record({ identityProvenance: value as Json }))]).toEqual([
        value,
        undefined,
      ]);
    }
  });

  it("PV4: a provider-returned record carries no build binding", function* () {
    // A provider that names its own session owns its own session lifetime and
    // binds no build, so a binding beside one describes a check nothing
    // performed.
    expect(
      parsePrepared(record({ identityProvenance: "provider-returned", executableBinding: BOUND })),
    ).toBe(undefined);
    // Absent provenance reads as provider-returned, so the same pairing refuses
    // through the compatibility inference too.
    expect(parsePrepared(record({ executableBinding: BOUND }))).toBe(undefined);
  });

  it("PV5: the settled failure classes round-trip", function* () {
    for (const failureClass of [
      "identity-unavailable",
      "instructions-refused",
      "process-creation-failed",
      "session-busy",
      "session-recovery-required",
      "executable-binding-refused",
    ]) {
      const parsed = parsePrepared(record({ failure: { class: failureClass, message: "why" } }));
      expect([failureClass, parsed?.failure?.class]).toEqual([failureClass, failureClass]);
    }
  });
});

/**
 * Tier EB — the executable build binding, read and compared strictly
 * (specs/native-agent-session-launch-spec.md §Provider-native identity).
 *
 * A client-allocated identity means one thing only while the build that
 * accepted it can be recognized later, so the binding is exact on the way in
 * and exact on the way out. Core observes no executables: it reads what was
 * retained and says whether two of them name the same build.
 */
describe("Tier EB — executable build binding", () => {
  function bound(overrides: Record<string, Json> = {}): Record<string, Json> {
    return prepared({ identityProvenance: "client-allocated", ...overrides });
  }

  it("EB1: a bound client-allocated preparation round-trips unchanged", function* () {
    const parsed = parsePrepared(bound({ executableBinding: BOUND }));
    expect(parsed?.identityProvenance).toBe("client-allocated");
    expect(parsed?.executableBinding).toEqual(BOUND);
  });

  it("EB2: a legacy client-allocated preparation without a binding still parses", function* () {
    // The client-allocated path was released before any build was observed.
    // That history stays readable as the native-only session it is; whether it
    // may still do live work is the provider's decision, not this parser's.
    const parsed = parsePrepared(bound());
    expect(parsed?.identityProvenance).toBe("client-allocated");
    expect(parsed?.executableBinding).toBe(undefined);
  });

  it("EB3: an inexact binding refuses rather than being read past", function* () {
    const cases: [string, Json][] = [
      ["unknown schema", { ...BOUND, schema: "executable-build.v2" }],
      ["extra member", { ...BOUND, path: "/usr/local/bin/claude" }],
      [
        "missing member",
        { schema: "executable-build.v1", reportedVersion: "2.1.241 (Claude Code)" },
      ],
      ["empty version", { ...BOUND, reportedVersion: "" }],
      ["non-string version", { ...BOUND, reportedVersion: 2 }],
      [
        "another algorithm",
        { ...BOUND, executableDigest: { algorithm: "sha1", value: "d".repeat(64) } },
      ],
      [
        "uppercase digest",
        { ...BOUND, executableDigest: { algorithm: "sha256", value: "D".repeat(64) } },
      ],
      [
        "short digest",
        { ...BOUND, executableDigest: { algorithm: "sha256", value: "d".repeat(63) } },
      ],
      [
        "extra digest member",
        {
          ...BOUND,
          executableDigest: { algorithm: "sha256", value: "d".repeat(64), size: 12 },
        },
      ],
      ["digest is not a record", { ...BOUND, executableDigest: "d".repeat(64) }],
    ];
    for (const [name, executableBinding] of cases) {
      expect([name, parsePrepared(bound({ executableBinding }))]).toEqual([name, undefined]);
    }
  });

  it("EB4: equality is over the retained build, and a path is not part of it", function* () {
    // There is no path to ignore, which is the point: the same build reached
    // through a different path compares equal because nothing about where it
    // was ever entered the record.
    const same: ExecutableBuildBindingV1 = {
      schema: "executable-build.v1",
      reportedVersion: "2.1.241 (Claude Code)",
      executableDigest: { algorithm: "sha256", value: "d".repeat(64) },
    };
    expect(sameExecutableBuild(BINDING, same)).toBe(true);
    expect(
      sameExecutableBuild(BINDING, { ...same, reportedVersion: "2.1.242 (Claude Code)" }),
    ).toBe(false);
    expect(
      sameExecutableBuild(BINDING, {
        ...same,
        executableDigest: { algorithm: "sha256", value: "e".repeat(64) },
      }),
    ).toBe(false);
  });

  it("EB5: completed replay stays provider-cold for a bound preparation", function* () {
    yield* replayIsCold({ identityProvenance: "client-allocated", executableBinding: BINDING });
  });

  it("EB6: completed replay stays provider-cold for a legacy unbound preparation", function* () {
    yield* replayIsCold({ identityProvenance: "client-allocated" });
  });
});
