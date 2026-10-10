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
import { installAgentComponents } from "@executablemd/core";
import { useAgentConversation } from "@executablemd/core/host";
import type { AgentConversation, ExecutionInstallation } from "@executablemd/core/host";

import { createAcpxProvider } from "../src/provider.ts";
import type { AcpxSessionIdentity, AcpxSessionPolicy } from "../src/provider.ts";
import { createFakeRuntime, makeRegistry, makeStore, useFlatWorld } from "./helpers.ts";
import type { FakeRuntimeHarness } from "./helpers.ts";

const AGENT = "scribe";
const WORKSPACE = "/workspace";

/** The runtime's own directory: provider-owned, and not a checkout. */
const HOST_DIR = "/runs/sessions/host";

/** Where this host puts the one session a chat conversation runs in. */
const SESSION_DIR = "/runs/sessions/cwd/8f2a";

/** The key this host places that session under — a chat, not a directory. */
const CHAT_SESSION_KEY = "xmd:chat:v1:acpx:scribe-cmd:default";

/** The conversation the fake adapter opens for that key, and asserts. */
const NATIVE = `agent-session:${CHAT_SESSION_KEY}`;

/**
 * One host's agent assembly, with its mapping acknowledgement under a switch.
 *
 * `place` answers `pending` every time, which is the truthful answer from a
 * host whose mapping was never acknowledged: it knows where the session lives
 * and has retained nothing about what stands there. `established` is the
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

function host(): Host {
  const harness = createFakeRuntime();
  const store = makeStore();
  const retained: AcpxSessionIdentity[] = [];
  let refusing = false;
  const sessions: AcpxSessionPolicy = {
    // deno-lint-ignore require-yield
    *place() {
      return { sessionKey: CHAT_SESSION_KEY, cwd: SESSION_DIR, state: "pending" };
    },
    // deno-lint-ignore require-yield
    *established(_placement, identity) {
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
              agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
              // deno-lint-ignore require-yield
              agentCwd: function* () {
                return HOST_DIR;
              },
              mcpServers: [],
              newSessionOptions: { allowedTools: [], systemPrompt: "none" },
              permissions: "strict",
              sessions,
            }),
            options: { defaultAgent: AGENT, permissionMode: "deny-all" },
          },
        });
      },
    },
  };
}

/** Open one conversation over this history, hand it to `body`, and close it. */
function withConversation<T>(
  stream: InMemoryStream,
  installation: ExecutionInstallation,
  body: (conversation: AgentConversation) => Operation<T>,
): Operation<Result<T>> {
  return scoped(function* () {
    const opened = yield* useAgentConversation({
      history: stream,
      id: "chat-1",
      agent: AGENT,
      installations: [installation],
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
