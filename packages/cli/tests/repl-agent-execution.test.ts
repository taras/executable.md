/**
 * The live Agent and permission session kernel (#854 L1–L4, P1–P4).
 *
 * Every row drives a real `<Prompt>` through real core execution over a real
 * `DurableStream`, with the provider installed at the seam a host installs one
 * at. Concurrency is authored — `<All>` with two `<Spawn>` children, the
 * ordinary language the prerequisite added — rather than simulated by calling
 * the kernel's own callbacks, because what these prove is that two ordinary
 * Prompt turns can be live at once and still correlate to their own records
 * exactly.
 *
 * The concurrent rows write the ordinary `<Session><Prompt /></Session>` path
 * in each `<Spawn>`, which is the shape the Story promises and the one the
 * product needs: two conversations, each with its own authentic identity, live
 * at once. Nothing here substitutes a bare `<Prompt>` for that.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  all,
  createScope,
  race,
  scoped,
  sleep,
  spawn,
  until,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Result, Stream } from "effection";
import {
  DurableContext,
  InMemoryStream,
  serializeDurableEvent,
} from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  Agent,
  agentIdentityComponents,
  Elicitation,
  installAgentComponents,
  registerComponents,
  useTempFileCompiler,
} from "@executablemd/core";
import type {
  AgentPromptEvent,
  PermissionMode,
  PermissionOption,
  PermissionOutcome,
  PermissionRequest,
  PromptOptions,
  Session,
} from "@executablemd/core";
import type { AgentProviderFactory } from "@executablemd/core";
import type { ExecutionInstallation } from "@executablemd/core/host";

import { API } from "@executablemd/runtime";

import { ordinaryEvaluationProfile } from "../src/evaluation-profile.ts";
import { REFERENCE_DIRECTORY } from "./fixtures/repl/reference.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import { useReplAgent } from "../src/repl/agent.ts";
import type { ReplAgentKernel, ReplAgentReading } from "../src/repl/agent.ts";
import { projectRepl } from "../src/repl/model.ts";
import type { ReplAgentPermission } from "../src/repl/model.ts";
import type { ReplExecution } from "../src/repl/journal.ts";

/**
 * How long a signal a correct kernel publishes immediately may go unpublished
 * before the wait is called a deadlock.
 *
 * Never reached by a passing run: every wait below is opened by the kernel, the
 * provider or the journal. It bounds only the failure mode, so a defect that
 * stops publishing says what it stopped publishing instead of hanging.
 */
const DEADLOCK_MS = 10_000;

interface Signal {
  publish(): void;
  readonly published: Operation<boolean>;
}

function signal(): Signal {
  const resolvers = withResolvers<boolean>();
  let settled = false;
  return {
    publish() {
      if (!settled) {
        settled = true;
        resolvers.resolve(true);
      }
    },
    get published() {
      return resolvers.operation;
    },
  };
}

function* awaiting(what: string, waited: Operation<boolean>): Operation<void> {
  const reached = yield* race([
    waited,
    (function* (): Operation<boolean> {
      yield* sleep(DEADLOCK_MS);
      return false;
    })(),
  ]);
  if (!reached) {
    throw new Error(`${what} never happened`);
  }
}

/** What one stubbed turn does when its gate opens. */
interface Scripted {
  readonly deltas?: readonly string[];
  readonly permission?: {
    readonly toolCallId: string;
    readonly kind?: string;
    readonly title?: string;
    readonly options?: readonly PermissionOption[];
    /** Provider-owned input nothing durable may hold, for the canary row. */
    readonly rawInput?: unknown;
  };
  /**
   * Two requests from one turn, both raised before either is answered.
   *
   * Concurrent on purpose: the order they are *answered* in is then the test's
   * to choose, which is what proves a retained audit keeps the order they
   * arrived in instead.
   */
  readonly permissions?: readonly {
    readonly toolCallId: string;
    readonly kind?: string;
    readonly title?: string;
  }[];
  /**
   * One more request, raised after this turn's first delta.
   *
   * By then a sibling turn has placed its own ledger, so a record correlated by
   * whichever ledger was placed most recently puts this audit on the wrong turn.
   */
  readonly late?: {
    readonly toolCallId: string;
    readonly kind?: string;
    readonly title?: string;
  };
  readonly status?: "completed" | "failed" | "cancelled";
  /**
   * Whether this turn waits before it produces anything: `true` for one gate
   * shared by every turn with this text, `"each"` for one gate per turn.
   */
  readonly gated?: boolean | "each";
  /**
   * Whether this turn waits *after* its terminal event and before returning the
   * stream's final value.
   *
   * The one hold that separates finishing from recording. `<Prompt>` writes its
   * record only once the stream returns, so a turn held here has produced every
   * event it ever will — it is terminal as far as anything watching can see —
   * while its sibling can still settle and append first.
   */
  readonly settle?: "each";
}

const ALL_KINDS: readonly PermissionOption[] = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Allow always", kind: "allow_always" },
  { optionId: "no", name: "Reject once", kind: "reject_once" },
  { optionId: "never", name: "Reject always", kind: "reject_always" },
];

interface Stub {
  readonly factory: AgentProviderFactory;
  /** Every prompt the provider was asked for, in the order it was asked. */
  readonly asked: string[];
  /** The live reading as it stood the instant each prompt reached the provider. */
  readonly seenWhenAsked: ReplAgentReading[];
  /** The outcome each permission request settled with, by tool call id. */
  readonly outcomes: Map<string, PermissionOutcome>;
  /** The exact event objects handed to the subscriber, by prompt text. */
  readonly produced: Map<string, AgentPromptEvent[]>;
  /** How many times a provider factory was materialized. */
  activations: number;
  /** How many times a turn's cold stream was subscribed. */
  subscriptions: number;
  /** Where to read the live reading from, at the moment the provider is asked. */
  watch(session: () => ReplAgentReading): void;
  arrival(prompt: string): Operation<void>;
  release(prompt: string): void;
  /** Wait for the turn running on this child coroutine to reach the provider. */
  reached(coroutine: string): Operation<void>;
  /** Release the turn running on this child coroutine, and only that one. */
  let_(coroutine: string): void;
  /** Wait for the turn on this child coroutine to emit its terminal event. */
  finished(coroutine: string): Operation<void>;
  /** Let the turn held after its terminal event return its final value. */
  settle(coroutine: string): void;
}

function createStub(script: Record<string, Scripted> = {}): Stub {
  const arrivals = new Map<string, Signal>();
  const releases = new Map<string, Signal>();
  const slot = (map: Map<string, Signal>, name: string): Signal => {
    const existing = map.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created = signal();
    map.set(name, created);
    return created;
  };
  let reading: (() => ReplAgentReading) | undefined;
  let issued = 0;

  const stub: Stub = {
    asked: [],
    seenWhenAsked: [],
    outcomes: new Map(),
    produced: new Map(),
    activations: 0,
    subscriptions: 0,
    watch(session) {
      reading = session;
    },
    arrival(prompt: string) {
      return awaiting(
        `<Prompt text="${prompt}"> reaching the provider`,
        slot(arrivals, prompt).published,
      );
    },
    release(prompt: string) {
      slot(releases, prompt).publish();
    },
    reached(coroutine: string) {
      return awaiting(
        `the turn on ${coroutine} reaching the provider`,
        slot(arrivals, `@${coroutine}`).published,
      );
    },
    let_(coroutine: string) {
      slot(releases, `@${coroutine}`).publish();
    },
    finished(coroutine: string) {
      return awaiting(
        `the turn on ${coroutine} reaching its terminal event`,
        slot(arrivals, `~${coroutine}`).published,
      );
    },
    settle(coroutine: string) {
      slot(releases, `!${coroutine}`).publish();
    },
    factory: function* (options) {
      stub.activations++;
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *agent([name]) {
            return name ?? options.defaultAgent ?? "stub-agent";
          },
          // deno-lint-ignore require-yield
          *session([routed]) {
            const name = typeof routed === "string" ? routed : routed?.name;
            return { sessionKey: `stub:${name ?? "default"}`, cwd: "/stub" };
          },
          // deno-lint-ignore require-yield
          *prompt([content, promptOptions]) {
            stub.asked.push(content);
            // What the session reports at the exact moment the provider is
            // asked. A kernel that published after delegating is caught here
            // rather than at the end.
            if (reading !== undefined) {
              stub.seenWhenAsked.push(reading());
            }
            issued += 1;
            return turn(
              stub,
              script,
              slot,
              arrivals,
              releases,
              options.defaultAgent ?? "stub-agent",
              content,
              promptOptions,
              issued,
            );
          },
        },
        { at: "min" },
      );
    },
  };
  return stub;
}

function turn(
  stub: Stub,
  script: Record<string, Scripted>,
  slot: (map: Map<string, Signal>, name: string) => Signal,
  arrivals: Map<string, Signal>,
  releases: Map<string, Signal>,
  defaultAgent: string,
  content: string,
  options: PromptOptions | undefined,
  issued: number,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      stub.subscriptions += 1;
      const scripted = script[content] ?? {};
      // The conversation this turn actually belongs to: the one the authored
      // `<Session>` routed, which is what makes two turns separate when
      // everything they say is identical. A prompt written outside a
      // `<Session>` falls back to one of this turn's own.
      const routed = options?.session;
      const session: Session =
        typeof routed === "object" && routed !== null && "sessionKey" in routed
          ? routed
          : { sessionKey: `stub:${issued}`, cwd: "/stub" };
      const agent = typeof options?.agent === "string" ? options.agent : defaultAgent;
      const deltas = scripted.deltas ?? ["delta"];
      const produced: AgentPromptEvent[] = [];
      stub.produced.set(content, produced);
      let stage = 0;
      let announced = false;
      // Where this turn is running. Two spawns may be written identically and
      // may reach the provider in either order, so the only stable way to name
      // one of them is the child coroutine its `<Spawn>` was given in source
      // order. Held across the whole subscription, because the hold after the
      // terminal event needs it too.
      let where = "";
      let released = false;
      let lateAsked = false;
      return {
        *next() {
          if (!announced) {
            announced = true;
            where = (yield* useScope()).get(DurableContext)?.coroutineId ?? "";
            slot(arrivals, content).publish();
            slot(arrivals, `@${where}`).publish();
            if (scripted.gated === true) {
              // Two gates, because two turns may be written identically: one
              // keyed by the text a row can name, and one by which turn this
              // is, which is the only way to release them in a chosen order.
              yield* awaiting(
                `<Prompt text="${content}"> being released`,
                slot(releases, content).published,
              );
            }
            if (scripted.gated === "each") {
              yield* awaiting(
                `the turn on ${where} being released`,
                slot(releases, `@${where}`).published,
              );
            }
            const wanted = scripted.permission;
            if (wanted !== undefined) {
              const request: PermissionRequest = {
                session,
                toolCall: {
                  toolCallId: wanted.toolCallId,
                  ...(wanted.title === undefined ? {} : { title: wanted.title }),
                  ...(wanted.kind === undefined ? {} : { kind: wanted.kind }),
                  ...(wanted.rawInput === undefined ? {} : { rawInput: wanted.rawInput }),
                },
                options: wanted.options ?? ALL_KINDS,
              };
              stub.outcomes.set(
                wanted.toolCallId,
                yield* Agent.operations.requestPermission(request),
              );
            }
            const pair = scripted.permissions;
            if (pair !== undefined) {
              // Both raised before either is answered, so the turn is holding two
              // decisions at once.
              yield* all(
                pair.map((one) =>
                  (function* (): Operation<void> {
                    const outcome = yield* Agent.operations.requestPermission({
                      session,
                      toolCall: {
                        toolCallId: one.toolCallId,
                        ...(one.title === undefined ? {} : { title: one.title }),
                        ...(one.kind === undefined ? {} : { kind: one.kind }),
                      },
                      options: ALL_KINDS,
                    });
                    stub.outcomes.set(one.toolCallId, outcome);
                  })(),
                ),
              );
            }
          }
          if (stage === 0) {
            stage = 1;
            const event: AgentPromptEvent = { type: "started", agent, session };
            produced.push(event);
            return { done: false, value: event };
          }
          if (stage <= deltas.length) {
            const event: AgentPromptEvent = { type: "text_delta", text: deltas[stage - 1]! };
            stage += 1;
            produced.push(event);
            return { done: false, value: event };
          }
          if (stage === deltas.length + 1 && scripted.late !== undefined && !lateAsked) {
            lateAsked = true;
            const one = scripted.late;
            stub.outcomes.set(
              one.toolCallId,
              yield* Agent.operations.requestPermission({
                session,
                toolCall: {
                  toolCallId: one.toolCallId,
                  ...(one.title === undefined ? {} : { title: one.title }),
                  ...(one.kind === undefined ? {} : { kind: one.kind }),
                },
                options: ALL_KINDS,
              }),
            );
          }
          if (stage === deltas.length + 1) {
            stage += 1;
            const event: AgentPromptEvent = {
              type: "terminal",
              status: scripted.status ?? "completed",
            };
            produced.push(event);
            slot(arrivals, `~${where}`).publish();
            return { done: false, value: event };
          }
          if (scripted.settle === "each" && !released) {
            released = true;
            // Finished, but not yet recorded: everything this turn will ever
            // produce has gone past, and `<Prompt>` cannot write its record
            // until this returns.
            yield* awaiting(
              `the turn on ${where} being allowed to finish`,
              slot(releases, `!${where}`).published,
            );
          }
          return { done: true, value: deltas.join("") };
        },
      };
    },
  };
}

function execution(events: readonly DurableEvent[] = []): ReplExecution {
  return { id: "agent-kernel", stream: new InMemoryStream([...events]) };
}

/**
 * An execution whose journal refuses to record an Agent turn.
 *
 * The one way a canonical publication fails after the turn has already run:
 * everything the provider was going to say has been said, the overlay is
 * terminal, and then nothing retains it.
 */
function refusingExecution(): ReplExecution {
  const stream = new InMemoryStream();
  const appended = stream.append.bind(stream);
  stream.append = function* (event: DurableEvent): Operation<void> {
    if (event.type === "yield" && event.description.type === "agent_prompt") {
      throw new Error("this journal refused the record");
    }
    yield* appended(event);
  };
  return { id: "agent-kernel", stream };
}

function installations(): readonly ExecutionInstallation[] {
  return [{ evaluation: ordinaryEvaluationProfile() }, { components: agentIdentityComponents() }];
}

function opened(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function refusal(result: Result<ReplSession>): Error {
  if (result.ok) {
    throw new Error("this session was handed back, and it must be refused");
  }
  return result.error;
}

/** Install the provider on this scope, the way a host installs one. */
function* useStub(stub: Stub): Operation<void> {
  yield* installAgentComponents({
    defaultAgent: "stub-agent",
    rootProvider: {
      factory: stub.factory,
      options: { defaultAgent: "stub-agent", permissionMode: "deny-all" },
    },
  });
}

function start(
  holder: ReplExecution,
  source: string,
  permissionMode: PermissionMode = "deny-all",
  includes?: readonly string[],
): Operation<Result<ReplSession>> {
  return submitReplEntry({
    execution: holder,
    installations: installations(),
    permissionMode,
    source,
    ...(includes === undefined ? {} : { includes }),
  });
}

/**
 * What a run actually performed, counted where the work happens.
 *
 * Outside the engine's own handlers, so what these count is the read and the
 * compilation themselves rather than the records of them: a replay that restored
 * a completed effect reads no source and compiles nothing, and that is the
 * difference between restoring and doing again.
 */
interface Performed {
  /** Component sources actually read from disk. */
  readonly reads: string[];
  /** Eval blocks actually compiled, which is where a block really runs. */
  compiles: number;
}

function* countPerformed(): Operation<Performed> {
  const performed: Performed = { reads: [], compiles: 0 };
  yield* API.Fs.around({
    *readTextFile([path], next) {
      performed.reads.push(path);
      return yield* next(path);
    },
  });
  yield* API.Env.around({
    *compile([source, options], next) {
      performed.compiles++;
      return yield* next(source, options);
    },
  });
  return performed;
}

/** One document that really reads a component and really compiles an eval block. */
const READS_AND_COMPILES = [
  "```js eval",
  'const plan = { title: "Ship the audit", steps: 2 };',
  "```",
  "",
  "<Checklist title={plan.title} steps={plan.steps} />",
  "",
  '<Prompt text="one" />',
].join("\n");

/** The exact bytes a journal holds, for a comparison that is about bytes. */
function serialized(events: readonly DurableEvent[]): string[] {
  return events.map((event) => serializeDurableEvent(event));
}

/** Wait until the live reading satisfies `holds`, or say it never did. */
function* reported(
  session: ReplSession,
  what: string,
  holds: (reading: ReplAgentReading) => boolean,
): Operation<void> {
  const readings = yield* session.agentChanges;
  if (holds(session.agent)) {
    return;
  }
  const reached = yield* race([
    (function* (): Operation<boolean> {
      let next = yield* readings.next();
      while (!next.done) {
        if (holds(next.value)) {
          return true;
        }
        next = yield* readings.next();
      }
      return false;
    })(),
    (function* (): Operation<boolean> {
      yield* sleep(DEADLOCK_MS);
      return false;
    })(),
  ]);
  if (!reached) {
    throw new Error(`the live reading never reported ${what}`);
  }
}

/**
 * Wait on the journal rather than on an announcement.
 *
 * A change signal delivers to whoever is pulling at that moment, so a state a
 * turn passes through can be missed by a subscriber that was between reads.
 * Records cannot: they only accumulate, and the append callback fires for every
 * one. Installed after the session's own observer and chained to it, so the
 * signal arrives with the session already reprojected.
 */
function watchAppends(holder: ReplExecution): (count: number) => Operation<void> {
  const inner = holder.stream.onAppend;
  const signals = new Map<number, Signal>();
  const slot = (count: number): Signal => {
    const existing = signals.get(count);
    if (existing !== undefined) {
      return existing;
    }
    const created = signal();
    signals.set(count, created);
    return created;
  };
  let seen = 0;
  holder.stream.onAppend = (event) => {
    inner?.(event);
    if (event.type === "yield" && event.description.type === "agent_prompt") {
      seen += 1;
      slot(seen).publish();
    }
  };
  return (count: number) => {
    if (seen >= count) {
      return (function* () {})();
    }
    return awaiting(`${count} agent turn(s) recorded`, slot(count).published);
  };
}

/**
 * Every permission this session's retained turns hold, turn by turn.
 *
 * Read from the projected model rather than from the ledger: what a row about a
 * durable audit is entitled to is what the Journal says, after core parsed it
 * back.
 */
function audited(session: ReplSession): readonly ReplAgentPermission[] {
  return session.model.turns.flatMap((turn) => turn.permissions);
}

/** Every appended `agent_prompt`, in journal order, with its coroutine. */
function appends(events: readonly DurableEvent[]): Array<{ name: string; coroutineId: string }> {
  return events
    .filter((event) => event.type === "yield" && event.description.type === "agent_prompt")
    .map((event) => ({
      name: event.type === "yield" ? event.description.name : "",
      coroutineId: event.coroutineId,
    }));
}

const ONE_PROMPT = '<Prompt text="one" />\n';
const TWO_SPAWNS = [
  "<All>",
  '<Spawn><Session name="planner"><Prompt text="same" /></Session></Spawn>',
  '<Spawn><Session name="reviewer"><Prompt text="same" /></Session></Spawn>',
  "</All>",
].join("\n");

describe("L1 — transparent queued/start/delta/terminal observation", () => {
  beforeAll(() => useTempFileCompiler());

  it("L1: queued before the provider is asked, then the turn's own facts", function* () {
    const stub = createStub({ one: { deltas: ["first", "second"] } });
    yield* useStub(stub);
    const holder = execution();
    const seen: ReplAgentReading[] = [];
    const session = opened(yield* start(holder, ONE_PROMPT));
    stub.watch(() => session.agent);
    yield* spawn(function* () {
      const readings = yield* session.agentChanges;
      let next = yield* readings.next();
      while (!next.done) {
        seen.push(next.value);
        next = yield* readings.next();
      }
    });
    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);

    // Queued before delegation: what the provider saw when it was asked
    // already held this turn, and held it as queued.
    expect(stub.seenWhenAsked).toHaveLength(1);
    const atDelegation = stub.seenWhenAsked[0]!;
    expect(atDelegation.turns).toHaveLength(1);
    expect(atDelegation.turns[0]!.state).toBe("queued");
    expect(atDelegation.turns[0]!.prompt).toBe("one");
    // A queued turn has no conversation to select yet.
    expect(atDelegation.turns[0]!.sessionKey).toBe(undefined);

    // One logical turn under one key, advanced by immutable replacements.
    const key = atDelegation.turns[0]!.key;
    const mine = seen.map((reading) => reading.turns[0]).filter((one) => one !== undefined);
    expect(new Set(mine.map((one) => one.key))).toEqual(new Set([key]));
    const states = mine.map((one) => one.state);
    expect(states).toContain("active");
    expect(states).toContain("terminal");
    const settled = mine.filter((one) => one.state === "terminal").at(-1)!;
    expect(settled.text).toBe("firstsecond");
    expect(settled.agent).toBe("stub-agent");
    expect(settled.sessionKey).toBe("stub:1");
    expect(settled.status).toBe("completed");

    // Deltas in order, and neither dropped.
    const texts = mine.map((one) => one.text);
    expect(texts).toContain("first");
    expect(texts).toContain("firstsecond");
    expect(texts.indexOf("first")).toBeLessThan(texts.indexOf("firstsecond"));

    // Every exposed value is detached and frozen.
    for (const reading of seen) {
      expect(Object.isFrozen(reading)).toBe(true);
      expect(Object.isFrozen(reading.turns)).toBe(true);
      for (const one of reading.turns) {
        expect(Object.isFrozen(one)).toBe(true);
      }
    }
    // `<Prompt>` is the stream's only subscriber: the observer wrapped the
    // cold stream rather than consuming it and handing on a second turn.
    expect(stub.subscriptions).toBe(1);
    // The provider's own event objects reached `<Prompt>` in order, unchanged
    // and unfrozen, and its final value is what the document rendered.
    const produced = stub.produced.get("one")!;
    expect(produced.map((event) => event.type)).toEqual([
      "started",
      "text_delta",
      "text_delta",
      "terminal",
    ]);
    for (const event of produced) {
      expect(Object.isFrozen(event)).toBe(false);
    }
    expect(session.overlay.output).toContain("firstsecond");
  });
});

describe("L2 — exact atomic live-to-durable replacement", () => {
  beforeAll(() => useTempFileCompiler());

  it("L2: identical concurrent turns replace their own overlays, in reverse order", function* () {
    const stub = createStub({ same: { deltas: ["reply"], gated: "each" } });
    yield* useStub(stub);
    const holder = execution();
    const snapshots: Array<{ live: number; durable: number }> = [];
    const session = opened(yield* start(holder, TWO_SPAWNS));
    stub.watch(() => session.agent);
    const recorded = watchAppends(holder);

    // Every announced snapshot, so "no duplicate and no disappearance" is
    // checked against all of them rather than against the end state.
    yield* spawn(function* () {
      const readings = yield* session.agentChanges;
      let next = yield* readings.next();
      while (!next.done) {
        snapshots.push({ live: next.value.turns.length, durable: session.model.turns.length });
        next = yield* readings.next();
      }
    });

    yield* spawn(function* () {
      // Both ordinary Prompt paths reach the provider before either is let go.
      yield* stub.reached("root.0");
      yield* stub.reached("root.1");
      yield* reported(session, "both turns live", (reading) => reading.turns.length === 2);
      const keys = session.agent.turns.map((one) => one.key);
      expect(new Set(keys).size).toBe(2);
      expect(session.agent.turns.map((one) => one.prompt)).toEqual(["same", "same"]);
      // The second spawn is released first, so its record appends first.
      stub.let_("root.1");
      yield* recorded(1);
      // Only its own overlay went. Which one survived is named by what it is
      // rather than by where it sat: the other spawn is still held before its
      // first event, so it is the one that has reached no conversation.
      expect(session.agent.turns).toHaveLength(1);
      const survivor = session.agent.turns[0]!;
      expect(keys).toContain(survivor.key);
      expect(survivor.state).toBe("queued");
      expect(survivor.sessionKey).toBe(undefined);
      // And the record that replaced the other one describes the turn that
      // actually ran, not this one.
      expect(session.model.turns).toHaveLength(1);
      expect(session.model.turns[0]!.sessionKey).not.toBe(survivor.sessionKey);
      stub.let_("root.0");
    });

    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);

    const written = appends(yield* holder.stream.readAll());
    expect(written).toHaveLength(2);
    // Completion order in the journal: the second spawn's child coroutine
    // appended first, and the document still holds both turns.
    expect(written.map((entry) => entry.coroutineId)).toEqual(["root.1", "root.0"]);
    expect(session.model.turns).toHaveLength(2);
    expect(session.agent.turns).toHaveLength(0);
    // Distinct conversations, identical text: nothing correlated by content.
    // The two conversations the authored `<Session>` elements named, each
    // carrying its own retained turn although the text is identical.
    expect(new Set(session.model.turns.map((one) => one.sessionKey))).toEqual(
      new Set(["stub:planner", "stub:reviewer"]),
    );
    expect(new Set(session.model.turns.map((one) => one.text))).toEqual(new Set(["reply"]));

    // No announced snapshot held one turn twice or neither time: from the
    // moment both were live, live plus durable is exactly two.
    const from = snapshots.findIndex((one) => one.live === 2);
    expect(from).toBeGreaterThanOrEqual(0);
    for (const snapshot of snapshots.slice(from)) {
      expect(snapshot.live + snapshot.durable).toBe(2);
    }
  });

  it("L2: the turn that finished first is not the turn the first record replaced", function* () {
    // The one arrangement in which finishing and recording come apart. Both
    // turns produce every event they ever will, so both are terminal to
    // anything watching; only then is one of them allowed to return and write
    // its record. A view that matched a record to "the turn that finished
    // first" would replace the wrong overlay here, and nowhere else.
    const stub = createStub({ same: { deltas: ["reply"], gated: "each", settle: "each" } });
    yield* useStub(stub);
    const holder = execution();
    const session = opened(yield* start(holder, TWO_SPAWNS));
    stub.watch(() => session.agent);
    const recorded = watchAppends(holder);

    yield* spawn(function* () {
      // Both live before either streams anything.
      yield* stub.reached("root.0");
      yield* stub.reached("root.1");
      // Then one at a time, so which turn finishes first is decided by this
      // row rather than by scheduling: the first spawn reaches its terminal
      // event and is held there, and only then does the second start.
      stub.let_("root.0");
      yield* stub.finished("root.0");
      stub.let_("root.1");
      yield* stub.finished("root.1");
      yield* reported(
        session,
        "both turns terminal",
        (reading) => reading.turns.filter((one) => one.state === "terminal").length === 2,
      );
      expect(session.model.turns).toHaveLength(0);

      // The second spawn finishes second and records first.
      stub.settle("root.1");
      yield* recorded(1);
      // The record replaced its own overlay and no other: the turn still live
      // is the one that reached terminal *first*, and the durable turn is the
      // one that got there second.
      expect(session.agent.turns.map((one) => one.sessionKey)).toEqual(["stub:planner"]);
      expect(session.agent.turns.map((one) => one.state)).toEqual(["terminal"]);
      expect(session.model.turns.map((one) => one.sessionKey)).toEqual(["stub:reviewer"]);

      stub.settle("root.0");
    });

    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);
    // And the second record replaced only the turn that was left.
    expect(session.agent.turns).toEqual([]);
    // Both conversations retained, each exactly once. Compared as a set: a
    // retained turn is ordered by its Prompt sequence, and two concurrent
    // children allocate that sequence in whichever order they reach it — so
    // source order is what the *rendering* preserves, not what this list does.
    expect(new Set(session.model.turns.map((one) => one.sessionKey))).toEqual(
      new Set(["stub:planner", "stub:reviewer"]),
    );
    expect(session.model.turns).toHaveLength(2);
    expect(appends(yield* holder.stream.readAll()).map((entry) => entry.coroutineId)).toEqual([
      "root.1",
      "root.0",
    ]);
  });

  it("L2: a replayed turn consumes its record without creating a live overlay", function* () {
    const golden = execution();
    yield* scoped(function* () {
      const stub = createStub({ one: { deltas: ["reply"] } });
      yield* useStub(stub);
      const session = opened(yield* start(golden, ONE_PROMPT));
      yield* session.join();
      expect(stub.asked).toHaveLength(1);
    });

    yield* scoped(function* () {
      const stub = createStub({ one: { deltas: ["reply"] } });
      yield* useStub(stub);
      const replayed = opened(
        yield* openReplSession({
          execution: execution(yield* golden.stream.readAll()),
          installations: installations(),
        }),
      );
      yield* replayed.join();
      // Restored rather than re-run: the provider was never asked, and the
      // retained turn produced no reading of its own.
      expect(stub.asked).toEqual([]);
      expect(replayed.agent.turns).toEqual([]);
      expect(replayed.model.turns).toHaveLength(1);
    });
  });
});

describe("L3 — execution owns live work, presentation does not", () => {
  beforeAll(() => useTempFileCompiler());

  it("L3: a document with no Agent work publishes nothing and materializes nothing", function* () {
    const stub = createStub();
    yield* useStub(stub);
    const session = opened(yield* start(execution(), "just text\n"));
    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);
    // The provider was never asked for anything, so no adapter was ever
    // materialized: installing the factory only installs middleware.
    expect(stub.asked).toEqual([]);
    expect(session.agent.turns).toEqual([]);
    expect(session.agent.requests).toEqual([]);
  });

  it("L3: a turn completes and publishes with nobody subscribed to changes", function* () {
    const stub = createStub({ one: { deltas: ["reply"] } });
    yield* useStub(stub);
    // Nothing subscribes to `agentChanges` anywhere in this row.
    const session = opened(yield* start(execution(), ONE_PROMPT));
    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);
    expect(session.model.turns).toHaveLength(1);
    expect(session.agent.turns).toEqual([]);
  });

  it("L3: cancelling the session owner cancels and joins a held turn", function* () {
    const holder = execution();
    const stub = createStub({ one: { gated: true } });
    const [owner, dispose] = createScope(yield* useScope());
    const held = withResolvers<ReplSession>();
    owner.run(function* () {
      yield* useStub(stub);
      held.resolve(opened(yield* start(holder, ONE_PROMPT)));
      yield* sleep(DEADLOCK_MS);
    });
    const session = yield* held.operation;
    yield* stub.arrival("one");
    yield* reported(session, "a live turn", (reading) => reading.turns.length === 1);

    yield* until(dispose());

    // Nothing the provider had not finished was recorded, and releasing it
    // afterwards moves nothing: the work is gone with its owner.
    expect(appends(yield* holder.stream.readAll())).toEqual([]);
    stub.release("one");
    expect(appends(yield* holder.stream.readAll())).toEqual([]);
  });

  it("L3: a divergence before admission returns no session and leaves nothing alive", function* () {
    const golden = execution();
    yield* scoped(function* () {
      const stub = createStub({ one: { deltas: ["reply"] } });
      yield* useStub(stub);
      yield* opened(yield* start(golden, ONE_PROMPT)).join();
    });

    yield* scoped(function* () {
      const stub = createStub({ one: { deltas: ["reply"] } });
      yield* useStub(stub);
      const events = yield* golden.stream.readAll();
      // The very first recorded effect names something this document does not
      // do, so replay meets the divergence before it has run any new work —
      // and therefore before a queued turn, a question or an append could have
      // admitted the session.
      const [first, ...rest] = events;
      const doctored =
        first !== undefined && first.type === "yield"
          ? [{ ...first, description: { ...first.description, name: "__elsewhere__" } }, ...rest]
          : events;
      const refused = refusal(
        yield* openReplSession({
          execution: execution(doctored),
          installations: installations(),
        }),
      );
      expect(refused).toBeInstanceOf(Error);
      // Refused before the provider was reached.
      expect(stub.asked).toEqual([]);
    });
  });
});

describe("L4 — an admitted session failure terminates its owner", () => {
  beforeAll(() => useTempFileCompiler());

  it("L4: a post-admission correlation failure withdraws authority and join returns it", function* () {
    const stub = createStub({
      one: { permission: { toolCallId: "call-1", kind: "execute" }, deltas: ["reply"] },
    });
    yield* useStub(stub);
    const holder = execution();
    const session = opened(yield* start(holder, ONE_PROMPT, "approve-reads"));
    // Admitted on a real queued turn and held at an interactive request.
    yield* reported(session, "a pending request", (reading) => reading.requests.length === 1);
    expect(session.live).toBe(true);
    const pending = session.agent.requests[0]!;

    // An `agent_prompt` on a coroutine this session never observed a turn
    // on. Correlation cannot be exact, and the session is already admitted,
    // so there is nothing left to refuse atomically.
    yield* holder.stream.append({
      type: "yield",
      coroutineId: "root.7",
      description: { type: "agent_prompt", name: "prompt:elsewhere#0" },
      result: {
        status: "ok",
        value: { sequence: 9, agent: "x", sessionKey: "y", status: "completed", text: "" },
      },
    });

    const outcome = yield* session.join();
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.name).toBe("ReplAgentCorrelationError");
    // The held request and its authority are gone, and a late choice cannot
    // replace the first failure.
    expect(session.agent.requests).toEqual([]);
    expect(session.permissions.choose(pending.key, "once")).toBe(false);
    expect(stub.outcomes.has("call-1")).toBe(false);
  });
});

describe("P1 — exact policy and per-turn suspension", () => {
  beforeAll(() => useTempFileCompiler());

  const cases: Array<{
    readonly title: string;
    readonly mode: PermissionMode;
    readonly kind: string;
    readonly options: readonly PermissionOption[];
    readonly expected: PermissionOutcome;
  }> = [
    {
      title: "approve-all selects allow_once first",
      mode: "approve-all",
      kind: "execute",
      options: ALL_KINDS,
      expected: { outcome: "selected", optionId: "once" },
    },
    {
      title: "approve-all falls back to allow_always",
      mode: "approve-all",
      kind: "execute",
      options: [ALL_KINDS[1]!, ALL_KINDS[2]!],
      expected: { outcome: "selected", optionId: "always" },
    },
    {
      title: "approve-all denies when neither allow kind is offered",
      mode: "approve-all",
      kind: "execute",
      options: [ALL_KINDS[2]!],
      expected: { outcome: "selected", optionId: "no" },
    },
    {
      title: "deny-all selects reject_once first",
      mode: "deny-all",
      kind: "read",
      options: ALL_KINDS,
      expected: { outcome: "selected", optionId: "no" },
    },
    {
      title: "deny-all falls back to reject_always",
      mode: "deny-all",
      kind: "read",
      options: [ALL_KINDS[0]!, ALL_KINDS[3]!],
      expected: { outcome: "selected", optionId: "never" },
    },
    {
      title: "deny-all cancels when no rejection is offered",
      mode: "deny-all",
      kind: "read",
      options: [ALL_KINDS[0]!],
      expected: { outcome: "cancelled" },
    },
    {
      title: "approve-reads approves a read",
      mode: "approve-reads",
      kind: "read",
      options: ALL_KINDS,
      expected: { outcome: "selected", optionId: "once" },
    },
    {
      title: "approve-reads approves a search with allow_always",
      mode: "approve-reads",
      kind: "search",
      options: [ALL_KINDS[1]!],
      expected: { outcome: "selected", optionId: "always" },
    },
    {
      title: "approve-reads denies a read with no allow kind",
      mode: "approve-reads",
      kind: "read",
      options: [ALL_KINDS[3]!],
      expected: { outcome: "selected", optionId: "never" },
    },
  ];

  for (const decided of cases) {
    it(`P1: ${decided.title}`, function* () {
      const stub = createStub({
        one: {
          permission: { toolCallId: "call-1", kind: decided.kind, options: decided.options },
        },
      });
      yield* useStub(stub);
      const session = opened(yield* start(execution(), ONE_PROMPT, decided.mode));
      const outcome = yield* session.join();
      expect(outcome.ok).toBe(true);
      expect(stub.outcomes.get("call-1")).toEqual(decided.expected);
      // An automatic decision publishes no pending request, and asks nobody.
      expect(session.agent.requests).toEqual([]);
    });
  }

  it("P1: one held request does not suspend its sibling spawn", function* () {
    const stub = createStub({
      blocked: { permission: { toolCallId: "call-1", kind: "execute" }, deltas: ["held"] },
      continue: { deltas: ["free"] },
    });
    yield* useStub(stub);
    const holder = execution();
    const session = opened(
      yield* start(
        holder,
        [
          "<All>",
          '<Spawn><Session name="permission"><Prompt text="blocked" /></Session></Spawn>',
          '<Spawn><Session name="other"><Prompt text="continue" /></Session></Spawn>',
          "</All>",
        ].join("\n"),
        "approve-reads",
      ),
    );
    const recorded = watchAppends(holder);

    yield* spawn(function* () {
      yield* reported(session, "a pending request", (reading) => reading.requests.length === 1);
      const pending = session.agent.requests[0]!;
      // The request identifies only its own turn.
      const owner = session.agent.turns.find((one) => one.key === pending.turn);
      expect(owner?.prompt).toBe("blocked");
      expect(pending.toolCallId).toBe("call-1");
      // While it waits, the sibling starts, streams, settles and appends
      // durably — one held request does not suspend the whole `<All>`.
      yield* recorded(1);
      expect(session.model.turns.map((one) => one.input)).toEqual(["continue"]);
      expect(session.agent.requests).toHaveLength(1);
      // Answering releases only its own turn.
      expect(session.permissions.choose(pending.key, "once")).toBe(true);
    });

    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);
    expect(stub.outcomes.get("call-1")).toEqual({ outcome: "selected", optionId: "once" });
    expect(appends(yield* holder.stream.readAll())).toHaveLength(2);
    expect(session.agent.requests).toEqual([]);
  });
});

describe("P2 — one live request, one direct settlement", () => {
  beforeAll(() => useTempFileCompiler());

  it("P2: an unknown option and a stale key settle nothing; the offered one settles once", function* () {
    const stub = createStub({
      one: { permission: { toolCallId: "call-1", kind: "execute" }, deltas: ["reply"] },
    });
    yield* useStub(stub);
    const session = opened(yield* start(execution(), ONE_PROMPT, "approve-reads"));
    yield* spawn(function* () {
      yield* reported(session, "a pending request", (reading) => reading.requests.length === 1);
      const pending = session.agent.requests[0]!;
      // Never an option the provider did not offer, and never a key this
      // process did not issue.
      expect(session.permissions.choose(pending.key, "invented")).toBe(false);
      expect(session.permissions.choose("request-999", "once")).toBe(false);
      expect(session.agent.requests).toHaveLength(1);
      expect(session.permissions.choose(pending.key, "always")).toBe(true);
      // Already settled: the same key acts on nothing a second time.
      expect(session.permissions.choose(pending.key, "once")).toBe(false);
      expect(session.permissions.dismiss(pending.key)).toBe(false);
    });
    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);
    expect(stub.outcomes.get("call-1")).toEqual({ outcome: "selected", optionId: "always" });
    // And the turn that asked retains exactly that decision, once: the outcome
    // the REPL's own authority returned, copied into the place the request
    // reserved on its way in.
    expect(audited(session)).toEqual([
      {
        toolCallId: "call-1",
        kind: "execute",
        options: ALL_KINDS,
        outcome: "selected",
        selected: "always",
      },
    ]);
  });

  it("P2: dismissal while live denies once and the turn resumes", function* () {
    const stub = createStub({
      one: { permission: { toolCallId: "call-1", kind: "execute" }, deltas: ["resumed"] },
    });
    yield* useStub(stub);
    const session = opened(yield* start(execution(), ONE_PROMPT, "approve-reads"));
    yield* spawn(function* () {
      yield* reported(session, "a pending request", (reading) => reading.requests.length === 1);
      expect(session.permissions.dismiss(session.agent.requests[0]!.key)).toBe(true);
    });
    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);
    // The established denial rule, and the turn carried on with it.
    expect(stub.outcomes.get("call-1")).toEqual({ outcome: "selected", optionId: "no" });
    expect(session.agent.requests).toEqual([]);
    expect(session.model.turns).toHaveLength(1);
    expect(session.model.turns[0]!.text).toBe("resumed");
    // Retained once, as the denial it was — not as a cancellation, and not twice.
    expect(audited(session)).toEqual([
      {
        toolCallId: "call-1",
        kind: "execute",
        options: ALL_KINDS,
        outcome: "selected",
        selected: "no",
      },
    ]);
  });

  it("P2: a cold retained audit has no pending reading and no authority", function* () {
    const AUDIT = [
      {
        toolCallId: "call-1",
        kind: "read",
        options: ALL_KINDS,
        outcome: "selected",
        selected: "once",
      },
    ];
    const golden = execution();
    let written: string[] = [];
    yield* scoped(function* () {
      const stub = createStub({
        one: { permission: { toolCallId: "call-1", kind: "read" }, deltas: ["reply"] },
      });
      yield* useStub(stub);
      // Counted where the work happens: this run really reads a component's
      // source and really compiles an eval block, so "nothing again" has
      // something to be measured against.
      const performed = yield* countPerformed();
      const live = opened(
        yield* start(golden, READS_AND_COMPILES, "approve-reads", [REFERENCE_DIRECTORY]),
      );
      yield* live.join();
      expect(stub.outcomes.has("call-1")).toBe(true);
      // The policy answered this one itself, and the record says exactly what it
      // answered: the safe fields and the outcome, and nothing of the request.
      expect(audited(live)).toEqual(AUDIT);
      expect(
        performed.reads.filter((path) => path.endsWith("Checklist.md")).length,
      ).toBeGreaterThan(0);
      expect(performed.compiles).toBeGreaterThan(0);
      written = serialized(yield* golden.stream.readAll());
    });

    yield* scoped(function* () {
      const stub = createStub();
      yield* useStub(stub);
      const performed = yield* countPerformed();
      // The cold process's own execution, held so the bytes it ends with can be
      // compared with the bytes the live run left.
      const cold = execution(yield* golden.stream.readAll());
      const reopened = opened(
        yield* openReplSession({
          execution: cold,
          includes: [REFERENCE_DIRECTORY],
          installations: installations(),
        }),
      );
      yield* reopened.join();
      // The same audit, read from the history rather than observed again.
      expect(audited(reopened)).toEqual(AUDIT);
      // The audit is retained model data; replay recreates no wait from it.
      expect(reopened.agent.requests).toEqual([]);
      expect(reopened.permissions.choose("request-1", "once")).toBe(false);
      expect(stub.asked).toEqual([]);
      // Nothing was performed again: the component's source was not read and the
      // eval block was not compiled, which is what "restored" has to mean.
      expect(performed.reads.filter((path) => path.endsWith("Checklist.md"))).toEqual([]);
      expect(performed.compiles).toBe(0);
      // And reconstructing wrote nothing: this execution ends with the exact
      // bytes the live run left, event for event.
      expect(serialized(yield* cold.stream.readAll())).toEqual(written);
    });
  });
});

describe("P3 — whole-session teardown is structured cancellation", () => {
  beforeAll(() => useTempFileCompiler());

  it("P3: teardown cancels and joins the held request without claiming a denial", function* () {
    const holder = execution();
    const stub = createStub({
      one: { permission: { toolCallId: "call-1", kind: "execute" }, deltas: ["reply"] },
    });
    const [owner, dispose] = createScope(yield* useScope());
    const held = withResolvers<ReplSession>();
    owner.run(function* () {
      yield* useStub(stub);
      held.resolve(opened(yield* start(holder, ONE_PROMPT, "approve-reads")));
      yield* sleep(DEADLOCK_MS);
    });
    const session = yield* held.operation;
    yield* reported(session, "a pending request", (reading) => reading.requests.length === 1);
    const pending = session.agent.requests[0]!;

    yield* until(dispose());

    // Absence only. The permission operation was cancelled with its owner, so
    // nothing here asserts that it observed a denial or any other outcome.
    expect(session.agent.requests).toEqual([]);
    expect(stub.outcomes.has("call-1")).toBe(false);
    expect(appends(yield* holder.stream.readAll())).toEqual([]);
    // A late choice acts on nothing, and settles nothing afterwards either.
    expect(session.permissions.choose(pending.key, "once")).toBe(false);
    expect(stub.outcomes.has("call-1")).toBe(false);
    // And no audit was published for a decision nobody made: the place the
    // request reserved was never completed, so nothing names an outcome.
    expect(session.model.turns).toEqual([]);
    expect(audited(session)).toEqual([]);
  });

  it("P3: releasing the owning scope retires the agent owner and wakes nobody", function* () {
    const holder = execution();
    const stub = createStub({
      one: { permission: { toolCallId: "call-1", kind: "execute" }, deltas: ["reply"] },
    });
    const [owner, dispose] = createScope(yield* useScope());
    const held = withResolvers<ReplSession>();
    owner.run(function* () {
      yield* useStub(stub);
      held.resolve(opened(yield* start(holder, ONE_PROMPT, "approve-reads")));
      yield* sleep(DEADLOCK_MS);
    });
    const session = yield* held.operation;
    yield* reported(session, "a pending request", (reading) => reading.requests.length === 1);
    const pending = session.agent.requests[0]!;

    yield* until(dispose());
    yield* sleep(0);

    // The owner is retired: nothing it was presenting is presented any more.
    expect(session.agent.turns).toEqual([]);
    expect(session.agent.requests).toEqual([]);
    // Retiring answered nothing. The held request was abandoned with its
    // scope, not decided on the way out.
    expect(stub.outcomes.has("call-1")).toBe(false);
    expect(session.permissions.choose(pending.key, "once")).toBe(false);
    expect(stub.outcomes.has("call-1")).toBe(false);
    // Nothing durable was written by any of it.
    expect(appends(yield* holder.stream.readAll())).toEqual([]);
  });

  it("P3: retiring the owner wakes nobody who was waiting on its failure", function* () {
    // The owner acquired directly, so what is under test is the resource's own
    // lifetime rather than a session's use of it.
    const [owner, dispose] = createScope(yield* useScope());
    const held = withResolvers<ReplAgentKernel>();
    owner.run(function* () {
      held.resolve(yield* useReplAgent("deny-all"));
      yield* sleep(DEADLOCK_MS);
    });
    const kernel = yield* held.operation;

    // Waiting from outside the scope that is about to go away, so this task
    // outlives the disposal and can say whether anything woke it.
    let woken = false;
    yield* spawn(function* () {
      yield* kernel.failed;
      woken = true;
    });
    yield* sleep(0);

    yield* until(dispose());
    yield* sleep(0);

    // Released, not failed: there was no failure, so the waiter is left
    // exactly as it was rather than told about one.
    expect(woken).toBe(false);
    expect(kernel.reading.turns).toEqual([]);
    expect(kernel.reading.requests).toEqual([]);
  });
});

describe("P4 — a request without one live owner fails the session", () => {
  beforeAll(() => useTempFileCompiler());

  it("P4: an unowned request publishes nothing, denies nothing and fails the session", function* () {
    const stub = createStub();
    yield* useStub(stub);
    const answered: PermissionOutcome[] = [];
    const raised: string[] = [];
    // An authored component, outside any live Prompt, reaching the public
    // operation exactly as a provider would.
    yield* registerComponents([
      {
        name: "AskOutside",
        origin: "tier-854",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          try {
            answered.push(
              yield* Agent.operations.requestPermission({
                session: { sessionKey: "stub:none", cwd: "/stub" },
                toolCall: { toolCallId: "orphan", kind: "execute" },
                options: ALL_KINDS,
              }),
            );
          } catch (error) {
            // Swallowed and carried on, the way an ordinary `<Prompt>` turns a
            // provider failure into its own durable result and continues. If
            // the failure reached only this operation, the session would still
            // be live — which is exactly what it may not be.
            raised.push(error instanceof Error ? error.name : String(error));
          }
          return "continued";
        },
      },
    ]);
    const holder = execution();
    const session = opened(yield* start(holder, "<AskOutside />\n", "approve-reads"));
    // Bounded, because the failure mode of not failing the session is that it
    // waits forever on a request nobody can answer. A correct kernel never
    // reaches the deadline.
    const outcome = yield* race([
      session.join(),
      (function* (): Operation<Result<unknown>> {
        yield* sleep(DEADLOCK_MS);
        throw new Error(
          "the session never ended: an unowned request was published, denied, or left waiting",
        );
      })(),
    ]);

    // The document did not fail on its own — the component carried on — and
    // the session failed anyway, because the owner was told too.
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.name).toBe("ReplPermissionOwnerError");
    // Reported to the permission operation as well as to the session owner.
    expect(raised).toEqual(["ReplPermissionOwnerError"]);
    // Never published, and never converted into a denial.
    expect(session.agent.requests).toEqual([]);
    expect(answered).toEqual([]);
    // No invented audit: the journal holds only what actually happened.
    expect(appends(yield* holder.stream.readAll())).toEqual([]);
  });
});

/** Two spawned turns, each asking its own question. */
const TWO_ASKS = [
  "<All>",
  '<Spawn><Session name="planner"><Prompt text="first" /></Session></Spawn>',
  '<Spawn><Session name="reviewer"><Prompt text="second" /></Session></Spawn>',
  "</All>",
].join("\n");

describe("P5 — the durable audit of a live REPL turn", () => {
  beforeAll(() => useTempFileCompiler());

  it("P5: two live turns settle in reverse order, and each record holds only its own", function* () {
    const stub = createStub({
      first: { permission: { toolCallId: "call-first", kind: "execute" }, deltas: ["a"] },
      second: { permission: { toolCallId: "call-second", kind: "execute" }, deltas: ["b"] },
    });
    yield* useStub(stub);
    const holder = execution();
    const session = opened(yield* start(holder, TWO_ASKS, "approve-reads"));
    yield* spawn(function* () {
      // Both waiting at once, which is what makes ownership a question at all.
      yield* reported(session, "two pending requests", (reading) => reading.requests.length === 2);
      const asked = session.agent.requests;
      const first = asked.find((request) => request.toolCallId === "call-first");
      const second = asked.find((request) => request.toolCallId === "call-second");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      // Different turns, so neither decision could belong to the other.
      expect(first?.turn).not.toBe(second?.turn);
      // Answered in the opposite order to the one they arrived in.
      expect(session.permissions.choose(second?.key ?? "", "always")).toBe(true);
      expect(session.permissions.choose(first?.key ?? "", "once")).toBe(true);
    });
    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);

    // One audit each, and each on the turn that asked it: nothing correlated by
    // which turn was newest or which decision settled first.
    const turns = session.model.turns;
    expect(turns).toHaveLength(2);
    const asking = (text: string): readonly ReplAgentPermission[] =>
      turns.find((turn) => turn.input === text)?.permissions ?? [];
    expect(asking("first").map((one) => one.toolCallId)).toEqual(["call-first"]);
    expect(asking("second").map((one) => one.toolCallId)).toEqual(["call-second"]);
    expect(asking("first")[0]?.selected).toBe("once");
    expect(asking("second")[0]?.selected).toBe("always");
  });

  it("P5: a later request from an earlier turn is still that turn's", function* () {
    const stub = createStub({
      first: {
        // Held until its sibling has asked, so the sibling's ledger is the most
        // recently placed one when this turn finally asks anything at all.
        gated: "each",
        permission: { toolCallId: "call-first", kind: "execute" },
        // And asked again once it is running, with the sibling still waiting.
        late: { toolCallId: "call-later", kind: "execute" },
        deltas: ["a"],
      },
      second: { permission: { toolCallId: "call-second", kind: "execute" }, deltas: ["b"] },
    });
    yield* useStub(stub);
    const session = opened(yield* start(execution(), TWO_ASKS, "approve-reads"));
    yield* spawn(function* () {
      yield* reported(session, "the sibling's request", (reading) =>
        reading.requests.some((request) => request.toolCallId === "call-second"),
      );
      stub.let_("root.0");
      yield* reported(session, "two pending requests", (reading) => reading.requests.length === 2);
      const held = (id: string): string =>
        session.agent.requests.find((request) => request.toolCallId === id)?.key ?? "";
      // The first turn is released and asks again while the second still waits.
      expect(session.permissions.choose(held("call-first"), "once")).toBe(true);
      yield* reported(session, "the later request", (reading) =>
        reading.requests.some((request) => request.toolCallId === "call-later"),
      );
      expect(session.permissions.choose(held("call-later"), "always")).toBe(true);
      expect(session.permissions.choose(held("call-second"), "no")).toBe(true);
    });
    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);
    const asking = (text: string): string[] =>
      session.model.turns
        .find((turn) => turn.input === text)
        ?.permissions.map((one) => one.toolCallId) ?? [];
    // Both of the first turn's requests are the first turn's, including the one
    // it asked after its sibling had placed a ledger of its own.
    expect(asking("first")).toEqual(["call-first", "call-later"]);
    expect(asking("second")).toEqual(["call-second"]);
  });

  it("P5: two requests from one turn keep the order they were asked, not the order they settled", function* () {
    const stub = createStub({
      one: {
        permissions: [
          { toolCallId: "call-a", title: "Asked first", kind: "execute" },
          { toolCallId: "call-b", title: "Asked second", kind: "execute" },
        ],
        deltas: ["reply"],
      },
    });
    yield* useStub(stub);
    const session = opened(yield* start(execution(), ONE_PROMPT, "approve-reads"));
    yield* spawn(function* () {
      yield* reported(session, "two pending requests", (reading) => reading.requests.length === 2);
      const asked = session.agent.requests;
      const a = asked.find((request) => request.toolCallId === "call-a");
      const b = asked.find((request) => request.toolCallId === "call-b");
      // One turn, both places already reserved, and the second one answered
      // first — which is exactly what a record sorted by completion would show
      // the wrong way round.
      expect(a?.turn).toBe(b?.turn);
      expect(session.permissions.choose(b?.key ?? "", "always")).toBe(true);
      expect(session.permissions.choose(a?.key ?? "", "once")).toBe(true);
    });
    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);
    expect(audited(session).map((one) => one.toolCallId)).toEqual(["call-a", "call-b"]);
    expect(audited(session).map((one) => one.selected)).toEqual(["once", "always"]);
  });

  it("P5: provider-owned input reaches neither the journal nor the model", function* () {
    const canary = "canary-9f3b7c1e-only-in-rawInput";
    const stub = createStub({
      one: {
        // A read, so the policy answers it without anybody being asked — and the
        // request carries something no record may ever hold.
        permission: {
          toolCallId: "call-1",
          kind: "read",
          title: "Read a file",
          rawInput: { path: "/etc/passwd", secret: canary },
        },
        deltas: ["reply"],
      },
    });
    yield* useStub(stub);
    const holder = execution();
    const session = opened(yield* start(holder, ONE_PROMPT, "approve-reads"));
    const outcome = yield* session.join();
    expect(outcome.ok).toBe(true);
    // The decision was made and retained.
    expect(audited(session)).toHaveLength(1);
    // And what the provider owned stayed the provider's: not in the bytes, not
    // in the model, not under any name.
    const written = yield* holder.stream.readAll();
    expect(written.map((event) => serializeDurableEvent(event)).join("\n")).not.toContain(canary);
    expect(JSON.stringify(session.model)).not.toContain(canary);
    expect(Object.keys(audited(session)[0] ?? {}).sort()).toEqual([
      "kind",
      "options",
      "outcome",
      "selected",
      "title",
      "toolCallId",
    ]);
  });
});

describe("P6 — only a canonical Prompt claims a record", () => {
  beforeAll(() => useTempFileCompiler());

  it("P6: a direct public prompt neither claims the canonical record nor lingers", function* () {
    const stub = createStub({
      direct: { deltas: ["off-books"] },
      one: { deltas: ["reply"] },
    });
    yield* useStub(stub);
    // A registered component reaching the public operation itself. This is
    // ordinary — the Api is exported — and it is not journal-owned work: no
    // `agent_prompt` record will ever describe it.
    yield* registerComponents([
      {
        name: "DirectPrompt",
        origin: "tier-854",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          const stream = yield* Agent.operations.prompt("direct", {});
          const subscription = yield* stream;
          let next = yield* subscription.next();
          while (!next.done) {
            next = yield* subscription.next();
          }
          return "direct";
        },
      },
    ]);
    const holder = execution();
    // Both on the root coroutine, the direct call first: a queue drained on
    // append would hand the canonical record the direct call's entry.
    const session = opened(yield* start(holder, '<DirectPrompt />\n\n<Prompt text="one" />\n'));
    const outcome = yield* session.join();

    expect(outcome.ok).toBe(true);
    // The provider answered both, so the direct call really did happen.
    expect(stub.asked).toEqual(["direct", "one"]);
    // Exactly one record, and it is the canonical Prompt's.
    expect(session.model.turns).toHaveLength(1);
    expect(session.model.turns[0]?.text).toBe("reply");
    // Nothing live is left over: the canonical publication removed its own
    // turn, and the direct call never had one to leave behind.
    expect(session.agent.turns).toEqual([]);
    expect(session.live).toBe(false);
  });

  it("P6: concurrent spawns with a direct call each retire only their own turn", function* () {
    // Two canonical turns running at once, one of them on a coroutine that
    // also made a direct public call. Reversed *completion* is held by the L2
    // and P5 rows above, which run the same mechanism; what this adds is a
    // direct call in the middle of concurrent work.
    const stub = createStub({
      direct: { deltas: ["off-books"] },
      same: { deltas: ["reply"] },
    });
    yield* useStub(stub);
    yield* registerComponents([
      {
        name: "DirectPrompt",
        origin: "tier-854",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          const stream = yield* Agent.operations.prompt("direct", {});
          const subscription = yield* stream;
          let next = yield* subscription.next();
          while (!next.done) {
            next = yield* subscription.next();
          }
          return "direct";
        },
      },
    ]);
    const holder = execution();
    const source = [
      "<All>",
      '<Spawn><Session name="planner"><DirectPrompt /><Prompt text="same" /></Session></Spawn>',
      '<Spawn><Session name="reviewer"><Prompt text="same" /></Session></Spawn>',
      "</All>",
    ].join("\n");
    const session = opened(yield* start(holder, source));
    const outcome = yield* session.join();

    expect(outcome.ok).toBe(true);
    // The direct call really happened, beside both canonical turns.
    expect(stub.asked.filter((asked) => asked === "direct")).toHaveLength(1);
    expect(stub.asked.filter((asked) => asked === "same")).toHaveLength(2);
    // Two canonical records, and the direct call is in neither.
    expect(session.model.turns).toHaveLength(2);
    expect(session.model.turns.map((turn) => turn.text)).toEqual(["reply", "reply"]);
    // Every live turn retired, including on the coroutine that also made a
    // direct call — which had no live turn to leave behind.
    expect(session.agent.turns).toEqual([]);
  });

  it("P6: a refused publication leaves the turn neither retained nor mounted", function* () {
    const stub = createStub({ one: { deltas: ["reply"] } });
    yield* useStub(stub);
    const holder = refusingExecution();
    const session = opened(yield* start(holder, ONE_PROMPT));
    const outcome = yield* session.join();

    // The provider really ran and really finished, so the overlay was
    // terminal at the moment publication was refused.
    expect(stub.asked).toEqual(["one"]);
    // Nothing retained it.
    expect(outcome.ok).toBe(false);
    expect(session.model.turns).toEqual([]);
    // And nothing is still mounted waiting for a record that will never come.
    expect(session.agent.turns).toEqual([]);
    expect(session.live).toBe(false);
  });

  const endings: readonly ("failed" | "cancelled")[] = ["failed", "cancelled"];
  for (const ended of endings) {
    it(`P6: a ${ended} canonical Prompt hands off exactly as a completed one does`, function* () {
      // `association` is absent for every unsuccessful turn, so this is the
      // case where nothing but the handle can say which live turn ended.
      const stub = createStub({ one: { deltas: ["partial"], status: ended } });
      yield* useStub(stub);
      const holder = execution();
      const session = opened(yield* start(holder, ONE_PROMPT));
      const outcome = yield* session.join();

      // Whether an unsuccessful turn also fails the document is the Prompt
      // failure policy's business and not this row's. What this row holds is
      // the handoff: the record was appended, and the live turn it began is
      // gone — with no `association` to identify it by, only the handle.
      expect(outcome).toBeDefined();
      expect(session.model.turns).toHaveLength(1);
      expect(session.model.turns[0]?.status).toBe(ended);
      expect(session.agent.turns).toEqual([]);
    });
  }
});

/** One prompt in a named conversation, which is what makes two entries share one. */
function onePromptIn(text: string): string {
  return `<Session name="planner"><Prompt text="${text}" /></Session>\n`;
}

/** Two prompts in that conversation, which one entry records as sequence 0 and 1. */
function twoPromptsIn(first: string, second: string): string {
  return [
    `<Session name="planner"><Prompt text="${first}" /></Session>`,
    `<Session name="planner"><Prompt text="${second}" /></Session>`,
    "",
  ].join("\n");
}

function admitted(result: Result<void>): void {
  if (!result.ok) {
    throw result.error;
  }
}

/**
 * The same journal with its last recorded prompt claiming an earlier sequence.
 *
 * Doctored, because no run writes it: a sequence counts the Prompts of one
 * execution, so one entry holding a value twice is damage to the file rather than
 * anything a second entry could cause.
 */
function resequenced(events: readonly DurableEvent[], sequence: number): DurableEvent[] {
  const last = events.reduce(
    (at, event, index) =>
      event.type === "yield" && event.description.type === "agent_prompt" ? index : at,
    -1,
  );
  if (last === -1) {
    throw new Error("this journal records no agent prompt");
  }
  return events.map((event, index) => {
    if (index !== last || event.type !== "yield" || event.result.status !== "ok") {
      return event;
    }
    const held = event.result.value;
    if (held === null || typeof held !== "object" || Array.isArray(held)) {
      throw new Error("a recorded prompt retains a record");
    }
    const doctored: DurableEvent = {
      ...event,
      result: { status: "ok", value: { ...held, sequence } },
    };
    return doctored;
  });
}

describe("EA1 — one chronology of entries, each counting its own Prompts", () => {
  beforeAll(() => useTempFileCompiler());

  it("EA1: two entries each retain sequence 0, ordered by entry and then sequence", function* () {
    const holder = execution();
    const stub = createStub();
    yield* scoped(function* () {
      yield* useStub(stub);
      const session = opened(yield* start(holder, twoPromptsIn("one", "two")));
      yield* session.join();
      admitted(yield* session.submit(twoPromptsIn("three", "four")));
      yield* session.join();

      expect(session.model.turns.map((turn) => [turn.entry, turn.sequence, turn.input])).toEqual([
        ["entry-1", 0, "one"],
        ["entry-1", 1, "two"],
        ["entry-2", 0, "three"],
        ["entry-2", 1, "four"],
      ]);
      // Each entry counts its own Prompts from zero, so one global sort by
      // sequence would interleave the two entries instead of following them.
      expect(
        session.model.entries.map((entry) => entry.turns.map((turn) => turn.sequence)),
      ).toEqual([
        [0, 1],
        [0, 1],
      ]);
    });
  });

  it("EA1: two prompts in one entry claiming one sequence refuse the whole projection", function* () {
    const holder = execution();
    const stub = createStub();
    yield* scoped(function* () {
      yield* useStub(stub);
      const session = opened(yield* start(holder, twoPromptsIn("one", "two")));
      yield* session.join();
      expect(session.model.turns.map((turn) => turn.sequence)).toEqual([0, 1]);
    });

    const result = projectRepl(resequenced(yield* holder.stream.readAll(), 0));
    expect(result.ok).toBe(false);
    // Atomically: there is no value to read at all, rather than a model holding
    // whichever turns happened to be unambiguous.
    expect(Object.hasOwn(result, "value")).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("claim sequence 0");
  });

  it("EA1: a live turn carries the entry that began it, and keeps it on publication", function* () {
    const holder = execution();
    const stub = createStub({ one: { gated: true }, two: { gated: true } });
    yield* scoped(function* () {
      yield* useStub(stub);
      const session = opened(yield* start(holder, onePromptIn("one")));
      const recorded = watchAppends(holder);
      yield* stub.arrival("one");

      // Live, before anything retains it: the turn names the entry whose
      // execution began it.
      expect(session.agent.turns.map((turn) => [turn.entry, turn.prompt])).toEqual([
        ["entry-1", "one"],
      ]);
      stub.release("one");
      yield* recorded(1);
      yield* session.join();

      // Published: the slot keeps its place and its entry, and so does the facts
      // it published with.
      expect(session.agent.slots.map((slot) => [slot.entry, slot.order])).toEqual([["entry-1", 1]]);
      expect(session.agent.slots[0]?.last?.entry).toBe("entry-1");

      admitted(yield* session.submit(onePromptIn("two")));
      yield* stub.arrival("two");

      // The entry that is running now is entry-2, and the first entry's slot
      // still says entry-1: which entry a turn belongs to is not which entry is
      // current.
      expect(session.agent.slots.map((slot) => [slot.entry, slot.order])).toEqual([
        ["entry-1", 1],
        ["entry-2", 2],
      ]);
      expect(session.agent.turns.map((turn) => [turn.entry, turn.prompt])).toEqual([
        ["entry-2", "two"],
      ]);

      stub.release("two");
      yield* recorded(2);
      yield* session.join();

      // And each record that replaced a live turn belongs to the entry that turn
      // did, at the position it held.
      expect(session.model.turns.map((turn) => [turn.entry, turn.sequence, turn.input])).toEqual([
        ["entry-1", 0, "one"],
        ["entry-2", 0, "two"],
      ]);
      expect(session.agent.slots.map((slot) => [slot.entry, slot.order])).toEqual([
        ["entry-1", 1],
        ["entry-2", 2],
      ]);
    });
  });

  it("EA1: one conversation spans two entries, and naming an entry does not narrow it", function* () {
    const holder = execution();
    const stub = createStub();
    yield* scoped(function* () {
      yield* useStub(stub);
      const session = opened(yield* start(holder, onePromptIn("one")));
      yield* session.join();
      admitted(yield* session.submit(onePromptIn("two")));
      yield* session.join();

      // One conversation, because the provider named one key across both
      // entries — and the key is the only thing the grouping reads.
      expect(session.model.sessions.map((one) => one.sessionKey)).toEqual(["stub:planner"]);
      expect(session.model.sessions[0].turns.map((turn) => [turn.entry, turn.sequence])).toEqual([
        ["entry-1", 0],
        ["entry-2", 0],
      ]);
      // Each entry identifies its own turn, and the execution-wide chronology
      // still holds both: reading one entry does not make the conversation a
      // reading of that entry.
      expect(session.model.entries.map((entry) => entry.turns.map((turn) => turn.entry))).toEqual([
        ["entry-1"],
        ["entry-2"],
      ]);
      expect(session.model.turns).toHaveLength(2);
      expect(session.model.sessions[0].turns).toHaveLength(2);
    });
  });
});

/** The schema an entry's stopping `<Elicit>` is asked with. */
const EMPTY_SCHEMA =
  'const schema = { type: "object", additionalProperties: false, properties: {} };';

/**
 * One entry whose held Prompt is cancelled by a sibling that fails.
 *
 * The ordinary shape of the hazard: concurrent children, one waiting on a
 * provider, and one that takes the whole entry down. The held Prompt is cancelled
 * where it stands, so it is never handed to a publication and no record is ever
 * written for it.
 */
const HELD_AND_STOPPED = [
  "```js eval",
  EMPTY_SCHEMA,
  "```",
  "",
  "<All>",
  '<Spawn><Session name="planner"><Prompt text="held" /></Session></Spawn>',
  '<Spawn><Elicit schema={schema} as="stop">Stop?</Elicit></Spawn>',
  "</All>",
  "",
].join("\n");

/**
 * One entry whose Prompt is waiting on a person when its sibling fails.
 *
 * The permission half of the same hazard: an interactive request is a live wait
 * this process owns, keyed to a live turn, and an entry that ends while one is
 * held leaves both behind unless its own scope takes them down.
 */
const ASKS_AND_STOPPED = [
  "```js eval",
  EMPTY_SCHEMA,
  "```",
  "",
  "<All>",
  '<Spawn><Session name="planner"><Prompt text="asks" /></Session></Spawn>',
  '<Spawn><Elicit schema={schema} as="stop">Stop?</Elicit></Spawn>',
  "</All>",
  "",
].join("\n");

/**
 * One entry asking for permission on the coroutine the entry before it used.
 *
 * The asking Prompt is the first `<Spawn>`, so it runs on `root.0` — the same
 * coroutine id the cancelled turn ran on, because coroutine ids restart with
 * every entry. An owner lookup that still saw the old turn there would find two
 * candidates for this request and fail the session rather than present it. The
 * second child asks nothing and exists because `<All>` runs at least two.
 */
const ASKS_ALONE = [
  "<All>",
  '<Spawn><Session name="planner"><Prompt text="next" /></Session></Spawn>',
  '<Spawn><Session name="planner"><Prompt text="quiet" /></Session></Spawn>',
  "</All>",
  "",
].join("\n");

/** The same entry, with one more child whose Prompt records before the failure. */
const PUBLISHED_HELD_AND_STOPPED = [
  "```js eval",
  EMPTY_SCHEMA,
  "```",
  "",
  "<All>",
  '<Spawn><Session name="planner"><Prompt text="done" /></Session></Spawn>',
  '<Spawn><Session name="planner"><Prompt text="held" /></Session></Spawn>',
  '<Spawn><Elicit schema={schema} as="stop">Stop?</Elicit></Spawn>',
  "</All>",
  "",
].join("\n");

/**
 * An Elicitation provider that fails its entry when the row says so.
 *
 * Installed at the ordinary position, outside the session's own provider at
 * `min`, so it decides before any question is published. Raising here fails the
 * `<Elicit>`, which fails the `<Spawn>` holding it and the `<All>` around it —
 * the ordinary way one child takes an entry down, with its siblings cancelled
 * where they stand.
 */
function* useStopping(stop: Signal): Operation<void> {
  yield* Elicitation.around({
    *elicit() {
      yield* awaiting("the row stopping this entry", stop.published);
      throw new Error("the sibling stopped this entry");
    },
  });
}

describe("EL2 — an entry's live Agent state is retired with its execution", () => {
  beforeAll(() => useTempFileCompiler());

  it("EL2: a cancelled turn is retired with its entry, and the next entry runs clean", function* () {
    const holder = execution();
    const stub = createStub({ held: { gated: true }, two: { gated: true } });
    const stop = signal();
    yield* scoped(function* () {
      yield* useStub(stub);
      yield* useStopping(stop);
      const session = opened(yield* start(holder, HELD_AND_STOPPED));
      const recorded = watchAppends(holder);

      // The Prompt is at the provider and held there, so this entry really does
      // own a live turn at the moment its sibling fails.
      yield* stub.arrival("held");
      expect(session.agent.turns.map((turn) => [turn.entry, turn.prompt])).toEqual([
        ["entry-1", "held"],
      ]);
      expect(session.agent.slots.map((slot) => [slot.entry, slot.durable])).toEqual([
        ["entry-1", undefined],
      ]);

      stop.publish();
      expect((yield* session.join()).ok).toBe(false);

      // The entry settled `err` and its task joined, and nothing of it is still
      // mounted: the turn never became a record, so nothing else would have taken
      // it down.
      expect(session.model.entries[0]?.terminal?.status).toBe("err");
      expect(session.model.entries[0]?.settled).toBe(true);
      expect(session.agent.turns).toEqual([]);
      expect(session.agent.slots).toEqual([]);
      // And it appended nothing on the way out: the journal holds no turn at all.
      expect(session.model.turns).toEqual([]);
      expect(appends(yield* holder.stream.readAll())).toEqual([]);

      admitted(yield* session.submit(onePromptIn("two")));
      yield* stub.arrival("two");
      // While the successor is live the reading holds its turn and only its turn.
      expect(session.agent.turns.map((turn) => [turn.entry, turn.prompt])).toEqual([
        ["entry-2", "two"],
      ]);
      expect(session.agent.slots.map((slot) => [slot.entry, slot.durable])).toEqual([
        ["entry-2", undefined],
      ]);

      stub.release("two");
      yield* recorded(1);
      yield* session.join();

      // And after publication the model and the durable slot identify only the
      // successor's turn: no correlation state of the entry before it claimed the
      // record.
      expect(session.model.turns.map((turn) => [turn.entry, turn.input])).toEqual([
        ["entry-2", "two"],
      ]);
      const [only] = session.agent.slots;
      expect(session.agent.slots).toHaveLength(1);
      expect(only.entry).toBe("entry-2");
      expect(only.durable).toBe(session.model.turns[0]?.name);
      expect(only.last?.entry).toBe("entry-2");
    });
  });

  it("EL2: cleanup keeps a published slot and removes only the unpublished one", function* () {
    const holder = execution();
    const stub = createStub({
      done: { gated: true },
      held: { gated: true },
      after: { gated: true },
    });
    const stop = signal();
    yield* scoped(function* () {
      yield* useStub(stub);
      yield* useStopping(stop);
      const session = opened(yield* start(holder, PUBLISHED_HELD_AND_STOPPED));
      const recorded = watchAppends(holder);

      // Both turns reach the provider before either is let go, so which of them
      // publishes is this row's to decide rather than the scheduler's.
      yield* stub.arrival("done");
      yield* stub.arrival("held");
      expect(session.agent.slots).toHaveLength(2);
      expect(session.agent.slots.every((slot) => slot.durable === undefined)).toBe(true);

      // One finishes and is recorded; the other is still waiting on its provider.
      stub.release("done");
      yield* recorded(1);
      stop.publish();
      expect((yield* session.join()).ok).toBe(false);
      expect(session.model.entries[0]?.terminal?.status).toBe("err");

      // The published turn keeps its slot and goes on resolving from its own
      // record; the one that never published is gone. A row a person was reading
      // that really happened does not disappear because its entry ended.
      expect(session.agent.turns).toEqual([]);
      expect(session.agent.slots).toHaveLength(1);
      const [kept] = session.agent.slots;
      expect(kept.entry).toBe("entry-1");
      expect(kept.durable).toBe(session.model.turns[0]?.name);
      expect(kept.last?.prompt).toBe("done");
      expect(session.model.turns.map((turn) => [turn.entry, turn.input])).toEqual([
        ["entry-1", "done"],
      ]);
      // Exactly one record was ever appended, and teardown added none.
      expect(appends(yield* holder.stream.readAll())).toHaveLength(1);

      // And the transfer is what makes it the session's rather than the entry's:
      // the slot is still there, in its own place and under its own entry key,
      // while a later entry is running and taking places of its own.
      admitted(yield* session.submit(onePromptIn("after")));
      yield* stub.arrival("after");
      const [first, second] = session.agent.slots;
      expect(session.agent.slots).toHaveLength(2);
      expect([first.entry, first.order, first.durable !== undefined]).toEqual([
        "entry-1",
        kept.order,
        true,
      ]);
      // A place is session-wide, so the successor takes the one after both of the
      // Prompts the entry before it observed — the published slot does not shuffle
      // down to make room.
      expect([second.entry, second.durable]).toEqual(["entry-2", undefined]);
      expect(second.order).toBe(3);
      expect(second.order).toBeGreaterThan(first.order);
      expect(session.agent.turns.map((turn) => [turn.entry, turn.prompt])).toEqual([
        ["entry-2", "after"],
      ]);

      stub.release("after");
      yield* recorded(2);
      yield* session.join();
      // Both records stand, each under the entry that wrote it.
      expect(session.model.turns.map((turn) => [turn.entry, turn.input])).toEqual([
        ["entry-1", "done"],
        ["entry-2", "after"],
      ]);
      expect(session.agent.slots.map((slot) => [slot.entry, slot.order])).toEqual([
        ["entry-1", kept.order],
        ["entry-2", 3],
      ]);
    });
  });

  it("EL2: a request held by a cancelled entry crosses nothing into its successor", function* () {
    const holder = execution();
    const stub = createStub({
      asks: { permission: { toolCallId: "entry-one", kind: "write", title: "Write once?" } },
      next: { permission: { toolCallId: "entry-two", kind: "write", title: "Write again?" } },
    });
    const stop = signal();
    yield* scoped(function* () {
      // `approve-reads`, because it is the one mode that leaves a non-read
      // decision to a person: the other two answer every request themselves, and
      // nothing would ever be held.
      yield* useStub(stub);
      yield* useStopping(stop);
      const session = opened(yield* start(holder, ASKS_AND_STOPPED, "approve-reads"));
      const recorded = watchAppends(holder);

      // A real interactive request, really waiting, and exposed before anything
      // fails — which is what makes its absence afterwards a fact about cleanup.
      yield* reported(
        session,
        "the first entry's request",
        (reading) => reading.requests.length === 1,
      );
      const [waiting] = session.agent.requests;
      expect(waiting.toolCallId).toBe("entry-one");
      const asking = session.agent.turns.find((turn) => turn.key === waiting.turn);
      expect(asking?.entry).toBe("entry-1");
      const staleRequest = waiting.key;
      const staleOption = waiting.choices.find((choice) => choice.kind === "allow_once")?.optionId;
      expect(staleOption).toBe("once");

      stop.publish();
      expect((yield* session.join()).ok).toBe(false);
      expect(session.model.entries[0]?.terminal?.status).toBe("err");

      // Nothing of the entry is left: no turn, no request, no provisional slot,
      // and no record — so no audit either. Named by the identities that really
      // existed a moment ago as well as by emptiness, because the wait above is
      // what makes these absences facts about cleanup rather than about a
      // fixture that never asked anything.
      expect(session.agent.requests.some((request) => request.key === staleRequest)).toBe(false);
      expect(session.agent.turns.some((turn) => turn.key === waiting.turn)).toBe(false);
      expect(session.agent.turns).toEqual([]);
      expect(session.agent.requests).toEqual([]);
      expect(session.agent.slots).toEqual([]);
      expect(session.model.turns).toEqual([]);
      expect(appends(yield* holder.stream.readAll())).toEqual([]);
      // And the provider was never answered. Teardown abandoned the wait instead
      // of resolving it, so there is no selection, no denial and no cancelled
      // outcome anywhere — the decision nobody made was not made.
      expect(stub.outcomes.has("entry-one")).toBe(false);
      // The key that really did name that request settles nothing now, either way.
      expect(session.permissions.choose(staleRequest, staleOption ?? "")).toBe(false);
      expect(session.permissions.dismiss(staleRequest)).toBe(false);
      expect(stub.outcomes.has("entry-one")).toBe(false);

      // The successor asks on the coroutine the cancelled turn ran on. The
      // journal says so: that coroutine closed under the entry before this one.
      const closed = (yield* holder.stream.readAll()).filter(
        (event) => event.type === "close" && event.coroutineId === "root.0",
      );
      expect(closed).toHaveLength(1);

      admitted(yield* session.submit(ASKS_ALONE));
      yield* reported(
        session,
        "the second entry's request",
        (reading) => reading.requests.length === 1,
      );
      const [now] = session.agent.requests;
      expect(now.toolCallId).toBe("entry-two");
      expect(now.key).not.toBe(staleRequest);
      // Only the successor's request is exposed, and nothing the reading holds
      // belongs to the entry before it — neither a turn nor the slot one sat in.
      // Asserted as "all of them are the successor's" rather than by counting,
      // because the sibling that asks nothing may already have published.
      expect(session.agent.requests).toHaveLength(1);
      expect(session.agent.turns.find((turn) => turn.key === now.turn)?.prompt).toBe("next");
      expect(session.agent.turns.filter((turn) => turn.entry !== "entry-2")).toEqual([]);
      expect(session.agent.slots.filter((slot) => slot.entry !== "entry-2")).toEqual([]);
      expect(session.agent.slots.length).toBeGreaterThan(0);
      // And the successor's request found exactly one owner. A turn left behind
      // on this coroutine would have made two candidates of it, and the session
      // would have been withdrawn instead of presenting anything.
      expect(session.agent.requests.filter((request) => request.turn === now.turn)).toHaveLength(1);

      // Settled once, through the authority, and only this one.
      const option = now.choices.find((choice) => choice.kind === "allow_once")?.optionId ?? "";
      expect(session.permissions.choose(now.key, option)).toBe(true);
      expect(session.permissions.choose(now.key, option)).toBe(false);

      yield* recorded(2);
      yield* session.join();

      // Only the successor's turns are published, and the audit is on the one
      // that asked — recorded at a position naming the coroutine the cancelled
      // turn had used.
      expect(session.model.turns.map((turn) => turn.entry)).toEqual(["entry-2", "entry-2"]);
      const asked = session.model.turns.find((turn) => turn.input === "next");
      expect(asked?.marker).toContain(":root.0:");
      expect(asked?.permissions.map((audit) => audit.toolCallId)).toEqual(["entry-two"]);
      expect(asked?.permissions.map((audit) => audit.selected)).toEqual([option]);
      expect(session.model.turns.find((turn) => turn.input === "quiet")?.permissions).toEqual([]);
      expect(stub.outcomes.get("entry-two")).toEqual({ outcome: "selected", optionId: option });
      expect(stub.outcomes.has("entry-one")).toBe(false);
    });
  });
});
