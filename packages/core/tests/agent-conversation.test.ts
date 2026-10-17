/**
 * Tier CV — one retained agent conversation a host holds open.
 *
 * A document's `<Session>` and `<Prompt>` are written inside an expansion, with
 * an element to name the session and a journal already around them. A host
 * discussing something with an agent has neither and still needs the genuine
 * thing, so `useAgentConversation()` opens the conversation as an execution it
 * keeps alive — and these rows are about what that costs and what it buys.
 *
 * The provider here is a stub installed through the conversation's own
 * installations, which is where the accepted contract puts it: the assembly
 * selects the provider and its creation policy before any of the conversation's
 * code runs. It uses the delivered launch coordinator exactly as a real
 * provider does, because configuration readback is one of the things under test
 * and a stub that skipped the coordinator could not show it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  createContext,
  ensure,
  Ok,
  race,
  scoped,
  sleep,
  spawn,
  suspend,
  withResolvers,
} from "effection";
import type { Operation, Result, Stream } from "effection";

// The pinned factories are core-internal, as main keeps them: there is no
// public siteless evaluator and no public pinning surface.
import { pinnedComponent, pinnedMutation } from "../src/generated-xmd.ts";
import type {
  GeneratedMutation,
  GeneratedObservation,
  GeneratedXmdRequest,
} from "../src/generated-xmd.ts";
import { useAgentConversation } from "../host.ts";
import type { AgentConversation, ExecutionInstallation, GeneratedXmdRootResult } from "../host.ts";
import type { InvocationForm } from "../src/invocation-identity.ts";
import type { FunctionComponentDefinition } from "../src/types.ts";
import { useSelection } from "./support/generated-selection.ts";
import { answerProvider } from "./support/answer-provider.ts";
import { contributeDocumentation, Documentation } from "../src/documentation-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import { durabilityFailure } from "../src/errors.ts";
import { Execution } from "../src/execute.ts";
import type { Json } from "../src/types.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type {
  AgentOptions,
  AgentPromptEvent,
  PromptOptions,
  Session,
  SessionConfiguration,
} from "../src/agent/agent-api.ts";
import { installAgentComponents } from "../src/agent/components.ts";
import { AgentConversationProvider } from "../src/agent/conversation-provider.ts";
import type { AgentSessionRequest } from "../src/agent/session-request.ts";
import { sessionOf } from "../src/agent/session-use.ts";
import { useAgentPromptPublisher } from "../src/agent/publication.ts";
import { useSecretScannerFactory } from "../src/secrets/policy.ts";
import type { SecretScanner } from "../src/secrets/scanner.ts";
import type { SecretFinding } from "../src/secrets/findings.ts";
import type { AgentLaunchCoordinator } from "../src/agent/launch-coordinator.ts";
import type { ProviderSessionConfiguration } from "../src/agent/provider-configuration.ts";

const AGENT = "stub-agent";

/** What the stub provider was asked to do, in order. */
interface Traffic {
  readonly prompts: { content: string; sessionKey: string; agent: string }[];
  /**
   * The agent each session resolution was told to resolve under.
   *
   * Stated, not inherited: a conversation hands its provider the agent it
   * resolved, so recording the argument here is what lets a row say that one
   * turn resolved its session and sent its prompt under the same agent — and
   * say it about a value nothing between them could have answered differently.
   */
  readonly sessionAgents: string[];
  /**
   * Every ordinary `Agent` dispatch this provider served, by operation.
   *
   * A conversation reaches its provider directly, so this is empty for a chat
   * however much middleware is installed around the chain. A row that found an
   * entry here would be a row where routing was still involved.
   */
  readonly routed: string[];
  readonly setups: string[];
  /**
   * The exact Session settling each request produced, in order.
   *
   * The object, not a copy and not its key: what the conversation checks is
   * identity, so a row that wants to say the turn ran in the session its own
   * setup finished with has to be able to compare the two values themselves.
   */
  readonly settledSessions: Session[];
  /** The exact Session each turn was handed, in order. */
  readonly promptSessions: Session[];
  /** What the provider declared it was building under, each time it asked. */
  readonly activated: (ProviderSessionConfiguration | undefined)[];
  readonly applied: SessionConfiguration[];
  readonly optionProbes: (string | undefined)[];
}

interface StubOptions {
  /** How the provider answers one turn. Default: completes, echoing the text. */
  readonly respond?: (content: string) => {
    status?: "completed" | "failed" | "cancelled";
    deltas?: string[];
    /**
     * What the stream returns, when that is not what its deltas said.
     *
     * A real provider's return is its own value: an adapter that assembles the
     * whole reply itself, or one that answers with nothing, returns something
     * the deltas do not add up to. Absent means the deltas joined, which is
     * what every other case here is.
     */
    returns?: string;
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
  readonly assertsAtSetup?: string;
  /**
   * Tool calls this provider asks permission for while the turn runs.
   *
   * Raised from inside the consumption of its own stream, which is where a real
   * provider raises them — and therefore inside whatever ledger the turn placed
   * around that stream.
   */
  readonly asks?: readonly { toolCallId: string; title?: string; kind?: string }[];
  /**
   * Bind this under the secret policy's own name, inside the turn's own scope.
   *
   * A provider's `prompt()` runs in the scope the canonical consumer owns, so
   * this is a counterfeit mounted exactly where the live observation reads its
   * policy — which is the only place one could hope to be taken for it.
   */
  readonly counterfeits?: unknown;
  /** Called when this turn's own provider scope unwinds, however it ended. */
  readonly tears?: () => void;
  /**
   * Held inside that cleanup, for a case that watches a join happen.
   *
   * The provider's own per-turn teardown suspends here until the case releases
   * it, which is what makes "this failure waited for the stream to come down"
   * observable rather than inferred from the order two callbacks ran in.
   */
  readonly holdsTeardown?: () => Operation<void>;
  /** The checkpoint this provider names for the turn it completed. */
  readonly checkpoint?: { provider: string; kind: string; value: string };
  /**
   * What this provider declares it is building the session under.
   *
   * Absent means the constrained configuration below, which is what a host
   * that states its own empty tool and server lists supplies. A case that
   * returns something else is a host assembled differently, and a case that
   * returns nothing is one that cannot state its construction inputs at all.
   */
  readonly declares?: () => ProviderSessionConfiguration | undefined;
  /**
   * Install only ordinary `Agent` middleware, as a provider that serves
   * documents and not conversations does.
   *
   * The pre-correction shape of this very stub, kept as a case rather than as
   * a fallback: a host whose provider cannot serve a saved conversation has to
   * be told so, not quietly served through the routing a handler can redirect.
   */
  readonly withoutConversations?: true;
  /**
   * What the provider answers with instead of the session it settled.
   *
   * `"unsettled"` returns a session this provider never put through the setup;
   * `"substituted"` settles the request genuinely and then answers with
   * another session. Both are a provider that did not resolve this
   * conversation's own request, and neither is visible in the value itself.
   */
  readonly answersWith?: "unsettled" | "substituted";
}

/** What the stub provider says it is, and what it resolved. */
const PROVIDER = "stub";
const COMMAND = "stub-cmd";

/** The constrained configuration a host supplies when it states one. */
const CONFIGURATION: ProviderSessionConfiguration = Object.freeze({
  providerTools: Object.freeze([]),
  mcpServers: Object.freeze([]),
  permissions: Object.freeze({
    permissionMode: "deny-all",
    routing: "strict",
    nonInteractivePermissions: "deny",
  }),
  systemPrompt: null,
});

/**
 * One conversation installation carrying a stub provider.
 *
 * `install()` runs before the execution's document, which is the position the
 * accepted contract gives a host's own assembly: it selects the provider and
 * its creation policy before any of the conversation's code exists. The
 * provider itself is installed the ordinary way, inside the document, so it is
 * handed the same launch coordinator a real one is — which is what lets this
 * stub settle session setups and report what it verified.
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
            /**
             * Resolve one session request, as the real provider does.
             *
             * `agentName` is stated by the caller: a conversation hands over the
             * agent it resolved, which is what makes one turn's session and
             * prompt provably the same agent's. The setup is settled through the
             * delivered coordinator, so the configuration check and the
             * configured use are the genuine ones.
             */
            function* resolved(routed: AgentSessionRequest, agentName: string): Operation<Session> {
              traffic.sessionAgents.push(agentName);
              const setup = coordinator.sessionSetup(routed);
              traffic.setups.push(setup.sessionIdentity ?? "<none>");
              // Where the real provider asks: the command is resolved and the
              // construction inputs are settled, and nothing has been
              // reattached or created. A conversation that refuses what this
              // provider would build under refuses here.
              const declared = options.declares === undefined ? CONFIGURATION : options.declares();
              const authorized = yield* setup.activate(PROVIDER, COMMAND, declared);
              traffic.activated.push(declared);
              if (!authorized.ok) {
                throw authorized.error;
              }
              const session: Session = {
                sessionKey: `stub:${routed.name ?? "default"}`,
                cwd: "/stub",
                ...(options.assertsAtSetup === undefined
                  ? {}
                  : { agentSessionId: options.assertsAtSetup }),
              };
              if (options.answersWith === "unsettled") {
                // Never settled, so nothing authorized this session — and
                // nothing about the value says so.
                return session;
              }
              // Established, so what this turn asks is applied and read back —
              // the only thing that makes a configuration a fact about the turn
              // rather than a hope.
              const settled = yield* setup.finish(session, {
                kind: "existing",
                // deno-lint-ignore require-yield
                *configure(asked: SessionConfiguration): Operation<SessionConfiguration> {
                  traffic.applied.push(asked);
                  return options.verify ? options.verify(asked) : asked;
                },
              });
              traffic.settledSessions.push(settled);
              return options.answersWith === "substituted"
                ? { sessionKey: `stub:substituted`, cwd: "/stub" }
                : settled;
            }

            /** What this agent advertises. The same answer either way. */
            function advertised(agent: string | undefined): AgentOptions {
              traffic.optionProbes.push(agent);
              return {
                agent: agent ?? AGENT,
                model: {
                  selected: "m-1",
                  options: [{ id: "m-1", name: "One", description: null, group: null }],
                },
                effort: null,
              };
            }

            // Ordinary `Agent` middleware, for a document's own `<Session>` and
            // `<Prompt>`. A conversation reaches none of it, which is what
            // `traffic.routed` is here to show.
            yield* Agent.around(
              {
                // deno-lint-ignore require-yield
                *agent([name]) {
                  traffic.routed.push("agent");
                  return name ?? providerOptions.defaultAgent;
                },
                *session([routed]): Operation<Session> {
                  traffic.routed.push("session");
                  if (typeof routed === "string" || routed === undefined) {
                    return { sessionKey: `stub:${routed ?? "default"}`, cwd: "/stub" };
                  }
                  return yield* resolved(routed, yield* Agent.operations.agent());
                },
                // deno-lint-ignore require-yield
                *options([agent]): Operation<AgentOptions> {
                  traffic.routed.push("options");
                  return advertised(agent);
                },
                // deno-lint-ignore require-yield
                *prompt([content, promptOptions]) {
                  traffic.routed.push("prompt");
                  return turn(traffic, content, promptOptions, options, coordinator);
                },
              },
              { at: "min" },
            );
            if (options.withoutConversations === true) {
              return;
            }
            // What a conversation reads once in its own scope. The same
            // implementations, reached without the chain and told the agent
            // and the session explicitly.
            yield* AgentConversationProvider.set({
              // deno-lint-ignore require-yield
              *agent(name: string): Operation<string> {
                return name;
              },
              *session(request: AgentSessionRequest, agent: string): Operation<Session> {
                return yield* resolved(request, agent);
              },
              // deno-lint-ignore require-yield
              *options(agent: string): Operation<AgentOptions> {
                return advertised(agent);
              },
              // deno-lint-ignore require-yield
              *prompt(
                content: string,
                promptOptions: PromptOptions & { agent: string; session: Session },
              ): Operation<Stream<AgentPromptEvent, string>> {
                return turn(traffic, content, promptOptions, options, coordinator);
              },
            });
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
  coordinator: AgentLaunchCoordinator,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      // The exact value this turn was routed, not a copy of it: for a
      // configured turn that is the authentic use, and it is the only thing
      // that can say what the conversation was put under.
      const routed = promptOptions?.session;
      const named: Session =
        typeof routed === "object" && routed !== null
          ? routed
          : { sessionKey: "stub:default", cwd: "/stub" };
      // Asserting the native identity the way a provider does: on the value it
      // reports as the conversation this turn ran in.
      const asserted = options.asserts?.(content);
      const session: Session =
        asserted === undefined ? named : { ...named, agentSessionId: asserted };
      traffic.prompts.push({
        content,
        sessionKey: sessionOf(named)?.sessionKey ?? named.sessionKey,
        agent: promptOptions?.agent ?? AGENT,
      });
      traffic.promptSessions.push(named);
      if (options.tears !== undefined || options.holdsTeardown !== undefined) {
        const tears = options.tears;
        const holds = options.holdsTeardown;
        // The provider's own per-turn cleanup, in the scope the consumer owns:
        // it runs when that scope unwinds, which is what joining it means.
        yield* ensure(function* (): Operation<void> {
          tears?.();
          if (holds !== undefined) {
            yield* holds();
          }
        });
      }
      if (options.counterfeits !== undefined) {
        yield* createContext<unknown>("executablemd.secrets.policy").set(options.counterfeits);
      }
      const response = options.respond ? options.respond(content) : {};
      const deltas = response.deltas ?? [`[${content}]`];
      const terminal: AgentPromptEvent = {
        type: "terminal",
        status: response.status ?? "completed",
      };
      // Named on the exact terminal event this turn produced, through the
      // coordinator delivered to this provider — the one channel that can say
      // which turn a checkpoint belongs to.
      if (options.checkpoint !== undefined) {
        coordinator.checkpoint(terminal, options.checkpoint);
      }
      const events: AgentPromptEvent[] = [
        { type: "started", agent: promptOptions?.agent ?? AGENT, session },
        ...deltas.map((text): AgentPromptEvent => ({ type: "text_delta", text })),
        terminal,
      ];
      let index = 0;
      let waited = false;
      let asked = false;
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
          if (!asked) {
            asked = true;
            // Raised while this turn's own stream is being consumed, in the
            // order the agent asked. Whatever ledger was placed around the
            // stream is the one these find.
            for (const call of options.asks ?? []) {
              yield* Agent.operations.requestPermission({
                session,
                toolCall: call,
                options: [
                  { optionId: "allow", name: "Allow once", kind: "allow_once" },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              });
            }
          }
          if (index < events.length) {
            return { done: false, value: events[index++]! };
          }
          return { done: true, value: response.returns ?? deltas.join("") };
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

/** The canonical records of what this conversation's sessions are built under. */
function configurations(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) =>
      event.type === "yield" && event.description.type === "agent_conversation_configuration",
  );
}

/**
 * The conversation's own durable records, in the order the history holds them.
 *
 * Filtered to the three this conversation writes. The execution's component
 * imports are on this stream too, and pinning those here would make this row
 * about how the synthetic root is assembled rather than about where the
 * configuration lands.
 */
const CONVERSATION_RECORDS = [
  "agent_conversation",
  "agent_conversation_configuration",
  "agent_prompt",
];

function sequence(events: readonly DurableEvent[]): string[] {
  const held: string[] = [];
  for (const event of events) {
    if (event.type === "yield" && CONVERSATION_RECORDS.includes(event.description.type)) {
      held.push(event.description.type);
    }
  }
  return held;
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
/**
 * Tier PV — what a host is shown while a canonical turn is still talking.
 *
 * The direct conversation path, which is the one that cannot be observed
 * through Agent middleware: its provider is called directly, so the canonical
 * consumer is the only place the exact turn and every arriving delta are both
 * known. These rows are about what that consumer offers, what it clears first,
 * and what happens when the host it offers it to fails.
 */
describe("Tier PV — the live account of a canonical turn", () => {
  /** One observing publisher, recording what it was told and what it began. */
  function watcher(
    seen: (string | null)[],
    handles: unknown[],
    published: unknown[],
    failing?: () => void,
  ) {
    return {
      *install(): Operation<void> {
        yield* useAgentPromptPublisher({
          // deno-lint-ignore require-yield
          *begin(): Operation<unknown> {
            // A fresh object per turn, the way a host that tells its own
            // conversations apart makes one.
            const handle = { turn: handles.length + 1 };
            handles.push(handle);
            return handle;
          },
          // deno-lint-ignore require-yield
          *observe({ begun, text }): Operation<void> {
            expect(begun).toBe(handles[handles.length - 1]);
            seen.push(text);
            failing?.();
          },
          *publish(publication): Operation<void> {
            published.push(publication.begun);
            yield* publication.append();
          },
        });
      },
    };
  }

  it("PV2: a host is shown whole prefixes, and the record holds the stream's own text", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const seen: (string | null)[] = [];
    const handles: unknown[] = [];
    const published: unknown[] = [];

    const answered = yield* withConversation(
      stream,
      // A construct split across two deltas: what arrives second completes
      // what arrived first, which is why a host is offered the whole of it
      // rather than the piece.
      stub(traffic, { respond: () => ({ deltas: ["<Output>par", "tial</Output>"] }) }),
      function* (chat) {
        return yield* chat.prompt("say something");
      },
      "chat-1",
      [watcher(seen, handles, published)],
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    // Each offer is the whole source so far, in arrival order — never a delta.
    expect(seen).toEqual(["<Output>par", "<Output>partial</Output>"]);
    // The record holds the stream's own return, untouched by any of this, and
    // the publication carries the handle this turn began with.
    expect(answered.value.ok && answered.value.value).toBe("<Output>partial</Output>");
    expect(record(yield* stream.readAll(), "turn:1")["text"]).toBe("<Output>partial</Output>");
    expect(published).toEqual([handles[0]]);
  });

  it("PV2: a return the deltas did not say replaces the candidate exactly", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const seen: (string | null)[] = [];

    const answered = yield* withConversation(
      stream,
      stub(traffic, {
        respond: () => ({ deltas: ["half"], returns: "the whole of it" }),
      }),
      function* (chat) {
        return yield* chat.prompt("say something");
      },
      "chat-1",
      [watcher(seen, [], [])],
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    // Offered after the delta, then replaced by what the stream actually
    // returned: a host left showing "half" would be showing something the
    // record does not hold.
    expect(seen).toEqual(["half", "the whole of it"]);
    expect(record(yield* stream.readAll(), "turn:1")["text"]).toBe("the whole of it");
  });

  it("PV2: a return of nothing is an empty candidate, not a withdrawal", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const seen: (string | null)[] = [];

    const answered = yield* withConversation(
      stream,
      stub(traffic, { respond: () => ({ deltas: ["something"], returns: "" }) }),
      function* (chat) {
        return yield* chat.prompt("say something");
      },
      "chat-1",
      [watcher(seen, [], [])],
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    // An empty string, which is a cleared prefix that says nothing — and not
    // `null`, which would mean this turn's source may not be shown at all.
    expect(seen).toEqual(["something", ""]);
    expect(seen[1]).not.toBe(null);
  });

  /** A scanner that finds a secret in whatever whole text contains this. */
  function useScannerFinding(marker: string, scanned: string[]): Operation<void> {
    return useSecretScannerFactory(() => {
      const scanner: SecretScanner = {
        // deno-lint-ignore require-yield
        *scan(content: string): Operation<SecretFinding[]> {
          scanned.push(content);
          return content.includes(marker)
            ? [
                {
                  ruleId: "test-rule",
                  messageId: "TEST_SECRET",
                  location: { line: 1, column: 1 },
                  fingerprint: "test-fingerprint",
                },
              ]
            : [];
        },
      };
      return scanner;
    });
  }

  it("PV4: a secret split across deltas is found in the whole, and withdraws the body", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const seen: (string | null)[] = [];
    const scanned: string[] = [];
    // Assembled here so no literal is committed, and split so that neither
    // piece contains it: only the accumulation does.
    const marker = ["tok", "en-", "ABCDEF"].join("");

    const answered = yield* scoped(function* () {
      yield* useScannerFinding(marker, scanned);
      return yield* withConversation(
        stream,
        stub(traffic, {
          respond: () => ({
            deltas: ["<Output>safe enough</Output>", `<Output>tok${"en-"}`, "ABCDEF</Output>"],
          }),
        }),
        function* (chat) {
          return yield* chat.prompt("say something");
        },
        "chat-1",
        [watcher(seen, [], [])],
      );
    });

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    // The first prefix cleared and was offered. The second did too — neither
    // piece holds the whole thing. The third completes it, and that is where
    // the body is withdrawn.
    expect(seen[0]).toBe("<Output>safe enough</Output>");
    expect(seen[seen.length - 1]).toBe(null);
    // And nothing further about this turn is offered, including the stream's
    // own return: one withdrawal, then silence.
    expect(seen.filter((one) => one === null)).toHaveLength(1);
    expect(seen.indexOf(null)).toBe(seen.length - 1);
    // The candidate that holds it was never offered at all. This is what the
    // accumulation buys: a piece that clears on its own does not make the
    // whole it became safe to show. Asserted as a predicate, never printed.
    expect(seen.filter((one) => one !== null).some((one) => one!.includes(marker))).toBe(false);
    // The withdrawal happened at the piece that completed it, before the
    // stream returned: three offers, the last of them the withdrawal.
    expect(seen).toHaveLength(3);
    // Whole prefixes were scanned, not pieces: the last one contains the whole
    // candidate. Asserted by length and shape, never by printing it.
    expect(scanned[scanned.length - 1]?.length).toBeGreaterThan(seen[0]!.length);
    // The journal's own gate is what decides persistence, and it refused this
    // turn's record rather than this screen decision doing it.
    expect(answered.value.ok).toBe(false);
  });

  it("PV4: a policy this execution did not install clears nothing", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const seen: (string | null)[] = [];

    const answered = yield* withConversation(
      stream,
      stub(traffic, {
        respond: () => ({ deltas: ["<Output>anything</Output>"] }),
        // Bound in the turn's own scope, under the policy's own name — written
        // out, the way something inside a run constructs it from the source. It
        // describes itself as disabled detection; it is not the policy this
        // execution installed, and describing itself is not authentication.
        counterfeits: { enabled: false, describe: () => "disabled" },
      }),
      function* (chat) {
        return yield* chat.prompt("say something");
      },
      "chat-1",
      [watcher(seen, [], [])],
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    // Whatever that value says about itself, the source is not shown.
    expect(seen).toEqual([null]);
  });

  it("PV5: an observer that throws fails the run and leaves no record of the turn", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const seen: (string | null)[] = [];
    const torn: string[] = [];
    const thrown = new Error("this host could not show the turn");

    const letGo = withResolvers<void>();
    const tearing = withResolvers<void>();
    /** Whether the turn had answered its caller, each time the hold looked. */
    const answering: boolean[] = [];
    let returned = false;
    const answered = yield* withConversation(
      stream,
      stub(traffic, {
        respond: () => ({ deltas: ["<Output>said</Output>"] }),
        tears: () => torn.push("provider"),
        *holdsTeardown(): Operation<void> {
          tearing.resolve();
          yield* letGo.operation;
        },
      }),
      function* (chat) {
        // Watched from beside the turn: while the provider's own cleanup is
        // held, this failure has not returned and nothing has been published.
        yield* spawn(function* (): Operation<void> {
          yield* tearing.operation;
          torn.push("held");
          // The prompt itself has not answered. This is the thing the hold is
          // for: a failure that returned to its caller and then waited for
          // cleanup somewhere else would publish the same nothing and run the
          // same sibling, so what is asked here is *when* the turn answered.
          answering.push(returned);
          expect(returned).toBe(false);
          expect(prompts(yield* stream.readAll())).toEqual([]);
          yield* sleep(5);
          torn.push("still held");
          answering.push(returned);
          expect(returned).toBe(false);
          letGo.resolve();
        });
        const refused = yield* chat.prompt("say something");
        returned = true;
        // Asked again, on the same conversation: a run whose durability failure
        // is active does not carry on, and this is how that is observable
        // rather than inferred.
        const after = yield* chat.prompt("and again");
        return { refused, after };
      },
      "chat-1",
      [
        watcher(seen, [], [], () => {
          throw thrown;
        }),
      ],
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    // The turn is refused, and refused with the host's own failure: a trusted
    // host that could not be shown its turn has failed its own operation, so
    // this is not an agent failure and is not answered as one.
    expect(answered.value.refused.ok).toBe(false);
    const refused = answered.value.refused.ok ? undefined : answered.value.refused.error;
    expect(String(refused?.message)).toContain("this host could not show the turn");
    // And the run does not carry on from it: the next turn is refused with the
    // same active failure and reaches no provider.
    expect(answered.value.after.ok).toBe(false);
    expect(traffic.prompts.map((call) => call.content)).toEqual(["say something"]);
    // Nothing durable describes the turn. A fabricated provider-failed Prompt
    // would say the agent failed, which is not what happened.
    expect(prompts(yield* stream.readAll())).toEqual([]);
    // And the join really was one: the failure waited for the provider's own
    // per-turn cleanup, which this case held open while nothing was returned
    // and nothing was published. The order is the evidence, and the hold is
    // what makes it an order rather than a coincidence.
    expect(torn).toEqual(["provider", "held", "still held"]);
    // Both times the hold looked, the turn had not answered — which is the
    // same observation stated from out here, where a throw inside the sibling
    // could not be the only thing carrying it.
    expect(answering).toEqual([false, false]);
    expect(returned).toBe(true);
  });

  it("PV5: control — an observing turn publishes once, with its audit and checkpoint", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const seen: (string | null)[] = [];
    const handles: unknown[] = [];
    const published: unknown[] = [];
    const associations: unknown[] = [];
    const appends: number[] = [];
    const decided: string[] = [];
    const torn: string[] = [];

    const answered = yield* withConversation(
      stream,
      stub(traffic, {
        respond: () => ({ deltas: ["<Output>said</Output>"] }),
        // A real tool permission raised from inside this turn's own stream,
        // and the provider's own checkpoint on the terminal it produced.
        asks: [{ toolCallId: "call-1", title: "Run the build" }],
        checkpoint: { provider: "stub", kind: "stub-turn", value: "turn-3" },
        tears: () => torn.push("provider"),
      }),
      function* (chat) {
        return yield* chat.prompt("say something");
      },
      "chat-1",
      [
        {
          *install(): Operation<void> {
            yield* Agent.around(
              {
                // deno-lint-ignore require-yield
                *requestPermission([request]) {
                  decided.push(request.toolCall.toolCallId);
                  return { outcome: "selected", optionId: "allow" };
                },
              },
              { at: "min" },
            );
            yield* useAgentPromptPublisher({
              // deno-lint-ignore require-yield
              *begin(): Operation<unknown> {
                const handle = { turn: handles.length + 1 };
                handles.push(handle);
                return handle;
              },
              // deno-lint-ignore require-yield
              *observe({ begun, text }): Operation<void> {
                expect(begun).toBe(handles[0]);
                seen.push(text);
              },
              *publish(publication): Operation<void> {
                published.push(publication.begun);
                associations.push(publication.association);
                yield* publication.append();
                appends.push(1);
              },
            });
          },
        },
      ],
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    // The discriminating half: observing at all is not what failed the run
    // above. The turn completed, was shown once, published exactly once with
    // the handle it began with, and nothing about either is changed by being
    // observed.
    expect(answered.value.ok).toBe(true);
    expect(seen).toEqual(["<Output>said</Output>"]);
    expect(published).toEqual([handles[0]]);
    expect(appends).toEqual([1]);
    expect(prompts(yield* stream.readAll())).toHaveLength(1);
    expect(record(yield* stream.readAll(), "turn:1")["status"]).toBe("completed");
    // The permission this turn really asked for reached the policy and is in
    // the record's own audit, with the outcome this host chose.
    expect(decided).toEqual(["call-1"]);
    expect(record(yield* stream.readAll(), "turn:1")["permissions"]).toEqual([
      {
        toolCallId: "call-1",
        title: "Run the build",
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        outcome: { outcome: "selected", optionId: "allow" },
      },
    ]);
    // And the association the provider named for this exact completion came
    // through the publication, not through anything the observation carried.
    expect(associations).toEqual([
      {
        checkpoint: { provider: "stub", kind: "stub-turn", value: "turn-3" },
        sessionKey: "stub:chat-1",
      },
    ]);
    expect(torn).toEqual(["provider"]);
  });

  it("PV5: a replayed turn tells nobody, because nothing is happening", function* () {
    const stream = new InMemoryStream();
    const first = fresh();
    const opened = yield* withConversation(stream, stub(first), function* (chat) {
      return yield* chat.prompt("first");
    });
    expect(opened.ok).toBe(true);

    const again = fresh();
    const seen: (string | null)[] = [];
    const handles: unknown[] = [];
    const published: unknown[] = [];
    const continued = yield* withConversation(
      stream,
      stub(again),
      function* (chat) {
        return yield* chat.prompt("second");
      },
      "chat-1",
      [watcher(seen, handles, published)],
    );

    if (!continued.ok) {
      throw new Error(`reopening refused: ${continued.error.message}`);
    }
    // The retained turn replayed from its own record: no provider stream, so
    // nothing to be shown and nothing to begin. Only the live turn did either.
    expect(again.prompts.map((call) => call.content)).toEqual(["second"]);
    expect(handles).toHaveLength(1);
    expect(seen).toEqual(["[second]"]);
    expect(published).toHaveLength(1);
  });

  it("PV2: two turns with the same words are two turns, by their own handles", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const seen: (string | null)[] = [];
    const handles: unknown[] = [];
    const published: unknown[] = [];

    const answered = yield* withConversation(
      stream,
      stub(traffic, { respond: () => ({ deltas: ["said"] }) }),
      function* (chat) {
        const first = yield* chat.prompt("the same words");
        const second = yield* chat.prompt("the same words");
        return [first, second];
      },
      "chat-1",
      [watcher(seen, handles, published)],
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    // Identical input, and nothing identical about the two turns: each began
    // with its own object, and each publication ended the turn that began it.
    expect(handles).toHaveLength(2);
    expect(handles[0]).not.toBe(handles[1]);
    expect(published).toEqual([handles[0], handles[1]]);
    expect(seen).toEqual(["said", "said"]);
  });
});

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
  /** Whatever else the case's host assembles beside the provider. */
  beside: readonly ExecutionInstallation[] = [],
  /** The agent this conversation is opened with. Default: the host's own. */
  agent = AGENT,
  /**
   * The generated components this conversation's host selects.
   *
   * Declared with the assembly rather than passed with each call, because a
   * root is admitted from the selection its execution captured. Every row that
   * names a component states it here, and the probe is what a row that only
   * evaluates structure gets.
   */
  declare: readonly (GeneratedObservation | GeneratedMutation)[] = [probe([])],
): Operation<Result<T>> {
  return scoped(function* () {
    const opened = yield* useAgentConversation({
      history: stream,
      id,
      agent,
      installations: [installation, ...beside, selecting(declare)],
    });
    if (!opened.ok) {
      return opened;
    }
    return Ok(yield* body(opened.value));
  });
}

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false } as const;

/**
 * One host definition, with the per-form metadata main's selection reads.
 *
 * Identity and effect are the declaration's own rather than an argument passed
 * beside it, which is what the captured selection reads. Every assertion below
 * is unchanged; only where the identity comes from moved.
 */
function definitionOf(
  name: string,
  effect: "read" | "write",
  forms: readonly ("self-closing" | "paired")[],
  body: () => Operation<Json>,
): FunctionComponentDefinition {
  return {
    kind: "function",
    name,
    props: NO_PROPS,
    generated: Object.fromEntries(
      forms.map((form) => [form, { identity: `https://executable.md/components/${name}`, effect }]),
    ),
    *fn(): Operation<Json> {
      return yield* body();
    },
  };
}

/** The two spellings a declaration can offer a generated use of. */
const FORMS: readonly InvocationForm[] = ["self-closing", "paired"];

/** Which spellings one pinned entry offers, as the selection states them. */
function formsOf(entry: GeneratedObservation | GeneratedMutation): readonly InvocationForm[] {
  const offered = entry.definition.generated ?? {};
  return FORMS.filter((form) => form in offered);
}

/** The installation that declares and answers for these entries. */
function selecting(
  entries: readonly (GeneratedObservation | GeneratedMutation)[],
): ExecutionInstallation {
  return {
    componentAnswers: entries.map((entry) => answerProvider(entry.name, entry.definition)),
    *install(): Operation<void> {
      yield* useSelection(Object.fromEntries(entries.map((entry) => [entry.name, formsOf(entry)])));
    },
  };
}

/** One observation a reply may name, recording every time it is invoked. */
function probe(invoked: string[]): GeneratedObservation {
  return pinnedComponent(
    "Probe",
    definitionOf("Probe", "read", ["self-closing"], function* (): Operation<Json> {
      invoked.push("probed");
      return "probed";
    }),
    "component-answer",
  );
}

/** One generated request, with the probe as its whole read table. */
function generated(source: string, _invoked: string[] = [], id = "reply-1"): GeneratedXmdRequest {
  // A root carries no tables: its execution captured the selection, which the
  // case declares with `selecting([...])` beside the provider.
  return { id, source };
}

/** A control that fails on its own terms, after whatever ran before it ran. */
function boom(): GeneratedObservation {
  return pinnedComponent(
    "Boom",
    definitionOf("Boom", "read", ["self-closing"], function* (): Operation<Json> {
      throw new Error("the control refused this request");
    }),
    "component-answer",
  );
}
/** One mutation a reply may name, so a `write` selection is statable. */
function fill(invoked: string[]): GeneratedMutation {
  return pinnedMutation(
    "Fill",
    definitionOf("Fill", "write", ["self-closing"], function* (): Operation<Json> {
      invoked.push("filled");
      return "filled";
    }),
    "self-closing",
    "component-answer",
  );
}
/** A control that journals nothing and holds both its body and its cleanup. */
function holdingControl(
  reached: { resolve(): void },
  release: Operation<void>,
  order: string[],
): GeneratedObservation {
  return pinnedComponent(
    "Hold",
    definitionOf("Hold", "read", ["self-closing"], function* (): Operation<Json> {
      yield* ensure(function* () {
        yield* release;
        order.push("evaluation cleanup");
      });
      reached.resolve();
      yield* suspend();
      return "held";
    }),
    "component-answer",
  );
}

/** The generated admissions a history holds, one per evaluation. */
function admissions(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
}

/** The coroutines a history holds, which is what names each sequence. */
function sequences(events: readonly DurableEvent[]): string[] {
  return [...new Set(events.map((event) => event.coroutineId))];
}

/** Whatever this answer rendered, or the refusal explaining why there is none. */
function rendered(answer: Result<GeneratedXmdRootResult>): GeneratedXmdRootResult {
  if (!answer.ok) {
    throw new Error(`the reply failed: ${answer.error.message}`);
  }
  return answer.value;
}

/**
 * A package of the host's own, documenting a component core does not ship.
 *
 * Registration and chapter together, through the one mechanism a package's
 * bootstrap uses, so the chapter is in the chain this conversation's execution
 * collects before its root import.
 */
function markerPackage(
  prose: string,
  counted: { reads: number } = { reads: 0 },
): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* registerComponents([
        {
          name: "Marker",
          origin: "@executablemd/test",
          props: NO_PROPS,
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            return "marked";
          },
        },
      ]);
      // deno-lint-ignore require-yield
      yield* contributeDocumentation(function* () {
        counted.reads += 1;
        return {
          source: {
            owner: "@executablemd/test",
            asset: "packages/test/src/components.md",
            text: prose,
          },
          supplies: new Set(["Marker"]),
        };
      });
    },
  };
}

function fresh(): Traffic {
  return {
    prompts: [],
    setups: [],
    activated: [],
    applied: [],
    optionProbes: [],
    sessionAgents: [],
    routed: [],
    settledSessions: [],
    promptSessions: [],
  };
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
    // One conversation: both turns ran in the session the one request named.
    expect(new Set(traffic.prompts.map((call) => call.sessionKey)).size).toBe(1);

    const events = yield* stream.readAll();
    expect(prompts(events)).toHaveLength(2);
    // The root was never completed, which is what makes this history a
    // conversation to reopen rather than a finished run to replay.
    expect(terminated(events)).toBe(false);
  });

  it("CV1a: a turn resolves its session under the agent it names on its prompt", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(stream, stub(traffic), function* (chat) {
      return yield* chat.prompt("hello");
    });

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    expect(answered.value.ok).toBe(true);
    // The positive control, and the reason this went unnoticed: a conversation
    // under the host's own agent answers the same whether or not its agent is
    // the one its provider was told, because the two answers coincide.
    expect(traffic.sessionAgents).toEqual([AGENT]);
    expect(traffic.prompts.map((call) => call.agent)).toEqual([AGENT]);
    expect(traffic.routed).toEqual([]);
  });

  it("CV1b: and does so for an agent that is not the host's default", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(
      stream,
      stub(traffic),
      function* (chat) {
        return yield* chat.prompt("hello");
      },
      "chat-1",
      [],
      "other-agent",
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    // The turn runs, which is the whole of it: a conversation that resolved its
    // session under one agent and sent its prompt to another is refused by a
    // provider that compares the two, so this row is what says a conversation
    // may run under an agent its host did not default to.
    expect(answered.value.ok).toBe(true);
    // One agent, stated to both of the turn's operations. The request still
    // names no agent — what puts this one in force is the conversation passing
    // what it resolved to its provider, so neither resolution could have
    // answered with anything else.
    expect(traffic.sessionAgents).toEqual(["other-agent"]);
    expect(traffic.prompts.map((call) => call.agent)).toEqual(["other-agent"]);
    // And none of it was routed. The chain is installed and composes for a
    // document; this conversation reached its provider directly, so nothing in
    // between was in a position to answer for either resolution.
    expect(traffic.routed).toEqual([]);
  });

  it("SC1: the configuration is committed before the provider resolves anything", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const opened = yield* withConversation(stream, stub(traffic), function* (chat) {
      return yield* chat.prompt("first");
    });
    expect(opened.ok).toBe(true);

    const events = yield* stream.readAll();
    // One record, written once, holding the values rather than a digest of
    // them — and sitting ahead of the turn, because the turn is the native
    // work it had to be committed before.
    const saved = configurations(events);
    expect(saved).toHaveLength(1);
    expect(sequence(events)).toEqual([
      "agent_conversation",
      "agent_conversation_configuration",
      "agent_prompt",
    ]);
    const held = saved[0];
    if (held?.type !== "yield" || held.result.status !== "ok") {
      throw new Error("the conversation's configuration recorded no outcome");
    }
    expect(held.result.value).toEqual({
      provider: PROVIDER,
      agentCommand: COMMAND,
      configuration: {
        providerTools: [],
        mcpServers: [],
        permissions: {
          permissionMode: "deny-all",
          routing: "strict",
          nonInteractivePermissions: "deny",
        },
        systemPrompt: null,
      },
    });
    // A second turn in the same process compares rather than writing again.
    const second = yield* withConversation(stream, stub(fresh()), function* (chat) {
      return yield* chat.prompt("second");
    });
    expect(second.ok).toBe(true);
    expect(configurations(yield* stream.readAll())).toHaveLength(1);
  });

  it("SC2: a reopening is continued under its own configuration, or not at all", function* () {
    const stream = new InMemoryStream();
    const created = fresh();
    const first = yield* withConversation(
      stream,
      stub(created, { asserts: () => "native-one" }),
      function* (chat) {
        return yield* chat.prompt("first");
      },
    );
    expect(first.ok).toBe(true);
    const established = yield* stream.readAll();

    // The compatible arm: same configuration, same conversation, next answer.
    const compatible = fresh();
    const continued = yield* withConversation(
      stream,
      stub(compatible, { asserts: () => "native-one" }),
      function* (chat) {
        return yield* chat.prompt("second");
      },
    );
    if (!continued.ok) {
      throw new Error(`the compatible reopening refused: ${continued.error.message}`);
    }
    expect(continued.value.ok && continued.value.value).toBe("[second]");

    // The incompatible arm, on a history of its own so the refusal is read
    // against the configuration that created it. One value differs — the
    // system prompt this host customizes — and everything else is fixed.
    const changed = new InMemoryStream();
    for (const event of established) {
      yield* changed.append(event);
    }
    const other = fresh();
    const refused = yield* withConversation(
      changed,
      stub(other, {
        asserts: () => "native-one",
        declares: () => ({ ...CONFIGURATION, systemPrompt: "a different prompt" }),
      }),
      function* (chat) {
        return yield* chat.prompt("second");
      },
    );
    if (!refused.ok) {
      throw new Error(`the incompatible reopening did not open: ${refused.error.message}`);
    }
    expect(refused.value.ok).toBe(false);
    expect(!refused.value.ok && refused.value.error.message).toContain(
      "created under a different provider configuration",
    );
    // Refused before the provider resolved anything: no session was settled
    // and no turn was sent, so nothing was created in place of this chat.
    expect(other.prompts).toEqual([]);
    expect(other.applied).toEqual([]);
    // And the chat, its configuration and its native identity all stand.
    expect(configurations(yield* changed.readAll())).toHaveLength(1);
    expect(prompts(yield* changed.readAll())).toHaveLength(1);
  });

  it("SC3: a provider that cannot state its configuration continues nothing", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const refused = yield* withConversation(
      stream,
      stub(traffic, { declares: () => undefined }),
      function* (chat) {
        return yield* chat.prompt("first");
      },
    );
    if (!refused.ok) {
      throw new Error(`the conversation did not open: ${refused.error.message}`);
    }
    expect(refused.value.ok).toBe(false);
    expect(!refused.value.ok && refused.value.error.message).toContain(
      "no active provider configuration was named",
    );
    // Nothing was saved and nothing was sent: a configuration that cannot be
    // stated is not one an empty record could stand in for.
    expect(configurations(yield* stream.readAll())).toEqual([]);
    expect(traffic.prompts).toEqual([]);
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
    expect(traffic.setups).toHaveLength(0);
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

  it("CV13: an existing conversation does not change agent in place", function* () {
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
      stub(again, { assertsAtSetup: "native-other", asserts: () => "native-other" }),
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
      stub(again, { assertsAtSetup: "native-1", asserts: () => "native-1" }),
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

    // The setup resolves the existing conversation, and the provider
    // then reports the turn ran somewhere else — an assertion that arrives too
    // late to be refused before the turn.
    const again = fresh();
    const continued = yield* withConversation(
      stream,
      stub(again, { assertsAtSetup: "native-1", asserts: () => "native-late" }),
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

/**
 * Tier CV — the conversation evaluates what its own turn produced.
 *
 * A reply is source, and running it is a separate act. `prompt` returns what
 * the provider said; `evaluateGeneratedXmdRoot` runs it, through the same
 * conversation, so the root is evaluated under the documentation and the
 * canonical protected dispatch that conversation's execution captured.
 *
 * It is a third job on the one mailbox rather than a door beside it, which is
 * what makes "one conversation does one thing at a time" true of all three.
 */
describe("Tier CV — a conversation evaluates a reply it produced", () => {
  it("CV25: a completed reply is evaluated explicitly, and evaluating reaches no provider", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const invoked: string[] = [];
    const answer: { reply?: string; ran?: Result<GeneratedXmdRootResult> } = {};

    const outcome = yield* withConversation(
      stream,
      stub(traffic),
      function* (chat) {
        // Asked immediately: no generated effect precedes this call, so the
        // conversation does not evaluate anything on the way to being ready.
        expect(admissions(yield* stream.readAll())).toHaveLength(0);
        const replied = yield* chat.prompt("<Output>\n<Probe />\n</Output>\n");
        answer.reply = replied.ok ? replied.value : undefined;
        // The prompt returned source and ran none of it.
        expect(invoked).toEqual([]);
        expect(admissions(yield* stream.readAll())).toHaveLength(0);
        answer.ran = yield* chat.evaluateGeneratedXmdRoot(
          generated("<Output>\n<Probe />\n</Output>\n", invoked),
        );
      },
      "chat-1",
      [],
      AGENT,
      // This row's own probe, so what it watches is the instance the host
      // declared.
      [probe(invoked)],
    );

    expect(outcome.ok).toBe(true);
    expect(answer.reply).toContain("Probe");
    expect(rendered(answer.ran ?? { ok: false, error: new Error("none") }).output).toContain(
      "probed",
    );
    expect(invoked).toEqual(["probed"]);
    // One turn, and no second setup, prompt, configuration or option probe
    // from the evaluation.
    expect(traffic.prompts).toHaveLength(1);
    expect(traffic.setups).toHaveLength(1);
    expect(traffic.applied).toHaveLength(0);
    expect(traffic.optionProbes).toEqual([]);
    // The evaluation owns a sequence of its own, beside the turn's.
    const events = yield* stream.readAll();
    expect(sequences(events)).toContain("generated_root:1");
    expect(prompts(events)).toHaveLength(1);
  });

  it("CV26: the three jobs share one admission guard", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const order: string[] = [];
    const invoked: string[] = [];
    const reached = withResolvers<void>();
    const release = withResolvers<void>();
    const promptHeld = withResolvers<void>();
    const promptStarted = withResolvers<void>();
    const refused: string[] = [];

    const outcome = yield* withConversation(
      stream,
      stub(traffic, {
        hold: (content) => (content === "slow" ? promptHeld.operation : undefined),
        started: () => promptStarted.resolve(),
      }),
      function* (chat) {
        // An evaluation in flight: a prompt and an inspection are refused, and
        // neither reaches the provider.
        const running = yield* spawn(() =>
          chat.evaluateGeneratedXmdRoot({
            id: "reply-1",
            source: "<Output>\n<Hold />\n</Output>\n",
          }),
        );
        yield* reached.operation;
        const whileEvaluating = yield* chat.prompt("during");
        const inspected = yield* chat.options();
        refused.push(
          whileEvaluating.ok ? "<admitted>" : whileEvaluating.error.message,
          inspected.ok ? "<admitted>" : inspected.error.message,
        );
        expect(traffic.prompts).toEqual([]);
        expect(traffic.optionProbes).toEqual([]);
        // Cancelled rather than waited for: the control suspends, so the only
        // way this evaluation ends is the caller giving up on it.
        release.resolve();
        yield* running.halt();

        // A prompt in flight: an evaluation is refused, with no component work.
        const turn = yield* spawn(() => chat.prompt("slow"));
        yield* promptStarted.operation;
        const whilePrompting = yield* chat.evaluateGeneratedXmdRoot(
          generated("<Output>\n<Probe />\n</Output>\n", invoked, "reply-2"),
        );
        refused.push(whilePrompting.ok ? "<admitted>" : whilePrompting.error.message);
        expect(invoked).toEqual([]);
        expect(admissions(yield* stream.readAll())).toHaveLength(1);
        promptHeld.resolve();
        yield* turn;
      },
      "chat-1",
      [],
      AGENT,
      [holdingControl(reached, release.operation, order)],
    );

    expect(outcome.ok).toBe(true);
    for (const message of refused) {
      expect(message).toContain("one turn at a time");
    }
  });

  it("CV27: a reply describes the vocabulary it was admitted under", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const invoked: string[] = [];
    const answers: { bare?: string; named?: string; refused?: string } = {};

    const outcome = yield* withConversation(
      stream,
      stub(traffic),
      function* (chat) {
        answers.bare = rendered(
          yield* chat.evaluateGeneratedXmdRoot(
            generated("<Output>\n<Syntax />\n</Output>\n", invoked),
          ),
        ).output;
        answers.named = rendered(
          yield* chat.evaluateGeneratedXmdRoot(
            generated('<Output>\n<Syntax names={["Json"]} />\n</Output>\n', invoked, "reply-2"),
          ),
        ).output;
        const writeOnly = yield* chat.evaluateGeneratedXmdRoot({
          id: "reply-3",
          source: "<Output>\n<Syntax />\n</Output>\n",
          allow: ["write"],
        });
        answers.refused = writeOnly.ok ? "<admitted>" : writeOnly.error.message;
      },
      "chat-1",
      [],
      AGENT,
      [probe(invoked), fill(invoked)],
    );

    expect(outcome.ok).toBe(true);
    // The response's own vocabulary, Syntax included because it is admitted
    // here too — and not the vocabulary of the conversation's own root, whose
    // one element is the host component this conversation is.
    expect(answers.bare).toContain("Probe");
    expect(answers.bare).toContain("Syntax");
    expect(answers.bare).toContain("Json");
    expect(answers.bare).not.toContain("AgentConversationHost");
    expect(answers.bare).not.toContain("Evaluate");
    // The real chapter rather than the absence notice, which is what a
    // reference carrying symbols and no index would render.
    expect(answers.named).toContain("Json");
    expect(answers.named).not.toContain("No long-form documentation is available");
    // Describing the vocabulary is an observation, so a write-only selection
    // reaches it not at all — refused before any control effect.
    expect(answers.refused).toContain("did not admit");
  });

  it("CV28: a reply reads this conversation's captured package documentation", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const counted = { reads: 0 };
    const invoked: string[] = [];
    const answer: { named?: string } = {};

    // Installed where the runner is attached, so a recollection would find it.
    yield* Execution.around({
      *document([claimed], next) {
        yield* Documentation.around({
          *contributions([read], nextChapter) {
            const held = yield* nextChapter(read);
            return held.map((one) =>
              one.source.owner === "@executablemd/test"
                ? { ...one, source: { ...one.source, text: "## Marker\n\nSUBSTITUTED LATE.\n" } }
                : one,
            );
          },
        });
        yield* next(claimed);
      },
    });

    const outcome = yield* withConversation(
      stream,
      stub(traffic),
      function* (chat) {
        answer.named = rendered(
          yield* chat.evaluateGeneratedXmdRoot(
            generated('<Output>\n<Syntax names={["Marker"]} />\n</Output>\n', invoked),
          ),
        ).output;
      },
      "chat-1",
      [markerPackage("## Marker\n\nTHE MARKER CHAPTER.\n", counted)],
    );

    expect(outcome.ok).toBe(true);
    // The chapter this conversation's own packages contributed, from the
    // capture rather than from the chain the document arranged afterwards.
    expect(answer.named).toContain("THE MARKER CHAPTER.");
    expect(answer.named).not.toContain("SUBSTITUTED LATE.");
    expect(counted.reads).toBe(1);
  });

  it("CV29: cancelling an evaluation holds the caller's halt until its cleanup joins", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const order: string[] = [];
    const invoked: string[] = [];
    const reached = withResolvers<void>();
    const release = withResolvers<void>();
    const refusals: string[] = [];
    const answer: { fresh?: Result<GeneratedXmdRootResult> } = {};

    const outcome = yield* withConversation(
      stream,
      stub(traffic),
      function* (chat) {
        const running = yield* spawn(() =>
          chat.evaluateGeneratedXmdRoot({
            id: "reply-1",
            source: "<Output>\n<Hold />\n</Output>\n",
          }),
        );
        yield* reached.operation;
        expect(admissions(yield* stream.readAll())).toHaveLength(1);

        const halting = yield* spawn(function* () {
          yield* running.halt();
          order.push("halt returned");
        });
        // Another job cannot slip in while a cancelled one is still unwinding.
        const overlapping = yield* chat.evaluateGeneratedXmdRoot(
          generated("<Output>\n<Probe />\n</Output>\n", invoked, "reply-2"),
        );
        refusals.push(overlapping.ok ? "<admitted>" : overlapping.error.message);
        expect(order).toEqual([]);
        expect(invoked).toEqual([]);
        expect(admissions(yield* stream.readAll())).toHaveLength(1);

        release.resolve();
        yield* halting;
        answer.fresh = yield* chat.evaluateGeneratedXmdRoot(
          generated("<Output>\n<Probe />\n</Output>\n", invoked, "reply-3"),
        );
      },
      "chat-1",
      [],
      AGENT,
      [probe(invoked), holdingControl(reached, release.operation, order)],
    );

    expect(outcome.ok).toBe(true);
    expect(refusals[0]).toContain("one turn at a time");
    expect(order).toEqual(["evaluation cleanup", "halt returned"]);
    expect(rendered(answer.fresh ?? { ok: false, error: new Error("none") }).output).toContain(
      "probed",
    );
    expect(invoked).toEqual(["probed"]);
    // The cancelled evaluation left its sequence unfinished, and the fresh call
    // took a new address rather than continuing it.
    const events = yield* stream.readAll();
    expect(sequences(events)).toContain("generated_root:2");
    expect(
      events.some((event) => event.type === "close" && event.coroutineId === "generated_root:1"),
    ).toBe(false);
  });

  it("CV30: reopening keeps the established identity and starts past retained replies", function* () {
    const stream = new InMemoryStream();
    const first = fresh();
    const order: string[] = [];
    const reached = withResolvers<void>();
    const release = withResolvers<void>();
    const invoked: string[] = [];

    // A completed turn, a completed evaluation, and one interrupted after its
    // first acknowledged effect.
    const opened = yield* withConversation(
      stream,
      stub(first, { asserts: () => "native-1" }),
      function* (chat) {
        expect((yield* chat.prompt("first")).ok).toBe(true);
        expect(
          rendered(yield* chat.evaluateGeneratedXmdRoot(generated("<Output>\nok\n</Output>\n")))
            .hasOutput,
        ).toBe(true);
        const running = yield* spawn(() =>
          chat.evaluateGeneratedXmdRoot({
            id: "reply-2",
            source: "<Output>\n<Hold />\n</Output>\n",
          }),
        );
        yield* reached.operation;
        release.resolve();
        yield* running.halt();
      },
      "chat-1",
      [],
      AGENT,
      // The control this row holds, declared by the host that admits it.
      [holdingControl(reached, release.operation, order)],
    );
    expect(opened.ok).toBe(true);

    const retained = yield* stream.readAll();
    expect(admissions(retained)).toHaveLength(2);
    expect(
      retained.some((event) => event.type === "close" && event.coroutineId === "generated_root:2"),
    ).toBe(false);

    const again = fresh();
    const next: { reply?: Result<string>; evaluated?: Result<GeneratedXmdRootResult> } = {};
    const continued = yield* withConversation(
      stream,
      stub(again, { asserts: () => "native-1" }),
      function* (chat) {
        // Opening alone repeated neither the completed response nor the
        // interrupted one's suffix.
        expect(invoked).toEqual([]);
        next.reply = yield* chat.prompt("second");
        next.evaluated = yield* chat.evaluateGeneratedXmdRoot(
          generated("<Output>\n<Probe />\n</Output>\n", invoked, "reply-3"),
        );
      },
      "chat-1",
      [],
      AGENT,
      [probe(invoked)],
    );

    expect(continued.ok).toBe(true);
    // The retained turn replayed from its record: the provider was asked for
    // exactly the one turn the person asked for, in the same conversation.
    expect(again.prompts.map((call) => call.content)).toEqual(["second"]);
    expect(next.reply?.ok).toBe(true);
    expect(record(yield* stream.readAll(), "turn:2").agentSessionId).toBe("native-1");
    // And the new evaluation took an address past every retained one.
    expect(invoked).toEqual(["probed"]);
    const after = yield* stream.readAll();
    expect(admissions(after)).toHaveLength(3);
    expect(admissions(after)[2]?.coroutineId).toBe("generated_root:3");
  });

  it("CV31: an ordinary reply failure is a Result, and a journal failure is not", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const ordinary: { answer?: Result<GeneratedXmdRootResult> } = {};

    const outcome = yield* withConversation(
      stream,
      stub(traffic),
      function* (chat) {
        ordinary.answer = yield* chat.evaluateGeneratedXmdRoot({
          id: "reply-1",
          source: "<Output>\nbefore the failure\n\n<Boom />\n</Output>\n",
        });
      },
      "chat-1",
      [],
      AGENT,
      [boom()],
    );

    // The request's own failure, carrying what the reply had rendered, and the
    // conversation is untouched by it.
    expect(outcome.ok).toBe(true);
    expect(ordinary.answer?.ok).toBe(false);
    const error: (Error & { partial?: GeneratedXmdRootResult }) | undefined =
      ordinary.answer?.ok === false ? ordinary.answer.error : undefined;
    expect(error?.message).toContain("the control refused this request");
    expect(error?.partial?.output).toContain("before the failure");
  });

  it("CV32: a journal that stops describing the run is not a reply worth correcting", function* () {
    const broken = new InMemoryStream();
    const raised: { fromCall?: unknown; fromConversation?: unknown } = {};

    // Caught *outside* the conversation's own scope, because releasing a
    // conversation whose run suffered an authoritative failure is not a clean
    // release: the scope that owned it is where that failure is reported.
    try {
      yield* scoped(function* () {
        const opened = yield* useAgentConversation({
          history: broken,
          id: "chat-2",
          agent: AGENT,
          installations: [stub(fresh()), selecting([probe([])])],
        });
        if (!opened.ok) {
          throw opened.error;
        }
        // Only the evaluation's own admission is refused, so this is the
        // evaluation's append failing rather than the conversation's history
        // becoming unwritable from the start.
        broken.onAppend = (event) => {
          if (event.type === "yield" && event.description.type === "generated_xmd") {
            throw new Error("the journal stopped accepting appends");
          }
        };
        try {
          yield* opened.value.evaluateGeneratedXmdRoot(generated("<Output>\nok\n</Output>\n"));
        } catch (caught) {
          raised.fromCall = caught;
        }
        broken.onAppend = null;
      });
    } catch (caught) {
      raised.fromConversation = caught;
    }

    // Raised rather than returned, and still classified as what it is.
    expect(durabilityFailure(raised.fromCall)).not.toBe(undefined);
    // And catching it on the call did not buy a clean ending. A conversation's
    // own document is halted rather than completed, so there is no terminal and
    // no completion for anybody to read this through — the release reports it,
    // as the same object with the same classification.
    expect(durabilityFailure(raised.fromConversation)).toBe(durabilityFailure(raised.fromCall));
  });
});

/**
 * Tier DP — the provider a conversation does its work through.
 *
 * `Agent` is compositional, which is right for a document and wrong for a
 * chat: a handler that forwarded a request's descriptive name used to open an
 * ordinary route, so the provider never reached the setup the coordinator
 * delivers and the configuration this history holds it to was never asked for.
 * These rows are about the other side of that — a conversation that reads its
 * provider once and then calls it directly, and what it still refuses when the
 * provider answers with something its own request never produced.
 */
describe("Tier DP — a conversation calls its own provider", () => {
  it("DP3: a session this request never settled reaches no prompt", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(
      stream,
      stub(traffic, { answersWith: "unsettled" }),
      function* (chat) {
        return yield* chat.prompt("hello");
      },
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    expect(answered.value.ok).toBe(false);
    expect(!answered.value.ok && answered.value.error.message).toContain(
      "did not resolve this conversation's own session request",
    );
    // Refused before the turn, which is the whole claim: the provider answered
    // with a session that looks exactly like one it had settled, and the chat
    // asked it for nothing.
    expect(traffic.prompts).toEqual([]);
    expect(prompts(yield* stream.readAll())).toHaveLength(0);
  });

  it("DP3: and neither does another session returned after a genuine one", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(
      stream,
      stub(traffic, { answersWith: "substituted" }),
      function* (chat) {
        return yield* chat.prompt("hello");
      },
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    expect(answered.value.ok).toBe(false);
    expect(!answered.value.ok && answered.value.error.message).toContain(
      "is not the one settling that request produced",
    );
    // The setup really was completed — the configuration was activated and
    // saved — and the substitution is still refused: what the turn would have
    // run in is not what was checked.
    expect(traffic.activated).toHaveLength(1);
    expect(traffic.prompts).toEqual([]);
  });

  it("DP3: the exact settled session, configured use included, is what the turn runs in", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const answered = yield* withConversation(stream, stub(traffic), function* (chat) {
      return yield* chat.prompt("hello", { model: "m-2", effort: "high" });
    });

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    expect(answered.value.ok).toBe(true);
    // The positive control for both rows above: one session settled, and the
    // object the turn was handed is that exact value rather than an equal one.
    expect(traffic.settledSessions).toHaveLength(1);
    expect(traffic.promptSessions[0]).toBe(traffic.settledSessions[0]);
    // And it is the authentic use, not the raw session inside it: what the
    // provider verified is readable from the value the turn ran in, which is
    // what the record is written from.
    expect(traffic.applied).toEqual([{ model: "m-2", effort: "high" }]);
    expect(record(yield* stream.readAll(), "turn:1")["configuration"]).toEqual({
      model: "m-2",
      effort: "high",
    });
  });

  it("DP4: a direct turn keeps its permission audit and its checkpoint", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();
    const decided: string[] = [];
    const published: {
      begun?: unknown;
      association?: unknown;
      appends?: number;
    } = { appends: 0 };
    const begun = { live: "turn-1" };

    const answered = yield* withConversation(
      stream,
      stub(traffic, {
        asks: [
          { toolCallId: "call-1", kind: "read" },
          { toolCallId: "call-2", title: "Run the build" },
        ],
        checkpoint: { provider: "stub", kind: "stub-turn", value: "turn-7" },
      }),
      function* (chat) {
        return yield* chat.prompt("hello");
      },
      "chat-1",
      [
        {
          *install(): Operation<void> {
            // A policy of this host's own, inside the observer that records
            // decisions: what it answers is what the audit has to say.
            yield* Agent.around(
              {
                // deno-lint-ignore require-yield
                *requestPermission([request]) {
                  decided.push(request.toolCall.toolCallId);
                  return { outcome: "selected", optionId: "allow" };
                },
              },
              { at: "min" },
            );
            yield* useAgentPromptPublisher({
              // deno-lint-ignore require-yield
              *begin(): Operation<unknown> {
                // Before the provider is asked, in the turn's own scope.
                expect(traffic.prompts).toEqual([]);
                return begun;
              },
              *publish(publication): Operation<void> {
                published.begun = publication.begun;
                published.association = publication.association;
                published.appends = (published.appends ?? 0) + 1;
                yield* publication.append();
              },
            });
          },
        },
      ],
    );

    if (!answered.ok) {
      throw new Error(`the conversation did not open: ${answered.error.message}`);
    }
    expect(answered.value.ok).toBe(true);
    // Both requests reached the policy, and the audit is the record's own
    // account of them: once each, in the order the agent asked, with the safe
    // fields exactly as asked and the outcome this host chose.
    expect(decided).toEqual(["call-1", "call-2"]);
    expect(record(yield* stream.readAll(), "turn:1")["permissions"]).toEqual([
      {
        toolCallId: "call-1",
        kind: "read",
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        outcome: { outcome: "selected", optionId: "allow" },
      },
      {
        toolCallId: "call-2",
        title: "Run the build",
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        outcome: { outcome: "selected", optionId: "allow" },
      },
    ]);
    // One publication, carrying the handle this host was given for this exact
    // live turn and the association the provider named through the coordinator.
    expect(published.appends).toBe(1);
    expect(published.begun).toBe(begun);
    expect(published.association).toEqual({
      checkpoint: { provider: "stub", kind: "stub-turn", value: "turn-7" },
      sessionKey: "stub:chat-1",
    });
  });

  it("DP5: a provider that serves only documents cannot open a conversation", function* () {
    const stream = new InMemoryStream();
    const traffic = fresh();

    const opened = yield* withConversation(
      stream,
      stub(traffic, { withoutConversations: true }),
      function* (chat) {
        return yield* chat.prompt("hello");
      },
    );

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error.message).toContain("does not support saved conversations");
    // Nothing was asked of the provider through any route, and nothing was
    // written: no conversation bound, no configuration, no turn, and no
    // terminal on the root — so the history is exactly what it was.
    expect(traffic.routed).toEqual([]);
    expect(traffic.prompts).toEqual([]);
    const events = yield* stream.readAll();
    expect(sequence(events)).toEqual([]);
    expect(terminated(events)).toBe(false);
  });
});
