/**
 * Tier RP — root-provider lifecycle (specs/acp-client-spec.md §Provider
 * lifetime). Proves the public `rootProvider` seam that bridgeRootProvider
 * implements: the provider is active while the document runs, its Effection
 * finalizer runs exactly once after execution, completion awaits cleanup,
 * and teardown failures fold into the DocumentExecution completion. The
 * fake provider is an Effection resource whose finalizer is driven by scope
 * teardown — never a manual teardown call or a Promise.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Ok, scoped } from "effection";
import type { Operation, Result, Stream } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { execute } from "../src/execute.ts";
import { Agent } from "../src/agent/agent-api.ts";
import { sessionOf } from "../src/agent/session-use.ts";
import type { AgentPromptEvent, PromptOptions, Session } from "../src/agent/agent-api.ts";
import { AgentPromptError } from "../src/agent/errors.ts";
import {
  AgentProviderInstallError,
  installAgentProvider,
  registerAgentProvider,
} from "../src/agent/provider-api.ts";
import type { AgentProviderFactory, AgentProviderOptions } from "../src/agent/provider-api.ts";
import type { AgentLaunchCoordinator } from "../src/agent/launch-coordinator.ts";
import type { AgentSessionSetup } from "../src/agent/session-setup.ts";
import type { ProviderSessionConfiguration } from "../src/agent/provider-configuration.ts";
import { openSessionRequest } from "../src/agent/session-request.ts";
import { installAgentComponents } from "../src/agent/components.ts";
import type { Json } from "@executablemd/core";

interface ProviderState {
  activeDuringPrompt: boolean;
  finalizeCount: number;
  cleanupDone: boolean;
  extraRan: boolean;
}

interface ProviderOpts {
  teardownError?: Error;
  extraFinalizer?: boolean;
  fail?: boolean;
}

function createProvider(opts: ProviderOpts = {}): {
  factory: AgentProviderFactory;
  state: ProviderState;
} {
  const state: ProviderState = {
    activeDuringPrompt: false,
    finalizeCount: 0,
    cleanupDone: false,
    extraRan: false,
  };
  let active = false;
  const factory: AgentProviderFactory = function* (options) {
    active = true;
    if (opts.extraFinalizer) {
      yield* ensure(() => {
        state.extraRan = true;
      });
    }
    yield* ensure(() => {
      state.finalizeCount++;
      state.cleanupDone = true;
      active = false;
      if (opts.teardownError) {
        throw opts.teardownError;
      }
    });
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *agent([name]) {
          return name ?? options.defaultAgent;
        },
        // deno-lint-ignore require-yield
        *session([name]) {
          return { sessionKey: `s:${name ?? "default"}`, cwd: "/" };
        },
        // deno-lint-ignore require-yield
        *prompt([content, promptOptions]) {
          return stubStream(state, () => active, content, promptOptions, opts.fail === true);
        },
      },
      { at: "min" },
    );
  };
  return { factory, state };
}

function stubStream(
  state: ProviderState,
  isActive: () => boolean,
  content: string,
  options: PromptOptions | undefined,
  fail: boolean,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      state.activeDuringPrompt = isActive();
      // The exact session, however it was routed: a use names one, and the
      // conversation it names is what a started event reports.
      const session: Session = sessionOf(options?.session) ?? { sessionKey: "s:default", cwd: "/" };
      const text = `[${content}]`;
      const terminal: AgentPromptEvent = fail
        ? { type: "terminal", status: "failed", stopReason: "refusal" }
        : { type: "terminal", status: "completed" };
      const events: AgentPromptEvent[] = [
        { type: "started", agent: options?.agent ?? "a", session },
        { type: "text_delta", text },
        terminal,
      ];
      let index = 0;
      return {
        // deno-lint-ignore require-yield
        *next() {
          if (index < events.length) {
            return { done: false, value: events[index++]! };
          }
          return { done: true, value: text };
        },
      };
    },
  };
}

function* runDoc(doc: string): Operation<{ output: string; result: Result<Json> }> {
  const dir = path.join(os.tmpdir(), `xmd-rp-test-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    const docPath = path.join(dir, "doc.md");
    yield* writeTextFile(docPath, doc);
    const execution = yield* execute({ path: docPath, stream: new InMemoryStream() });
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    return { output: next.value, result };
  });
}

const OPTIONS: AgentProviderOptions = { defaultAgent: "a", permissionMode: "deny-all" };

describe("Tier RP — root-provider lifecycle", () => {
  it("RP1: provider is active during execution; its finalizer runs once, before completion settles", function* () {
    const { factory, state } = createProvider();
    yield* installAgentComponents({ rootProvider: { factory, options: OPTIONS } });
    const { output, result } = yield* runDoc('<Prompt text="hi" />\n');
    expect(result.ok).toBe(true);
    expect(output).toContain("[hi]");
    expect(state.activeDuringPrompt).toBe(true);
    expect(state.finalizeCount).toBe(1);
    // Completion only settled after cleanup ran.
    expect(state.cleanupDone).toBe(true);
  });

  it("RP2: a teardown failure still closes rendered output but makes completion an Err", function* () {
    const boom = new Error("teardown boom");
    const { factory } = createProvider({ teardownError: boom });
    yield* installAgentComponents({ rootProvider: { factory, options: OPTIONS } });
    const { output, result } = yield* runDoc('<Prompt text="hi" />\n');
    expect(output).toContain("[hi]");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(boom);
    }
  });

  // RP5: first-failure precedence, where it is easiest to get wrong. The
  // document fails on its own terms and cleanup fails too. Both happened; what
  // the caller receives is the failure the document earned, because a completion
  // policy adds and never replaces.
  it("RP5: a failed document keeps its own failure even when cleanup also fails", function* () {
    const boom = new Error("teardown boom");
    const { factory, state } = createProvider({ teardownError: boom, extraFinalizer: true });
    yield* installAgentComponents({ rootProvider: { factory, options: OPTIONS } });

    // The document fails on its own terms — a failing command inside <Output>,
    // where an error fails the execution rather than printing — with no prompt
    // having failed.
    const { result } = yield* runDoc(
      ["<Output>", "", "```bash exec", "exit 3", "```", "", "</Output>", ""].join("\n"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBe(boom);
      expect(result.error).not.toBeInstanceOf(AggregateError);
      expect(result.error.message).not.toContain("teardown boom");
    }
    // Cleanup still ran — both finalizers.
    expect(state.extraRan).toBe(true);
    expect(state.cleanupDone).toBe(true);
  });

  it("RP3: a prompt failure plus a teardown failure aggregate — primary first, every cleanup runs", function* () {
    const boom = new Error("teardown boom");
    const { factory, state } = createProvider({
      teardownError: boom,
      extraFinalizer: true,
      fail: true,
    });
    yield* installAgentComponents({ rootProvider: { factory, options: OPTIONS } });
    const { result } = yield* runDoc('<Prompt text="hi" />\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AggregateError);
      if (result.error instanceof AggregateError) {
        const errors = result.error.errors;
        expect(errors[0]).toBeInstanceOf(AgentPromptError);
        expect(errors[errors.length - 1]).toBe(boom);
        expect(result.error.message).toContain("agent prompt(s) failed");
        expect(result.error.message).toContain("teardown failed");
      }
    }
    // The non-throwing finalizer still ran despite the throwing one.
    expect(state.extraRan).toBe(true);
    expect(state.cleanupDone).toBe(true);
  });
});

describe("Tier RP — what the delivery adapter carries to a provider", () => {
  interface Asked {
    provider: string;
    agentCommand: string;
    configuration: ProviderSessionConfiguration | undefined;
  }

  /**
   * A delivered handle that can only be used as itself.
   *
   * The private field is the point: it is readable through this exact object
   * and throws through any other receiver, so a bridge that forwarded the
   * operation unbound — or bound to the adapter it built around it — fails
   * here rather than appearing to work.
   */
  class DeliveredSetup {
    readonly #asked: Asked[];
    readonly requestedModel = undefined;
    readonly agentSessionId: string | undefined = undefined;
    readonly session: AgentSessionSetup["session"] = undefined;

    constructor(asked: Asked[]) {
      this.#asked = asked;
    }

    // deno-lint-ignore require-yield
    *activate(
      provider: string,
      agentCommand: string,
      configuration?: ProviderSessionConfiguration,
    ): Operation<Result<void>> {
      this.#asked.push({ provider, agentCommand, configuration });
      return Ok(undefined);
    }

    // deno-lint-ignore require-yield
    *finish(session: Session): Operation<Session> {
      return session;
    }
  }

  const CONFIGURATION: ProviderSessionConfiguration = Object.freeze({
    providerTools: Object.freeze([]),
    mcpServers: Object.freeze([]),
    permissions: Object.freeze({ permissionMode: "deny-all", routing: "strict" }),
    systemPrompt: null,
  });

  /**
   * A coordinator shaped the way the terminal delivers one.
   *
   * What it answers with crosses the real structural adapter in
   * `provider-api.ts`, which is what these rows are about: the provider never
   * receives this object, it receives whatever that adapter made of it.
   */
  function coordinatorAnswering(setup: () => AgentSessionSetup): AgentLaunchCoordinator {
    return {
      // deno-lint-ignore require-yield
      *perform(): Operation<never> {
        throw new Error("this probe performs no launch");
      },
      // deno-lint-ignore require-yield
      *refuse(): Operation<never> {
        throw new Error("this probe refuses no launch");
      },
      sessionSetup: () => setup(),
      checkpoint: () => {},
      sessionUse: () => undefined,
    };
  }

  it("SC5: activate crosses the delivery adapter bound to the handle that answered", function* () {
    const asked: Asked[] = [];
    let delivered: AgentSessionSetup | undefined;
    const issuance = openSessionRequest("expansion:1", "review");

    yield* scoped(function* () {
      yield* registerAgentProvider(
        "probe",
        // deno-lint-ignore require-yield
        function* (_options, launchCoordinator): Operation<void> {
          delivered = launchCoordinator.sessionSetup(issuance.request);
        },
      );
      yield* installAgentProvider(
        "probe",
        OPTIONS,
        coordinatorAnswering(() => new DeliveredSetup(asked)),
      );
    });

    if (delivered === undefined) {
      throw new Error("the provider was delivered no session setup");
    }
    // It reaches the handle that answered, once, with exactly what the provider
    // said. An unbound forward would have thrown reading the private field.
    const authorized = yield* delivered.activate("acpx", "scribe-cmd", CONFIGURATION);
    expect(authorized.ok).toBe(true);
    expect(asked).toEqual([
      { provider: "acpx", agentCommand: "scribe-cmd", configuration: CONFIGURATION },
    ]);
  });

  it("SC5: a delivered setup carries a valid requested model member", function* () {
    for (const presence of [undefined, null, true, 1]) {
      const issuance = openSessionRequest("expansion:1", "review");
      let refusal: Error | undefined;
      let forwarded: string | undefined;
      yield* scoped(function* () {
        yield* registerAgentProvider(
          "probe",
          // deno-lint-ignore require-yield
          function* (_options, launchCoordinator): Operation<void> {
            try {
              forwarded = launchCoordinator.sessionSetup(issuance.request).requestedModel;
            } catch (error) {
              refusal = error instanceof Error ? error : new Error(String(error));
            }
          },
        );
        yield* installAgentProvider(
          "probe",
          OPTIONS,
          coordinatorAnswering(() => {
            const handle = new DeliveredSetup([]);
            // An untyped embedder's answer, reached without a cast.
            if (presence === undefined) {
              Reflect.deleteProperty(handle, "requestedModel");
            } else {
              Reflect.defineProperty(handle, "requestedModel", { value: presence });
            }
            return handle;
          }),
        );
      });
      // No fallback guesses a missing or malformed fact.
      expect(forwarded).toBe(undefined);
      expect(refusal).toBeInstanceOf(AgentProviderInstallError);
      expect(refusal?.message).toContain("requested model");
    }

    // The exact requested model crosses unchanged.
    const issuance = openSessionRequest("expansion:1", "review");
    let forwarded: string | undefined;
    yield* scoped(function* () {
      yield* registerAgentProvider(
        "probe",
        // deno-lint-ignore require-yield
        function* (_options, launchCoordinator): Operation<void> {
          forwarded = launchCoordinator.sessionSetup(issuance.request).requestedModel;
        },
      );
      yield* installAgentProvider(
        "probe",
        OPTIONS,
        coordinatorAnswering(() => {
          const handle = new DeliveredSetup([]);
          Reflect.defineProperty(handle, "requestedModel", { value: "claude-exact-model" });
          return handle;
        }),
      );
    });
    expect(forwarded).toBe("claude-exact-model");
  });

  it("SC5: a delivered setup carries its history facts as a detached copy, or is refused", function* () {
    /** What the adapter made of one handle, or why it refused it. */
    function* delivered(
      answer: () => DeliveredSetup,
    ): Operation<{ setup?: AgentSessionSetup; refusal?: Error }> {
      const issuance = openSessionRequest("expansion:1", "review");
      const seen: { setup?: AgentSessionSetup; refusal?: Error } = {};
      yield* scoped(function* () {
        yield* registerAgentProvider(
          "probe",
          // deno-lint-ignore require-yield
          function* (_options, launchCoordinator): Operation<void> {
            try {
              seen.setup = launchCoordinator.sessionSetup(issuance.request);
            } catch (error) {
              seen.refusal = error instanceof Error ? error : new Error(String(error));
            }
          },
        );
        yield* installAgentProvider("probe", OPTIONS, coordinatorAnswering(answer));
      });
      return seen;
    }

    // Populated facts cross unchanged, as values this copy owns: a later edit
    // of the answering copy's object reaches nothing the provider holds.
    const located = { provider: "acpx", agentCommand: "old-cmd", sessionKey: "held-key" };
    const asked: Asked[] = [];
    const populated = yield* delivered(() => {
      const handle = new DeliveredSetup(asked);
      Reflect.defineProperty(handle, "agentSessionId", { value: "native-1" });
      Reflect.defineProperty(handle, "session", { value: located });
      return handle;
    });
    const setup = populated.setup;
    if (setup === undefined) {
      throw new Error(`the populated setup was refused: ${populated.refusal?.message}`);
    }
    expect(setup.agentSessionId).toBe("native-1");
    expect(setup.session).toEqual(located);
    expect(setup.session).not.toBe(located);
    expect(Object.isFrozen(setup.session)).toBe(true);
    located.sessionKey = "edited";
    expect(setup.session?.sessionKey).toBe("held-key");
    // Still bound to the handle that answered.
    expect((yield* setup.activate("acpx", "new-cmd", CONFIGURATION)).ok).toBe(true);
    expect(asked.map((one) => one.agentCommand)).toEqual(["new-cmd"]);

    // Absent is two present members holding undefined, and a locator without a
    // placement keeps no placement.
    const ordinary = yield* delivered(() => new DeliveredSetup([]));
    expect(ordinary.setup !== undefined && Reflect.has(ordinary.setup, "session")).toBe(true);
    expect(ordinary.setup !== undefined && Reflect.has(ordinary.setup, "agentSessionId")).toBe(
      true,
    );
    expect(ordinary.setup?.session).toBe(undefined);
    expect(ordinary.setup?.agentSessionId).toBe(undefined);
    const unplaced = yield* delivered(() => {
      const handle = new DeliveredSetup([]);
      Reflect.defineProperty(handle, "session", {
        value: { provider: "acpx", agentCommand: "old-cmd" },
      });
      return handle;
    });
    expect(unplaced.setup?.session).toEqual({ provider: "acpx", agentCommand: "old-cmd" });
    expect(
      unplaced.setup !== undefined && Reflect.has(unplaced.setup.session ?? {}, "sessionKey"),
    ).toBe(false);

    // A missing member and a malformed locator are refusals, never a default.
    for (const member of ["agentSessionId", "session"]) {
      const missing = yield* delivered(() => {
        const handle = new DeliveredSetup([]);
        Reflect.deleteProperty(handle, member);
        return handle;
      });
      expect(missing.setup).toBe(undefined);
      expect(missing.refusal).toBeInstanceOf(AgentProviderInstallError);
    }
    const malformed = yield* delivered(() => {
      const handle = new DeliveredSetup([]);
      Reflect.defineProperty(handle, "session", {
        value: { provider: "acpx", agentCommand: "old-cmd", sessionKey: 7 },
      });
      return handle;
    });
    expect(malformed.setup).toBe(undefined);
    expect(malformed.refusal).toBeInstanceOf(AgentProviderInstallError);
    expect(malformed.refusal?.message).toContain("session locator");
  });

  it("SC5: a delivered setup that authorizes nothing is refused", function* () {
    const issuance = openSessionRequest("expansion:1", "review");
    let refusal: Error | undefined;

    yield* scoped(function* () {
      yield* registerAgentProvider(
        "probe",
        // deno-lint-ignore require-yield
        function* (_options, launchCoordinator): Operation<void> {
          try {
            launchCoordinator.sessionSetup(issuance.request);
          } catch (error) {
            refusal = error instanceof Error ? error : new Error(String(error));
          }
        },
      );
      yield* installAgentProvider(
        "probe",
        OPTIONS,
        coordinatorAnswering(() => {
          const handle: AgentSessionSetup = {
            requestedModel: undefined,
            agentSessionId: undefined,
            session: undefined,
            // deno-lint-ignore require-yield
            *activate(): Operation<Result<void>> {
              return Ok(undefined);
            },
            // deno-lint-ignore require-yield
            *finish(session: Session): Operation<Session> {
              return session;
            },
          };
          // Removed before delivery: the untyped embedder this adapter exists
          // for, reached without claiming an incomplete object is a handle.
          expect(Reflect.deleteProperty(handle, "activate")).toBe(true);
          return handle;
        }),
      );
    });

    // It settles a conversation and authorizes nothing, and there is no
    // fallback that reads that as authorized.
    expect(refusal).toBeInstanceOf(AgentProviderInstallError);
    expect(refusal?.message).toContain("authorizes nothing");
  });
});
