/**
 * Tier CV — one retained agent conversation a host holds open.
 *
 * A document's `<Session>` and `<Prompt>` are written inside an expansion, with
 * an element to name the placement and a journal already around them. A host
 * discussing something with an agent has neither and still needs the genuine
 * thing, so `useAgentConversation()` opens the conversation as an execution it
 * keeps alive — and these rows are about what that costs and what it buys.
 *
 * The provider here is a stub installed through the conversation's own
 * installations, which is where the accepted contract puts it: the assembly
 * selects the provider and its creation policy before any of the conversation's
 * code runs. It uses the delivered placement coordinator exactly as a real
 * provider does, because configuration readback is one of the things under test
 * and a stub that skipped the coordinator could not show it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { ensure, Ok, race, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result, Stream } from "effection";

import { useAgentConversation } from "../host.ts";
import type { AgentConversation, ExecutionInstallation } from "../host.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type {
  AgentOptions,
  AgentPromptEvent,
  PromptOptions,
  Session,
  SessionConfiguration,
} from "../src/agent/agent-api.ts";
import { installAgentComponents } from "../src/agent/components.ts";
import { sessionOf } from "../src/agent/session-use.ts";
import type { AgentLaunchCoordinator } from "../src/agent/launch-coordinator.ts";

const AGENT = "stub-agent";

/** What the stub provider was asked to do, in order. */
interface Traffic {
  readonly prompts: { content: string; sessionKey: string; agent: string }[];
  readonly placements: string[];
  readonly applied: SessionConfiguration[];
  readonly optionProbes: (string | undefined)[];
}

interface StubOptions {
  /** How the provider answers one turn. Default: completes, echoing the text. */
  readonly respond?: (content: string) => {
    status?: "completed" | "failed" | "cancelled";
    deltas?: string[];
  };
  /**
   * Held open before a turn's first event, for a case that interrupts one.
   *
   * Asked per turn, so a case can hold the turn it means to abandon and let
   * the next one through — a hold that applied to every turn would stall the
   * work the case is actually about.
   */
  readonly hold?: (content: string) => Operation<void> | undefined;
  /** Called when a held turn has actually reached the provider. */
  readonly started?: (content: string) => void;
  /** What the provider reports it verified, when it is not what was asked. */
  readonly verify?: (asked: SessionConfiguration) => SessionConfiguration;
  /**
   * The native conversation identity the provider asserts, per turn.
   *
   * A real provider asserts it on the Session it issued, and reports that same
   * value on the turn's `started` event — which is how the journal comes to
   * hold the provider's own account of which conversation a turn ran in.
   * Asked per turn so a case can have the provider resolve a *different*
   * conversation on reopening.
   */
  readonly asserts?: (content: string) => string | undefined;
  /** Asserted when the session resolves rather than when the turn starts. */
  readonly assertsAtPlacement?: string;
}

/**
 * One conversation installation carrying a stub provider.
 *
 * `install()` runs before the execution's document, which is the position the
 * accepted contract gives a host's own assembly: it selects the provider and
 * its creation policy before any of the conversation's code exists. The
 * provider itself is installed the ordinary way, inside the document, so it is
 * handed the same launch coordinator a real one is — which is what lets this
 * stub settle placements and report what it verified.
 */
function stub(traffic: Traffic, options: StubOptions = {}): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* installAgentComponents({
        rootProvider: {
          factory: function* (
            providerOptions,
            coordinator: AgentLaunchCoordinator,
          ): Operation<void> {
            yield* Agent.around(
              {
                // deno-lint-ignore require-yield
                *agent([name]) {
                  return name ?? providerOptions.defaultAgent;
                },
                *session([routed]): Operation<Session> {
                  if (typeof routed === "string" || routed === undefined) {
                    return { sessionKey: `stub:${routed ?? "default"}`, cwd: "/stub" };
                  }
                  const placement = coordinator.sessionPlacement(routed);
                  traffic.placements.push(placement.sessionIdentity ?? "<none>");
                  const session: Session = {
                    sessionKey: `stub:${routed.name ?? "default"}`,
                    cwd: "/stub",
                    ...(options.assertsAtPlacement === undefined
                      ? {}
                      : { agentSessionId: options.assertsAtPlacement }),
                  };
                  // Established, so what this turn asks is applied and read
                  // back — the only thing that makes a configuration a fact
                  // about the turn rather than a hope.
                  return yield* placement.complete(session, {
                    kind: "established",
                    // deno-lint-ignore require-yield
                    *configure(asked: SessionConfiguration): Operation<SessionConfiguration> {
                      traffic.applied.push(asked);
                      return options.verify ? options.verify(asked) : asked;
                    },
                  });
                },
                // deno-lint-ignore require-yield
                *options([agent]): Operation<AgentOptions> {
                  traffic.optionProbes.push(agent);
                  return {
                    agent: agent ?? AGENT,
                    model: {
                      selected: "m-1",
                      options: [{ id: "m-1", name: "One", description: null, group: null }],
                    },
                    effort: null,
                  };
                },
                // deno-lint-ignore require-yield
                *prompt([content, promptOptions]) {
                  return turn(traffic, content, promptOptions, options);
                },
              },
              { at: "min" },
            );
          },
          options: { defaultAgent: AGENT, permissionMode: "deny-all" },
        },
      });
    },
  };
}

/** One provider turn, as the stub plays it out. */
function turn(
  traffic: Traffic,
  content: string,
  promptOptions: PromptOptions | undefined,
  options: StubOptions,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      // The exact value this turn was routed, not a copy of it: for a
      // configured turn that is the authentic use, and it is the only thing
      // that can say what the conversation was put under.
      const routed = promptOptions?.session;
      const placed: Session =
        typeof routed === "object" && routed !== null
          ? routed
          : { sessionKey: "stub:default", cwd: "/stub" };
      // Asserting the native identity the way a provider does: on the value it
      // reports as the conversation this turn ran in.
      const asserted = options.asserts?.(content);
      const session: Session =
        asserted === undefined ? placed : { ...placed, agentSessionId: asserted };
      traffic.prompts.push({
        content,
        sessionKey: sessionOf(placed)?.sessionKey ?? placed.sessionKey,
        agent: promptOptions?.agent ?? AGENT,
      });
      const response = options.respond ? options.respond(content) : {};
      const deltas = response.deltas ?? [`[${content}]`];
      const events: AgentPromptEvent[] = [
        { type: "started", agent: promptOptions?.agent ?? AGENT, session },
        ...deltas.map((text): AgentPromptEvent => ({ type: "text_delta", text })),
        { type: "terminal", status: response.status ?? "completed" },
      ];
      let index = 0;
      let waited = false;
      return {
        *next() {
          if (!waited) {
            waited = true;
            const holding = options.hold?.(content);
            if (holding !== undefined) {
              options.started?.(content);
              yield* holding;
            }
          }
          if (index < events.length) {
            return { done: false, value: events[index++]! };
          }
          return { done: true, value: deltas.join("") };
        },
      };
    },
  };
}

/** Every canonical prompt record this history holds. */
function prompts(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "agent_prompt",
  );
}

/** Whether this history records the conversation root's own terminal. */
function terminated(events: readonly DurableEvent[]): boolean {
  return events.some((event) => event.type === "close" && event.coroutineId === "root");
}

/** The durable name of each retained turn, in order. */
function turnNames(events: readonly DurableEvent[]): string[] {
  return prompts(events).map((event) =>
    event.type === "yield" ? event.description.name : "<not a yield>",
  );
}

/** What one retained turn record holds, for a case that reads the journal. */
function record(events: readonly DurableEvent[], name: string): Record<string, unknown> {
  const found = prompts(events).find(
    (event) => event.type === "yield" && event.description.name === name,
  );
  if (found?.type !== "yield" || found.result.status !== "ok") {
    throw new Error(`the history holds no completed turn "${name}"`);
  }
  const value = found.result.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`the turn "${name}" retained no record`);
  }
  return value as Record<string, unknown>;
}

/** Open one conversation and hand it to `body`, closing it afterwards. */
function withConversation<T>(
  stream: InMemoryStream,
  installation: ExecutionInstallation,
  body: (conversation: AgentConversation) => Operation<T>,
  id = "chat-1",
): Operation<Result<T>> {
  return scoped(function* () {
    const opened = yield* useAgentConversation({
      history: stream,
      id,
      agent: AGENT,
      installations: [installation],
    });
    if (!opened.ok) {
      return opened;
    }
    return Ok(yield* body(opened.value));
  });
}

function fresh(): Traffic {
  return { prompts: [], placements: [], applied: [], optionProbes: [] };
}

describe("Tier CV — a conversation is an execution the host keeps open", () => {
  it("CV1: two turns reach the same conversation and are retained in order", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(stream, stub(traffic), function* (chat) {
      return [yield* chat.prompt("first"), yield* chat.prompt("second")];
    });

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    const [one, two] = answered.value;
    expect(one.ok && one.value).toBe("[first]");
    expect(two.ok && two.value).toBe("[second]");
    expect(traffic.prompts.map((call) => call.content)).toEqual(["first", "second"]);
    // One conversation: both turns ran in the session the one placement named.
    expect(new Set(traffic.prompts.map((call) => call.sessionKey)).size).toBe(1);

    const events = yield* stream.readAll();
    expect(prompts(events)).toHaveLength(2);
    // The root was never completed, which is what makes this history a
    // conversation to reopen rather than a finished run to replay.
    expect(terminated(events)).toBe(false);
  });

  it("CV2: reopening continues the conversation and replays no provider work", function* () {
    const stream = new InMemoryStream();
    const first = fresh();
    const opened = yield* withConversation(stream, stub(first), function* (chat) {
      return yield* chat.prompt("first");
    });
    expect(opened.ok).toBe(true);

    const again = fresh();
    const continued = yield* withConversation(stream, stub(again), function* (chat) {
      return yield* chat.prompt("second");
    });

    if (!continued.ok) {
      throw new Error(`reopening refused: ${continued.error.message}`);
    }
    expect(continued.value.ok && continued.value.value).toBe("[second]");
    // The retained turn replayed from its own record: the second process asked
    // the provider for exactly the one turn the person asked for.
    expect(again.prompts.map((call) => call.content)).toEqual(["second"]);
    expect(prompts(yield* stream.readAll())).toHaveLength(2);
  });

  it("CV3: one conversation runs one turn at a time", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const release = withResolvers<void>();
    const started = withResolvers<void>();

    const outcome = yield* withConversation(
      stream,
      stub(traffic, {
        hold: () => release.operation,
        started: () => started.resolve(),
      }),
      function* (chat) {
        const held = yield* spawn(() => chat.prompt("first"));
        // The turn is running when the provider says so, not when the call was
        // made: a spawned task starts a turn later than its spawner.
        yield* started.operation;
        const overlapping = yield* chat.prompt("second");
        release.resolve();
        return { overlapping, held: yield* held };
      },
    );

    if (!outcome.ok) {
      throw new Error(`the conversation did not open: ${outcome.error.message}`);
    }
    expect(outcome.value.overlapping.ok).toBe(false);
    expect(!outcome.value.overlapping.ok && outcome.value.overlapping.error.message).toContain(
      "one turn at a time",
    );
    expect(outcome.value.held.ok).toBe(true);
    // The refused call reached no provider at all.
    expect(traffic.prompts.map((call) => call.content)).toEqual(["first"]);
  });

  it("CV4: a handle kept past the scope that opened it reaches nothing", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const kept: { chat?: AgentConversation } = {};

    const opened = yield* withConversation(stream, stub(traffic), function* (chat) {
      kept.chat = chat;
      return yield* chat.prompt("first");
    });
    expect(opened.ok).toBe(true);

    const refused = yield* kept.chat!.prompt("after");
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.message).toContain("has been closed");
    // And it reached no provider.
    expect(traffic.prompts).toHaveLength(1);
  });

  it("CV5: a failed turn answers Err and stays retained", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(
      stream,
      stub(traffic, { respond: () => ({ status: "failed" }) }),
      function* (chat) {
        return yield* chat.prompt("first");
      },
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    expect(answered.value.ok).toBe(false);
    // The turn is a fact of the history either way: a failure is an outcome,
    // not an absence.
    expect(prompts(yield* stream.readAll())).toHaveLength(1);
  });

  it("CV6: inspecting advertised choices sends no model turn", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(stream, stub(traffic), function* (chat) {
      return yield* chat.options();
    });

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    expect(answered.value.ok && answered.value.value.model?.selected).toBe("m-1");
    expect(traffic.optionProbes).toEqual([AGENT]);
    expect(traffic.prompts).toHaveLength(0);
    // Inspection journals nothing.
    expect(prompts(yield* stream.readAll())).toHaveLength(0);
  });

  it("CV7: a turn's configuration is applied and read back for this conversation", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(stream, stub(traffic), function* (chat) {
      return yield* chat.prompt("first", { model: "m-1", effort: "high" });
    });

    expect(answered.ok).toBe(true);
    expect(traffic.applied).toEqual([{ model: "m-1", effort: "high" }]);
  });
});

describe("Tier CV — the history decides whether a conversation may open", () => {
  it("CV8: a history that records its own terminal is a finished run, not a conversation", function* () {
    const stream = new InMemoryStream([
      { type: "close", coroutineId: "root", result: { status: "ok", value: "" } },
    ]);

    const opened = yield* withConversation(stream, stub(fresh()), function* () {
      return "reached";
    });

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error.message).toContain("finished run");
  });
});

describe("Tier CV — nothing opens a provider before the first turn", () => {
  it("CV9: opening and closing a conversation reaches no provider at all", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const opened = yield* withConversation(stream, stub(traffic), function* () {
      return "opened";
    });

    expect(opened.ok).toBe(true);
    expect(traffic.prompts).toHaveLength(0);
    expect(traffic.placements).toHaveLength(0);
    expect(prompts(yield* stream.readAll())).toHaveLength(0);
  });
});

describe("Tier CV — a turn is its own sequence", () => {
  it("CV10: two turns take distinct durable names, in order", function* () {
    const stream = new InMemoryStream();
    const answered = yield* withConversation(stream, stub(fresh()), function* (chat) {
      yield* chat.prompt("first");
      return yield* chat.prompt("second");
    });

    expect(answered.ok).toBe(true);
    expect(turnNames(yield* stream.readAll())).toEqual(["turn:1", "turn:2"]);
  });

  it("CV11: cancelling a turn starts fresh work rather than resuming it", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const started = withResolvers<void>();

    const answered = yield* withConversation(
      stream,
      // Only the turn this case abandons is held; the one after it runs.
      stub(traffic, {
        hold: (content) => (content === "abandoned" ? suspend() : undefined),
        started: () => started.resolve(),
      }),
      function* (chat) {
        const held = yield* spawn(() => chat.prompt("abandoned"));
        yield* started.operation;
        // Cancellation is scope cancellation, which is what Stop is.
        yield* held.halt();
        return yield* chat.prompt("asked again");
      },
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    expect(answered.value.ok && answered.value.value).toBe("[asked again]");
    // The abandoned turn reached the provider and recorded nothing: its append
    // never landed, so there is no outcome for anything to resume.
    expect(traffic.prompts.map((call) => call.content)).toEqual(["abandoned", "asked again"]);
    const events = yield* stream.readAll();
    expect(turnNames(events)).toEqual(["turn:2"]);
    // And the second turn is a turn of its own rather than the first finished.
    expect(record(events, "turn:2").text).toBe("[asked again]");
  });
});

describe("Tier CV — a history belongs to one conversation", () => {
  it("CV12: a history established for another conversation refuses", function* () {
    const stream = new InMemoryStream();
    const opened = yield* withConversation(
      stream,
      stub(fresh()),
      function* (chat) {
        return yield* chat.prompt("first");
      },
      "chat-1",
    );
    expect(opened.ok).toBe(true);

    const misrouted = yield* withConversation(
      stream,
      stub(fresh()),
      function* () {
        return "reached";
      },
      "chat-2",
    );

    expect(misrouted.ok).toBe(false);
    expect(!misrouted.ok && misrouted.error.message).toContain("another conversation");
  });

  it("CV13: an established conversation does not change agent in place", function* () {
    const stream = new InMemoryStream();
    const opened = yield* withConversation(stream, stub(fresh()), function* (chat) {
      return yield* chat.prompt("first");
    });
    expect(opened.ok).toBe(true);

    const switched = yield* scoped(function* () {
      const result = yield* useAgentConversation({
        history: stream,
        id: "chat-1",
        agent: "another-agent",
        installations: [stub(fresh())],
      });
      return result.ok ? "opened" : result.error.message;
    });

    expect(switched).toContain("never changes agent in place");
  });

  it("CV14: a retained turn with no outcome refuses before anything opens", function* () {
    const traffic = fresh();
    // A history interrupted mid-turn: the record was offered and never settled.
    const stream = new InMemoryStream([
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "agent_prompt", name: "turn:1", input: "interrupted" },
        result: { status: "err", error: { message: "interrupted" } },
      },
    ]);

    const opened = yield* withConversation(stream, stub(traffic), function* () {
      return "reached";
    });

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error.message).toContain("recorded no outcome");
    // Nothing ran, and nothing was appended to the history it refused.
    expect(traffic.prompts).toHaveLength(0);
    expect(yield* stream.readAll()).toHaveLength(1);
  });
});

describe("Tier CV — what a turn ran under is the provider's own account", () => {
  it("CV15: the retained record carries the configuration the provider verified", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(stream, stub(traffic), function* (chat) {
      return yield* chat.prompt("first", { model: "m-1", effort: "high" });
    });

    expect(answered.ok).toBe(true);
    expect(record(yield* stream.readAll(), "turn:1").configuration).toEqual({
      model: "m-1",
      effort: "high",
    });
  });

  it("CV16: a provider that put the conversation under something else refuses the turn", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(
      stream,
      stub(traffic, { verify: () => ({ model: "m-2", effort: "high" }) }),
      function* (chat) {
        return yield* chat.prompt("first", { model: "m-1", effort: "high" });
      },
    );

    // The turn never started: a conversation running under settings nobody
    // asked for is not this turn's conversation.
    expect(traffic.prompts).toHaveLength(0);
    if (answered.ok) {
      expect(answered.value.ok).toBe(false);
    }
  });

  it("CV17: the record names the conversation the provider said the turn ran in", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(stream, stub(traffic), function* (chat) {
      return yield* chat.prompt("first");
    });

    expect(answered.ok).toBe(true);
    const retained = record(yield* stream.readAll(), "turn:1");
    expect(retained.sessionKey).toBe(traffic.prompts[0]?.sessionKey);
    expect(retained.agent).toBe(AGENT);
    expect(retained.status).toBe("completed");
  });
});

describe("Tier CV — cancelling a turn joins the work it started", () => {
  it("CV18: the caller's halt waits for the provider's own cleanup", function* () {
    const started = withResolvers<void>();
    const cleanupStarted = withResolvers<void>();
    const cleanupRelease = withResolvers<void>();

    const answered = yield* withConversation(
      new InMemoryStream(),
      stub(fresh(), {
        // A turn whose teardown is held open, which is the only shape that can
        // tell "the caller stopped waiting" apart from "the work stopped".
        hold: () =>
          (function* (): Operation<void> {
            yield* ensure(function* () {
              cleanupStarted.resolve();
              yield* cleanupRelease.operation;
            });
            started.resolve();
            yield* suspend();
          })(),
      }),
      function* (chat) {
        // Registered before the held work exists, so the gate opens however
        // this case leaves and nothing is left blocked on it.
        yield* ensure(() => {
          cleanupRelease.resolve();
        });
        const caller = yield* spawn(() => chat.prompt("held"));
        yield* started.operation;
        const halted = yield* spawn(function* (): Operation<string> {
          yield* caller.halt();
          return "halt returned";
        });
        yield* cleanupStarted.operation;
        const observation = yield* race([
          (function* (): Operation<string> {
            return yield* halted;
          })(),
          (function* (): Operation<string> {
            yield* sleep(25);
            return "halt waits";
          })(),
        ]);
        // Released after the observation, so the case joins its own work
        // rather than leaving a held cleanup behind.
        cleanupRelease.resolve();
        yield* halted;
        return observation;
      },
    );

    if (!answered.ok) {
      throw answered.error;
    }
    // Asking is not stopping: the halt is still unwinding the provider's
    // cleanup, so a caller that has returned could not claim the work stopped.
    expect(answered.value).toBe("halt waits");
  });

  it("CV19: fresh work starts after a cancelled turn whose teardown was held", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const started = withResolvers<void>();
    const cleanupRelease = withResolvers<void>();

    const answered = yield* withConversation(
      stream,
      stub(traffic, {
        hold: (content) =>
          content !== "abandoned"
            ? undefined
            : (function* (): Operation<void> {
                yield* ensure(function* () {
                  yield* cleanupRelease.operation;
                });
                started.resolve();
                yield* suspend();
              })(),
      }),
      function* (chat) {
        const caller = yield* spawn(() => chat.prompt("abandoned"));
        yield* started.operation;
        const halted = yield* spawn(function* (): Operation<void> {
          yield* caller.halt();
        });
        cleanupRelease.resolve();
        yield* halted;
        // The conversation is free again only because the cancelled turn's
        // work finished unwinding first.
        return yield* chat.prompt("asked again");
      },
    );

    if (!answered.ok) {
      throw answered.error;
    }
    expect(answered.value.ok && answered.value.value).toBe("[asked again]");
    expect(traffic.prompts.map((call) => call.content)).toEqual(["abandoned", "asked again"]);
    // The abandoned turn recorded nothing, so nothing resumes it.
    expect(turnNames(yield* stream.readAll())).toEqual(["turn:2"]);
  });
});

describe("Tier CV — the native conversation an established history names", () => {
  it("CV20: the provider's assertion is retained as the turn's own account", function* () {
    const stream = new InMemoryStream();

    const answered = yield* withConversation(
      stream,
      stub(fresh(), { asserts: () => "native-1" }),
      function* (chat) {
        return yield* chat.prompt("first");
      },
    );

    expect(answered.ok).toBe(true);
    expect(record(yield* stream.readAll(), "turn:1").agentSessionId).toBe("native-1");
  });

  it("CV21: a provider resolving a different native conversation refuses the turn", function* () {
    const stream = new InMemoryStream();
    const first = fresh();
    const opened = yield* withConversation(
      stream,
      stub(first, { asserts: () => "native-1" }),
      function* (chat) {
        return yield* chat.prompt("first");
      },
    );
    expect(opened.ok).toBe(true);

    // Reopened against a provider that resolves some other conversation.
    const again = fresh();
    const continued = yield* withConversation(
      stream,
      stub(again, { assertsAtPlacement: "native-other", asserts: () => "native-other" }),
      function* (chat) {
        return yield* chat.prompt("second");
      },
    );

    if (!continued.ok) {
      throw new Error(`reopening refused outright: ${continued.error.message}`);
    }
    expect(continued.value.ok).toBe(false);
    expect(!continued.value.ok && continued.value.error.message).toContain(
      "not reattached to another identity",
    );
    // Refused before the turn started: no prompt was sent anywhere, and the
    // established identity stands in the history unchanged.
    expect(again.prompts).toHaveLength(0);
    expect(turnNames(yield* stream.readAll())).toEqual(["turn:1"]);
    expect(record(yield* stream.readAll(), "turn:1").agentSessionId).toBe("native-1");
  });

  /**
   * Reopening against the identity the history itself names.
   *
   * What the next turn is held to comes from the retained turn records and from
   * nothing else — this conversation keeps no mapping record of its own, so a
   * record is the only account of which conversation it is. The window *before*
   * a turn has retained one is the canonical provider's to reconcile, and it is
   * proven there: `packages/acp/tests/host-conversation.test.ts` HC1.
   */
  it("CV22: reopening joins the identity its retained turns name, without resending them", function* () {
    const stream = new InMemoryStream();
    const first = fresh();
    // One completed turn and nothing after it: the provider's own account of
    // that turn is all this history holds about which conversation it is.
    const opened = yield* withConversation(
      stream,
      stub(first, { asserts: () => "native-1" }),
      function* (chat) {
        return yield* chat.prompt("first");
      },
    );
    expect(opened.ok).toBe(true);
    const events = yield* stream.readAll();
    expect(turnNames(events)).toEqual(["turn:1"]);

    // Reopened against a provider that resolves that same conversation. It is
    // reconciled to that identity rather than treated as unestablished, and no
    // replacement conversation is created.
    const again = fresh();
    const continued = yield* withConversation(
      stream,
      stub(again, { assertsAtPlacement: "native-1", asserts: () => "native-1" }),
      function* (chat) {
        return yield* chat.prompt("second");
      },
    );

    if (!continued.ok) {
      throw new Error(`reopening refused: ${continued.error.message}`);
    }
    expect(continued.value.ok && continued.value.value).toBe("[second]");
    // The accepted turn was not resent, and the second turn joined the same
    // native conversation.
    expect(again.prompts.map((call) => call.content)).toEqual(["second"]);
    expect(record(yield* stream.readAll(), "turn:2").agentSessionId).toBe("native-1");
  });

  it("CV23: a turn that ran in another native conversation does not replace the established one", function* () {
    const stream = new InMemoryStream();
    const first = fresh();
    const opened = yield* withConversation(
      stream,
      stub(first, { asserts: () => "native-1" }),
      function* (chat) {
        return yield* chat.prompt("first");
      },
    );
    expect(opened.ok).toBe(true);

    // The placement resolves the established conversation, and the provider
    // then reports the turn ran somewhere else — an assertion that arrives too
    // late to be refused before the turn.
    const again = fresh();
    const continued = yield* withConversation(
      stream,
      stub(again, { assertsAtPlacement: "native-1", asserts: () => "native-late" }),
      function* (chat) {
        return yield* chat.prompt("second");
      },
    );

    if (!continued.ok) {
      throw new Error(`reopening refused outright: ${continued.error.message}`);
    }
    expect(continued.value.ok).toBe(false);
    expect(!continued.value.ok && continued.value.error.message).toContain(
      "established identity stands",
    );
  });

  it("CV24: a history naming two native conversations cannot be opened", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    let turn = 0;
    const opened = yield* withConversation(
      stream,
      // Two turns, two different native conversations: nothing in the history
      // says which one this chat is.
      stub(traffic, {
        asserts: () => {
          turn += 1;
          return `native-${turn}`;
        },
      }),
      function* (chat) {
        yield* chat.prompt("first");
        return yield* chat.prompt("second");
      },
    );
    expect(opened.ok).toBe(true);

    const reopened = yield* withConversation(stream, stub(fresh()), function* () {
      return "reached";
    });

    expect(reopened.ok).toBe(false);
    expect(!reopened.ok && reopened.error.message).toContain("more than one native conversation");
  });
});
