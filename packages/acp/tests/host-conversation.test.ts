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
import {
  InMemoryStream,
  parseDurableEvent,
  serializeDurableEvent,
} from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { Ok, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { Agent, Component, installAgentComponents } from "@executablemd/core";
import type { FunctionComponentDefinition, Json, Session } from "@executablemd/core";
import { useAgentConversation } from "@executablemd/core/host";
import type { AgentConversation, ExecutionInstallation } from "@executablemd/core/host";

import { createAcpxSessionStore } from "../src/session-store.ts";
import { withCertificationFixture } from "./certification-fixture.ts";
import type { CertificationFixture } from "./certification-fixture.ts";
import { readdir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { createAcpxProvider } from "../src/provider.ts";
import type {
  AcpxSessionIdentity,
  AcpxSessionPolicy,
  ProbeCapableRuntime,
} from "../src/provider.ts";
import { createAcpRuntime } from "../src/acpx-runtime.ts";
import type { AcpRuntimeEnsureInput, AcpRuntimeOptions } from "../src/acpx-runtime.ts";
import type { NativeAdapter } from "../src/native-launch.ts";
import { createMemorySessionRouteStore } from "../src/session-route.ts";
import type { AgentSessionRouteStore } from "../src/session-route.ts";
import { deriveSessionKey } from "../src/session-key.ts";
import type { AgentSessionRequest } from "@executablemd/core/api";
import {
  createFakeObserver,
  createFakeRuntime,
  makeCoordinator,
  makeRegistry,
  makeStore,
  useFlatWorld,
} from "./helpers.ts";
import type { CoordinatorHarness, FakeRuntimeHarness } from "./helpers.ts";

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
  readonly assertions: AcpxSessionIdentity[];
  /** Every key this host's policy answered with, in order. */
  readonly placed: string[];
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
  /** The command `scribe` resolves to. Default: `scribe-cmd`. */
  readonly command?: string;
  /**
   * Own this host's sessions, construct them under routes and bind them to an
   * observed build, as a host that may hand a session to a native UI does.
   */
  readonly owned?: Owned;
  /** Provider state an earlier installation of this host left behind. */
  readonly harness?: FakeRuntimeHarness;
  readonly store?: ReturnType<typeof makeStore>;
  /**
   * Place each session under the key its command derives, as a host keying
   * sessions the way the directory walk does. Default: one fixed chat key.
   */
  readonly derived?: true;
}

/** Who owns this host's sessions and how each was first constructed. */
interface Owned {
  readonly coordinator: CoordinatorHarness;
  readonly routes: AgentSessionRouteStore;
}

/** One owned assembly, shared by every installation of a host that outlives them. */
function owned(): Owned {
  return { coordinator: makeCoordinator(), routes: createMemorySessionRouteStore() };
}

/**
 * The scribe adapter, bound to one observed build.
 *
 * Provider-returned, so the adapter names the conversation; build-bound, so its
 * construction route records the build and a later run compares it.
 */
const BOUND_SCRIBE: NativeAdapter = {
  launcher: "scribe",
  identity: "provider-returned",
  acceptance: "first-turn-acceptance",
  resume: () => [],
  binding: {
    command: "scribe-native",
    version: (output) => output.trim() || undefined,
    environment: () => ({}),
  },
};

function host(options: HostOptions = {}): Host {
  const harness = options.harness ?? createFakeRuntime();
  const store = options.store ?? makeStore();
  const assertions: AcpxSessionIdentity[] = [];
  const placed: string[] = [];
  let refusing = false;
  const sessions: AcpxSessionPolicy = {
    *requestSession(request) {
      const sessionKey =
        options.derived === true
          ? deriveSessionKey(request.agentCommand, SESSION_DIR, request.session)
          : CHAT_SESSION_KEY;
      placed.push(sessionKey);
      const record = yield* until(store.load(sessionKey));
      return {
        sessionKey,
        cwd: SESSION_DIR,
        state:
          record === undefined || record.sessionMaterialization !== undefined ? "new" : "existing",
      };
    },
    // deno-lint-ignore require-yield
    *recordSessionIdentity(_details, identity) {
      assertions.push(identity);
      if (refusing) {
        refusing = false;
        throw new Error("the host could not retain this session");
      }
    },
  };
  return {
    harness,
    store,
    assertions,
    placed,
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
              nativeAdapters: {
                scribe:
                  options.owned === undefined
                    ? {
                        launcher: "scribe",
                        identity: "provider-returned",
                        acceptance: "first-turn-acceptance",
                        resume: () => [],
                      }
                    : BOUND_SCRIBE,
              },
              agentRegistry: makeRegistry(
                options.agents ?? { scribe: options.command ?? "scribe-cmd" },
              ),
              // deno-lint-ignore require-yield
              agentCwd: function* () {
                return HOST_DIR;
              },
              ...(options.owned === undefined
                ? {}
                : {
                    advertiseNativeLaunch: ["scribe"],
                    advertiseClientNativeAttachment: [],
                    coordinator: options.owned.coordinator.coordinator,
                    routeStore: options.owned.routes,
                    executableObserver: createFakeObserver({ versionOutput: "scribe 1.0.0\n" })
                      .observer,
                  }),
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
    expect(target.assertions.map((identity) => identity.agentSessionId)).toEqual([NATIVE]);
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
    expect(target.assertions.map((identity) => identity.agentSessionId)).toEqual([
      NATIVE,
      NATIVE,
      NATIVE,
    ]);
    expect([...target.store.records.keys()]).toEqual([CHAT_SESSION_KEY]);
    expect(asked(target)).toEqual(["first", "again"]);
    const retained = turns(yield* stream.readAll());
    expect(retained.map((turn) => turn.name)).toEqual(["turn:1", "turn:2"]);
    expect(retained[1]!.record.agentSessionId).toBe(NATIVE);
  });

  /**
   * The same window, met through a different adapter command (#1221).
   *
   * The only native assertion is the provider's own promoted record: the
   * interrupted turn recorded a placement and no identity. Reopening through
   * today's command must find that exact record, reopen it by its ACP loading
   * target, hold it to the native conversation the record asserts — a
   * different name — and keep its owner and route where the conversation
   * began, through both the eager session and the turn that follows it.
   */
  it("HC1b: a session asserted before its mapping was acknowledged is joined through a changed command", function* () {
    const ownership = owned();
    const first = host({ owned: ownership });
    const stream = new InMemoryStream();

    first.refuseNextRetention();
    const interrupted = yield* withConversation(stream, first.installation, function* (chat) {
      return yield* chat.prompt("first");
    });
    expect(answer(interrupted)).toBe("the host could not retain this session");
    const promoted = first.store.records.get(CHAT_SESSION_KEY);
    if (promoted === undefined) {
      throw new Error("the provider kept no record of the interrupted turn");
    }
    expect(promoted.agentSessionId).toBe(NATIVE);
    expect(promoted.acpSessionId).not.toBe(NATIVE);
    const failed = turns(yield* stream.readAll());
    expect(failed.map((turn) => [turn.record.sessionKey, turn.record.agentSessionId])).toEqual([
      [CHAT_SESSION_KEY, undefined],
    ]);
    const originalTuple = { provider: "acpx", agent: "scribe-cmd", sessionKey: CHAT_SESSION_KEY };
    expect((yield* ownership.routes.read(originalTuple))?.route).toBe("acp-first");

    // The first owner is gone, and this host now runs another adapter command.
    // The adapter reports the native conversation it loaded, not its target.
    const next = host({
      owned: ownership,
      command: "scribe-cmd-next",
      harness: first.harness,
      store: first.store,
    });
    next.harness.assertIdentity = NATIVE;
    const ensured = next.harness.ensureCalls.length;
    const acquired = ownership.coordinator.acquisitions.length;
    const continued = yield* withConversation(stream, next.installation, function* (chat) {
      return yield* chat.prompt("again");
    });

    expect(answer(continued)).toBe("hello world");
    // The exact record and directory, reopened by its own ACP target through
    // today's command, and then continued in place.
    const calls = next.harness.ensureCalls.slice(ensured);
    expect(calls.map((call) => [call.sessionKey, call.cwd])).toEqual([
      [CHAT_SESSION_KEY, SESSION_DIR],
      [CHAT_SESSION_KEY, SESSION_DIR],
    ]);
    expect(calls[0]?.resumeSessionId).toBe(promoted.acpSessionId);
    expect(next.store.records.get(CHAT_SESSION_KEY)?.agentCommand).toBe("scribe-cmd-next");
    // One owner tuple, the original, for the eager session and for the turn.
    expect(ownership.coordinator.acquisitions.slice(acquired)).toEqual([
      { kind: "session", key: originalTuple, outcome: "granted" },
      { kind: "prompt", key: originalTuple, outcome: "granted" },
    ]);
    expect(yield* ownership.routes.read({ ...originalTuple, agent: "scribe-cmd-next" })).toBe(
      undefined,
    );
    // The host's own callbacks still ran, and committed that same assertion.
    expect(next.assertions.map((identity) => identity.agentSessionId)).toEqual([NATIVE, NATIVE]);
    // The interrupted turn was not sent again, and its evidence is unchanged.
    expect(asked(next)).toEqual(["first", "again"]);
    const recorded = turns(yield* stream.readAll());
    expect(recorded[0]).toEqual(failed[0]);
    expect(recorded.map((turn) => turn.record.agentSessionId)).toEqual([undefined, NATIVE]);
  });

  /**
   * The same window, under a host whose policy derives each key from the
   * command it is asked about (#1221).
   *
   * After the adapter changes, that policy answers a key this conversation has
   * never been placed at. The host is still asked — its answer is where it
   * would refuse — but the placement the interrupted turn recorded is where the
   * conversation stays: the provider's promoted assertion is joined there, by
   * its own ACP target, under the original owner, and nothing is created at
   * the key the policy answered.
   */
  it("HC6: a policy deriving placement from today's command does not move a held conversation", function* () {
    const ownership = owned();
    const first = host({ owned: ownership, derived: true });
    const stream = new InMemoryStream();

    first.refuseNextRetention();
    const interrupted = yield* withConversation(stream, first.installation, function* (chat) {
      return yield* chat.prompt("first");
    });
    expect(answer(interrupted)).toBe("the host could not retain this session");
    const [placement] = first.placed;
    if (placement === undefined) {
      throw new Error("the host placed nothing for the interrupted turn");
    }
    const promoted = first.store.records.get(placement);
    if (promoted?.agentSessionId === undefined) {
      throw new Error("the provider promoted no assertion for the interrupted turn");
    }
    const failed = turns(yield* stream.readAll());
    expect(failed.map((turn) => [turn.record.sessionKey, turn.record.agentSessionId])).toEqual([
      [placement, undefined],
    ]);
    const originalTuple = { provider: "acpx", agent: "scribe-cmd", sessionKey: placement };

    const next = host({
      owned: ownership,
      derived: true,
      command: "scribe-cmd-next",
      harness: first.harness,
      store: first.store,
    });
    next.harness.assertIdentity = promoted.agentSessionId;
    const ensured = next.harness.ensureCalls.length;
    const acquired = ownership.coordinator.acquisitions.length;
    const continued = yield* withConversation(stream, next.installation, function* (chat) {
      return yield* chat.prompt("again");
    });

    expect(answer(continued)).toBe("hello world");
    // The policy was asked, and answered somewhere else.
    expect(next.placed.length).toBeGreaterThan(0);
    expect(next.placed.every((key) => key !== placement)).toBe(true);
    // Every ensure stayed at the recorded placement, the first by its own ACP
    // target, and nothing stands at the key the policy answered.
    const calls = next.harness.ensureCalls.slice(ensured);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.sessionKey === placement)).toBe(true);
    expect(calls[0]?.resumeSessionId).toBe(promoted.acpSessionId);
    expect([...next.store.records.keys()]).toEqual([placement]);
    expect(next.store.records.get(placement)?.agentSessionId).toBe(promoted.agentSessionId);
    // The original owner, and the host's callbacks committing the same assertion.
    expect(ownership.coordinator.acquisitions.slice(acquired)).toEqual([
      { kind: "session", key: originalTuple, outcome: "granted" },
      { kind: "prompt", key: originalTuple, outcome: "granted" },
    ]);
    expect(next.assertions.map((identity) => identity.agentSessionId)).toEqual([
      promoted.agentSessionId,
      promoted.agentSessionId,
    ]);
    // No replacement work: the interrupted turn was not sent again.
    expect(asked(next)).toEqual(["first", "again"]);
    const recorded = turns(yield* stream.readAll());
    expect(recorded[0]).toEqual(failed[0]);
    expect(recorded.map((turn) => [turn.record.sessionKey, turn.record.agentSessionId])).toEqual([
      [placement, undefined],
      [placement, promoted.agentSessionId],
    ]);
  });

  /**
   * And who may reopen it: the conversation's original owner tuple.
   *
   * An earlier owner still holds the session under the command it was built
   * with. A contender running today's command would find its own natural tuple
   * free, so refusing proves it asked for the original one — before any
   * provider effect, route or record could move.
   */
  it("HC5: a changed command is refused while the original owner holds the conversation", function* () {
    const ownership = owned();
    const first = host({ owned: ownership });
    const stream = new InMemoryStream();
    expect(
      answer(
        yield* withConversation(stream, first.installation, function* (chat) {
          return yield* chat.prompt("first");
        }),
      ),
    ).toBe("hello world");
    const history = stream.snapshot();
    const originalTuple = { provider: "acpx", agent: "scribe-cmd", sessionKey: CHAT_SESSION_KEY };
    const route = yield* ownership.routes.read(originalTuple);
    const record = first.store.records.get(CHAT_SESSION_KEY);

    const next = host({
      owned: ownership,
      command: "scribe-cmd-next",
      harness: first.harness,
      store: first.store,
    });
    const ensured = next.harness.ensureCalls.length;
    const refused = yield* scoped(function* () {
      const holding = withResolvers<void>();
      yield* spawn(function* () {
        yield* ownership.coordinator.coordinator.coordinate(
          originalTuple,
          { kind: "native-launch", operationId: "earlier-owner" },
          function* () {
            holding.resolve();
            yield* suspend();
          },
        );
      });
      yield* holding.operation;
      return yield* withConversation(stream, next.installation, function* (chat) {
        return yield* chat.prompt("again");
      });
    });

    expect(answer(refused)).toContain("is held");
    expect(ownership.coordinator.acquisitions.at(-1)).toEqual({
      kind: "session",
      key: originalTuple,
      outcome: "busy",
    });
    expect(
      ownership.coordinator.acquisitions.some((one) => one.key.agent === "scribe-cmd-next"),
    ).toBe(false);
    // Nothing was ensured, prompted, routed or written, and no recovery forced.
    expect(next.harness.ensureCalls.length).toBe(ensured);
    expect(asked(next)).toEqual(["first"]);
    expect(yield* ownership.routes.read(originalTuple)).toEqual(route);
    expect(yield* ownership.routes.read({ ...originalTuple, agent: "scribe-cmd-next" })).toBe(
      undefined,
    );
    expect(next.store.records.get(CHAT_SESSION_KEY)).toBe(record);
    expect(stream.snapshot()).toEqual(history);
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
    expect(target.assertions.map((identity) => identity.agentSessionId)).toEqual([NATIVE]);
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
    expect(interrupted.map((turn) => turn.name)).toEqual(["turn:1"]);
    expect(interrupted[0]!.record.agentSessionId).toBe(NATIVE);

    const continued = yield* withConversation(stream, target.installation, function* (chat) {
      return yield* chat.prompt("third");
    });

    expect(answer(continued)).toBe("hello world");
    expect(asked(target)).toEqual(["first", "third"]);
    expect([...target.store.records.keys()]).toEqual([CHAT_SESSION_KEY]);
    const reconciled = turns(yield* stream.readAll());
    expect(reconciled.map((turn) => turn.name)).toEqual(["turn:1", "turn:2"]);
    expect(reconciled[1]!.record.agentSessionId).toBe(NATIVE);
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

    // The reopening is an exact resume held to the conversation the history
    // names, so the provider refuses it before any turn could run there.
    expect(answer(diverged)).toContain("reopened a different native conversation");
    expect(asked(target)).toEqual(["first"]);
    const retained = turns(yield* stream.readAll());
    expect(retained).toHaveLength(1);
    expect(retained[0]!.record.agentSessionId).toBe(NATIVE);
    const reopened = yield* withConversation(stream, target.installation, function* (chat) {
      return yield* chat.options();
    });
    expect(reopened.ok).toBe(true);
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
        const record = yield* until(store.load(CHAT_SESSION_KEY));
        return {
          sessionKey: CHAT_SESSION_KEY,
          cwd: SESSION_DIR,
          state:
            record === undefined || record.sessionMaterialization !== undefined
              ? "new"
              : "existing",
        };
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
              nativeAdapters: {
                scribe: {
                  launcher: "scribe",
                  identity: "provider-returned",
                  acceptance: "first-turn-acceptance",
                  resume: () => [],
                },
              },
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
 * A conversation reads its provider once and reaches it through a terminal of
 * its own, so there is no dispatch for an `agent` or `session` handler to sit
 * on. Content is the exception and the only one: a held turn's text and its
 * stream are composed by outer `prompt` middleware above that terminal, which
 * validates the checked call rather than letting it be rerouted. These rows are
 * the permanent form of that: the refusal must still be the specific one about
 * configuration — a refusal because no provider object was installed would
 * prove nothing about the routing at all.
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
    // A session this chat has never been in. Composition reaches the content
    // and nothing else, so a handler that puts this on the call is refused
    // rather than quietly sending the turn somewhere else.
    const canary: Session = { sessionKey: "xmd:chat:v1:acpx:elsewhere", cwd: SESSION_DIR };
    for (const reroutes of [false, true]) {
      const seen: string[] = [];
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
                return yield* next(
                  content,
                  reroutes ? { ...promptOptions, session: canary } : promptOptions,
                );
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

      // The content handler is reached, because composing what a held turn
      // says is what outer prompt middleware is for. The agent and the session
      // are not its to decide, and neither handler is on the chat's path.
      expect(seen).toEqual(["prompt"]);

      if (reroutes) {
        // Refused at the turn's own terminal, before anything native: the
        // canary never reached a provider and this chat established no native
        // conversation through it.
        expect(answer(answered)).toContain("arrived at its own terminal");
        expect(asked(target)).toEqual([]);
        expect(target.assertions).toEqual([]);
        // The attempt is retained the way every other failure before native
        // work is — as a failed turn carrying its refusal. What it holds is
        // what this turn tried to ask, which is not evidence it was sent.
        const refused = turns(yield* stream.readAll());
        expect(refused.map((turn) => turn.name)).toEqual(["turn:1"]);
        expect(refused[0]!.record.status).toBe("failed");
        expect(refused[0]!.record.text).toBe("");
        expect(refused[0]!.record.agentSessionId).toBe(undefined);
        // What this conversation settled still happened; the turn did not.
        expect(configurations(yield* stream.readAll())).toBe(1);
        continue;
      }

      expect(answer(answered)).toBe("hello world");
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
      expect(target.assertions.map((identity) => identity.agentSessionId)).toEqual([NATIVE]);
      expect(configurations(yield* stream.readAll())).toBe(1);
    }
  });
});

describe(
  "standard held conversation persistence",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    for (const missing of [false, true]) {
      it(`reopening with ${missing ? "missing" : "intact"} provider storage never replaces history`, function* () {
        yield* withCertificationFixture(function* (f) {
          const history = new InMemoryStream();
          const store = createAcpxSessionStore(join(f.dir, "store"));
          const key = "held-standard";
          const command = f.command("standard");
          const installation: ExecutionInstallation = {
            *install() {
              yield* installAgentComponents({
                defaultAgent: command,
                rootProvider: {
                  options: { defaultAgent: command, permissionMode: "deny-all" },
                  factory: createAcpxProvider({
                    sessionStore: store,
                    advertiseNativeLaunch: [],
                    advertiseClientNativeAttachment: [],
                    mcpServers: [],
                    newSessionOptions: { allowedTools: [] },
                    permissions: "strict",
                    *agentCwd() {
                      return f.dir;
                    },
                    sessions: {
                      *requestSession() {
                        return {
                          sessionKey: key,
                          cwd: f.dir,
                          state: (yield* until(store.load(key))) === undefined ? "new" : "existing",
                        };
                      },
                      *recordSessionIdentity() {},
                    },
                  }),
                },
              });
            },
          };
          expect(
            answer(
              yield* withConversation(
                history,
                installation,
                (chat) => chat.prompt("seed:remembered"),
                command,
              ),
            ),
          ).toBe("READY");
          const kept = history.snapshot();
          const record = yield* until(store.load(key));
          if (record === undefined) {
            throw new Error("missing seeded record");
          }
          expect(record.agentSessionId).toBe(undefined);
          if (missing) {
            yield* rm(join(f.dir, "store", "sessions", key + ".json"));
          }
          const before = yield* f.calls();
          const next = yield* withConversation(
            history,
            installation,
            function* (chat) {
              expect(yield* f.calls()).toEqual(before);
              const reply = yield* chat.prompt("recall");
              if (missing) {
                expect(reply.ok).toBe(false);
                if (!reply.ok) {
                  expect(reply.error.message).toContain("Start a new conversation");
                }
                expect(history.snapshot()).toEqual(kept);
              } else {
                expect(reply).toEqual(Ok("remembered"));
              }
              return reply;
            },
            command,
          );
          expect(next.ok).toBe(true);
          const delta = (yield* f.calls())
            .slice(before.length)
            .filter((call) =>
              ["session/new", "session/load", "session/prompt"].includes(call.method),
            );
          expect(delta.map((call) => call.method)).toEqual(
            missing ? [] : ["session/load", "session/prompt"],
          );
          expect(delta.every((call) => call.sessionId === record.acpSessionId)).toBe(true);
          expect(turns(history.snapshot()).length).toBe(missing ? 1 : 2);
        });
      });
    }
  },
);

/**
 * What the provider asked of the real ACPX runtime, in order.
 *
 * Recorded at the runtime boundary and delegated unchanged, so what runs is
 * ACPX itself and what a case reads is what the provider actually asked it.
 */
interface RuntimeBoundary {
  readonly environments: AcpRuntimeOptions["agentProcessEnv"][];
  readonly log: {
    readonly op: "ensure" | "close";
    readonly sessionKey?: string;
    readonly cwd?: string;
    readonly resumeSessionId?: string;
    readonly requestedModel?: string;
  }[];
  create(options: AcpRuntimeOptions): ProbeCapableRuntime;
}

function runtimeBoundary(): RuntimeBoundary {
  const log: RuntimeBoundary["log"] = [];
  const environments: RuntimeBoundary["environments"] = [];
  return {
    log,
    environments,
    create(options) {
      environments.push(options.agentProcessEnv);
      const runtime = createAcpRuntime(options);
      return new Proxy(runtime, {
        get(target, property) {
          if (property === "ensureSession") {
            return (input: AcpRuntimeEnsureInput) => {
              log.push({
                op: "ensure",
                sessionKey: input.sessionKey,
                ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                ...(input.resumeSessionId === undefined
                  ? {}
                  : { resumeSessionId: input.resumeSessionId }),
                ...(input.requestedModel === undefined
                  ? {}
                  : { requestedModel: input.requestedModel }),
              });
              return target.ensureSession(input);
            };
          }
          if (property === "close") {
            return (input: Parameters<typeof target.close>[0]) => {
              log.push({ op: "close" });
              return target.close(input);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

/**
 * One host over the real ACPX runtime and a controlled subprocess adapter.
 *
 * `scribe` is the stable agent alias a conversation is bound to; the command it
 * resolves to is the host's to change between releases, which is exactly what
 * happened when the bundled Codex adapter became the host-installed one. The
 * session store, ownership and construction routes outlive every installation.
 * Placement is the ordinary command-derived directory walk.
 */
interface ChangingHost {
  readonly store: ReturnType<typeof createAcpxSessionStore>;
  readonly ownership: Owned;
  readonly runtime: RuntimeBoundary;
  readonly observer: ReturnType<typeof createFakeObserver>;
  installation(command: string | string[]): ExecutionInstallation;
}

function changingHost(f: CertificationFixture, agent = AGENT): ChangingHost {
  const store = createAcpxSessionStore(join(f.dir, "store"));
  const ownership = owned();
  const runtime = runtimeBoundary();
  const observer = createFakeObserver({
    versionOutput: agent === "codex" ? "codex-cli 0.163.0\n" : "scribe 1.0.0\n",
  });
  return {
    store,
    ownership,
    runtime,
    observer,
    installation(command) {
      return {
        *install() {
          yield* installAgentComponents({
            defaultAgent: agent,
            rootProvider: {
              options: { defaultAgent: agent, permissionMode: "deny-all" },
              factory: createAcpxProvider({
                createRuntime: runtime.create,
                sessionStore: store,
                agentRegistry: { resolve: () => command, list: () => [agent] },
                ...(agent === AGENT ? { nativeAdapters: { scribe: BOUND_SCRIBE } } : {}),
                advertiseNativeLaunch: [agent],
                advertiseClientNativeAttachment: [],
                coordinator: ownership.coordinator.coordinator,
                routeStore: ownership.routes,
                executableObserver: observer.observer,
                mcpServers: [],
                newSessionOptions: { allowedTools: [] },
                permissions: "strict",
                *agentCwd() {
                  return f.dir;
                },
              }),
            },
          });
        },
      };
    },
  };
}

/** A history's canonical events, written out and read back as a new history. */
function* reread(history: InMemoryStream): Operation<{ lines: string[]; stream: InMemoryStream }> {
  const lines = (yield* history.readAll()).map(serializeDurableEvent);
  const stream = new InMemoryStream();
  for (const line of lines) {
    const parsed = parseDurableEvent(line);
    if (!parsed.ok) {
      throw parsed.error;
    }
    yield* stream.append(parsed.value);
  }
  return { lines, stream };
}

/** The configuration records a history holds, as they were written. */
function configurationLines(events: readonly DurableEvent[]): string[] {
  return events
    .filter(
      (event) =>
        event.type === "yield" && event.description.type === "agent_conversation_configuration",
    )
    .map(serializeDurableEvent);
}

describe(
  "Tier HR — a held conversation resumes through a changed adapter command (#1221)",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("HR1: the exact native history continues through today's command and configuration", function* () {
      yield* withCertificationFixture(function* (f) {
        const target = changingHost(f);
        const before = f.command("distinct");
        const after = f.command("distinct-next");
        const original = deriveSessionKey(before, f.dir, "chat-1");
        const natural = deriveSessionKey(after, f.dir, "chat-1");
        expect(natural).not.toBe(original);

        const history = new InMemoryStream();
        expect(
          answer(
            yield* withConversation(history, target.installation(before), (chat) =>
              chat.prompt("seed:remembered"),
            ),
          ),
        ).toBe("READY");
        const record = yield* until(target.store.load(original));
        if (record === undefined) {
          throw new Error("the seeded conversation left no provider record");
        }
        // Two different names for one conversation: the ACP loading target and
        // the native identity the adapter asserts.
        const acp = record.acpSessionId;
        const native = `native-${acp}`;
        expect(record.agentSessionId).toBe(native);
        // A record standing where today's command would place this name. It is
        // somebody else's, and nothing may continue it.
        yield* until(
          target.store.save({
            ...record,
            acpxRecordId: natural,
            name: natural,
            agentCommand: after,
            acpSessionId: "decoy-acp",
            agentSessionId: "decoy-native",
          }),
        );

        const { lines, stream } = yield* reread(history);
        const called = yield* f.calls();
        const logged = target.runtime.log.length;
        const acquired = target.ownership.coordinator.acquisitions.length;
        const continued = yield* withConversation(
          stream,
          target.installation(after),
          function* (chat) {
            // Opening and replaying contact no provider.
            expect(yield* f.calls()).toEqual(called);
            return yield* chat.prompt("recall", { model: "selected", effort: "high" });
          },
        );

        // The original marker, from the conversation's own provider history.
        expect(answer(continued)).toBe("remembered");
        const all = yield* f.calls();
        expect(
          all.filter((call) => call.method === "session/prompt").map((call) => call.kind),
        ).toEqual(["seed", "recall"]);
        // Today's command executes, and only against the original ACP session.
        const delta = all.slice(called.length);
        expect(delta.every((call) => call.mode === "distinct-next")).toBe(true);
        expect(delta.map((call) => call.method)).not.toContain("session/new");
        const sessionCalls = delta.filter((call) => call.sessionId !== undefined);
        expect(sessionCalls.length).toBeGreaterThan(0);
        expect(sessionCalls.every((call) => call.sessionId === acp)).toBe(true);
        expect(delta.filter((call) => call.method === "session/load").length).toBe(2);
        // The current requested settings are applied before the new prompt.
        const methods = delta.map((call) => call.method);
        expect(methods.lastIndexOf("session/set_config_option")).toBeLessThan(
          methods.lastIndexOf("session/prompt"),
        );

        // The eager session reopens the exact record by its ACP target and is
        // released; the turn reacquires that same record, by that same target,
        // in its own directory.
        const boundary = target.runtime.log.slice(logged);
        const ensures = boundary.filter((entry) => entry.op === "ensure");
        expect(ensures).toEqual([
          {
            op: "ensure",
            sessionKey: original,
            cwd: record.cwd,
            resumeSessionId: acp,
            requestedModel: "selected",
          },
          {
            op: "ensure",
            sessionKey: original,
            cwd: record.cwd,
            resumeSessionId: acp,
            requestedModel: "selected",
          },
        ]);
        const second = boundary.indexOf(ensures[1]!);
        expect(boundary.slice(1, second).map((entry) => entry.op)).toContain("close");

        // One owner and one route, both where the conversation began.
        const tuple = { provider: "acpx", agent: before, sessionKey: original };
        expect(target.ownership.coordinator.acquisitions.slice(acquired)).toEqual([
          { kind: "session", key: tuple, outcome: "granted" },
          { kind: "prompt", key: tuple, outcome: "granted" },
        ]);
        const route = yield* target.ownership.routes.read(tuple);
        expect(route?.route).toBe("acp-first");
        expect(route?.schema).toBe("session-route.v3");
        expect(yield* target.ownership.routes.read({ ...tuple, agent: after })).toBe(undefined);
        expect(
          yield* target.ownership.routes.read({ ...tuple, agent: after, sessionKey: natural }),
        ).toBe(undefined);

        // The record is the same conversation under today's command; the decoy
        // was never touched.
        const resumed = yield* until(target.store.load(original));
        expect([resumed?.acpSessionId, resumed?.agentSessionId, resumed?.agentCommand]).toEqual([
          acp,
          native,
          after,
        ]);
        const decoy = yield* until(target.store.load(natural));
        expect([decoy?.acpSessionId, decoy?.agentCommand]).toEqual(["decoy-acp", after]);

        // The journal keeps its prefix exactly, with one initial configuration
        // naming the original command, and both turns name the native identity.
        const events = yield* stream.readAll();
        expect(events.slice(0, lines.length).map(serializeDurableEvent)).toEqual(lines);
        const saved = configurationLines(events);
        expect(saved).toEqual(configurationLines(yield* history.readAll()));
        expect(saved).toHaveLength(1);
        expect(saved[0]).toContain(JSON.stringify(before).slice(1, -1));
        const held = turns(events);
        expect(held.map((turn) => turn.name)).toEqual(["turn:1", "turn:2"]);
        expect(held.map((turn) => turn.record.agentSessionId)).toEqual([native, native]);
      });
    });

    it("HR2: a resume the provider cannot perform fails, and nothing replaces the conversation", function* () {
      yield* withCertificationFixture(function* (f) {
        const target = changingHost(f);
        const before = f.command("distinct");
        const after = f.command("distinct-next");
        const original = deriveSessionKey(before, f.dir, "chat-1");
        const history = new InMemoryStream();
        expect(
          answer(
            yield* withConversation(history, target.installation(before), (chat) =>
              chat.prompt("seed:remembered"),
            ),
          ),
        ).toBe("READY");
        const record = yield* until(target.store.load(original));
        if (record === undefined) {
          throw new Error("the seeded conversation left no provider record");
        }
        // The provider's own history for that conversation is gone.
        const providerHistory = join(f.dir, `fixture-${record.acpSessionId}.json`);
        const kept = yield* readTextFile(providerHistory);
        yield* rm(providerHistory);

        const journal = history.snapshot();
        const called = yield* f.calls();
        const reopened = yield* withConversation(
          history,
          target.installation(after),
          function* (chat) {
            const refused = yield* chat.prompt("recall");
            const failed = yield* f.calls();
            // The provider's account of what happened, and nothing was created
            // or prompted in its place.
            const attempt = failed.slice(called.length).map((call) => call.method);
            expect(attempt).toContain("session/load");
            expect(attempt).not.toContain("session/new");
            expect(attempt).not.toContain("session/prompt");
            expect(history.snapshot()).toEqual(journal);
            const unchanged = yield* until(target.store.load(original));
            expect([
              unchanged?.acpSessionId,
              unchanged?.agentSessionId,
              unchanged?.agentCommand,
            ]).toEqual([record.acpSessionId, record.agentSessionId, before]);
            // The failure released what it held: a later explicit action is
            // free to try again, and nothing retried on its own.
            yield* writeTextFile(providerHistory, kept);
            const later = yield* chat.prompt("recall");
            return { refused, later };
          },
        );
        if (!reopened.ok) {
          throw reopened.error;
        }
        expect(reopened.value.refused.ok).toBe(false);
        // The adapter's own account of the failed load crosses unchanged.
        expect(!reopened.value.refused.ok && reopened.value.refused.error.message).toContain(
          "missing controlled history",
        );
        expect(reopened.value.later).toEqual(Ok("remembered"));
        expect(
          (yield* f.calls())
            .filter((call) => call.method === "session/prompt")
            .map((call) => call.kind),
        ).toEqual(["seed", "recall"]);
        // The refused turn recorded nothing; only the seed and the later turn are recorded.
        const keptTurns = turns(history.snapshot());
        expect(keptTurns).toHaveLength(2);
        expect(keptTurns.map((turn) => turn.record.status)).toEqual(["completed", "completed"]);
      });
    });

    it("HR3: the same command given as a string instead of argv reopens the exact record", function* () {
      yield* withCertificationFixture(function* (f) {
        const target = changingHost(f);
        // One command identity in two supported shapes: ACPX keeps the argv it
        // was given on its record and reuses that record only for the same argv.
        const argv = ["node", join(f.dir, "agent.cjs"), "distinct", f.dir];
        const command = argv.join(" ");
        const key = deriveSessionKey(command, f.dir, "chat-1");

        const history = new InMemoryStream();
        expect(
          answer(
            yield* withConversation(history, target.installation(argv), (chat) =>
              chat.prompt("seed:remembered"),
            ),
          ),
        ).toBe("READY");
        const record = yield* until(target.store.load(key));
        if (record === undefined) {
          throw new Error("the seeded conversation left no provider record");
        }
        expect(record.agentCommand).toBe(command);
        expect(record.agentArgv).toEqual(argv);
        const acp = record.acpSessionId;
        const native = `native-${acp}`;
        expect(record.agentSessionId).toBe(native);

        const called = yield* f.calls();
        const logged = target.runtime.log.length;
        const continued = yield* withConversation(history, target.installation(command), (chat) =>
          chat.prompt("recall"),
        );

        expect(answer(continued)).toBe("remembered");
        // Loaded by its own ACP target; nothing was created under its key.
        const delta = (yield* f.calls()).slice(called.length);
        expect(delta.map((call) => call.method)).not.toContain("session/new");
        expect(delta.map((call) => call.method)).toContain("session/load");
        expect(
          delta
            .filter((call) => call.sessionId !== undefined)
            .every((call) => call.sessionId === acp),
        ).toBe(true);
        const ensures = target.runtime.log.slice(logged).filter((entry) => entry.op === "ensure");
        expect(ensures.length).toBeGreaterThan(0);
        expect(
          ensures.every((entry) => entry.sessionKey === key && entry.resumeSessionId === acp),
        ).toBe(true);
        // The same key, the same ACP target and the same native conversation.
        const resumed = yield* until(target.store.load(key));
        expect([resumed?.acpSessionId, resumed?.agentSessionId]).toEqual([acp, native]);
        expect(turns(history.snapshot()).map((turn) => turn.record.agentSessionId)).toEqual([
          native,
          native,
        ]);
      });
    });

    it("HR4: a reopened conversation answering another native identity leaves the record as it was", function* () {
      yield* withCertificationFixture(function* (f) {
        const target = changingHost(f);
        const before = f.command("distinct");
        const original = deriveSessionKey(before, f.dir, "chat-1");
        const history = new InMemoryStream();
        expect(
          answer(
            yield* withConversation(history, target.installation(before), (chat) =>
              chat.prompt("seed:remembered"),
            ),
          ),
        ).toBe("READY");
        const record = yield* until(target.store.load(original));
        if (record === undefined) {
          throw new Error("the seeded conversation left no provider record");
        }
        const acp = record.acpSessionId;
        const native = `native-${acp}`;
        expect(record.agentSessionId).toBe(native);

        // Today's adapter loads that same ACP target and reports its native
        // conversation as the target itself: another identity than the history's.
        const journal = history.snapshot();
        const called = yield* f.calls();
        const refused = yield* withConversation(
          history,
          target.installation(f.command("normal")),
          (chat) => chat.prompt("recall"),
        );
        if (!refused.ok) {
          throw refused.error;
        }
        expect(refused.value.ok).toBe(false);
        expect(!refused.value.ok && refused.value.error.message).toContain(
          "reopened a different native conversation",
        );
        const attempt = (yield* f.calls()).slice(called.length).map((call) => call.method);
        expect(attempt).toContain("session/load");
        expect(attempt).not.toContain("session/new");
        expect(attempt).not.toContain("session/prompt");
        expect(history.snapshot()).toEqual(journal);
        // The refused assertion never stands as the record's own.
        const kept = yield* until(target.store.load(original));
        expect([kept?.acpSessionId, kept?.agentSessionId, kept?.agentCommand]).toEqual([
          acp,
          native,
          before,
        ]);

        // A later explicit turn through an adapter reporting the right
        // conversation reaches the original target and its history.
        const later = yield* withConversation(
          history,
          target.installation(f.command("distinct-next")),
          (chat) => chat.prompt("recall"),
        );
        expect(answer(later)).toBe("remembered");
        const resumed = yield* until(target.store.load(original));
        expect([resumed?.acpSessionId, resumed?.agentSessionId]).toEqual([acp, native]);
        expect(
          (yield* f.calls())
            .filter((call) => call.method === "session/prompt")
            .map((call) => call.kind),
        ).toEqual(["seed", "recall"]);
      });
    });
  },
);

describe(
  "a held Codex conversation across a host CLI upgrade",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    for (const [mode, failure] of [
      ["distinct", undefined],
      ["normal", "reopened a different native conversation"],
      ["standard", "did not confirm the retained native conversation"],
      ["missing", "missing controlled history"],
    ] as const) {
      it(`requires the new build's live identity (${mode})`, function* () {
        yield* withCertificationFixture(function* (f) {
          const target = changingHost(f, "codex");
          const command = f.command("distinct");
          const key = deriveSessionKey(command, f.dir, "chat-1");
          const tuple = { provider: "acpx", agent: command, sessionKey: key };
          const history = new InMemoryStream();
          expect(
            answer(
              yield* withConversation(
                history,
                target.installation(command),
                (chat) => chat.prompt("seed:remembered"),
                "codex",
              ),
            ),
          ).toBe("READY");
          const record = yield* until(target.store.load(key));
          const route = yield* target.ownership.routes.read(tuple);
          if (!record?.agentSessionId || route?.schema !== "session-route.v3") {
            throw new Error("The original build did not establish a native conversation");
          }
          expect(route.executableBinding.reportedVersion).toBe("codex-cli 0.163.0");
          const { lines, stream } = yield* reread(history);
          const before = yield* f.calls();
          if (mode === "missing") {
            yield* rm(join(f.dir, `fixture-${record.acpSessionId}.json`));
          }
          const runtimeCount = target.runtime.environments.length;
          target.observer.observation.path = "/opt/builds/codex-0.167.1";
          target.observer.observation.versionOutput = "codex-cli 0.167.1\n";
          target.observer.observation.digest = "b".repeat(64);
          const resumed = yield* withConversation(
            stream,
            target.installation(mode === "missing" ? command : f.command(mode)),
            (chat) => chat.prompt("recall", { model: "selected", effort: "high" }),
            "codex",
          );
          const calls = (yield* f.calls()).slice(before.length);
          const methods = calls.map((call) => call.method);
          const environments = target.runtime.environments.slice(runtimeCount);
          expect(environments).toContainEqual({ CODEX_PATH: "/opt/builds/codex-0.167.1" });
          expect(methods).toContain("session/load");
          expect(methods).not.toContain("session/new");
          expect(
            calls
              .filter((call) => call.sessionId !== undefined)
              .every((call) => call.sessionId === record.acpSessionId),
          ).toBe(true);
          expect(yield* target.ownership.routes.read(tuple)).toEqual(route);
          if (failure === undefined) {
            expect(answer(resumed)).toBe("remembered");
            expect(methods.indexOf("session/load")).toBeLessThan(methods.indexOf("session/prompt"));
            expect(methods.lastIndexOf("session/set_config_option")).toBeLessThan(
              methods.indexOf("session/prompt"),
            );
            const kept = yield* until(target.store.load(key));
            expect(kept?.agentSessionId).toBe(record.agentSessionId);
            expect(kept?.messages.slice(0, record.messages.length)).toEqual(record.messages);
            expect(turns(stream.snapshot()).map((turn) => turn.record.agentSessionId)).toEqual([
              record.agentSessionId,
              record.agentSessionId,
            ]);
          } else {
            if (!resumed.ok || resumed.value.ok) {
              throw new Error("The held conversation did not report a resume refusal");
            }
            expect(resumed.value.error.message).toContain(failure);
            expect(methods).not.toContain("session/set_config_option");
            expect(methods).not.toContain("session/prompt");
            expect(yield* until(target.store.load(key))).toEqual(record);
            expect(stream.snapshot().map(serializeDurableEvent)).toEqual(lines);
          }
        });
      });
    }
  },
);

describe(
  "standard held conversation persistence through a changed command",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    for (const missing of [false, true]) {
      it(`reopening with ${missing ? "missing" : "intact"} provider storage under another command continues only its own record`, function* () {
        yield* withCertificationFixture(function* (f) {
          const history = new InMemoryStream();
          const store = createAcpxSessionStore(join(f.dir, "store"));
          const installation = (command: string): ExecutionInstallation => ({
            *install() {
              yield* installAgentComponents({
                defaultAgent: AGENT,
                rootProvider: {
                  options: { defaultAgent: AGENT, permissionMode: "deny-all" },
                  factory: createAcpxProvider({
                    sessionStore: store,
                    agentRegistry: makeRegistry({ scribe: command }),
                    advertiseNativeLaunch: [],
                    advertiseClientNativeAttachment: [],
                    mcpServers: [],
                    newSessionOptions: { allowedTools: [] },
                    permissions: "strict",
                    *agentCwd() {
                      return f.dir;
                    },
                  }),
                },
              });
            },
          });
          const before = f.command("standard");
          const after = `${f.command("standard")} --next`;
          const original = deriveSessionKey(before, f.dir, "chat-1");
          const natural = deriveSessionKey(after, f.dir, "chat-1");
          expect(
            answer(
              yield* withConversation(history, installation(before), (chat) =>
                chat.prompt("seed:remembered"),
              ),
            ),
          ).toBe("READY");
          const record = yield* until(store.load(original));
          if (record === undefined) {
            throw new Error("missing seeded record");
          }
          // The one record the seed wrote, by the name the store gave its file.
          const written = yield* readdir(join(f.dir, "store", "sessions"));
          expect(written).toHaveLength(1);
          // Where today's command would look, somebody else's conversation.
          yield* until(
            store.save({
              ...record,
              acpxRecordId: natural,
              name: natural,
              agentCommand: after,
              acpSessionId: "decoy-acp",
            }),
          );
          if (missing) {
            yield* rm(join(f.dir, "store", "sessions", written[0]!));
            expect(yield* until(store.load(original))).toBe(undefined);
          }
          const kept = history.snapshot();
          const called = yield* f.calls();
          const reply = yield* withConversation(history, installation(after), (chat) =>
            chat.prompt("recall"),
          );
          if (!reply.ok) {
            throw reply.error;
          }
          const delta = (yield* f.calls())
            .slice(called.length)
            .filter((call) =>
              ["session/new", "session/load", "session/prompt"].includes(call.method),
            );
          if (missing) {
            // A used history whose own record is gone refuses, and the decoy at
            // today's natural placement is not a substitute.
            expect(reply.value.ok).toBe(false);
            expect(!reply.value.ok && reply.value.error.message).toContain(
              "Start a new conversation",
            );
            expect(delta).toEqual([]);
            expect(history.snapshot()).toEqual(kept);
          } else {
            expect(reply.value).toEqual(Ok("remembered"));
            expect(delta.map((call) => call.method)).toEqual([
              "session/load",
              "session/load",
              "session/prompt",
            ]);
            expect(delta.every((call) => call.sessionId === record.acpSessionId)).toBe(true);
            expect(delta.every((call) => call.mode === "standard")).toBe(true);
          }
          expect((yield* until(store.load(natural)))?.acpSessionId).toBe("decoy-acp");
        });
      });
    }
  },
);
