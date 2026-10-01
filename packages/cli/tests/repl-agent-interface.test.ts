/**
 * Presenting Agent work in the REPL (#854 U1, U2, U3).
 *
 * Every row drives one real `ReplSession` over a real Journal, with a real
 * Freedom tree mounted from the real descriptions. What is under test is what a
 * person can see and reach: the order turns appear in while some are live and
 * some are recorded, what a conversation filter changes, who owns a pending
 * permission request, and which nodes a frame mounts at each accepted size.
 *
 * The document is the Story's own shape — one `<All>` with `<Spawn>` children
 * each holding an ordinary `<Session><Prompt /></Session>` — because concurrent
 * turns are the whole difficulty. Nothing here substitutes a shaped object for a
 * session, a screenshot for a frame, or a bare `<Prompt>` for a conversation.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  race,
  scoped,
  sleep,
  spawn,
  until as untilResolved,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Result, Stream } from "effection";
import { DurableContext, InMemoryStream } from "@executablemd/durable-streams";
import {
  Agent,
  agentIdentityComponents,
  installAgentComponents,
  useTempFileCompiler,
} from "@executablemd/core";
import type {
  AgentPromptEvent,
  AgentProviderFactory,
  PermissionMode,
  PermissionOption,
  PermissionOutcome,
  PermissionRequest,
  PromptOptions,
  Session,
} from "@executablemd/core";
import type { ExecutionInstallation } from "@executablemd/core/host";

import { ordinaryEvaluationProfile } from "../src/evaluation-profile.ts";
import { agentReferenceEvents } from "./fixtures/repl/reference.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplExecution } from "../src/repl/journal.ts";
import { projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import {
  describeApplication,
  focusClaim,
  focusSettled,
  initialState,
  permissionSettled,
  reduceRepl,
  replSurface,
  viewFor,
} from "../src/repl/application.ts";
import type {
  ReplAction,
  ReplIntent,
  ReplLive,
  ReplState,
  ReplView,
} from "../src/repl/application.ts";
import { layout, NARROW, surfaceWidth } from "../src/repl/layout.ts";
import type { ReplPlacedCell, ReplSemanticFrame } from "../src/repl/layout.ts";
import { decodeLocation, encodeLocation } from "../src/repl/route.ts";
import { installReplHost } from "../src/repl-assembly.ts";
import { installReplTerminal } from "../src/repl/terminal-host.ts";
import type { ReplTerminalCapabilities } from "../src/repl/terminal-host.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { ReplClock } from "../src/repl/frame.ts";
import { runReplProgram } from "../src/repl/program.ts";
import type { ReplExecutionProfile } from "../src/repl-profile.ts";
import type { ReplOutcome } from "../src/repl/program.ts";
import { appendFile, mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fields, readDescription } from "../src/repl/description.ts";
import type { ReplDescription } from "../src/repl/description.ts";
import { snapshotRender, useReplRenderer } from "../src/repl/renderer.ts";
import type { ReplRenderer } from "../src/repl/renderer.ts";
import { useReplTree } from "../src/repl/reconcile.ts";
import type { ReplTree } from "../src/repl/reconcile.ts";

/** The widest accepted frame, stated here because layout keeps it private. */
const WIDE = { columns: 160, rows: 36 };

/** The Story's shape: three spawned children, each its own conversation. */
const THREE_SPAWNS = [
  "<All>",
  '<Spawn><Session name="reviewer"><Prompt text="review" /></Session></Spawn>',
  '<Spawn><Session name="builder"><Prompt text="build" /></Session></Spawn>',
  '<Spawn><Session name="checker"><Prompt text="check" /></Session></Spawn>',
  "</All>",
].join("\n");

/** The child coroutine each `<Spawn>` runs on, in source order. */
const REVIEWER = "root.0";
const BUILDER = "root.1";
const CHECKER = "root.2";

/** Two conversations named after the suffixes a turn's own facts are keyed with. */
const SPAWNS_NAMED_LIKE_FACTS = [
  "<All>",
  '<Spawn><Session name="text"><Prompt text="review" /></Session></Spawn>',
  '<Spawn><Session name="stop"><Prompt text="build" /></Session></Spawn>',
  "</All>",
].join("\n");

/** More choices than the smallest accepted drawer can place at once. */
const SEVEN_CHOICES: readonly PermissionOption[] = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Allow for this session", kind: "allow_always" },
  { optionId: "conversation", name: "Allow for this conversation", kind: "allow_always" },
  { optionId: "reads", name: "Allow reads only", kind: "allow_once" },
  { optionId: "no", name: "Deny once", kind: "reject_once" },
  { optionId: "never", name: "Deny for this session", kind: "reject_always" },
  { optionId: "halt", name: "Deny and stop", kind: "reject_always" },
];

/** Options named after a turn's own read-only facts. */
const NAMED_LIKE_FACTS: readonly PermissionOption[] = [
  { optionId: "text", name: "Allow the write", kind: "allow_once" },
  { optionId: "stop", name: "Stop here", kind: "reject_once" },
  { optionId: "failed", name: "Report it failed", kind: "reject_once" },
  { optionId: "whose", name: "Ask whose this is", kind: "allow_once" },
];

/** The permission drawer's own read-only rows, which are never targets. */
const drawerContentKeys = [
  "drawer:permission:kind",
  "drawer:permission:call",
  "drawer:permission:turn",
  "drawer:permission:dismissal",
];

/** Every option kind a provider can offer, for the permission rows. */
const ALL_KINDS: readonly PermissionOption[] = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Allow for this session", kind: "allow_always" },
  { optionId: "no", name: "Deny once", kind: "reject_once" },
  { optionId: "never", name: "Deny for this session", kind: "reject_always" },
];

/**
 * How long a step a correct engine completes immediately may go uncompleted
 * before the wait is called a deadlock.
 *
 * Never reached by a passing run: every step below is completed by the turn it
 * names. It bounds only the failure mode, so a defect that stops one turn says
 * which step it stopped at instead of hanging the suite.
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
    published: resolvers.operation,
  };
}

function awaiting(what: string, reached: Operation<boolean>): Operation<void> {
  return (function* () {
    const arrived = yield* race([
      reached,
      (function* (): Operation<boolean> {
        yield* sleep(DEADLOCK_MS);
        return false;
      })(),
    ]);
    if (!arrived) {
      throw new Error(`${what} never happened`);
    }
  })();
}

/** What one turn does, and where it waits while doing it. */
interface Script {
  /** Hold before producing anything, which is a turn that stays queued. */
  readonly queued?: true;
  /** Hold after the first delta, which is a turn that stays streaming. */
  readonly streaming?: true;
  /**
   * Hold after the terminal event and before returning the stream's value.
   *
   * The one hold that separates finishing from recording: everything this turn
   * will ever produce has gone past, so it is terminal as far as anything
   * watching can see, while a sibling can still settle and append first.
   */
  readonly unrecorded?: true;
  /** Ask for one permission before producing anything. */
  readonly permission?: {
    readonly toolCallId: string;
    readonly title?: string;
    readonly kind?: string;
    readonly options?: readonly PermissionOption[];
  };
  readonly status?: "completed" | "failed" | "cancelled";
}

/** The provider these rows drive, and the gates that hold its turns. */
interface Stub {
  readonly factory: AgentProviderFactory;
  /** The outcome each permission request settled with, by tool call id. */
  readonly outcomes: Map<string, PermissionOutcome>;
  /** How many times each request was answered, by tool call id. */
  readonly answers: Map<string, number>;
  /** Wait for the turn on this child coroutine to reach the provider. */
  reached(coroutine: string): Operation<void>;
  /** Wait for the turn on this child coroutine to emit its terminal event. */
  finished(coroutine: string): Operation<void>;
  /** Let the turn on this child coroutine start. */
  start(coroutine: string): void;
  /** Let the turn on this child coroutine produce the rest of its deltas. */
  stream(coroutine: string): void;
  /** Let the turn on this child coroutine return, which records it. */
  record(coroutine: string): void;
}

function createStub(script: Record<string, Script> = {}): Stub {
  const signals = new Map<string, Signal>();
  const slot = (name: string): Signal => {
    const existing = signals.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created = signal();
    signals.set(name, created);
    return created;
  };

  const stub: Stub = {
    outcomes: new Map(),
    answers: new Map(),
    reached(coroutine) {
      return awaiting(
        `the turn on ${coroutine} reaching the provider`,
        slot(`@${coroutine}`).published,
      );
    },
    finished(coroutine) {
      return awaiting(
        `the turn on ${coroutine} reaching its terminal event`,
        slot(`~${coroutine}`).published,
      );
    },
    start(coroutine) {
      slot(`>${coroutine}`).publish();
    },
    stream(coroutine) {
      slot(`#${coroutine}`).publish();
    },
    record(coroutine) {
      slot(`!${coroutine}`).publish();
    },
    factory: function* (options) {
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
            return one(
              stub,
              script[content] ?? {},
              slot,
              content,
              promptOptions,
              options.defaultAgent,
            );
          },
        },
        { at: "min" },
      );
    },
  };
  return stub;
}

/** One turn's cold stream, held at whichever gates its script asks for. */
function one(
  stub: Stub,
  script: Script,
  slot: (name: string) => Signal,
  content: string,
  options: PromptOptions | undefined,
  defaultAgent: string | undefined,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      const routed = options?.session;
      const session: Session =
        typeof routed === "object" && routed !== null && "sessionKey" in routed
          ? routed
          : { sessionKey: "stub:default", cwd: "/stub" };
      const agent =
        typeof options?.agent === "string" ? options.agent : (defaultAgent ?? "stub-agent");
      let stage = 0;
      let announced = false;
      let asked = false;
      // Which turn this is. Two spawns may be written identically and may reach
      // the provider in either order, so the child coroutine its `<Spawn>` was
      // given in source order is the only stable way to name one.
      let where = "";
      let held = false;
      return {
        *next() {
          if (!announced) {
            announced = true;
            where = (yield* useScope()).get(DurableContext)?.coroutineId ?? "";
            slot(`@${where}`).publish();
            if (script.queued === true) {
              yield* awaiting(`the turn on ${where} being started`, slot(`>${where}`).published);
            }
          }
          if (stage === 0) {
            stage = 1;
            return { done: false, value: { type: "started", agent, session } };
          }
          if (!asked) {
            asked = true;
            // Asked after `started`, which is when a provider knows which
            // conversation it is in — so the request belongs to a turn that can
            // say whose it is.
            const wanted = script.permission;
            if (wanted !== undefined) {
              const request: PermissionRequest = {
                session,
                toolCall: {
                  toolCallId: wanted.toolCallId,
                  ...(wanted.title === undefined ? {} : { title: wanted.title }),
                  ...(wanted.kind === undefined ? {} : { kind: wanted.kind }),
                },
                options: wanted.options ?? ALL_KINDS,
              };
              const outcome = yield* Agent.operations.requestPermission(request);
              stub.outcomes.set(wanted.toolCallId, outcome);
              stub.answers.set(wanted.toolCallId, (stub.answers.get(wanted.toolCallId) ?? 0) + 1);
            }
          }
          if (stage === 1) {
            stage = 2;
            return { done: false, value: { type: "text_delta", text: `${content} ` } };
          }
          if (stage === 2) {
            stage = 3;
            if (script.streaming === true) {
              yield* awaiting(
                `the turn on ${where} being allowed to finish streaming`,
                slot(`#${where}`).published,
              );
            }
            return { done: false, value: { type: "text_delta", text: "done" } };
          }
          if (stage === 3) {
            stage = 4;
            slot(`~${where}`).publish();
            return {
              done: false,
              value: { type: "terminal", status: script.status ?? "completed" },
            };
          }
          if (script.unrecorded === true && !held) {
            held = true;
            yield* awaiting(
              `the turn on ${where} being allowed to record`,
              slot(`!${where}`).published,
            );
          }
          return { done: true, value: `${content} done` };
        },
      };
    },
  };
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

/**
 * The profile these rows' program runs under.
 *
 * `approve-reads` is the mode that leaves a non-read decision to a person, which
 * is the only way a request reaches this screen at all.
 */
const PROFILE: ReplExecutionProfile = {
  includes: [],
  installations: [
    { evaluation: ordinaryEvaluationProfile() },
    { components: agentIdentityComponents() },
  ],
  permissionMode: "approve-reads",
};

function installations(): readonly ExecutionInstallation[] {
  return [{ evaluation: ordinaryEvaluationProfile() }, { components: agentIdentityComponents() }];
}

function execution(): ReplExecution {
  return { id: "agent-interface", stream: new InMemoryStream([]) };
}

/** The session, or the refusal that means there is nothing to drive. */
function granted(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** This process's overlay, exactly as the program reads it into a view. */
function liveReading(session: ReplSession): ReplLive {
  return {
    output: session.overlay.output,
    question: session.overlay.question,
    expansion: session.expansion.state,
    pausable: session.controller !== undefined,
    agent: session.agent,
  };
}

/** The view this state reads as, or the failure that stopped it. */
function reading(
  state: ReplState,
  session: ReplSession,
  size = WIDE,
  focused?: string,
  model: ReplModel = session.model,
): ReplView {
  const resolved = viewFor(state, model, liveReading(session), size, focused);
  if (!resolved.ok) {
    throw resolved.error;
  }
  return resolved.value;
}

/** This journal, projected at the position a frozen route names. */
function* projectedAt(holder: ReplExecution, marker: string): Operation<ReplModel> {
  const projected = projectRepl(yield* holder.stream.readAll(), marker);
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

/** Every described row, flattened, with its key and label. */
function rowsOf(descriptions: readonly ReplDescription<ReplAction>[]): Array<{
  key: string;
  label: string;
}> {
  const found: Array<{ key: string; label: string }> = [];
  const walk = (description: ReplDescription<ReplAction>): void => {
    const read = readDescription(description);
    const named = fields(read.input);
    const label = named?.["label"] ?? named?.["text"] ?? "";
    found.push({ key: read.key, label: typeof label === "string" ? label : "" });
    for (const child of read.children ?? []) {
      walk(child);
    }
  };
  for (const description of descriptions) {
    walk(description);
  }
  return found;
}

/** The keys this state describes, in order. */
function keysOf(view: ReplView): string[] {
  return rowsOf(describeApplication(view)).map((one) => one.key);
}

/** Commit one view into the real tree, refusing to assert past a rejected set. */
function* applied(tree: ReplTree<ReplAction>, view: ReplView): Operation<void> {
  const result = yield* tree.apply(describeApplication(view));
  if (!result.ok) {
    throw result.error;
  }
}

/** The key of whatever holds focus now, as the root reads it. */
function keyed(tree: ReplTree<ReplAction>): string | undefined {
  const node = tree.focused();
  return node === undefined ? undefined : tree.keyOf(node);
}

/** Every mounted node's key, in canonical order. */
function mountedKeys(tree: ReplTree<ReplAction>): string[] {
  return tree.mounted().map((id) => tree.keyOf(id) ?? "");
}

/** The cell this frame placed for one key, or none, which is what a map holds. */
function placedFor(
  tree: ReplTree<ReplAction>,
  frame: ReplSemanticFrame,
  key: string,
): ReplPlacedCell | undefined {
  return frame.cells.find((cell) => tree.keyOf(cell.node) === key);
}

/**
 * Point at one key the way the renderer's map resolves a pointer.
 *
 * Through the frame rather than through the tree: a cell the frame did not
 * place, or placed and did not offer, is not in the map at all, so reaching for
 * the node directly would prove something no pointer can do.
 */
function* pointed(
  tree: ReplTree<ReplAction>,
  frame: ReplSemanticFrame,
  key: string,
): Operation<ReplAction> {
  const cell = placedFor(tree, frame, key);
  if (cell === undefined) {
    throw new Error(`this frame placed no cell for ${key}`);
  }
  if (!cell.targetable) {
    throw new Error(`${key} is placed but is in no target map`);
  }
  const dispatched = yield* tree.dispatch({
    kind: "pointer",
    target: cell.node,
    frame: tree.frame().id,
  });
  if (!dispatched.ok || dispatched.value.outcome !== "action") {
    throw new Error(`the pointer on ${key} produced no action`);
  }
  return dispatched.value.action;
}

/** One action, reduced at one size, refusing to carry a refusal forward. */
function acted(
  state: ReplState,
  action: ReplAction,
  session: ReplSession,
  size = NARROW,
): ReplState {
  const next = reduceRepl(state, action, session.model, liveReading(session), size);
  if (next.state.refusal !== undefined) {
    throw new Error(`${action.kind} was refused: ${next.state.refusal}`);
  }
  return next.state;
}

/** The Sessions rows this view describes, in order. */
function sessionKeysOf(view: ReplView): string[] {
  return keysOf(view).filter(
    (key) =>
      key.startsWith("sessions:") &&
      key !== "sessions:heading" &&
      key !== "sessions:earlier" &&
      key !== "sessions:later",
  );
}

/** The permission choices this view's drawer describes, in order. */
function drawerKeysOf(view: ReplView): string[] {
  return keysOf(view).filter((key) => key.startsWith("drawer:permission:choice:"));
}

/** The same state carrying one draft, which is where a location gets long. */
function withDraft(state: ReplState, draft: string): ReplState {
  return Object.freeze({
    ...state,
    draft,
    route: Object.freeze({ ...state.route, draft }),
  });
}

/** Draw one laid-out frame through this renderer, and keep what it wrote. */
function* painted(
  renderer: ReplRenderer,
  frame: ReplSemanticFrame,
  tree: ReplTree<ReplAction>,
): Operation<Uint8Array> {
  const drawn = yield* renderer.render(
    snapshotRender({
      frame,
      tree: tree.frame().id,
      mounted: tree.mounted(),
      deltaTime: 0,
      pointer: undefined,
    }),
  );
  if (!drawn.ok) {
    throw drawn.error;
  }
  return drawn.value.output;
}

/** The row this screen is showing the location's omission summary on. */
function summaryOn(rows: readonly string[]): string {
  const found = rows.find((row) => row.includes("more characters"));
  if (found === undefined) {
    throw new Error("the screen is showing no omission summary");
  }
  return found;
}

/** The keys this view describes with one `select`, which is what a row asks for. */
function keysSelecting(view: ReplView, select: string): string[] {
  const found: string[] = [];
  const walk = (description: ReplDescription<ReplAction>): void => {
    const read = readDescription(description);
    if (fields(read.input)?.["select"] === select) {
      found.push(read.key);
    }
    for (const child of read.children) {
      walk(child);
    }
  };
  for (const description of describeApplication(view)) {
    walk(description);
  }
  return found;
}

/** Everything inside the drawer's window, which is what moving it changes. */
function drawerWindowOf(view: ReplView): string[] {
  return keysOf(view).filter((key) => key.startsWith("drawer:permission:"));
}

/** Scroll the Sessions window until it is showing this row, or say it never did. */
function scrolledTo(state: ReplState, session: ReplSession, key: string): ReplState {
  let at = state;
  for (let press = 0; press < 60; press += 1) {
    if (sessionKeysOf(reading(at, session, NARROW)).includes(key)) {
      return at;
    }
    const next = acted(at, { kind: "scroll-sessions", delta: 1 }, session);
    if (next.viewports.sessions === at.viewports.sessions) {
      break;
    }
    at = next;
  }
  throw new Error(`the Sessions window never reached ${key}`);
}

/** Wait until nothing is painting, so the next paint is the one released. */
function* quiet(terminal: Terminal): Operation<void> {
  let seen = -1;
  for (let round = 0; round < 200; round += 1) {
    const painted = terminal.presented.length;
    if (painted === seen) {
      return;
    }
    seen = painted;
    yield* settled(20);
  }
  throw new Error("the screen never stopped painting");
}

/** The mounted node this key names, or none. */
function nodeOf(tree: ReplTree<ReplAction>, key: string): string | undefined {
  return tree.mounted().find((id) => tree.keyOf(id) === key);
}

/** Tab until the control this key names holds focus, the way a person reaches it. */
function* focusTo(tree: ReplTree<ReplAction>, key: string): Operation<void> {
  for (let press = 0; press < 400; press++) {
    if (keyed(tree) === key) {
      return;
    }
    yield* tree.dispatch({ kind: "key", key: "Tab" });
  }
  throw new Error(`focus never reached ${key}`);
}

/** Activate the focused control, and answer what it asked for. */
function* activate(tree: ReplTree<ReplAction>): Operation<ReplAction> {
  const dispatched = yield* tree.dispatch({ kind: "key", key: "Enter" });
  if (!dispatched.ok || dispatched.value.outcome !== "action") {
    throw new Error("the focused control produced no action");
  }
  return dispatched.value.action;
}

/** Activate the control this key names with a pointer, against the drawn frame. */
function* clicked(tree: ReplTree<ReplAction>, key: string): Operation<ReplAction> {
  const node = nodeOf(tree, key);
  if (node === undefined) {
    throw new Error(`no mounted node is keyed ${key}`);
  }
  const dispatched = yield* tree.dispatch({
    kind: "pointer",
    target: node,
    frame: tree.frame().id,
  });
  if (!dispatched.ok || dispatched.value.outcome !== "action") {
    throw new Error(`the pointer on ${key} produced no action`);
  }
  return dispatched.value.action;
}

/** Every turn control this view draws, in the order it draws them. */
/**
 * A turn's own key may hold colons — a recorded one is keyed by its marker — so
 * its detail lines are told apart by what they end with rather than by counting
 * separators.
 */
const DETAILS = [":whose", ":text", ":stop", ":failed"];

function turnRows(view: ReplView): Array<{ key: string; label: string }> {
  return rowsOf(describeApplication(view)).filter(
    (one) =>
      one.key.startsWith("sessions:turn:") && !DETAILS.some((suffix) => one.key.endsWith(suffix)),
  );
}

/** Every conversation control this view offers, sorted so order is its own row. */
function conversationRows(view: ReplView): string[] {
  return rowsOf(describeApplication(view))
    .filter((one) => one.key.startsWith("sessions:conversation:"))
    .map((one) => one.key)
    .sort();
}

/** The label of the turn control showing this prompt. */
function labelOf(view: ReplView, prompt: string): string {
  const row = turnRows(view).find((one) => one.label.includes(prompt));
  if (row === undefined) {
    throw new Error(`no turn row shows the prompt "${prompt}"`);
  }
  return row.label;
}

/** One of a turn's own detail lines, by suffix, or none when it has none. */
function detailOf(view: ReplView, prompt: string, suffix: string): string | undefined {
  const key = turnKeyed(view, prompt);
  return rowsOf(describeApplication(view)).find((one) => one.key === `${key}:${suffix}`)?.label;
}

/** One turn row's key, by the prompt text its label starts with. */
function turnKeyed(view: ReplView, prompt: string): string {
  const row = turnRows(view).find((one) => one.label.includes(prompt));
  if (row === undefined) {
    throw new Error(`no turn row shows the prompt "${prompt}"`);
  }
  return row.key;
}

/**
 * Start the three-spawn document with this script, and hand back its session.
 *
 * `approve-reads` by default, because that is the mode that leaves a decision to
 * a person: `approve-all` and `deny-all` answer everything themselves, so a
 * request would never be published and there would be nothing to present.
 */
function* asking(
  script: Record<string, Script>,
  permissionMode: PermissionMode = "approve-reads",
  source: string = THREE_SPAWNS,
): Operation<{
  readonly session: ReplSession;
  readonly stub: Stub;
  readonly holder: ReplExecution;
}> {
  const stub = createStub(script);
  yield* useStub(stub);
  const holder = execution();
  const session = granted(
    yield* submitReplEntry({
      execution: holder,
      installations: installations(),
      permissionMode,
      source,
    }),
  );
  return { session, stub, holder };
}

describe("U1 — one chronology, filtered, undisturbed by the background", () => {
  beforeAll(() => useTempFileCompiler());

  it("U1: retained, streaming and queued turns show together, in scheduling order", function* () {
    const { session, stub } = yield* asking({
      review: {},
      build: { streaming: true },
      check: { queued: true },
    });
    // Every turn reaches the provider before any of them is let go, so the order
    // they were scheduled in is this test's to decide rather than the
    // scheduler's.
    yield* stub.reached(REVIEWER);
    yield* stub.reached(BUILDER);
    yield* stub.reached(CHECKER);
    // The reviewer runs to its record; the builder stops mid-stream; the checker
    // never starts.
    yield* until(session, "all three Prompts being observed", () => observed(session) === 3);
    yield* until(session, "the reviewer's turn being recorded", () => recorded(session) === 1);

    const view = reading(initialState("agents"), session);
    // Three slots, one screen: a recorded turn, a turn still streaming and a turn
    // that has not started, all present at once.
    expect(turnRows(view)).toHaveLength(3);
    expect(labelOf(view, "review")).toContain("completed, recorded");
    expect(labelOf(view, "build")).toContain("streaming");
    expect(labelOf(view, "check")).toContain("queued");
    // Each started turn says whose it is, and the queued one cannot: the provider
    // has not said which conversation it joined, and the authored
    // `<Session name>` is not an answer to that.
    expect(detailOf(view, "review", "whose")).toContain("stub:reviewer");
    expect(detailOf(view, "build", "whose")).toContain("stub:builder");
    expect(detailOf(view, "check", "whose")).toBe(undefined);
    // So the conversations offered are exactly the two the provider started.
    expect(conversationRows(view)).toEqual([
      "sessions:conversation:stub:builder",
      "sessions:conversation:stub:reviewer",
    ]);
  });

  it("U1: an earlier live turn stays before a later recorded one, and survives its own record", function* () {
    // Every turn runs to its terminal event and then waits, so which one is
    // *recorded* first is this row's to decide rather than the scheduler's.
    const { session, stub } = yield* asking({
      review: { unrecorded: true },
      build: { unrecorded: true },
      check: { unrecorded: true },
    });
    yield* stub.finished(REVIEWER);
    yield* stub.finished(BUILDER);
    yield* stub.finished(CHECKER);

    // Which turn was scheduled first is the scheduler's business, so it is read
    // rather than assumed — and then the *later* one is recorded first, which is
    // the order a reader must not be shown.
    const order = [...session.agent.slots].sort((left, right) => left.order - right.order);
    const first = promptOf(session, order[0]?.key);
    const last = promptOf(session, order[order.length - 1]?.key);
    expect(first).not.toBe(last);
    stub.record(coroutineFor(last));
    yield* until(session, `${last} being recorded`, () => recorded(session) === 1);

    const before = reading(initialState("agents"), session);
    expect(turnRows(before)).toHaveLength(3);
    expect(labelOf(before, first)).toContain("not recorded yet");
    expect(labelOf(before, last)).toContain("completed, recorded");
    // The earlier turn is still live and the later one is already in the
    // history, and the earlier one is still first. Appending the live list to
    // the retained one would put it last.
    const shown = turnRows(before).map((one) => one.label);
    expect(shown.findIndex((label) => label.includes(first))).toBeLessThan(
      shown.findIndex((label) => label.includes(last)),
    );

    // Focus the live turn, then let it record underneath the person looking at it.
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, before);
    const mounted = turnKeyed(before, first);
    yield* focusTo(tree, mounted);
    expect(keyed(tree)).toBe(mounted);

    stub.record(coroutineFor(first));
    yield* until(session, `${first} being recorded`, () => recorded(session) === 2);
    const after = reading(initialState("agents"), session, WIDE, keyed(tree));
    // The same node: publication changed where its facts come from, not which
    // turn a person is looking at.
    expect(turnKeyed(after, first)).toBe(mounted);
    expect(turnRows(after)).toHaveLength(3);
    expect(labelOf(after, first)).toContain("completed, recorded");
    // And it is still in the same place, before the one that recorded first.
    const later = turnRows(after).map((one) => one.label);
    expect(later.findIndex((label) => label.includes(first))).toBeLessThan(
      later.findIndex((label) => label.includes(last)),
    );
    yield* applied(tree, after);
    expect(keyed(tree)).toBe(mounted);
  });

  it("U1: conversations are ordered by their earliest turn, and selecting one changes only the filter", function* () {
    const { session, stub } = yield* asking({
      review: { streaming: true },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(
      session,
      "both started turns reporting their conversation",
      () => started(session) === 2,
    );
    // And the queued one being observed, which is a different fact: a turn is a
    // row as soon as its Prompt is observed, and a turn held before it produces
    // anything never reports a conversation — so waiting for the two that do
    // says nothing about whether the third is there yet. This row ends by
    // counting all three under All.
    yield* until(session, "all three Prompts being observed", () => observed(session) === 3);
    // In the order the provider was reached, among the turns it has answered:
    // which spawn gets there first is the scheduler's business, and a queued turn
    // has no conversation to be ordered by at all.
    const [earlier, later] = startedInOrder(session);

    // Activity on the *later* conversation, so the two orders disagree: by
    // earliest turn it is still second, and by anything to do with recency it
    // would be first.
    stub.stream(coroutineFor(later));
    yield* stub.finished(coroutineFor(later));
    yield* until(session, `${later} finishing`, () => recorded(session) >= 1);

    const standing = initialState("agents");
    const view = reading(standing, session);
    expect(conversationOrder(view)).toEqual([
      `sessions:conversation:stub:${whose(earlier)}`,
      `sessions:conversation:stub:${whose(later)}`,
    ]);

    // Selecting one is one semantic action carrying one key, and it moves the
    // filter and nothing else.
    const transition = reduceRepl(
      standing,
      { kind: "select-session", session: `stub:${whose(later)}` },
      session.model,
      liveReading(session),
      WIDE,
    );
    expect(transition.intent.kind).toBe("none");
    expect(transition.state.route).toEqual({
      ...standing.route,
      session: `stub:${whose(later)}`,
    });
    // Only the Sessions rows narrow. The entry, its scopes and the transcript are
    // the same reading they were.
    const filtered = reading(transition.state, session);
    expect(turnRows(filtered).map((one) => one.label.includes(later))).toEqual([true]);
    expect(
      keysOf(filtered).filter((key) => key.startsWith("entry:") || key.startsWith("line:")),
    ).toEqual(keysOf(view).filter((key) => key.startsWith("entry:") || key.startsWith("line:")));

    // And All puts every turn back, removing only the filter.
    const cleared = reduceRepl(
      transition.state,
      { kind: "all-sessions" },
      session.model,
      liveReading(session),
      WIDE,
    );
    expect(cleared.state.route).toEqual(standing.route);
    expect(turnRows(reading(cleared.state, session))).toHaveLength(3);
  });

  it("U1: background Agent work changes no route, no filter and not where focus is", function* () {
    const { session, stub } = yield* asking({
      review: { streaming: true },
      build: { streaming: true },
      check: {
        queued: true,
        // Not a read: `approve-reads` answers those itself, and what this row
        // needs is the request that reaches a person.
        permission: { toolCallId: "call-1", title: "Write a file", kind: "edit" },
      },
    });
    yield* until(session, "both started turns", () => started(session) === 2);
    const [earlier] = startedInOrder(session);

    // Filtered to one conversation, with focus held on one exact control.
    const filtered = reduceRepl(
      initialState("agents"),
      { kind: "select-session", session: `stub:${whose(earlier)}` },
      session.model,
      liveReading(session),
      WIDE,
    ).state;
    const before = reading(filtered, session);
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, before);
    const held = turnKeyed(before, earlier);
    yield* focusTo(tree, held);

    // Now everything happens in the *other* turns: one starts, one asks for
    // permission, one streams and finishes.
    stub.start(CHECKER);
    yield* until(
      session,
      "the third turn asking for permission",
      () => session.agent.requests.length === 1,
    );
    const after = reading(filtered, session, WIDE, keyed(tree));
    yield* applied(tree, after);
    // The route is untouched, the filter still holds, and focus has not moved.
    expect(after.state.route).toEqual(before.state.route);
    expect(keyed(tree)).toBe(held);
    // The request arrived and opened nothing.
    expect(after.state.route.drawers).toEqual([]);
    expect(after.state.permission).toBe(undefined);
  });

  it("U1: a historical prefix shows no live turn and no live request", function* () {
    const { session, stub, holder } = yield* asking({
      review: {},
      build: { streaming: true },
      check: { queued: true, permission: { toolCallId: "call-1", kind: "edit" } },
    });
    yield* until(session, "all three Prompts being observed", () => observed(session) === 3);
    yield* until(session, "one recorded turn", () => recorded(session) === 1);
    stub.start(CHECKER);
    yield* until(
      session,
      "the queued turn asking for permission",
      () => session.agent.requests.length === 1,
    );

    const head = reading(initialState("agents"), session);
    expect(turnRows(head)).toHaveLength(3);
    const recordedTurn = session.model.turns[0];
    if (recordedTurn === undefined) {
      throw new Error("the reviewer's turn was not projected");
    }

    // Frozen at the position that turn was recorded at. A prefix is a different
    // reading of the file, and this process's live work is not in it.
    const frozen = reduceRepl(
      initialState("agents"),
      { kind: "select-marker", marker: recordedTurn.marker },
      session.model,
      liveReading(session),
      WIDE,
    ).state;
    const at = yield* projectedAt(holder, recordedTurn.marker);
    const past = reading(frozen, session, WIDE, undefined, at);
    expect(turnRows(past)).toHaveLength(1);
    expect(labelOf(past, recordedTurn.input)).toContain("recorded");
    // No live request is reachable there, whatever the head holds.
    expect(keysOf(past).some((key) => key.startsWith("sessions:request:"))).toBe(false);
    // And a conversation only this process knows about cannot be selected there.
    const refused = reduceRepl(
      frozen,
      { kind: "select-session", session: "stub:checker" },
      at,
      liveReading(session),
      WIDE,
    );
    expect(refused.state.route).toEqual(frozen.route);
    expect(refused.state.refusal).toBeDefined();
  });
});

/**
 * The prompts of the turns that have started, in the order they were observed.
 *
 * Slot order, which is the order the Prompts were scheduled in — and only the
 * ones the provider has answered, because a queued turn has no conversation to
 * be ordered or filtered by.
 */
function startedInOrder(session: ReplSession): string[] {
  return [...session.agent.slots]
    .sort((left, right) => left.order - right.order)
    .map((slot) => session.agent.turns.find((turn) => turn.key === slot.key))
    .filter((turn) => turn?.sessionKey !== undefined)
    .map((turn) => turn?.prompt ?? "");
}

/** How many observed turns have been told which conversation they joined. */
function started(session: ReplSession): number {
  return session.agent.turns.filter((turn) => turn.sessionKey !== undefined).length;
}

/** The authored `<Session name>` the spawn asking this prompt routed. */
function whose(prompt: string): string {
  const named: Record<string, string> = {
    review: "reviewer",
    build: "builder",
    check: "checker",
  };
  const name = named[prompt];
  if (name === undefined) {
    throw new Error(`this document has no spawn asking "${prompt}"`);
  }
  return name;
}

/** Every conversation control, in the order this view draws them. */
function conversationOrder(view: ReplView): string[] {
  return rowsOf(describeApplication(view))
    .filter((one) => one.key.startsWith("sessions:conversation:"))
    .map((one) => one.key);
}

/** The prompt text the live turn or published slot with this key was asked. */
function promptOf(session: ReplSession, key: string | undefined): string {
  const live = session.agent.turns.find((turn) => turn.key === key);
  if (live !== undefined) {
    return live.prompt;
  }
  const slot = session.agent.slots.find((candidate) => candidate.key === key);
  if (slot?.last !== undefined) {
    return slot.last.prompt;
  }
  throw new Error(`no observed turn is keyed ${key}`);
}

/** The child coroutine the `<Spawn>` holding this prompt runs on. */
function coroutineFor(prompt: string): string {
  const spawned: Record<string, string> = {
    review: REVIEWER,
    build: BUILDER,
    check: CHECKER,
  };
  const coroutine = spawned[prompt];
  if (coroutine === undefined) {
    throw new Error(`this document has no spawn asking "${prompt}"`);
  }
  return coroutine;
}

/**
 * Wait until this session says `holds`, or say it never did.
 *
 * The session is read rather than a change stream: a signal delivers to whoever
 * is pulling at that moment, and these rows wait for states a turn passes
 * through. What a row waits on is monotone — a record appended, a turn observed
 * — so reading is exact.
 */
function until(session: ReplSession, what: string, holds: () => boolean): Operation<void> {
  return (function* () {
    // Bounded by time rather than by a number of turns: how many turns of the
    // loop a state takes depends on what else the machine is doing, and a count
    // that is generous on an idle machine is a flake on a busy one.
    const deadline = Date.now() + DEADLOCK_MS;
    while (!holds()) {
      if (Date.now() > deadline) {
        throw new Error(`this session never reached ${what}`);
      }
      yield* sleep(0);
    }
  })();
}

/**
 * How many Prompts this process has observed at all.
 *
 * Waited for wherever a row counts turn rows: the three spawns reach the provider
 * whenever the scheduler runs them, so a row that counted before the third one
 * was observed would be counting how fast the machine is.
 */
function observed(session: ReplSession): number {
  return session.agent.slots.length;
}

/** How many of this process's observed Prompts have been recorded. */
function recorded(session: ReplSession): number {
  return session.agent.slots.filter((slot) => slot.durable !== undefined).length;
}

describe("U2 — one action path, and one owner for a pending request", () => {
  beforeAll(() => useTempFileCompiler());

  it("U2: Enter and a pointer on the same control ask for the same thing", function* () {
    const { session, stub } = yield* asking({
      review: { streaming: true, permission: { toolCallId: "call-1", kind: "edit" } },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }
    const standing = onSessions(session);
    const view = reading(standing, session);
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, view);

    // Every control a person can reach here, asked for twice: once with Enter on
    // the focused control, once with a pointer resolved against the frame that
    // drew it. A router that decided at the target rather than through mounted
    // dispatch would answer differently to one of them.
    const conversation = conversationOrder(view)[0];
    if (conversation === undefined) {
      throw new Error("no conversation control was drawn");
    }
    for (const key of ["sessions:all", conversation, `sessions:request:${request.key}`]) {
      yield* focusTo(tree, key);
      const pressed = yield* activate(tree);
      const clickedOn = yield* clicked(tree, key);
      expect(clickedOn).toEqual(pressed);
    }
    // And the same for the choices, which only exist once the drawer is open.
    const opened = reduceRepl(
      standing,
      { kind: "select-permission", request: request.key },
      session.model,
      liveReading(session),
      WIDE,
    ).state;
    yield* applied(tree, reading(opened, session));
    for (const choice of request.choices) {
      const key = `drawer:permission:choice:${choice.optionId}`;
      yield* focusTo(tree, key);
      const pressed = yield* activate(tree);
      const clickedOn = yield* clicked(tree, key);
      expect(clickedOn).toEqual(pressed);
      expect(pressed).toEqual({
        kind: "choose-permission",
        request: request.key,
        option: choice.optionId,
      });
    }
    // Nothing was settled by asking: an action is a question for the root.
    expect(stub.outcomes.size).toBe(0);
  });

  it("U2: a request arriving opens nothing, moves nothing and claims no focus", function* () {
    const { session, stub } = yield* asking({
      review: { streaming: true },
      build: { streaming: true, permission: { toolCallId: "call-1", kind: "edit" } },
      check: { queued: true },
    });
    yield* until(session, "a started turn", () => started(session) >= 1);
    const standing = onSessions(session);
    const before = reading(standing, session);
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, before);
    const held = "sessions:all";
    yield* focusTo(tree, held);

    // The request arrives with somebody looking at something else.
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }
    const after = reading(standing, session, WIDE, keyed(tree));
    yield* applied(tree, after);
    // It is there to be seen, on the turn that is waiting.
    expect(keysOf(after)).toContain(`sessions:request:${request.key}`);
    expect(turnKeyed(after, "build")).toBe(`sessions:turn:${request.turn}`);
    // And it opened nothing, selected nothing and took nothing.
    expect(after.state.route).toEqual(before.state.route);
    expect(after.state.permission).toBe(undefined);
    expect(keyed(tree)).toBe(held);
    expect(stub.outcomes.size).toBe(0);
  });

  it("U2: activating it opens the drawer, and one choice settles that request once", function* () {
    const { session, stub } = yield* asking({
      review: {
        streaming: true,
        permission: { toolCallId: "call-1", title: "Write", kind: "edit" },
      },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }
    const standing = onSessions(session);
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, reading(standing, session));
    yield* focusTo(tree, `sessions:request:${request.key}`);
    const asked = yield* activate(tree);
    expect(asked).toEqual({ kind: "select-permission", request: request.key });

    const opening = reduceRepl(standing, asked, session.model, liveReading(session), WIDE);
    expect(opening.state.permission).toBe(request.key);
    // The route says a permission drawer is open and nothing about which request:
    // a live key in a location would publish an identity nothing else can use.
    expect(opening.state.route.drawers).toEqual([{ kind: "live-permission" }]);
    const location = reading(opening.state, session).location;
    expect(location).toContain("+permission");
    expect(location).not.toContain(request.key);

    // Every choice the provider offered is drawn, scoped to this session where it
    // is a lasting one.
    const drawer = reading(opening.state, session);
    const drawn = rowsOf(describeApplication(drawer)).filter((one) =>
      one.key.startsWith("drawer:permission:choice:"),
    );
    expect(drawn).toHaveLength(request.choices.length);
    expect(drawn.find((one) => one.key.endsWith("always"))?.label).toContain(
      "for this Agent session",
    );
    expect(JSON.stringify(drawn)).not.toContain("machine");

    // Choosing one: the reducer decides, the root calls the authority once.
    yield* applied(tree, drawer);
    yield* focusTo(tree, "drawer:permission:choice:once");
    const chose = yield* activate(tree);
    const settling = reduceRepl(opening.state, chose, session.model, liveReading(session), WIDE);
    expect(settling.intent).toEqual({
      kind: "settle-permission",
      request: request.key,
      option: "once",
      turn: request.turn,
    });
    expect(answer(session, settling.intent)).toBe(true);
    yield* until(session, "the request being answered", () => stub.outcomes.size === 1);
    expect(stub.outcomes.get("call-1")).toEqual({ outcome: "selected", optionId: "once" });
    expect(stub.answers.get("call-1")).toBe(1);

    // The drawer goes because the request is gone, and focus returns to the turn
    // that was waiting.
    const done = permissionSettled(settling.state, request.turn);
    expect(done.permission).toBe(undefined);
    expect(done.route.drawers).toEqual([]);
    const restored = reading(done, session, WIDE, keyed(tree));
    expect(focusClaim(restored)).toBe(`sessions:turn:${request.turn}`);
    yield* applied(tree, restored);
    expect(keyed(tree)).toBe(`sessions:turn:${request.turn}`);
    // Spent once, so traversal from there is the person's.
    expect(focusSettled(restored, keyed(tree)).restore).toBe(undefined);
    // And the other conversation is still running.
    expect(session.agent.turns.some((turn) => turn.prompt === "build")).toBe(true);
  });

  it("U2: closing the drawer denies exactly once, through the authority", function* () {
    const { session, stub } = yield* asking({
      review: { streaming: true, permission: { toolCallId: "call-1", kind: "edit" } },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }
    const opened = reduceRepl(
      onSessions(session),
      { kind: "select-permission", request: request.key },
      session.model,
      liveReading(session),
      WIDE,
    ).state;
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, reading(opened, session));

    // Escape on the drawer, which is the ordinary dismissal — and it does not
    // close anything by itself, because denying is the authority's to do.
    const dismissed = yield* tree.dispatch({ kind: "key", key: "Escape" });
    if (!dismissed.ok || dismissed.value.outcome !== "action") {
      throw new Error("Escape reached no drawer");
    }
    const transition = reduceRepl(
      opened,
      dismissed.value.action,
      session.model,
      liveReading(session),
      WIDE,
    );
    expect(transition.intent).toEqual({
      kind: "settle-permission",
      request: request.key,
      option: undefined,
      turn: request.turn,
    });
    expect(transition.state.route.drawers).toEqual([{ kind: "live-permission" }]);
    expect(answer(session, transition.intent)).toBe(true);
    yield* until(session, "the request being denied", () => stub.outcomes.size === 1);
    // Denied once, by the provider's own denial rather than a rule spelled here.
    expect(stub.answers.get("call-1")).toBe(1);
    expect(stub.outcomes.get("call-1")).toBeDefined();
    // A second dismissal of the same key settles nothing more.
    expect(session.permissions.dismiss(request.key)).toBe(false);
    expect(stub.answers.get("call-1")).toBe(1);
    // The session is still live: dismissing one request is not cancelling it.
    expect(session.live).toBe(true);
  });

  it("U2: an unknown request or an unoffered option changes nothing and calls nobody", function* () {
    const { session, stub } = yield* asking({
      review: { streaming: true, permission: { toolCallId: "call-1", kind: "edit" } },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }
    const opened = reduceRepl(
      onSessions(session),
      { kind: "select-permission", request: request.key },
      session.model,
      liveReading(session),
      WIDE,
    ).state;

    // A key this screen never selected, an option the provider never offered, and
    // a dismissal of somebody else's request: each changes no route and settles
    // nothing.
    const stale: readonly ReplAction[] = [
      { kind: "choose-permission", request: "nobody", option: "once" },
      { kind: "choose-permission", request: request.key, option: "not-offered" },
      { kind: "dismiss-permission", request: "nobody" },
    ];
    for (const action of stale) {
      const refused = reduceRepl(opened, action, session.model, liveReading(session), WIDE);
      expect(refused.intent.kind).toBe("none");
      expect(refused.state.route).toEqual(opened.route);
      expect(refused.state.refusal).toBeDefined();
    }
    // The authority refuses them too, when asked directly.
    expect(session.permissions.choose("nobody", "once")).toBe(false);
    expect(session.permissions.choose(request.key, "not-offered")).toBe(false);
    expect(stub.outcomes.size).toBe(0);
  });

  it("U2: a recorded permission audit is read, never answered", function* () {
    // Reconstructed from a journal a real run recorded, because what this row owns
    // is how a *retained* audit is presented: read, with no target, no action and
    // no authority call. How a live turn comes to retain one is Slice B's, and is
    // proved there.
    const holder: ReplExecution = {
      id: "agent-audits",
      stream: new InMemoryStream([...(yield* agentReferenceEvents())]),
    };
    const session = granted(
      yield* openReplSession({ execution: holder, installations: installations() }),
    );
    const recordedAudits = session.model.turns.flatMap((turn) => turn.permissions);
    expect(recordedAudits.length).toBeGreaterThan(0);
    const view = reading(onSessions(session), session);
    const audits = rowsOf(describeApplication(view)).filter((one) =>
      one.key.startsWith("sessions:audit:"),
    );
    expect(audits).toHaveLength(recordedAudits.length);
    // What it was granted and how that was answered, in the record's own words.
    expect(audits[0]?.label).toContain("granted:");
    // Readable, and nothing to activate: a record is what a turn was granted.
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, view);
    const node = nodeOf(tree, audits[0]?.key ?? "");
    expect(node).toBeDefined();
    const aimed = yield* tree.dispatch({
      kind: "pointer",
      target: node ?? "",
      frame: tree.frame().id,
    });
    expect(aimed.ok && aimed.value.outcome === "action").toBe(false);
    // And no request is waiting on anybody: a replay asks nobody anything.
    expect(session.agent.requests).toEqual([]);
    expect(keysOf(view).some((key) => key.startsWith("sessions:request:"))).toBe(false);
  });
});

/** The same state, on the surface a permission is answered from. */
function onSessions(session: ReplSession, state = initialState("agents")): ReplState {
  const moved = reduceRepl(
    state,
    { kind: "select-surface", surface: "sessions" },
    session.model,
    liveReading(session),
    WIDE,
  );
  if (moved.state.refusal !== undefined) {
    throw new Error(`the Sessions surface refused: ${moved.state.refusal}`);
  }
  return moved.state;
}

/**
 * Perform one settlement the way the root performs it.
 *
 * The authority and nothing else: the reducer decided, and this is the one thing
 * that holds the capability to answer.
 */
function answer(session: ReplSession, intent: ReplIntent): boolean {
  if (intent.kind !== "settle-permission") {
    throw new Error("this intent settles no permission");
  }
  return intent.option === undefined
    ? session.permissions.dismiss(intent.request)
    : session.permissions.choose(intent.request, intent.option);
}

describe("U3 — what each accepted frame mounts, and nothing else", () => {
  beforeAll(() => useTempFileCompiler());

  it("U3: wide keeps Sessions in the sidebar and leaves the other readings alone", function* () {
    const { session, stub } = yield* asking({
      review: { streaming: true, permission: { toolCallId: "call-1", kind: "edit" } },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    // Two conversations, so filtering to one is observably narrower than All.
    yield* until(session, "two started turns", () => started(session) >= 2);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }
    const tree = yield* useReplTree<ReplAction>();

    const all = onSessions(session);
    // A conversation this reading actually offers: which turns have started is
    // the scheduler's business, so the filter is chosen from what is drawn.
    const offered = conversationOrder(reading(all, session, WIDE))[0];
    if (offered === undefined) {
      throw new Error("no conversation control was drawn");
    }
    const filtered = reduceRepl(
      all,
      { kind: "select-session", session: offered.slice("sessions:conversation:".length) },
      session.model,
      liveReading(session),
      WIDE,
    ).state;
    expect(filtered.refusal).toBe(undefined);
    const drawered = reduceRepl(
      all,
      { kind: "select-permission", request: request.key },
      session.model,
      liveReading(session),
      WIDE,
    ).state;

    const placed: Array<{ sessions: string[]; transcript: string[]; inspection: string[] }> = [];
    for (const state of [all, filtered, drawered]) {
      const view = reading(state, session, WIDE);
      yield* applied(tree, view);
      const surface = replSurface(tree, view);
      placed.push({
        sessions: surface.sessions.map((cell) => tree.keyOf(cell.node) ?? ""),
        transcript: surface.transcript.map((cell) => tree.keyOf(cell.node) ?? ""),
        inspection: surface.inspection.map((cell) => tree.keyOf(cell.node) ?? ""),
      });
    }
    // Sessions is in the sidebar at this size, and it holds the turns.
    expect(placed[0]?.sessions.some((key) => key.startsWith("sessions:turn:"))).toBe(true);
    // Filtering and opening the drawer change what Sessions shows and leave the
    // document transcript and the inspection column exactly as they were.
    expect(placed[1]?.transcript).toEqual(placed[0]?.transcript);
    expect(placed[2]?.transcript).toEqual(placed[0]?.transcript);
    expect(placed[1]?.inspection).toEqual(placed[0]?.inspection);
    expect(placed[2]?.inspection).toEqual(placed[0]?.inspection);
    expect(placed[1]?.sessions).not.toEqual(placed[0]?.sessions);
  });

  it("U3: narrow Sessions mounts its own outlet and nothing of the other panes", function* () {
    const { session } = yield* asking({
      review: { streaming: true },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a started turn", () => started(session) >= 1);
    const tree = yield* useReplTree<ReplAction>();
    const view = reading(onSessions(session), session, NARROW);
    yield* applied(tree, view);
    const frame = layout(NARROW, replSurface(tree, view));

    // Absent, not clipped: the entry list, the transcript and the inspection
    // column are not mounted, so they are in no frame, no target map and no
    // pointer's way.
    const mounted = tree.mounted().map((id) => tree.keyOf(id) ?? "");
    for (const prefix of ["entry:", "scope:", "line:", "binding:", "elicit:"]) {
      expect(mounted.filter((key) => key.startsWith(prefix))).toEqual([]);
      expect(keysOf(view).filter((key) => key.startsWith(prefix))).toEqual([]);
    }
    // The entry *outlet* is absent; the control that goes to it is not part of
    // that outlet and stays, because a screen a person cannot leave is not one
    // this route may put them on.
    expect(mounted.filter((key) => key.startsWith("entries:"))).toEqual(["entries:heading"]);
    const drawn = frame.cells.map((cell) => tree.keyOf(cell.node) ?? "");
    expect(drawn.some((key) => key.startsWith("sessions:turn:"))).toBe(true);
    expect(drawn).toContain("entries:heading");
    expect(drawn.filter((key) => key.startsWith("entry:") || key.startsWith("line:"))).toEqual([]);
    // Every target this frame offers is a control, and every one of them is
    // mounted: nothing offers itself to a pointer and then does nothing.
    for (const cell of frame.cells.filter((one) => one.targetable)) {
      const key = tree.keyOf(cell.node);
      expect(key).toBeDefined();
      expect(nodeOf(tree, key ?? "")).toBe(cell.node);
      expect(TURN_FACT_SUFFIXES.some((suffix) => (key ?? "").endsWith(suffix))).toBe(false);
    }
  });

  it("U3: narrow REPL mounts no Sessions row", function* () {
    const { session } = yield* asking({
      review: { streaming: true },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a started turn", () => started(session) >= 1);
    const tree = yield* useReplTree<ReplAction>();
    // The ordinary REPL route, which is where this process starts.
    const view = reading(initialState("agents"), session, NARROW);
    yield* applied(tree, view);
    const mounted = tree.mounted().map((id) => tree.keyOf(id) ?? "");
    // No row of the Sessions reading: not a conversation, not a turn, not a
    // fact, not a request, and neither window control.
    expect(mounted.filter((key) => key.startsWith("sessions:"))).toEqual(["sessions:heading"]);
    // The entry list is what this frame is for.
    expect(mounted.some((key) => key.startsWith("entries:"))).toBe(true);
    // And the way to the other surface is drawn and pointable from here, which
    // is the whole reason it is mounted.
    const frame = layout(NARROW, replSurface(tree, view));
    const drawn = frame.cells.filter((cell) => tree.keyOf(cell.node) === "sessions:heading");
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.targetable).toBe(true);
  });

  it("U3: the permission drawer traps focus, keeps History inside it and hides what is behind", function* () {
    const { session } = yield* asking({
      review: { streaming: true, permission: { toolCallId: "call-1", kind: "edit" } },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }
    const tree = yield* useReplTree<ReplAction>();
    const standing = onSessions(session);
    yield* applied(tree, reading(standing, session, WIDE));
    // A node behind the drawer, remembered before it opens.
    const behind = nodeOf(tree, "sessions:all");
    expect(behind).toBeDefined();

    const opened = reduceRepl(
      standing,
      { kind: "select-permission", request: request.key },
      session.model,
      liveReading(session),
      WIDE,
    ).state;
    yield* applied(tree, reading(opened, session, WIDE));

    // Focus is trapped: Tab all the way round and every stop is inside the modal.
    const seen = new Set<string>();
    for (let press = 0; press < 40; press++) {
      const key = keyed(tree);
      expect(key).toBeDefined();
      seen.add(key ?? "");
      yield* tree.dispatch({ kind: "key", key: "Tab" });
    }
    for (const key of seen) {
      expect(key === "drawer:open" || key.startsWith("drawer:") || key === "footer:history").toBe(
        true,
      );
    }
    // The one History node, reachable from inside rather than duplicated beside.
    expect([...seen]).toContain("footer:history");
    expect(
      tree
        .mounted()
        .map((id) => tree.keyOf(id))
        .filter((key) => key === "footer:history"),
    ).toHaveLength(1);
    // And a pointer at what the drawer covers reaches nothing.
    const blocked = yield* tree.dispatch({
      kind: "pointer",
      target: behind ?? "",
      frame: tree.frame().id,
    });
    expect(blocked.ok && blocked.value.outcome === "action").toBe(false);
  });

  it("U3: every accepted frame carries one location, and too small carries only its refusal", function* () {
    const { session } = yield* asking({
      review: { streaming: true },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a started turn", () => started(session) >= 1);
    const tree = yield* useReplTree<ReplAction>();
    for (const size of [WIDE, { columns: 120, rows: 30 }, NARROW]) {
      const view = reading(onSessions(session), session, size);
      yield* applied(tree, view);
      const frame = layout(size, replSurface(tree, view));
      const located = frame.cells.filter((cell) =>
        (tree.keyOf(cell.node) ?? "").startsWith("location:"),
      );
      // One canonical location, once — and not repeated inside the Sessions rows.
      expect(located.map((cell) => cell.text).join("")).toContain(view.location);
      expect(new Set(located.map((cell) => cell.region)).size).toBe(1);
    }
    // Smaller than narrow draws its refusal and offers nothing to activate.
    const tiny = layout(
      { columns: 40, rows: 10 },
      replSurface(tree, reading(onSessions(session), session, NARROW)),
    );
    expect(tiny.profile).toBe("too-small");
    expect(tiny.refusal).toBeDefined();
    expect(tiny.cells.filter((cell) => cell.targetable)).toEqual([]);
  });
});

/** The suffixes a turn's own read-only facts are keyed with. */
const TURN_FACT_SUFFIXES = [":whose", ":text", ":stop", ":failed"];

describe("U2 — the program performs a permission, end to end", () => {
  beforeAll(() => useTempFileCompiler());

  it("U2: choosing through the running program settles the request and closes its drawer", function* () {
    const stub = createStub({
      review: {
        streaming: true,
        permission: { toolCallId: "call-1", title: "Write", kind: "edit" },
      },
      build: { streaming: true },
      check: { queued: true },
    });
    const { terminal, install } = recordingTerminal();
    let outcome: ReplOutcome | undefined;

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useStub(stub);
      yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        outcome = ran.value;
      });
      yield* untilDrawn(terminal);

      // One entry, submitted the way a person submits one.
      terminal.bytes(BYTES.encode(THREE_SPAWNS));
      yield* settled(20);
      terminal.feed("\r");
      yield* settled(40);

      yield* showing(terminal, "asks: Write");
      // Nothing opened by itself: the request is a fact on its turn, and the
      // location says no drawer is up.
      expect(maybeLocation(terminal)).not.toContain("+permission");

      // A permission is answered on the Sessions surface, so that is where a
      // person goes first — through the ordinary control, not a shortcut.
      yield* pressUntil(terminal, "Sessions");
      terminal.feed("\r");
      yield* settled(40);

      // Activate the request fact, then choose one offered option — Tab and Enter,
      // through the ordinary normalized boundary.
      yield* pressUntil(terminal, "asks: Write");
      terminal.feed("\r");
      yield* settled(40);
      expect(maybeLocation(terminal)).toContain("+permission");
      expect(shows(terminal, "[Allow once]")).toBe(true);

      yield* pressUntil(terminal, "[Allow once]");
      terminal.feed("\r");
      // The program performs it: `perform()` calls the session's authority, and
      // only a successful call closes the drawer.
      yield* answered(stub, "call-1");
      expect(stub.outcomes.get("call-1")).toEqual({ outcome: "selected", optionId: "once" });
      // Once, through one authority call: a second would answer a request that is
      // already over.
      expect(stub.answers.get("call-1")).toBe(1);
      yield* settled(40);

      // The drawer is gone from the screen and from the location, and focus is on
      // the turn that was waiting rather than on whatever opened the drawer.
      expect(maybeLocation(terminal)).not.toContain("+permission");
      expect(shows(terminal, "[Allow once]")).toBe(false);
      expect(focusedOn(terminal, "review ·")).toBe(true);

      terminal.end();
      yield* running;
    });

    expect(outcome?.location).toBeDefined();
    expect(outcome?.location).not.toContain("+permission");
  });

  it("U2: Escape on the drawer denies once through the program, and the session runs on", function* () {
    const stub = createStub({
      review: {
        streaming: true,
        permission: { toolCallId: "call-1", title: "Write", kind: "edit" },
      },
      build: { streaming: true },
      check: { queued: true },
    });
    const { terminal, install } = recordingTerminal();
    let outcome: ReplOutcome | undefined;

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useStub(stub);
      yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        outcome = ran.value;
      });
      yield* untilDrawn(terminal);
      terminal.bytes(BYTES.encode(THREE_SPAWNS));
      yield* settled(20);
      terminal.feed("\r");
      yield* settled(40);
      yield* showing(terminal, "asks: Write");

      // Open it the way a person does, from the surface a permission is answered
      // on.
      yield* pressUntil(terminal, "Sessions");
      terminal.feed("\r");
      yield* settled(40);
      yield* pressUntil(terminal, "asks: Write");
      terminal.feed("\r");
      yield* settled(40);
      expect(maybeLocation(terminal)).toContain("+permission");
      expect(shows(terminal, "Escape or close denies")).toBe(true);
      expect(stub.outcomes.size).toBe(0);

      // Escape: the direct dismissal, which denies through the authority rather
      // than closing a screen and leaving a provider waiting.
      terminal.feed("\x1b");
      yield* answered(stub, "call-1");
      // One denial, and exactly one authority call made it.
      expect(stub.outcomes.get("call-1")).toEqual({ outcome: "selected", optionId: "no" });
      expect(stub.answers.get("call-1")).toBe(1);
      yield* settled(40);

      // The drawer closed because the request is gone, not because a key was
      // pressed: it is out of the screen and out of the location, and focus is
      // back on the turn that was waiting.
      expect(maybeLocation(terminal)).not.toContain("+permission");
      expect(shows(terminal, "Escape or close denies")).toBe(false);
      expect(focusedOn(terminal, "review ·")).toBe(true);

      // And the session is still live: dismissing one request cancelled nothing,
      // so the other conversation is still there to be seen.
      expect(shows(terminal, "build")).toBe(true);
      expect(maybeLocation(terminal)).not.toContain("at=");
      terminal.end();
      yield* running;
    });

    expect(outcome?.location).toBeDefined();
    expect(outcome?.location).not.toContain("+permission");
  });
});

describe("U4 — the loop wakes for Agent work", () => {
  beforeAll(() => useTempFileCompiler());

  it("U4: queued, streaming and a waiting request each repaint on their own", function* () {
    // Every turn is held before it produces anything, so the only thing that
    // moves between the assertions below is the Agent reading: no record
    // appends, nothing is printed, nothing is asked through Elicit and
    // expansion stays where it is. If the screen changes, this is what changed
    // it.
    const stub = createStub({
      review: { queued: true, streaming: true },
      build: {
        queued: true,
        permission: { toolCallId: "call-1", title: "Write", kind: "edit" },
      },
      check: { queued: true },
    });
    const { terminal, install } = recordingTerminal();

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useStub(stub);
      yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(terminal);
      terminal.bytes(BYTES.encode(THREE_SPAWNS));
      yield* settled(20);
      terminal.feed("\r");
      yield* settled(40);

      // A stable frame: all three observed, none of them started.
      yield* showing(terminal, "review · queued");
      yield* showing(terminal, "check · queued");
      yield* quiet(terminal);

      // One turn starts. Nobody pressed anything, nothing was recorded, and the
      // screen has to say so.
      const beforeStart = terminal.presented.length;
      stub.start(REVIEWER);
      yield* showing(terminal, "review · streaming");
      expect(terminal.presented.length).toBeGreaterThan(beforeStart);
      // And only that turn moved.
      expect(shows(terminal, "check · queued")).toBe(true);
      yield* quiet(terminal);

      // One turn asks for permission. The fact appears on the turn that is
      // waiting, in a frame nothing else asked for.
      const beforeAsking = terminal.presented.length;
      stub.start(BUILDER);
      yield* showing(terminal, "asks: Write");
      expect(terminal.presented.length).toBeGreaterThan(beforeAsking);
      // Arriving opened nothing and moved nobody: the location is unchanged and
      // no drawer is up.
      expect(maybeLocation(terminal)).not.toContain("+permission");

      terminal.end();
      yield* running;
    });
  });
});

describe("U5 — navigation is outside the outlet it leaves", () => {
  beforeAll(() => useTempFileCompiler());

  it("U5: a narrow frame is left in both directions, by key and by pointer", function* () {
    const { session } = yield* asking({
      review: { streaming: true },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a started turn", () => started(session) >= 1);

    // The narrow REPL route, which mounts the entry outlet and no Sessions row.
    const onRepl = initialState("agents");
    const tree = yield* useReplTree<ReplAction>();
    const replView = reading(onRepl, session, NARROW);
    yield* applied(tree, replView);
    const replFrame = layout(NARROW, replSurface(tree, replView));
    expect(mountedKeys(tree).filter((key) => key.startsWith("sessions:"))).toEqual([
      "sessions:heading",
    ]);

    // Enter on the control and a pointer resolved from the frame ask for the
    // same thing, and both are available from the outlet this route mounts.
    yield* focusTo(tree, "sessions:heading");
    const pressed = yield* activate(tree);
    const aimed = yield* pointed(tree, replFrame, "sessions:heading");
    expect(pressed).toEqual({ kind: "select-surface", surface: "sessions" });
    expect(aimed).toEqual(pressed);

    // Which takes the person to Sessions, where the way back is mounted too.
    const onSessionsNow = acted(onRepl, pressed, session);
    expect(onSessionsNow.route.surface).toBe("sessions");
    const sessionsView = reading(onSessionsNow, session, NARROW);
    yield* applied(tree, sessionsView);
    const sessionsFrame = layout(NARROW, replSurface(tree, sessionsView));
    // The entry outlet is absent; the control that goes to it is not.
    expect(mountedKeys(tree).filter((key) => key.startsWith("entry:"))).toEqual([]);
    expect(mountedKeys(tree).filter((key) => key.startsWith("scope:"))).toEqual([]);
    yield* focusTo(tree, "entries:heading");
    const back = yield* activate(tree);
    expect(back).toEqual({ kind: "select-surface", surface: "repl" });
    expect(yield* pointed(tree, sessionsFrame, "entries:heading")).toEqual(back);
    expect(acted(onSessionsNow, back, session).route.surface).toBe("repl");
  });

  it("U5: a request arriving on the other surface is still reachable from this one", function* () {
    const { session } = yield* asking({
      review: { streaming: true, permission: { toolCallId: "call-1", title: "Write" } },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }

    // Standing on the narrow REPL route when it arrives: no route changed, no
    // drawer opened, and the fact is not a control here.
    const onRepl = initialState("agents");
    const tree = yield* useReplTree<ReplAction>();
    const replView = reading(onRepl, session, NARROW);
    yield* applied(tree, replView);
    expect(replView.state.route).toEqual(onRepl.route);
    expect(replView.state.route.drawers).toEqual([]);

    // The person goes to Sessions through the mounted control, and the request
    // is there to activate.
    yield* focusTo(tree, "sessions:heading");
    const moved = acted(onRepl, yield* activate(tree), session);
    const sessionsView = reading(moved, session, NARROW);
    yield* applied(tree, sessionsView);
    const key = `sessions:request:${request.key}`;
    const at = scrolledTo(moved, session, key);
    const view = reading(at, session, NARROW);
    yield* applied(tree, view);
    yield* focusTo(tree, key);
    expect(yield* activate(tree)).toEqual({ kind: "select-permission", request: request.key });
  });
});

describe("U6 — the Sessions reading is windowed", () => {
  beforeAll(() => useTempFileCompiler());

  it("U6: a request past the first window is reached by scrolling, and the top comes back", function* () {
    // Every turn asks. Which one the scheduler reaches first is its own
    // business, so what this row relies on is only that the reading is longer
    // than the smallest accepted frame can place — and one of the requests is
    // therefore past its first window.
    const { session } = yield* asking({
      review: { permission: { toolCallId: "call-1", title: "Write", kind: "edit" } },
      build: { permission: { toolCallId: "call-2", title: "Move", kind: "edit" } },
      check: { permission: { toolCallId: "call-3", title: "Delete", kind: "edit" } },
    });
    // Every turn observed and started, so the reading is the whole one this row
    // is about rather than however much of it had arrived first.
    yield* until(session, "all three Prompts being observed", () => observed(session) === 3);
    yield* until(session, "all three turns being started", () => started(session) === 3);
    yield* until(session, "all three requests waiting", () => session.agent.requests.length === 3);

    const standing = onSessions(session);
    const whole = sessionKeysOf(reading(standing, session, WIDE));
    const first = reading(standing, session, NARROW);
    const shown = sessionKeysOf(first);
    // There is more reading than this frame can place, and what it places is a
    // prefix of the whole thing rather than a sample of it.
    expect(whole.length).toBeGreaterThan(shown.length);
    expect(whole.slice(0, shown.length)).toEqual(shown);

    // The exact request whose row this window does not reach.
    const request = session.agent.requests.find(
      (candidate) => !shown.includes(`sessions:request:${candidate.key}`),
    );
    if (request === undefined) {
      throw new Error("every request was inside the first window");
    }
    const key = `sessions:request:${request.key}`;
    // Past the window: not described, so not mounted, not focusable, not drawn
    // and not in any target map.
    expect(whole).toContain(key);
    expect(shown).not.toContain(key);
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, first);
    expect(nodeOf(tree, key)).toBe(undefined);
    expect(placedFor(tree, layout(NARROW, replSurface(tree, first)), key)).toBe(undefined);

    // Scrolling reaches it, and the control it becomes is the exact one that
    // answers this request — by pointer, resolved from the frame that drew it.
    const at = scrolledTo(standing, session, key);
    const view = reading(at, session, NARROW);
    yield* applied(tree, view);
    const frame = layout(NARROW, replSurface(tree, view));
    const placed = placedFor(tree, frame, key);
    expect(placed).toBeDefined();
    expect(placed?.targetable).toBe(true);
    expect(yield* pointed(tree, frame, key)).toEqual({
      kind: "select-permission",
      request: request.key,
    });
    // The window controls never scroll away from whoever is using them.
    expect(placedFor(tree, frame, "sessions:earlier")).toBeDefined();
    expect(placedFor(tree, frame, "sessions:later")).toBeDefined();
    expect(placedFor(tree, frame, "sessions:heading")).toBeDefined();

    // And scrolling back recovers what was there before, rather than leaving a
    // window that only travels one way.
    let back = at;
    for (let press = 0; press < 40 && back.viewports.sessions > 0; press += 1) {
      back = acted(back, { kind: "scroll-sessions", delta: -1 }, session);
    }
    expect(back.viewports.sessions).toBe(0);
    expect(sessionKeysOf(reading(back, session, NARROW))).toEqual(shown);
  });

  it("U6: the stored offset is clamped when the reading it was taken against changes", function* () {
    const { session, stub } = yield* asking({
      review: { permission: { toolCallId: "call-1", title: "Write", kind: "edit" } },
      build: { permission: { toolCallId: "call-2", title: "Move", kind: "edit" } },
      check: { permission: { toolCallId: "call-3", title: "Delete", kind: "edit" } },
    });
    yield* until(session, "all three Prompts being observed", () => observed(session) === 3);
    yield* until(session, "all three turns being started", () => started(session) === 3);
    yield* until(session, "all three requests waiting", () => session.agent.requests.length === 3);
    const standing = onSessions(session);
    const shown = sessionKeysOf(reading(standing, session, NARROW));
    const beyond = session.agent.requests.find(
      (candidate) => !shown.includes(`sessions:request:${candidate.key}`),
    );
    if (beyond === undefined) {
      throw new Error("every request was inside the first window");
    }
    const scrolled = scrolledTo(standing, session, `sessions:request:${beyond.key}`);
    expect(scrolled.viewports.sessions).toBeGreaterThan(0);

    // Filtering is a different list, so the window starts again at its first
    // row rather than at a number taken against the other one.
    const filtered = acted(scrolled, { kind: "select-session", session: "stub:builder" }, session);
    expect(filtered.viewports.sessions).toBe(0);
    expect(acted(filtered, { kind: "all-sessions" }, session).viewports.sessions).toBe(0);

    // A window cannot be scrolled past the end of the reading it is over, and
    // what is stored is what is being shown: one press back moves it.
    let far = scrolled;
    for (let press = 0; press < 60; press += 1) {
      far = acted(far, { kind: "scroll-sessions", delta: 1 }, session);
    }
    const furthest = far.viewports.sessions;
    const stepped = acted(far, { kind: "scroll-sessions", delta: -1 }, session);
    expect(stepped.viewports.sessions).toBe(furthest - 1);
    expect(sessionKeysOf(reading(stepped, session, NARROW))).not.toEqual(
      sessionKeysOf(reading(far, session, NARROW)),
    );
    // Nothing about any of this reached the location.
    expect(reading(far, session, NARROW).location).not.toContain(String(furthest));
    expect(stub.outcomes.size).toBe(0);
  });

  it("U6: a draft long enough to fill the region still leaves every control placed", function* () {
    const { session } = yield* asking({
      review: { permission: { toolCallId: "call-1", title: "Write", kind: "edit" } },
      build: { streaming: true },
      // One turn runs all the way to its record, so the outlet holds a control
      // whose action is the turn's own — a position in the history that no
      // surface selector can ask for.
      check: {},
    });
    yield* until(session, "all three Prompts being observed", () => observed(session) === 3);
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    yield* until(session, "one turn being recorded", () => recorded(session) === 1);

    // A draft of a thousand characters, which is a location of more than a
    // thousand: at 72 columns that is more rows than the whole narrow region
    // has, so drawing all of it would take every control off the screen while
    // leaving each one mounted, focusable and reachable by nothing.
    const standing = onSessions(session);
    const drafted: ReplState = Object.freeze({
      ...standing,
      draft: "x".repeat(1000),
      route: Object.freeze({ ...standing.route, draft: "x".repeat(1000) }),
    });
    const view = reading(drafted, session, NARROW);
    expect(view.location.length).toBeGreaterThan(1000);

    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, view);
    const frame = layout(NARROW, replSurface(tree, view));
    const body = NARROW.rows - 7;
    expect(frame.cells.filter((cell) => cell.region === "content").length).toBeLessThanOrEqual(
      body,
    );

    // Both ways off this screen are drawn and pointable.
    for (const key of ["sessions:heading", "entries:heading"]) {
      const placed = placedFor(tree, frame, key);
      expect(placed).toBeDefined();
      expect(placed?.targetable).toBe(true);
    }
    expect(yield* pointed(tree, frame, "entries:heading")).toEqual({
      kind: "select-surface",
      surface: "repl",
    });

    // And so is the outlet the route selected — not merely present in it: a
    // control of the reading itself is placed, offered to a pointer, and asks
    // for what that turn asks for.
    const drawn = frame.cells.map((cell) => tree.keyOf(cell.node) ?? "");
    const turns = frame.cells
      .filter((cell) => (tree.keyOf(cell.node) ?? "").startsWith("sessions:turn:"))
      .map((cell) => ({ key: tree.keyOf(cell.node) ?? "", targetable: cell.targetable }));
    expect(turns.length).toBeGreaterThan(0);
    // Every placed turn control is offered to a pointer, and the facts beneath
    // them are not.
    for (const one of turns) {
      expect(one.targetable).toBe(TURN_FACT_SUFFIXES.every((end) => !one.key.endsWith(end)));
    }

    // One of them, activated: the pointer resolved against this exact frame
    // asks for exactly what Enter on it asks for.
    const control = turns.find((one) => one.targetable);
    expect(control).toBeDefined();
    yield* focusTo(tree, control?.key ?? "");
    const pressed = yield* activate(tree);
    expect(yield* pointed(tree, frame, control?.key ?? "")).toEqual(pressed);

    expect(placedFor(tree, frame, "sessions:earlier")).toBeDefined();
    expect(placedFor(tree, frame, "sessions:later")).toBeDefined();
    // The location says what it is not showing rather than showing none of it.
    const location = drawn.filter((key) => key.startsWith("location:"));
    expect(location.length).toBeLessThanOrEqual(3);
    const shown = rowsOf(describeApplication(view))
      .filter((one) => one.key.startsWith("location:"))
      .map((one) => one.label);
    expect(shown.at(0)).toContain("xmd://repl/");
    expect(shown.at(-1)).toContain("more characters");
    // Every row this frame describes is one it places: nothing is mounted with
    // nowhere to be.
    for (const key of keysOf(view).filter((one) => one.startsWith("sessions:"))) {
      expect(placedFor(tree, frame, key)).toBeDefined();
    }

    // And the outlet stays usable at this size rather than merely present: the
    // recorded turn's own control is reached by walking the window, and asks
    // for a position in the history — the one action neither surface selector
    // can ask for.
    const recordedKey = keysSelecting(reading(drafted, session, WIDE), "marker").find((key) =>
      key.startsWith("sessions:turn:"),
    );
    expect(recordedKey).toBeDefined();
    const walked = scrolledTo(drafted, session, recordedKey ?? "");
    const scrolled = reading(walked, session, NARROW);
    yield* applied(tree, scrolled);
    const scrolledFrame = layout(NARROW, replSurface(tree, scrolled));
    expect(placedFor(tree, scrolledFrame, recordedKey ?? "")?.targetable).toBe(true);
    expect((yield* pointed(tree, scrolledFrame, recordedKey ?? "")).kind).toBe("select-marker");
    // Walking it changed no location and took no control off the screen.
    expect(scrolled.location).toBe(view.location);
    for (const key of ["sessions:heading", "entries:heading"]) {
      expect(placedFor(tree, scrolledFrame, key)?.targetable).toBe(true);
    }
  });

  it("U6: a shrinking omission summary repaints cleanly, and is a complete row", function* () {
    const { session } = yield* asking({
      review: { streaming: true },
      build: { streaming: true },
      check: {},
    });
    yield* until(session, "all three Prompts being observed", () => observed(session) === 3);
    yield* until(session, "one turn being recorded", () => recorded(session) === 1);

    // Two drafts whose omission counts have different numbers of digits, so the
    // row that says how much is hidden gets shorter as the draft does. That row
    // is the only location row whose length changes, and these two facts about
    // it are separate: what the terminal ends up showing, and what this
    // application described for it to show.
    const standing = onSessions(session);
    const longer = withDraft(standing, "x".repeat(1200));
    const shorter = withDraft(standing, "x".repeat(1050));

    const tree = yield* useReplTree<ReplAction>();
    const renderer = yield* useReplRenderer(NARROW);
    /** Everything written to this one terminal, in order. */
    const written: Uint8Array[] = [];

    const first = reading(longer, session, NARROW);
    yield* applied(tree, first);
    const before = layout(NARROW, replSurface(tree, first));
    written.push(yield* painted(renderer, before, tree));
    const four = summaryOn(screenFrom(written));
    expect(four).toMatch(/^… \d{4} more characters/);

    // The same terminal, drawn again, with nothing clearing it between the two.
    // What comes back is the shorter summary and nothing of the longer one —
    // measured, and true of this renderer either way: it fills a placed cell to
    // its bounds, so it is not the padding below that makes this pass.
    const second = reading(shorter, session, NARROW);
    yield* applied(tree, second);
    const after = layout(NARROW, replSurface(tree, second));
    written.push(yield* painted(renderer, after, tree));

    const three = summaryOn(screenFrom(written));
    expect(three).toMatch(/^… \d{3} more characters/);

    // And the row this application described is itself a complete row, as wide
    // as the ones around it. This is the assertion that discriminates: the
    // rendered screen above is clean whether or not the summary arrives padded,
    // so it says what this renderer does, while this says what the application
    // owns — the same full-width contract `chunked` gives every other location
    // row, rather than one inherited from whatever draws it.
    const located = rowsOf(describeApplication(second))
      .filter((one) => one.key.startsWith("location:"))
      .map((one) => one.label);
    expect(located.length).toBe(3);
    for (const row of located) {
      expect(row.length).toBe(surfaceWidth(NARROW));
    }
    // Exactly the new summary, with nothing of the longer one left on the end
    // of it: the row is the row, not the row plus whatever it stopped short of.
    const hidden = /… (\d+) more characters/.exec(three)?.[1] ?? "";
    expect(three.trimEnd()).toBe(`… ${hidden} more characters, in a wider window`);
    expect(three.trimEnd().endsWith("window")).toBe(true);

    // And the screen is still one a person can use: both ways off it, and a
    // control of the reading itself.
    for (const key of ["sessions:heading", "entries:heading"]) {
      expect(placedFor(tree, after, key)?.targetable).toBe(true);
    }
    const outlet = after.cells.filter(
      (cell) => (tree.keyOf(cell.node) ?? "").startsWith("sessions:turn:") && cell.targetable,
    );
    expect(outlet.length).toBeGreaterThan(0);
  });

  it("U6: the first press after a resize moves the window, not the stored number", function* () {
    const { session } = yield* asking({
      review: { permission: { toolCallId: "call-1", title: "Write", kind: "edit" } },
      build: { permission: { toolCallId: "call-2", title: "Move", kind: "edit" } },
      check: { permission: { toolCallId: "call-3", title: "Delete", kind: "edit" } },
    });
    yield* until(session, "all three Prompts being observed", () => observed(session) === 3);
    yield* until(session, "all three requests waiting", () => session.agent.requests.length === 3);

    // As far down as the smallest frame goes.
    let at = onSessions(session);
    for (let press = 0; press < 60; press += 1) {
      at = acted(at, { kind: "scroll-sessions", delta: 1 }, session);
    }
    const furthest = at.viewports.sessions;
    expect(furthest).toBeGreaterThan(0);

    // One row taller holds one row more, so the last window starts one row
    // earlier and the frame is already drawing that. The stored number is now
    // past it.
    const taller: ReplTerminalSize = { columns: NARROW.columns, rows: NARROW.rows + 1 };
    const before = sessionKeysOf(reading(at, session, taller));
    const pressed = acted(at, { kind: "scroll-sessions", delta: -1 }, session, taller);
    // Moved, rather than spending the press normalizing state nobody can see.
    expect(sessionKeysOf(reading(pressed, session, taller))).not.toEqual(before);
    expect(pressed.viewports.sessions).toBeLessThan(furthest);
  });
});

describe("U7 — the permission drawer is windowed", () => {
  beforeAll(() => useTempFileCompiler());

  it("U7: every offered choice becomes placed and pointable, in the provider's order", function* () {
    const { session, stub } = yield* asking({
      review: {
        streaming: true,
        permission: {
          toolCallId: "call-1",
          title: "Write",
          kind: "edit",
          options: SEVEN_CHOICES,
        },
      },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }
    expect(request.choices).toHaveLength(SEVEN_CHOICES.length);

    const opened = acted(
      onSessions(session),
      { kind: "select-permission", request: request.key },
      session,
    );
    const tree = yield* useReplTree<ReplAction>();
    // More content than the smallest accepted drawer can place, so the first
    // window is a prefix and the rest is reached by scrolling.
    const firstWindow = drawerKeysOf(reading(opened, session, NARROW));
    expect(firstWindow.length).toBeLessThan(SEVEN_CHOICES.length);

    const reached: string[] = [];
    let at = opened;
    for (let press = 0; press < 20; press += 1) {
      const view = reading(at, session, NARROW);
      yield* applied(tree, view);
      const frame = layout(NARROW, replSurface(tree, view));
      for (const choice of SEVEN_CHOICES) {
        const key = `drawer:permission:choice:${choice.optionId}`;
        const placed = placedFor(tree, frame, key);
        if (placed !== undefined && !reached.includes(choice.optionId)) {
          // Placed means pointable: a choice a person can read is a choice they
          // can take.
          expect(placed.targetable).toBe(true);
          expect(yield* pointed(tree, frame, key)).toEqual({
            kind: "choose-permission",
            request: request.key,
            option: choice.optionId,
          });
          reached.push(choice.optionId);
        }
      }
      // Leaving is never scrolled away from, whatever the window is showing.
      expect(placedFor(tree, frame, "drawer:close")).toBeDefined();
      // What the window is not showing is in no target map at all.
      for (const key of drawerContentKeys) {
        const described = keysOf(view).includes(key);
        if (!described) {
          expect(placedFor(tree, frame, key)).toBe(undefined);
          expect(nodeOf(tree, key)).toBe(undefined);
        }
      }
      if (reached.length === SEVEN_CHOICES.length) {
        break;
      }
      at = acted(at, { kind: "scroll", delta: 1 }, session);
    }
    // Every one of them, in the order the provider offered them.
    expect(reached).toEqual(SEVEN_CHOICES.map((choice) => choice.optionId));

    // And taking one calls the authority exactly once.
    const chose = reduceRepl(
      at,
      { kind: "choose-permission", request: request.key, option: "never" },
      session.model,
      liveReading(session),
      NARROW,
    );
    expect(answer(session, chose.intent)).toBe(true);
    yield* until(session, "the request being answered", () => stub.outcomes.size === 1);
    expect(stub.outcomes.get("call-1")).toEqual({ outcome: "selected", optionId: "never" });
    expect(stub.answers.get("call-1")).toBe(1);
    // The window over it is gone with it: the next request opens at its own
    // first row.
    expect(permissionSettled(chose.state, request.turn).viewports.permission).toBe(0);
  });

  it("U7: closing a scrolled drawer denies exactly once", function* () {
    const { session, stub } = yield* asking({
      review: {
        streaming: true,
        permission: {
          toolCallId: "call-1",
          title: "Write",
          kind: "edit",
          options: SEVEN_CHOICES,
        },
      },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }
    let at = acted(
      onSessions(session),
      { kind: "select-permission", request: request.key },
      session,
    );
    at = acted(at, { kind: "scroll", delta: 1 }, session);
    at = acted(at, { kind: "scroll", delta: 1 }, session);
    expect(at.viewports.permission).toBeGreaterThan(0);

    const tree = yield* useReplTree<ReplAction>();
    const view = reading(at, session, NARROW);
    yield* applied(tree, view);
    const frame = layout(NARROW, replSurface(tree, view));
    // Still there, whatever the window is showing, and it denies this request
    // rather than meaning "this changed nothing".
    const closing = yield* pointed(tree, frame, "drawer:close");
    expect(closing).toEqual({ kind: "dismiss-permission", request: request.key });
    const dismissed = reduceRepl(at, closing, session.model, liveReading(session), NARROW);
    expect(answer(session, dismissed.intent)).toBe(true);
    yield* until(session, "the request being denied", () => stub.outcomes.size === 1);
    expect(stub.answers.get("call-1")).toBe(1);
    expect(session.permissions.dismiss(request.key)).toBe(false);
    expect(stub.answers.get("call-1")).toBe(1);
    expect(session.live).toBe(true);
  });

  it("U7: the first press after a resize moves the drawer, not the stored number", function* () {
    const { session } = yield* asking({
      review: {
        streaming: true,
        permission: {
          toolCallId: "call-1",
          title: "Write",
          kind: "edit",
          options: SEVEN_CHOICES,
        },
      },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }
    let at = acted(
      onSessions(session),
      { kind: "select-permission", request: request.key },
      session,
    );
    for (let press = 0; press < 20; press += 1) {
      at = acted(at, { kind: "scroll", delta: 1 }, session);
    }
    const furthest = at.viewports.permission;
    expect(furthest).toBeGreaterThan(0);

    // One row taller holds one row more, so the last window starts one row
    // earlier and the drawer is already showing that. The stored number is now
    // past it, and the first press has to move what is drawn.
    const taller: ReplTerminalSize = { columns: NARROW.columns, rows: NARROW.rows + 1 };
    const before = drawerWindowOf(reading(at, session, taller));
    const pressed = acted(at, { kind: "scroll", delta: -1 }, session, taller);
    expect(drawerWindowOf(reading(pressed, session, taller))).not.toEqual(before);
    expect(pressed.viewports.permission).toBeLessThan(furthest);
  });
});

describe("U8 — a target is a control, whatever its key is spelled", () => {
  beforeAll(() => useTempFileCompiler());

  it("U8: values named like a turn's facts are still pointer-equivalent to Enter", function* () {
    // Conversations named after the suffixes a turn's own read-only facts carry,
    // and options named the same way: a rule about spelling would take the
    // pointer away from every one of them.
    const { session } = yield* asking(
      {
        review: {
          streaming: true,
          permission: {
            toolCallId: "call-1",
            title: "Write",
            kind: "edit",
            options: NAMED_LIKE_FACTS,
          },
        },
        build: { streaming: true },
      },
      "approve-reads",
      SPAWNS_NAMED_LIKE_FACTS,
    );
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }

    const standing = onSessions(session);
    const tree = yield* useReplTree<ReplAction>();
    const view = reading(standing, session, WIDE);
    yield* applied(tree, view);
    const frame = layout(WIDE, replSurface(tree, view));

    // A conversation whose provider key ends in `:text`.
    const conversation = "sessions:conversation:stub:text";
    expect(keysOf(view)).toContain(conversation);
    yield* focusTo(tree, conversation);
    const pressed = yield* activate(tree);
    expect(pressed).toEqual({ kind: "select-session", session: "stub:text" });
    expect(yield* pointed(tree, frame, conversation)).toEqual(pressed);

    // And every option named after one of those facts.
    const opened = acted(standing, { kind: "select-permission", request: request.key }, session);
    const drawer = reading(opened, session, WIDE);
    yield* applied(tree, drawer);
    const drawerFrame = layout(WIDE, replSurface(tree, drawer));
    for (const choice of NAMED_LIKE_FACTS) {
      const key = `drawer:permission:choice:${choice.optionId}`;
      yield* focusTo(tree, key);
      const chose = yield* activate(tree);
      expect(chose).toEqual({
        kind: "choose-permission",
        request: request.key,
        option: choice.optionId,
      });
      expect(yield* pointed(tree, drawerFrame, key)).toEqual(chose);
    }
  });

  it("U8: a fact is read, not activated, wherever it is drawn", function* () {
    const { session } = yield* asking({
      review: {
        streaming: true,
        permission: { toolCallId: "call-1", title: "Write", kind: "edit" },
      },
      build: { streaming: true },
      check: { queued: true },
    });
    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);
    const request = session.agent.requests[0];
    if (request === undefined) {
      throw new Error("no request was published");
    }
    const tree = yield* useReplTree<ReplAction>();

    // On the REPL surface the pending request is a fact: the grammar answers one
    // on Sessions, so a control here would be a target that refuses.
    const onRepl = reading(initialState("agents"), session, WIDE);
    yield* applied(tree, onRepl);
    const replFrame = layout(WIDE, replSurface(tree, onRepl));
    const fact = placedFor(tree, replFrame, `sessions:request:${request.key}`);
    expect(fact).toBeDefined();
    expect(fact?.targetable).toBe(false);

    // Inside the drawer, what a person decides *about* is read the same way.
    const opened = acted(
      onSessions(session),
      { kind: "select-permission", request: request.key },
      session,
    );
    const drawer = reading(opened, session, WIDE);
    yield* applied(tree, drawer);
    const drawerFrame = layout(WIDE, replSurface(tree, drawer));
    for (const key of drawerContentKeys) {
      const placed = placedFor(tree, drawerFrame, key);
      expect(placed).toBeDefined();
      expect(placed?.targetable).toBe(false);
    }
    // A turn's own facts and a retained audit are lines wherever they appear.
    const sessions = reading(onSessions(session), session, WIDE);
    yield* applied(tree, sessions);
    const sessionsFrame = layout(WIDE, replSurface(tree, sessions));
    for (const cell of sessionsFrame.cells) {
      const key = tree.keyOf(cell.node) ?? "";
      if (TURN_FACT_SUFFIXES.some((suffix) => key.endsWith(suffix))) {
        expect(cell.targetable).toBe(false);
      }
    }
  });
});

/**
 * Wait until the screen shows this text, or say it never did.
 *
 * Bounded by time rather than by attempts: reaching a question runs a document,
 * spawns three children and asks a provider, and how long that takes is not a
 * number of turns.
 */
function* showing(terminal: Terminal, expected: string): Operation<void> {
  const deadline = Date.now() + DEADLOCK_MS;
  while (!shows(terminal, expected)) {
    if (Date.now() > deadline) {
      throw new Error(`the screen never showed ${expected}`);
    }
    yield* sleep(5);
    yield* settled(10);
  }
}

/** Wait until the provider has been told one decision, or say it never was. */
function* answered(stub: Stub, toolCallId: string): Operation<void> {
  const deadline = Date.now() + DEADLOCK_MS;
  while (!stub.outcomes.has(toolCallId)) {
    if (Date.now() > deadline) {
      throw new Error(`the provider was never told what was decided about ${toolCallId}`);
    }
    yield* sleep(5);
    yield* settled(10);
  }
}

/**
 * Tab until the row containing this text holds focus.
 *
 * Through the terminal, because that is how a person reaches a control: there is
 * no host shortcut, and the marker on the focused row is how anybody knows where
 * they are.
 */
function* pressUntil(terminal: Terminal, label: string): Operation<void> {
  for (let press = 0; press < 200; press += 1) {
    if (focusedOn(terminal, label)) {
      return;
    }
    terminal.feed("\t");
    yield* settled(6);
  }
  throw new Error(`focus never reached ${label}`);
}

/**
 * The program harness, mirrored from the journey suite.
 *
 * Copied rather than shared, because there is no shared harness module and this
 * slice owns no new fixture. What it buys is the real boundary: the row below
 * drives `runReplProgram()`, so a permission intent is performed by the program's
 * own `perform()` and answered by the session's own authority.
 */
const BYTES = new TextEncoder();
const TEXT = new TextDecoder();

/** Let every task that is ready take its turn. */
function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
}

/** A clock the test moves, so nothing in this suite waits on real time. */
function immediateClock(): Operation<void> {
  return ReplClock.around(
    {
      // deno-lint-ignore require-yield
      *now(): Operation<number> {
        return 0;
      },
      // deno-lint-ignore require-yield
      *wait(): Operation<void> {
        // Returns at once: this product draws when something changed, so the
        // frame interval is the only thing being skipped.
      },
    },
    { at: "min" },
  );
}

/** A terminal the test drives completely. */
interface Terminal {
  /** Everything ever presented, in order. */
  readonly presented: Uint8Array[];
  /**
   * When set, the next presentation blocks here until it is released.
   *
   * The seam the frame-order control needs: while a frame is being written, the
   * stream must not have been told that frame was applied.
   */
  holdPresent: { release(): void } | undefined;
  size: ReplTerminalSize;
  readonly raw: boolean[];
  resets: number;
  listeners: number;
  readers: number;
  feed(text: string): void;
  bytes(raw: Uint8Array): void;
  /** Make the next presentation block, so a test can look at the frame stream. */
  holdNextPresent(): void;
  resized(size: ReplTerminalSize): void;
  end(): void;
}

function recordingTerminal(
  size: ReplTerminalSize = { columns: 160, rows: 36 },
  interactive = true,
): {
  terminal: Terminal;
  install(): Operation<void>;
} {
  const queue: Uint8Array[] = [];
  const watchers = new Set<() => void>();
  let waiting: ((result: IteratorResult<Uint8Array, undefined>) => void) | undefined;
  let ended = false;

  let holding = false;
  const terminal: Terminal = {
    presented: [],
    holdPresent: undefined,
    size,
    raw: [],
    resets: 0,
    listeners: 0,
    readers: 0,
    feed(text: string): void {
      terminal.bytes(BYTES.encode(text));
    },
    holdNextPresent(): void {
      holding = true;
    },
    bytes(raw: Uint8Array): void {
      const resolve = waiting;
      if (resolve === undefined) {
        queue.push(raw);
        return;
      }
      waiting = undefined;
      resolve({ done: false, value: raw });
    },
    resized(next: ReplTerminalSize): void {
      terminal.size = next;
      for (const watcher of watchers) {
        watcher();
      }
    },
    end(): void {
      ended = true;
      const resolve = waiting;
      if (resolve !== undefined) {
        waiting = undefined;
        resolve({ done: true, value: undefined });
      }
    },
  };

  const host: ReplTerminalCapabilities = {
    interactive: () => interactive,
    size: () => terminal.size,
    write(bytes: Uint8Array): Promise<void> {
      terminal.presented.push(new Uint8Array(bytes));
      if (!holding) {
        return Promise.resolve();
      }
      holding = false;
      return new Promise<void>((resolve) => {
        terminal.holdPresent = { release: resolve };
      });
    },
    writeNow(): void {
      terminal.resets += 1;
    },
    setRaw(raw: boolean): void {
      terminal.raw.push(raw);
    },
    bytes(): AsyncIterable<Uint8Array> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array, undefined> {
          terminal.readers += 1;
          return {
            next(): Promise<IteratorResult<Uint8Array, undefined>> {
              const head = queue.shift();
              if (head !== undefined) {
                return Promise.resolve({ done: false, value: head });
              }
              if (ended) {
                return Promise.resolve({ done: true, value: undefined });
              }
              return new Promise((resolve) => {
                waiting = resolve;
              });
            },
            return(): Promise<IteratorResult<Uint8Array, undefined>> {
              terminal.readers -= 1;
              const resolve = waiting;
              waiting = undefined;
              resolve?.({ done: true, value: undefined });
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };
    },
    onResize(listener: () => void): () => void {
      watchers.add(listener);
      terminal.listeners += 1;
      return () => {
        watchers.delete(listener);
        terminal.listeners -= 1;
      };
    },
  };

  return { terminal, install: () => installReplTerminal(host) };
}

/** A REPL host over a temporary directory nothing else uses. */
function* useTemporaryHost(): Operation<string> {
  const root = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-agents-")));
  yield* installReplHost({
    dataRoot: () => root,
    identify: () => randomBytes(8).toString("hex"),
    createExclusive: (path) => open(path, "wx").then((handle) => handle.close()),
    appendRecord: (path, record) => appendFile(path, record),
  });
  return root;
}

/**
 * What the screen says, by replaying what was written to it.
 *
 * A real buffer rather than the bytes with escapes stripped, because this
 * renderer writes *diffs*: it moves the cursor to what changed and writes only
 * that. Concatenating the diffs gives characters in the order they were written
 * rather than the order they appear, and a character the previous frame already
 * had is not written again at all — so stripped bytes read as words with letters
 * missing. Interpreting the cursor moves is what makes an assertion about the
 * screen an assertion about the screen.
 */
function screenOf(terminal: Terminal): string[] {
  return screenFrom(terminal.presented);
}

/**
 * Replay written bytes into the rows a terminal would be showing.
 *
 * One buffer across every chunk, because that is what a terminal is: a renderer
 * writes what changed, and what it did not write is still whatever was there.
 * Reading the rows back is how a test sees the screen a person sees rather than
 * the row an application described.
 */
function screenFrom(chunks: readonly Uint8Array[]): string[] {
  const rows: string[][] = [];
  let row = 0;
  let column = 0;

  const put = (character: string): void => {
    while (rows.length <= row) {
      rows.push([]);
    }
    const line = rows[row];
    while (line.length < column) {
      line.push(" ");
    }
    line[column] = character;
    column += 1;
  };

  const written = chunks.map((bytes) => TEXT.decode(bytes)).join("");
  for (let index = 0; index < written.length; index += 1) {
    const character = written[index];
    if (character !== "\u001B") {
      if (character === "\n") {
        row += 1;
        column = 0;
      } else if (character === "\r") {
        column = 0;
      } else {
        put(character);
      }
      continue;
    }
    // CSI: the only sequences this renderer uses to position and to clear.
    const csi = /^\u001B\[([0-9;]*)([@-~])/.exec(written.slice(index));
    if (csi !== null) {
      const parameters = csi[1].split(";").map((one) => (one === "" ? 0 : Number(one)));
      if (csi[2] === "H") {
        row = Math.max(0, (parameters[0] ?? 1) - 1);
        column = Math.max(0, (parameters[1] ?? 1) - 1);
      } else if (csi[2] === "J") {
        rows.length = 0;
        row = 0;
        column = 0;
      }
      index += csi[0].length - 1;
      continue;
    }
    // OSC, and the two-byte escapes. Neither carries anything readable.
    const osc = /^\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/.exec(written.slice(index));
    if (osc !== null) {
      index += osc[0].length - 1;
      continue;
    }
    index += 1;
  }
  return rows.map((line) => line.join(""));
}

/**
 * The canonical location the screen is showing, if it has drawn one yet.
 *
 * Reassembled, because a location carrying a draft is longer than a row and the
 * screen shows it as consecutive rows. Which rows belong to it is decided by the
 * grammar rather than by counting: the longest run that decodes *is* the location,
 * and a shorter prefix of it decodes to a different route or to nothing.
 */
function maybeLocation(terminal: Terminal): string | undefined {
  const rows = screenOf(terminal);
  const first = rows.findIndex((line) => line.includes("xmd://repl/"));
  if (first === -1) {
    return undefined;
  }
  const at = rows[first].indexOf("xmd://repl/");
  const parts: string[] = [];
  for (let row = first; row < rows.length && row < first + 24; row += 1) {
    const part = (rows[row] ?? "").slice(at, at + surfaceWidth(terminal.size));
    if (part.trim().length === 0) {
      break;
    }
    parts.push(part.trimEnd());
  }

  // The rows below a location belong to whatever is drawn under it, and a row that
  // used to hold a longer location can still have that tail on the end. So the
  // answer is the longest prefix that *round-trips*: the grammar accepts some
  // trailing junk inside a drawer segment, but re-encoding what it decoded only
  // reproduces the prefix that really was the location.
  const joined = parts.join("");
  let found: string | undefined;
  for (let length = joined.length; length > "xmd://repl/".length; length -= 1) {
    const candidate = joined.slice(0, length);
    const decoded = decodeLocation(candidate);
    if (decoded.ok && encodeLocation(decoded.value) === candidate) {
      found = candidate;
      break;
    }
  }
  return found;
}

/**
 * Whether the control holding focus is the one this label names.
 *
 * Anchored to the marker rather than matched anywhere on the line, because a
 * line of this screen crosses three columns: the sidebar, the transcript and the
 * inspection column all write to the same rows, so a label found *somewhere* on
 * a line with a marker on it is usually a different control in a different column.
 * The marker is searched for at any position for the same reason — a focused
 * control in the inspection column has the sidebar's text to the left of it.
 */
function focusedOn(terminal: Terminal, label: string): boolean {
  for (const line of screenOf(terminal)) {
    for (let at = line.indexOf(">"); at !== -1; at = line.indexOf(">", at + 1)) {
      if (
        line
          .slice(at + 1)
          .trimStart()
          .startsWith(label)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Whether any row of the screen contains this text. */
function shows(terminal: Terminal, expected: string): boolean {
  return screenOf(terminal).some((line) => line.includes(expected));
}

/**
 * Wait until the first frame has been drawn.
 *
 * The command opens a terminal, a repository and a session before it can draw
 * anything, and how long that takes is not a number of turns — so every test
 * that reads the screen waits for it rather than assuming.
 */
function* untilDrawn(terminal: Terminal): Operation<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (maybeLocation(terminal) !== undefined) {
      return;
    }
    yield* sleep(10);
    yield* settled(10);
  }
  throw new Error(
    `the screen never drew its first frame. frames=${terminal.presented.length} rows=` +
      JSON.stringify(
        screenOf(terminal)
          .map((l) => l.trimEnd())
          .filter((l) => l.trim().length > 0),
      ),
  );
}

/**
 * One Prompt in one conversation, written at the same place whatever it asks.
 *
 * The two spellings differ only inside the quotes, so each entry's Prompt sits at
 * the same offset and both are journaled under the same durable name. That is
 * ordinary rather than damaged — a durable name says where a Prompt was written,
 * and every entry is its own execution — and it is the collision this row exists
 * for.
 */
function onePromptAt(text: string): string {
  return `<Session name="planner"><Prompt text="${text}" /></Session>\n`;
}

describe("U9 — two entries whose Prompts share one durable name", () => {
  beforeAll(() => useTempFileCompiler());

  it("U9: each entry's turn shows once and resolves to its own record", function* () {
    const stub = createStub({ two: { unrecorded: true } });
    yield* useStub(stub);
    const holder = execution();
    const session = granted(
      yield* submitReplEntry({
        execution: holder,
        installations: installations(),
        permissionMode: "deny-all",
        source: onePromptAt("one"),
      }),
    );
    yield* until(session, "the first entry's turn being recorded", () => recorded(session) === 1);
    yield* session.join();

    const started = yield* session.submit(onePromptAt("two"));
    expect(started.ok).toBe(true);
    yield* until(session, "the second entry's turn reaching its terminal event", () =>
      session.agent.turns.some((turn) => turn.state === "terminal"),
    );

    // The one moment the two are most easily confused: the first entry's turn is
    // durable, the second entry's is terminal and unrecorded, and both are
    // mounted.
    const before = reading(initialState("agents"), session);
    expect(turnRows(before)).toHaveLength(2);
    const firstRow = turnKeyed(before, "one");
    const secondRow = turnKeyed(before, "two");
    expect(firstRow).not.toBe(secondRow);
    expect(labelOf(before, "one")).toContain("completed, recorded");
    expect(labelOf(before, "two")).toContain("not recorded yet");

    stub.record("root");
    yield* until(session, "the second entry's turn being recorded", () => recorded(session) === 2);
    yield* session.join();

    // The hazard, stated: one durable name, two entries, two records.
    const [first, last] = session.model.turns;
    expect(first.name).toBe(last.name);
    expect([first.entry, last.entry]).toEqual(["entry-1", "entry-2"]);
    // Their history positions are namespaced, so the two places a reader can go to
    // are distinct and each names its own entry's record.
    expect(first.marker).not.toBe(last.marker);
    expect(first.marker.startsWith("entry-")).toBe(false);
    expect(last.marker.startsWith("entry-2:")).toBe(true);

    const after = reading(initialState("agents"), session);
    // Each turn exactly once — two rows, rather than one record shown twice and
    // the other not at all.
    expect(turnRows(after)).toHaveLength(2);
    expect(labelOf(after, "one")).toContain("completed, recorded");
    expect(labelOf(after, "two")).toContain("completed, recorded");
    // Each row resolved to its own entry's record, so each shows its own prompt
    // and its own text.
    expect(detailOf(after, "one", "text")).toContain("one done");
    expect(detailOf(after, "two", "text")).toContain("two done");
    // Publication preserved each mounted slot: the rows a person was reading a
    // moment ago are the rows they are reading now.
    expect(turnKeyed(after, "one")).toBe(firstRow);
    expect(turnKeyed(after, "two")).toBe(secondRow);
    // And the conversation the provider named is still one conversation, holding
    // both entries' turns.
    expect(conversationRows(after)).toEqual(["sessions:conversation:stub:planner"]);
    expect(session.model.sessions.map((one) => one.sessionKey)).toEqual(["stub:planner"]);
    expect(session.model.sessions[0]?.turns).toHaveLength(2);
  });
});
