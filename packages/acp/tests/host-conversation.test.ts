/**
 * Tier HC — one host conversation over the canonical ACP provider.
 *
 * `useAgentConversation()` is proven against a stub provider in
 * `packages/core/tests/agent-conversation.test.ts`, where a stub is the right
 * instrument: those rows are about what the conversation does with what a
 * provider says. One thing a stub cannot show is the *order* the canonical
 * provider commits in — the adapter accepts the session, the provider's own
 * record is promoted to assert an identity, the host's mapping is acknowledged
 * second, and the session becomes established last. The window between the
 * first two is the one a chat actually has to recover from: the agent is in a
 * conversation nobody wrote down.
 *
 * So these rows install the real provider, with ACPX's runtime replaced by the
 * scriptable fake this package already drives it with. The installation is the
 * one `installAgentProviderStack` makes — `installAgentComponents` with
 * `createAcpxProvider` as the root provider — so what the conversation reaches
 * is the product's provider rather than a second account of it, and the host's
 * mapping acknowledgement is the one seam a case interrupts.
 *
 * The companion row at the provider's own level is `provider.test.ts` SM9,
 * which shows that window leaves exactly one canonical assertion. These rows
 * ask the question a chat asks: after it, what can the conversation still do?
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { Agent, Component, installAgentComponents } from "@executablemd/core";
import type { FunctionComponentDefinition, Json, Session } from "@executablemd/core";
import { useAgentConversation } from "@executablemd/core/host";
import type { AgentConversation, ExecutionInstallation } from "@executablemd/core/host";

import { createAcpxProvider } from "../src/provider.ts";
import type { AcpxSessionIdentity, AcpxSessionPolicy } from "../src/provider.ts";
import type { AgentSessionRequest } from "@executablemd/core/api";
import { createFakeRuntime, makeRegistry, makeStore, useFlatWorld } from "./helpers.ts";
import type { FakeRuntimeHarness } from "./helpers.ts";

const AGENT = "scribe";
const WORKSPACE = "/workspace";

/** The runtime's own directory: provider-owned, and not a checkout. */
const HOST_DIR = "/runs/sessions/host";

/** Where this host puts the one session a chat conversation runs in. */
const SESSION_DIR = "/runs/sessions/cwd/8f2a";

/** The key this host puts that session under — a chat, not a directory. */
const CHAT_SESSION_KEY = "xmd:chat:v1:acpx:scribe-cmd:default";

/** The conversation the fake adapter opens for that key, and asserts. */
const NATIVE = `agent-session:${CHAT_SESSION_KEY}`;

/**
 * One host's agent assembly, with its mapping acknowledgement under a switch.
 *
 * `requestSession` answers `new` every time, which is the truthful answer from
 * a host whose mapping was never acknowledged: it knows where the session lives
 * and has retained nothing about what stands there. `recordSessionIdentity` is the
 * acknowledgement itself, so refusing it once is exactly the interruption these
 * rows are about — and the provider's own assertion is already written by then.
 *
 * The runtime and the store are the host's, held outside the installation, so
 * the same provider state survives a conversation being closed and reopened.
 */
interface Host {
  /** The installation a conversation is opened with. */
  readonly installation: ExecutionInstallation;
  /** The ACPX runtime behind the provider, for what it was asked to do. */
  readonly harness: FakeRuntimeHarness;
  /** The ACPX store behind the provider, which outlives each conversation. */
  readonly store: ReturnType<typeof makeStore>;
  /** Every identity this host was asked to retain, in order. */
  readonly retained: AcpxSessionIdentity[];
  /** Refuse the next acknowledgement, as a host interrupted before its commit does. */
  refuseNextRetention(): void;
}

/** How one case's host differs from the ordinary one. */
interface HostOptions {
  /**
   * Leave the construction inputs unstated, as a host that configures nothing
   * does.
   *
   * A provider that cannot state all four members states none, so a retained
   * conversation has nothing to be held to and refuses. That is the arm the
   * routing finding was reproduced against.
   */
  readonly states?: false;
  /** The agents this host's registry knows. Default: `scribe` alone. */
  readonly agents?: Record<string, string>;
  /** Whatever else this host installs around the provider's own chain. */
  readonly around?: () => Operation<void>;
}

function host(options: HostOptions = {}): Host {
  const harness = createFakeRuntime();
  const store = makeStore();
  const retained: AcpxSessionIdentity[] = [];
  let refusing = false;
  const sessions: AcpxSessionPolicy = {
    // deno-lint-ignore require-yield
    *requestSession() {
      return { sessionKey: CHAT_SESSION_KEY, cwd: SESSION_DIR, state: "new" };
    },
    // deno-lint-ignore require-yield
    *recordSessionIdentity(_details, identity) {
      retained.push(identity);
      if (refusing) {
        refusing = false;
        throw new Error("the host could not retain this session");
      }
    },
  };
  return {
    harness,
    store,
    retained,
    refuseNextRetention() {
      refusing = true;
    },
    installation: {
      *install(): Operation<void> {
        yield* useFlatWorld(WORKSPACE);
        yield* installAgentComponents({
          defaultAgent: AGENT,
          permissionMode: "deny-all",
          rootProvider: {
            factory: createAcpxProvider({
              createRuntime: harness.create,
              sessionStore: store,
              agentRegistry: makeRegistry(options.agents ?? { scribe: "scribe-cmd" }),
              // deno-lint-ignore require-yield
              agentCwd: function* () {
                return HOST_DIR;
              },
              ...(options.states === false
                ? {}
                : {
                    mcpServers: [],
                    newSessionOptions: { allowedTools: [], systemPrompt: "none" },
                  }),
              permissions: "strict",
              sessions,
            }),
            options: { defaultAgent: AGENT, permissionMode: "deny-all" },
          },
        });
        if (options.around !== undefined) {
          yield* options.around();
        }
      },
    },
  };
}

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false } as const;

/** The one observation this tier's reply names, recording every invocation. */
const PROBE: FunctionComponentDefinition = {
  kind: "function",
  name: "Probe",
  props: NO_PROPS,
  generated: {
    "self-closing": { identity: "https://executable.md/components/probe", effect: "read" },
  },
  // deno-lint-ignore require-yield
  *fn(): Operation<Json> {
    return "probed";
  },
};

/**
 * The host that declares and answers for this tier's one generated component.
 *
 * A root is admitted from the selection its execution captured, so the name is
 * offered with the assembly and answered by a provider — the public shape a
 * trusted host uses — rather than passed as a table with the call.
 */
function selecting(invoked: string[]): ExecutionInstallation {
  const definition: FunctionComponentDefinition = {
    ...PROBE,
    // deno-lint-ignore require-yield
    *fn(): Operation<Json> {
      invoked.push("probed");
      return "probed";
    },
  };
  // Published once. The profile resolves a selected name before the root
  // import and seals what it retained, so there is no window open afterwards
  // and a second publication would identify nothing.
  let settled = false;
  return {
    componentAnswers: [
      {
        origin: "test://probe",
        *install(registrar): Operation<void> {
          yield* registrar.around(function* (request, next) {
            if (request.name !== "Probe" || settled) {
              return yield* next();
            }
            settled = true;
            // Published through the request, not merely returned: capture
            // admits the object canonical execution issued for the import that
            // asked, so an implementation handed back any other way is refused.
            return request.answer(definition);
          });
        },
      },
    ],
    *install(): Operation<void> {
      yield* Component.around({ generated: () => ({ Probe: ["self-closing"] }) });
    },
  };
}

/** Open one conversation over this history, hand it to `body`, and close it. */
function withConversation<T>(
  stream: InMemoryStream,
  installation: ExecutionInstallation,
  body: (conversation: AgentConversation) => Operation<T>,
  /** The agent this conversation is opened with. Default: the host's own. */
  agent = AGENT,
  /**
   * The host that declares this conversation's generated selection.
   *
   * A root is admitted from the selection its execution captured, so a row
   * that names a component declares it with the assembly rather than passing a
   * table with the call.
   */
  declared?: ExecutionInstallation,
): Operation<Result<T>> {
  return scoped(function* () {
    const opened = yield* useAgentConversation({
      history: stream,
      id: "chat-1",
      agent,
      installations: [installation, ...(declared === undefined ? [] : [declared])],
    });
    if (!opened.ok) {
      return opened;
    }
    return Ok(yield* body(opened.value));
  });
}

/** Every canonical prompt record this history holds, in order. */
function turns(
  events: readonly DurableEvent[],
): { name: string; record: Record<string, unknown> }[] {
  return events.flatMap((event) => {
    if (event.type !== "yield" || event.description.type !== "agent_prompt") {
      return [];
    }
    if (event.result.status !== "ok") {
      throw new Error(`the retained turn "${event.description.name}" recorded no outcome`);
    }
    return [
      { name: event.description.name, record: event.result.value as Record<string, unknown> },
    ];
  });
}

/** The text of every prompt the provider was actually asked to run, in order. */
function asked(target: Host): string[] {
  return target.harness.turns.map((turn) => turn.input.text);
}

/** One turn's answer, or the failure that stands in a refusal's place. */
function answer(settled: Result<Result<string>>): string {
  if (!settled.ok) {
    throw new Error(`the conversation could not be opened: ${settled.error.message}`);
  }
  return settled.value.ok ? settled.value.value : settled.value.error.message;
}

describe("Tier HC — a host conversation across the provider's own commit window", () => {
  /**
   * The window SM9 describes, met by a conversation rather than by a document.
   *
   * Nothing here is reconciled from the journal, and that is the point: the
   * interrupted turn never started, so it retained no identity to reconcile
   * against. What the next turn joins is decided by the provider's own record,
   * which is the only account of that conversation anyone kept.
   */
  it("HC1: a session asserted before its mapping was acknowledged is joined, not replaced", function* () {
    const target = host();
    const stream = new InMemoryStream();

    target.refuseNextRetention();
    const interrupted = yield* withConversation(stream, target.installation, function* (chat) {
      return yield* chat.prompt("first");
    });

    expect(answer(interrupted)).toBe("the host could not retain this session");
    // The pre-commit window, from the chat's side: the provider's own record
    // asserts a conversation and is no longer awaiting materialization, while
    // the host retained nothing about it.
    expect(target.store.records.get(CHAT_SESSION_KEY)?.agentSessionId).toBe(NATIVE);
    expect(target.store.records.get(CHAT_SESSION_KEY)?.sessionMaterialization).toBe(undefined);
    expect(target.retained.map((identity) => identity.agentSessionId)).toEqual([NATIVE]);
    // The turn is retained as the fact it is: it ran in no conversation this
    // history can name, so it establishes nothing either way.
    expect(turns(yield* stream.readAll()).map((turn) => turn.name)).toEqual(["turn:1"]);
    expect(turns(yield* stream.readAll())[0]!.record.agentSessionId).toBe(undefined);

    // The first owner is gone. Explicit new work over the same history.
    const continued = yield* withConversation(stream, target.installation, function* (chat) {
      return yield* chat.prompt("again");
    });

    expect(answer(continued)).toBe("hello world");
    // Reconciled to that same assertion and committed, with nothing created in
    // its place — and the interrupted turn was not sent a second time.
    expect(target.retained.map((identity) => identity.agentSessionId)).toEqual([NATIVE, NATIVE]);
    expect([...target.store.records.keys()]).toEqual([CHAT_SESSION_KEY]);
    expect(asked(target)).toEqual(["first", "again"]);
    const retained = turns(yield* stream.readAll());
    expect(retained.map((turn) => turn.name)).toEqual(["turn:1", "turn:2"]);
    expect(retained[1]!.record.agentSessionId).toBe(NATIVE);
  });

  /**
   * Evaluating a reply, on the conversation that produced it.
   *
   * The third job on the mailbox, through the provider the product actually
   * uses: a turn is sent and journaled, its reply comes back as source, and
   * running that source is a separate explicit call. What this adds to the stub
   * rows is that the real provider is reached by the turn and by nothing else —
   * no second setup, no second prompt, no configuration applied — so a host
   * evaluating a reply is not quietly spending another turn.
   */
  it("HC4: a reply is evaluated on the conversation that produced it, reaching no provider", function* () {
    const target = host();
    const stream = new InMemoryStream();
    const invoked: string[] = [];
    const settled: { reply?: string; rendered?: string } = {};

    const outcome = yield* withConversation(
      stream,
      target.installation,
      function* (chat) {
        const replied = yield* chat.prompt("write me a reply");
        settled.reply = replied.ok ? replied.value : replied.error.message;
        const evaluated = yield* chat.evaluateGeneratedXmdRoot({
          id: "reply-1",
          source: "<Output>\n<Probe />\n</Output>\n",
        });
        settled.rendered = evaluated.ok ? evaluated.value.output : evaluated.error.message;
      },
      AGENT,
      selecting(invoked),
    );

    if (!outcome.ok) {
      throw new Error(`the conversation could not be opened: ${outcome.error.message}`);
    }
    expect(settled.reply).toBe("hello world");
    expect(settled.rendered).toContain("probed");
    expect(invoked).toEqual(["probed"]);
    // One turn asked of the provider, and the evaluation asked it nothing.
    expect(asked(target)).toEqual(["write me a reply"]);
    expect(target.retained.map((identity) => identity.agentSessionId)).toEqual([NATIVE]);
    // One journaled turn, and the evaluation on a sequence of its own.
    const events = yield* stream.readAll();
    expect(turns(events).map((turn) => turn.name)).toEqual(["turn:1"]);
    expect(
      events.filter(
        (event) => event.type === "yield" && event.description.type === "generated_xmd",
      ),
    ).toHaveLength(1);
    expect(new Set(events.map((event) => event.coroutineId))).toContain("generated_root:1");
  });

  /**
   * The same interruption, once the history has an identity of its own.
   *
   * Here the journal is the account that survives, because a completed turn
   * retained the conversation the provider named. The acknowledgement that
   * failed changes none of that: the refused turn is its own recorded fact, and
   * the conversation is still the one its first turn established.
   */
  it("HC2: an acknowledgement refused on an established chat leaves its identity standing", function* () {
    const target = host();
    const stream = new InMemoryStream();

    const opened = yield* withConversation(stream, target.installation, function* (chat) {
      return yield* chat.prompt("first");
    });
    expect(answer(opened)).toBe("hello world");

    target.refuseNextRetention();
    const refused = yield* withConversation(stream, target.installation, function* (chat) {
      return yield* chat.prompt("second");
    });

    expect(answer(refused)).toBe("the host could not retain this session");
    // Refused before the turn reached the backend, so the prompt was never run
    // — and the established conversation is still the one the history names.
    expect(asked(target)).toEqual(["first"]);
    const interrupted = turns(yield* stream.readAll());
    expect(interrupted.map((turn) => turn.name)).toEqual(["turn:1", "turn:2"]);
    expect(interrupted[0]!.record.agentSessionId).toBe(NATIVE);
    expect(interrupted[1]!.record.status).toBe("failed");

    const continued = yield* withConversation(stream, target.installation, function* (chat) {
      return yield* chat.prompt("third");
    });

    expect(answer(continued)).toBe("hello world");
    expect(asked(target)).toEqual(["first", "third"]);
    expect([...target.store.records.keys()]).toEqual([CHAT_SESSION_KEY]);
    const reconciled = turns(yield* stream.readAll());
    expect(reconciled.map((turn) => turn.name)).toEqual(["turn:1", "turn:2", "turn:3"]);
    expect(reconciled[2]!.record.agentSessionId).toBe(NATIVE);
  });

  /**
   * And what the established identity is *for*.
   *
   * A provider that answers with another conversation after this history has
   * established one is not reconciliation, however plausible the answer looks:
   * the turn ran in a history this chat has never been in. The outcome is
   * refused to the caller and the established identity stands — which is the
   * same rule CV23 states against a stub, asked here of the real seam.
   */
  it("HC3: a turn the provider ran in another native conversation is refused", function* () {
    const target = host();
    const stream = new InMemoryStream();

    const opened = yield* withConversation(stream, target.installation, function* (chat) {
      return yield* chat.prompt("first");
    });
    expect(answer(opened)).toBe("hello world");

    // The adapter answers with a different conversation than the one this
    // chat's own turn named.
    target.harness.assertIdentity = "agent-session:somewhere-else";
    const diverged = yield* withConversation(stream, target.installation, function* (chat) {
      return yield* chat.prompt("second");
    });

    expect(answer(diverged)).toContain("established identity stands");
    // Recorded as what it was — a turn that ran somewhere else — so the host
    // reconciles it rather than the next turn inheriting whichever identity
    // was read last.
    const retained = turns(yield* stream.readAll());
    expect(retained[0]!.record.agentSessionId).toBe(NATIVE);
    expect(retained[1]!.record.agentSessionId).toBe("agent-session:somewhere-else");

    const reopened = yield* withConversation(stream, target.installation, function* () {
      return "reached";
    });

    expect(reopened.ok).toBe(false);
    expect(!reopened.ok && reopened.error.message).toContain("more than one native conversation");
  });
});

describe("Tier HC — what this provider declared it was building under", () => {
  /** The configuration record this history holds, as one value. */
  function saved(events: readonly DurableEvent[]): Record<string, unknown> {
    for (const event of events) {
      if (event.type !== "yield" || event.description.type !== "agent_conversation_configuration") {
        continue;
      }
      if (event.result.status !== "ok") {
        throw new Error("the conversation's configuration recorded no outcome");
      }
      const held = event.result.value;
      if (held === null || typeof held !== "object" || Array.isArray(held)) {
        throw new Error("the conversation's configuration is not a record");
      }
      return held;
    }
    throw new Error("this history holds no provider configuration");
  }

  it("SC1: the configuration is the values construction used, and a later edit changes neither", function* () {
    const harness = createFakeRuntime();
    const store = makeStore();
    const stream = new InMemoryStream();
    // The host's own containers, kept and edited after the turn — which is what
    // a long-lived assembly actually does with the objects it built.
    const tools: string[] = [];
    const servers = [
      {
        name: "notes",
        command: "/usr/local/bin/notes-mcp",
        args: ["--quiet"],
        env: [{ name: "NOTES_TOKEN", value: "first" }],
      },
    ];
    const sessions: AcpxSessionPolicy = {
      // deno-lint-ignore require-yield
      *requestSession() {
        return { sessionKey: CHAT_SESSION_KEY, cwd: SESSION_DIR, state: "new" };
      },
      // deno-lint-ignore require-yield
      *recordSessionIdentity() {},
    };
    const installation: ExecutionInstallation = {
      *install(): Operation<void> {
        yield* useFlatWorld(WORKSPACE);
        yield* installAgentComponents({
          defaultAgent: AGENT,
          permissionMode: "deny-all",
          rootProvider: {
            factory: createAcpxProvider({
              createRuntime: harness.create,
              sessionStore: store,
              agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
              // deno-lint-ignore require-yield
              agentCwd: function* () {
                return HOST_DIR;
              },
              mcpServers: servers,
              newSessionOptions: { allowedTools: tools },
              permissions: "strict",
              sessions,
            }),
            options: { defaultAgent: AGENT, permissionMode: "deny-all" },
          },
        });
      },
    };

    const sent = yield* withConversation(stream, installation, function* (chat) {
      return yield* chat.prompt("first");
    });
    if (!sent.ok || !sent.value.ok) {
      throw new Error(`the first turn did not complete: ${answer(sent)}`);
    }
    // The turn really ran, which is what makes the construction inputs below
    // the ones a native session was actually built from.
    expect(harness.turns.map((turn) => turn.input.text)).toEqual(["first"]);

    // What the provider actually constructed with.
    const created = harness.createdOptions[0];
    const ensured = harness.ensureCalls[0];
    expect(created?.mcpServers).toEqual(servers);
    expect(ensured?.sessionOptions?.allowedTools).toEqual([]);

    // What Core admitted: the same values, and all four members stated. The
    // permission configuration is all three settings, because a mode alone
    // does not say who is asked or what happens when nobody is.
    expect(saved(yield* stream.readAll())).toEqual({
      provider: "acpx",
      agentCommand: "scribe-cmd",
      configuration: {
        providerTools: [],
        mcpServers: [
          {
            name: "notes",
            command: "/usr/local/bin/notes-mcp",
            args: ["--quiet"],
            env: [{ name: "NOTES_TOKEN", value: "first" }],
          },
        ],
        permissions: {
          permissionMode: "deny-all",
          routing: "strict",
          nonInteractivePermissions: "deny",
        },
        systemPrompt: null,
      },
    });

    // Now the host edits what it still holds — a nested member, not the array
    // itself, which is the edit a shallow copy would not have stopped.
    tools.push("Edit");
    servers[0]!.env[0]!.value = "second";
    servers[0]!.args.push("--loud");

    // Neither the configuration Core admitted nor the options the provider
    // constructed with moved: both are the one detached copy, and the record
    // read back from the journal is still the admitted value.
    expect(harness.createdOptions[0]?.mcpServers).toEqual([
      {
        name: "notes",
        command: "/usr/local/bin/notes-mcp",
        args: ["--quiet"],
        env: [{ name: "NOTES_TOKEN", value: "first" }],
      },
    ]);
    expect(harness.ensureCalls[0]?.sessionOptions?.allowedTools).toEqual([]);
    const admitted = saved(yield* stream.readAll());
    const configuration = admitted["configuration"];
    expect(configuration).toEqual({
      providerTools: [],
      mcpServers: [
        {
          name: "notes",
          command: "/usr/local/bin/notes-mcp",
          args: ["--quiet"],
          env: [{ name: "NOTES_TOKEN", value: "first" }],
        },
      ],
      permissions: {
        permissionMode: "deny-all",
        routing: "strict",
        nonInteractivePermissions: "deny",
      },
      systemPrompt: null,
    });
  });
});

/**
 * Tier DP — the routing a saved conversation no longer travels.
 *
 * Both of these were reproduced against the real provider before the
 * correction: a supported `Agent.session` handler that forwarded the request's
 * descriptive name made ACP see a string, so it never obtained the request's
 * setup, never asked whether the configuration was stated, and answered a turn
 * with one native ensure and zero configuration records. A prompt handler could
 * do the same thing one call later by replacing `options.session` after another
 * session had been checked.
 *
 * A conversation now reads its provider once and calls it directly, so there is
 * no dispatch for either handler to sit on. These rows are the permanent form
 * of that: the refusal must still be the specific one about configuration — a
 * refusal because no provider object was installed would prove nothing about
 * the routing at all.
 */
describe("Tier DP — a saved conversation reaches its provider directly", () => {
  /** How many provider configurations this history holds. */
  function configurations(events: readonly DurableEvent[]): number {
    return events.filter(
      (event) =>
        event.type === "yield" && event.description.type === "agent_conversation_configuration",
    ).length;
  }

  /**
   * What the reproducing handler forwarded: the descriptive name alone.
   *
   * Supported composition — a handler may observe or change a session's name —
   * and the finding was that for a conversation it also dropped the request,
   * and with it the only channel the required configuration travels on.
   */
  function named(request: string | AgentSessionRequest | undefined): string | undefined {
    return typeof request === "object" && request !== null ? request.name : request;
  }

  /** The handler that reproduced the finding: forward the name, drop the request. */
  function forwardsTheName(seen: string[]): () => Operation<void> {
    return function* (): Operation<void> {
      yield* Agent.around(
        {
          *session([request], next) {
            seen.push("session");
            return yield* next(named(request));
          },
        },
        { at: "max" },
      );
    };
  }

  it("DP1: a provider that stated no configuration is refused, routed or not", function* () {
    // The control arm: nothing installed around the chain at all.
    const plain = host({ states: false });
    const first = new InMemoryStream();
    const refused = yield* withConversation(first, plain.installation, function* (chat) {
      return yield* chat.prompt("first");
    });

    expect(refused.ok).toBe(true);
    if (!refused.ok) {
      throw refused.error;
    }
    expect(refused.value.ok).toBe(false);
    expect(!refused.value.ok && refused.value.error.message).toContain(
      "did not state what it is building this conversation's session under",
    );
    expect(!refused.value.ok && refused.value.error.message).toContain(
      "no active provider configuration was named",
    );
    // And it is not the readiness refusal: a conversation that could not find a
    // provider at all would say so, and would prove nothing about routing.
    expect(!refused.value.ok && refused.value.error.message).not.toContain(
      "does not support saved conversations",
    );
    expect(plain.harness.ensureCalls).toHaveLength(0);
    expect(asked(plain)).toEqual([]);
    expect(configurations(yield* first.readAll())).toBe(0);

    // The arm that used to answer. The handler is installed and supported; it
    // simply has no dispatch to sit on for a conversation.
    const seen: string[] = [];
    const routed = host({ states: false, around: forwardsTheName(seen) });
    const second = new InMemoryStream();
    const forwarded = yield* withConversation(second, routed.installation, function* (chat) {
      return yield* chat.prompt("first");
    });

    expect(forwarded.ok).toBe(true);
    if (!forwarded.ok) {
      throw forwarded.error;
    }
    expect(forwarded.value.ok).toBe(false);
    expect(!forwarded.value.ok && forwarded.value.error.message).toContain(
      "no active provider configuration was named",
    );
    // The same answer as the control, by the same route, and the handler was
    // never reached: one native ensure, one turn and zero configuration records
    // is what this used to produce.
    expect(seen).toEqual([]);
    expect(routed.harness.ensureCalls).toHaveLength(0);
    expect(asked(routed)).toEqual([]);
    expect(configurations(yield* second.readAll())).toBe(0);
  });

  it("DP2: neither the session nor the agent of a chat is something a handler decides", function* () {
    const seen: string[] = [];
    // A session this chat has never been in, and a canary on the prompt: if
    // either handler were reached, the turn would run somewhere else and the
    // runtime below would say so.
    const canary: Session = { sessionKey: "xmd:chat:v1:acpx:elsewhere", cwd: SESSION_DIR };
    const target = host({
      agents: { scribe: "scribe-cmd", editor: "editor-cmd" },
      around: function* (): Operation<void> {
        yield* Agent.around(
          {
            *session([request], next) {
              seen.push("session");
              return yield* next(named(request));
            },
            *agent([_name], next) {
              seen.push("agent");
              return yield* next("scribe");
            },
            *prompt([content, promptOptions], next) {
              seen.push("prompt");
              return yield* next(content, { ...promptOptions, session: canary });
            },
          },
          { at: "max" },
        );
      },
    });
    const stream = new InMemoryStream();

    const answered = yield* withConversation(
      stream,
      target.installation,
      function* (chat): Operation<Result<string>> {
        return yield* chat.prompt("first");
      },
      "editor",
    );

    expect(answer(answered)).toBe("hello world");
    // None of the three handlers was reached on the chat's path.
    expect(seen).toEqual([]);
    // The turn ran in this conversation's own native session, under the agent
    // the conversation selected rather than the host's default — and the
    // command the configuration was saved against is that agent's.
    expect(target.harness.ensureCalls.map((call) => call.sessionKey)).toEqual([CHAT_SESSION_KEY]);
    expect(asked(target)).toEqual(["first"]);
    const retained = turns(yield* stream.readAll());
    expect(retained.map((turn) => turn.name)).toEqual(["turn:1"]);
    expect(retained[0]!.record.agentSessionId).toBe(NATIVE);
    expect(retained[0]!.record.agent).toBe("editor");
    expect(retained[0]!.record.sessionKey).toBe(CHAT_SESSION_KEY);
    expect(target.retained.map((identity) => identity.agentSessionId)).toEqual([NATIVE]);
    expect(configurations(yield* stream.readAll())).toBe(1);
  });
});
