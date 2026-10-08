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
  ensure,
  race,
  resource,
  scoped,
  sleep,
  spawn,
  until as untilResolved,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Result, Stream, Subscription } from "effection";
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
import { readRecords } from "../src/repl/journal.ts";
import { readdir } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import type { ReplModel } from "../src/repl/model.ts";
import {
  focusClaim,
  focusSettled,
  initialState,
  permissionSettled,
  reduceRepl,
  presentationFor,
  viewFor,
} from "../src/repl/application.ts";
import type {
  ReplAction,
  ReplIntent,
  ReplLive,
  ReplState,
  ReplView,
} from "../src/repl/application.ts";
import { flatten, inspectionWidth, NARROW, sidebarWidth } from "../src/repl/layout.ts";
import type { ReplBounds, ReplRegion } from "../src/repl/layout.ts";
import type { ReplAdmission } from "../src/repl/layout-admission.ts";
import type { ReplPresentationContext } from "../src/repl/application.ts";
import { commitReplFrame } from "../src/repl/program.ts";
import type { ReplCommitted } from "../src/repl/program.ts";
import { createGrid, committedContext } from "./fixtures/repl/presentation.ts";
import { decodeLocation, encodeLocation, NO_LIVE, resolveLocation } from "../src/repl/route.ts";
import type { ReplRoute } from "../src/repl/route.ts";
import { installReplHost } from "../src/repl-assembly.ts";
import { installReplTerminal } from "../src/repl/terminal-host.ts";
import type { ReplTerminalCapabilities } from "../src/repl/terminal-host.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { ReplClock } from "../src/repl/frame.ts";
import { runReplProgram } from "../src/repl/program.ts";
import type { ReplExecutionProfile } from "../src/repl-profile.ts";
import type { ReplOutcome } from "../src/repl/program.ts";
import { appendFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fields, readDescription } from "../src/repl/description.ts";
import type { ReplDescription } from "../src/repl/description.ts";
import { useReplRenderer } from "../src/repl/renderer.ts";
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
    running: session.live,
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

/**
 * Measure one view with a real engine pair, as the product does.
 *
 * A window's rows are the rows the measurement left room for, so a test asking
 * what a view describes has to measure it.
 */
function* measuring<T>(
  size: ReplTerminalSize,
  engine: ReplRenderer | undefined,
  body: (renderer: ReplRenderer) => Operation<T>,
): Operation<T> {
  if (engine !== undefined) {
    return yield* body(engine);
  }
  return yield* scoped(function* (): Operation<T> {
    return yield* body(yield* useReplRenderer(size));
  });
}

/** What one view's frame settled on: its measured widths and its admission. */
function* contextOf(view: ReplView, engine?: ReplRenderer): Operation<ReplPresentationContext> {
  return yield* measuring(view.size, engine, (renderer) => committedContext(renderer, view));
}

/** The described rows of one view, measured. */
function* describedBy(view: ReplView, engine?: ReplRenderer) {
  return rowsOf(presentationFor(view, yield* contextOf(view, engine)).descriptions);
}

/**
 * What this state admits at this size, which is what a scroll moves within.
 *
 * Measured for the state the action is answered at, which is what the program
 * does before it reduces: a window moves within the capacity the screen is
 * showing, not one left over from an earlier size or reading.
 */
function* admissionOf(
  state: ReplState,
  session: ReplSession,
  size = NARROW,
  model: ReplModel = session.model,
  engine?: ReplRenderer,
): Operation<ReplAdmission> {
  const view = reading(state, session, size, undefined, model);
  return (yield* contextOf(view, engine)).admission;
}

/** The keys this state describes, in order. */
function* keysOf(view: ReplView, engine?: ReplRenderer): Operation<string[]> {
  return (yield* describedBy(view, engine)).map((one) => one.key);
}

/**
 * One committed frame, as a test reads it back.
 *
 * Everything here comes from the frame that was drawn: which boxes the manifest
 * placed, which of them mounted a live node, the geometry the engine gave each
 * one, and the bytes it wrote.
 */
interface Frame {
  readonly committed: ReplCommitted;
  /** The bytes this frame presented. */
  readonly bytes: Uint8Array;
  /** The live node one placed key mounted, or none. */
  node(key: string): string | undefined;
  /** Whether this frame placed that key and offered it to a pointer. */
  targetable(key: string): boolean;
  /** The cell one placed row contributed. */
  cell(key: string): string | undefined;
  /** Where one placed row's own cell landed. */
  boundsOf(key: string): ReplBounds | undefined;
  /** The keys this frame placed in one region, in placement order. */
  inRegion(name: ReplRegion): string[];
  /** Where one named region landed. */
  region(name: ReplRegion): ReplBounds | undefined;
  /** Every key this frame placed. */
  readonly keys: readonly string[];
}

/** Mount one view and draw it, exactly the way the program does. */
function* drawn(
  tree: ReplTree<ReplAction>,
  view: ReplView,
  engine?: ReplRenderer,
): Operation<Frame> {
  const committed = yield* measuring(view.size, engine, (renderer) =>
    commitReplFrame(tree, renderer, view, 0, undefined),
  );
  if (!committed.ok) {
    throw committed.error;
  }
  const mounted = new Set(tree.mounted());
  const nodeByKey = new Map<string, string>();
  for (const node of mounted) {
    const key = tree.keyOf(node);
    if (key !== undefined) {
      nodeByKey.set(key, node);
    }
  }
  const placed: Array<{ key: string; node: string; control: boolean; region?: ReplRegion }> = [];
  for (const box of flatten(committed.value.manifest.root)) {
    if (box.key === undefined) {
      continue;
    }
    const node = nodeByKey.get(box.key);
    if (node !== undefined) {
      placed.push({ key: box.key, node, control: box.control, region: box.region });
    }
  }
  const byKey = new Map(placed.map((one) => [one.key, one]));
  const { map } = committed.value.rendered;
  return {
    committed: committed.value,
    bytes: committed.value.rendered.output,
    node: (key: string) => byKey.get(key)?.node,
    targetable: (key: string) => byKey.get(key)?.control === true,
    cell(key: string) {
      const node = byKey.get(key)?.node;
      if (node === undefined) {
        return undefined;
      }
      return tree.frame().cells.find((one) => one.node === node)?.cell;
    },
    boundsOf(key: string) {
      const node = byKey.get(key)?.node;
      return node === undefined ? undefined : map.boundsOf(node);
    },
    inRegion: (name: ReplRegion) =>
      placed.filter((one) => one.region === name).map((one) => one.key),
    region(name: ReplRegion) {
      const found = committed.value.manifest.regions.find((one) => one.region === name);
      return found === undefined ? undefined : map.regionOf(found.id);
    },
    keys: Object.freeze(placed.map((one) => one.key)),
  };
}

/** Commit one view into the real tree, refusing to assert past a rejected set. */
function* applied(
  tree: ReplTree<ReplAction>,
  view: ReplView,
  engine?: ReplRenderer,
): Operation<void> {
  yield* drawn(tree, view, engine);
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

/**
 * Point at one key the way the renderer's map resolves a pointer.
 *
 * Through the frame rather than through the tree: a row the frame did not place,
 * or placed and did not offer, is not in the map at all, so reaching for the
 * node directly would prove something no pointer can do.
 */
function* pointed(tree: ReplTree<ReplAction>, frame: Frame, key: string): Operation<ReplAction> {
  const node = frame.node(key);
  if (node === undefined) {
    throw new Error(`this frame placed no cell for ${key}`);
  }
  if (!frame.targetable(key)) {
    throw new Error(`${key} is placed but is in no target map`);
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

/** One action, reduced at one size, refusing to carry a refusal forward. */
function* acted(
  state: ReplState,
  action: ReplAction,
  session: ReplSession,
  size = NARROW,
  engine?: ReplRenderer,
): Operation<ReplState> {
  // Measured for the state this action is answered at, which is what the program
  // does before it reduces.
  const view = reading(state, session, size);
  const next = reduceRepl(
    state,
    action,
    session.model,
    liveReading(session),
    (yield* contextOf(view, engine)).admission,
  );
  if (next.state.refusal !== undefined) {
    throw new Error(`${action.kind} was refused: ${next.state.refusal}`);
  }
  return next.state;
}

/** The Sessions rows this view describes, in order. */
function* sessionKeysOf(view: ReplView, engine?: ReplRenderer): Operation<string[]> {
  return (yield* keysOf(view, engine)).filter(
    (key) =>
      key.startsWith("sessions:") &&
      key !== "sessions:heading" &&
      key !== "sessions:earlier" &&
      key !== "sessions:later",
  );
}

/** The permission choices this view's drawer describes, in order. */
function* drawerKeysOf(view: ReplView, engine?: ReplRenderer): Operation<string[]> {
  return (yield* keysOf(view, engine)).filter((key) => key.startsWith("drawer:permission:choice:"));
}

/** The same state carrying one draft, which is where a location gets long. */
function withDraft(state: ReplState, draft: string): ReplState {
  return Object.freeze({
    ...state,
    draft,
    route: Object.freeze({ ...state.route, draft }),
  });
}

/**
 * Commit one view through this renderer and keep the bytes it wrote.
 *
 * The same engine across calls, so the display-diff state between two frames is
 * the product's own: what a later frame writes is the difference from the frame
 * before it, which is the whole point of asking.
 */
function* painted(
  renderer: ReplRenderer,
  tree: ReplTree<ReplAction>,
  view: ReplView,
): Operation<Uint8Array> {
  return (yield* drawn(tree, view, renderer)).bytes;
}

/** The row this screen is drawing the draft on. */
function draftRowIn(rows: readonly string[]): string {
  const found = rows.find((row) => row.includes(DRAFT_PROMPT));
  if (found === undefined) {
    throw new Error("the screen is drawing no draft row");
  }
  return found;
}

/** What the draft row is called, which is how this suite finds it. */
const DRAFT_PROMPT = "Draft: ";

/** The keys this view describes with one `select`, which is what a row asks for. */
function* keysSelecting(view: ReplView, select: string): Operation<string[]> {
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
  for (const description of presentationFor(view, yield* contextOf(view)).descriptions) {
    walk(description);
  }
  return found;
}

/** Everything inside the drawer's window, which is what moving it changes. */
function* drawerWindowOf(view: ReplView): Operation<string[]> {
  return (yield* keysOf(view)).filter((key) => key.startsWith("drawer:permission:"));
}

/** Scroll the Sessions window until it is showing this row, or say it never did. */
function* scrolledTo(state: ReplState, session: ReplSession, key: string): Operation<ReplState> {
  let at = state;
  for (let press = 0; press < 60; press += 1) {
    if ((yield* sessionKeysOf(reading(at, session, NARROW))).includes(key)) {
      return at;
    }
    const next = yield* acted(at, { kind: "scroll-sessions", delta: 1 }, session);
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

function* turnRows(view: ReplView): Operation<Array<{ key: string; label: string }>> {
  return (yield* describedBy(view)).filter(
    (one) =>
      one.key.startsWith("sessions:turn:") && !DETAILS.some((suffix) => one.key.endsWith(suffix)),
  );
}

/** Every conversation control this view offers, sorted so order is its own row. */
function* conversationRows(view: ReplView): Operation<string[]> {
  return (yield* describedBy(view))
    .filter((one) => one.key.startsWith("sessions:conversation:"))
    .map((one) => one.key)
    .sort();
}

/**
 * Whether this row's label shows this prompt, whole or shortened to fit.
 *
 * A row is fitted to the width the frame measured for it, and a sidebar is
 * thirty-two columns: a turn whose state takes twenty-seven of them leaves the
 * prompt a couple, marked where it was cut. So a lookup by prompt asks whether
 * the row shows that prompt rather than whether it holds every letter of it.
 */
function showsPrompt(label: string, prompt: string): boolean {
  if (label.includes(prompt)) {
    return true;
  }
  for (let kept = prompt.length - 1; kept >= 1; kept -= 1) {
    if (label.includes(`${prompt.slice(0, kept)}…`)) {
      return true;
    }
  }
  return false;
}

/** The label of the turn control showing this prompt. */
function* labelOf(view: ReplView, prompt: string): Operation<string> {
  const row = (yield* turnRows(view)).find((one) => showsPrompt(one.label, prompt));
  if (row === undefined) {
    throw new Error(`no turn row shows the prompt "${prompt}"`);
  }
  return row.label;
}

/** One of a turn's own detail lines, by suffix, or none when it has none. */
function* detailOf(view: ReplView, prompt: string, suffix: string): Operation<string | undefined> {
  const key = yield* turnKeyed(view, prompt);
  return (yield* describedBy(view)).find((one) => one.key === `${key}:${suffix}`)?.label;
}

/** One turn row's key, by the prompt text its label starts with. */
function* turnKeyed(view: ReplView, prompt: string): Operation<string> {
  const row = (yield* turnRows(view)).find((one) => showsPrompt(one.label, prompt));
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
    expect(yield* turnRows(view)).toHaveLength(3);
    expect(yield* labelOf(view, "review")).toContain("completed, recorded");
    expect(yield* labelOf(view, "build")).toContain("streaming");
    expect(yield* labelOf(view, "check")).toContain("queued");
    // Each started turn says whose it is, and the queued one cannot: the provider
    // has not said which conversation it joined, and the authored
    // `<Session name>` is not an answer to that.
    expect(yield* detailOf(view, "review", "whose")).toContain("stub:reviewer");
    expect(yield* detailOf(view, "build", "whose")).toContain("stub:builder");
    expect(yield* detailOf(view, "check", "whose")).toBe(undefined);
    // So the conversations offered are exactly the two the provider started.
    expect(yield* conversationRows(view)).toEqual([
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
    expect(yield* turnRows(before)).toHaveLength(3);
    expect(yield* labelOf(before, first)).toContain("not recorded yet");
    expect(yield* labelOf(before, last)).toContain("completed, recorded");
    // The earlier turn is still live and the later one is already in the
    // history, and the earlier one is still first. Appending the live list to
    // the retained one would put it last.
    const shown = (yield* turnRows(before)).map((one) => one.label);
    expect(shown.findIndex((label) => showsPrompt(label, first))).toBeLessThan(
      shown.findIndex((label) => showsPrompt(label, last)),
    );

    // Focus the live turn, then let it record underneath the person looking at it.
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, before);
    const mounted = yield* turnKeyed(before, first);
    yield* focusTo(tree, mounted);
    expect(keyed(tree)).toBe(mounted);

    stub.record(coroutineFor(first));
    yield* until(session, `${first} being recorded`, () => recorded(session) === 2);
    const after = reading(initialState("agents"), session, WIDE, keyed(tree));
    // The same node: publication changed where its facts come from, not which
    // turn a person is looking at.
    expect(yield* turnKeyed(after, first)).toBe(mounted);
    expect(yield* turnRows(after)).toHaveLength(3);
    expect(yield* labelOf(after, first)).toContain("completed, recorded");
    // And it is still in the same place, before the one that recorded first.
    const later = (yield* turnRows(after)).map((one) => one.label);
    expect(later.findIndex((label) => showsPrompt(label, first))).toBeLessThan(
      later.findIndex((label) => showsPrompt(label, last)),
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
    expect(yield* conversationOrder(view)).toEqual([
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
      yield* admissionOf(standing, session, WIDE),
    );
    expect(transition.intent.kind).toBe("none");
    expect(transition.state.route).toEqual({
      ...standing.route,
      session: `stub:${whose(later)}`,
    });
    // Only the Sessions rows narrow. The entry, its scopes and the transcript are
    // the same reading they were.
    const filtered = reading(transition.state, session);
    expect((yield* turnRows(filtered)).map((one) => one.label.includes(later))).toEqual([true]);
    expect(
      (yield* keysOf(filtered)).filter(
        (key) => key.startsWith("entry:") || key.startsWith("line:"),
      ),
    ).toEqual(
      (yield* keysOf(view)).filter((key) => key.startsWith("entry:") || key.startsWith("line:")),
    );

    // And All puts every turn back, removing only the filter.
    const cleared = reduceRepl(
      transition.state,
      { kind: "all-sessions" },
      session.model,
      liveReading(session),
      yield* admissionOf(transition.state, session, WIDE),
    );
    expect(cleared.state.route).toEqual(standing.route);
    expect(yield* turnRows(reading(cleared.state, session))).toHaveLength(3);
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
    ).state;
    const before = reading(filtered, session);
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, before);
    const held = yield* turnKeyed(before, earlier);
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
    expect(yield* turnRows(head)).toHaveLength(3);
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
    ).state;
    const at = yield* projectedAt(holder, recordedTurn.marker);
    const past = reading(frozen, session, WIDE, undefined, at);
    expect(yield* turnRows(past)).toHaveLength(1);
    expect(yield* labelOf(past, recordedTurn.input)).toContain("recorded");
    // No live request is reachable there, whatever the head holds.
    expect((yield* keysOf(past)).some((key) => key.startsWith("sessions:request:"))).toBe(false);
    // And a conversation only this process knows about cannot be selected there.
    const refused = reduceRepl(
      frozen,
      { kind: "select-session", session: "stub:checker" },
      at,
      liveReading(session),
      yield* admissionOf(frozen, session, WIDE, at),
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
function* conversationOrder(view: ReplView): Operation<string[]> {
  return (yield* describedBy(view))
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
    const conversation = (yield* conversationOrder(view))[0];
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
      yield* admissionOf(standing, session, WIDE),
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
    expect(yield* keysOf(after)).toContain(`sessions:request:${request.key}`);
    expect(yield* turnKeyed(after, "build")).toBe(`sessions:turn:${request.turn}`);
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

    const opening = reduceRepl(
      standing,
      asked,
      session.model,
      liveReading(session),
      yield* admissionOf(standing, session, WIDE),
    );
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
    const shownRows = (yield* describedBy(drawer)).filter((one) =>
      one.key.startsWith("drawer:permission:choice:"),
    );
    expect(shownRows).toHaveLength(request.choices.length);
    expect(shownRows.find((one) => one.key.endsWith("always"))?.label).toContain(
      "for this Agent session",
    );
    expect(JSON.stringify(shownRows)).not.toContain("machine");

    // Choosing one: the reducer decides, the root calls the authority once.
    yield* applied(tree, drawer);
    yield* focusTo(tree, "drawer:permission:choice:once");
    const chose = yield* activate(tree);
    const settling = reduceRepl(
      opening.state,
      chose,
      session.model,
      liveReading(session),
      yield* admissionOf(opening.state, session, WIDE),
    );
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
      yield* admissionOf(opened, session, WIDE),
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
      const refused = reduceRepl(
        opened,
        action,
        session.model,
        liveReading(session),
        yield* admissionOf(opened, session, WIDE),
      );
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
    const audits = (yield* describedBy(view)).filter((one) =>
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
    expect((yield* keysOf(view)).some((key) => key.startsWith("sessions:request:"))).toBe(false);
  });
});

/** The same state, on the surface a permission is answered from. */
function onSessions(session: ReplSession, state = initialState("agents")): ReplState {
  // No admission: choosing a surface moves no window, so there is nothing for a
  // measured capacity to decide here.
  const moved = reduceRepl(
    state,
    { kind: "select-surface", surface: "sessions" },
    session.model,
    liveReading(session),
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
    const offered = (yield* conversationOrder(reading(all, session, WIDE)))[0];
    if (offered === undefined) {
      throw new Error("no conversation control was drawn");
    }
    const filtered = reduceRepl(
      all,
      { kind: "select-session", session: offered.slice("sessions:conversation:".length) },
      session.model,
      liveReading(session),
      yield* admissionOf(all, session, WIDE),
    ).state;
    expect(filtered.refusal).toBe(undefined);
    const drawered = reduceRepl(
      all,
      { kind: "select-permission", request: request.key },
      session.model,
      liveReading(session),
      yield* admissionOf(all, session, WIDE),
    ).state;

    const placed: Array<{ sessions: string[]; transcript: string[]; inspection: string[] }> = [];
    for (const state of [all, filtered, drawered]) {
      const view = reading(state, session, WIDE);
      const frame = yield* drawn(tree, view);
      // Read off the frame that was drawn: which keys it placed in each region.
      placed.push({
        sessions: frame.inRegion("sidebar").filter((key) => key.startsWith("sessions:")),
        transcript: frame.inRegion("transcript"),
        inspection: frame.inRegion("inspection"),
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
    const frame = yield* drawn(tree, view);

    // Absent, not clipped: the entry list, the transcript and the inspection
    // column are not mounted, so they are in no frame, no target map and no
    // pointer's way.
    const mounted = tree.mounted().map((id) => tree.keyOf(id) ?? "");
    for (const prefix of ["entry:", "scope:", "line:", "binding:", "elicit:"]) {
      expect(mounted.filter((key) => key.startsWith(prefix))).toEqual([]);
      expect((yield* keysOf(view)).filter((key) => key.startsWith(prefix))).toEqual([]);
    }
    // The entry *outlet* is absent; the control that goes to it is not part of
    // that outlet and stays, because a screen a person cannot leave is not one
    // this route may put them on.
    expect(mounted.filter((key) => key.startsWith("entries:"))).toEqual(["entries:heading"]);
    const placed = frame.keys;
    expect(placed.some((key) => key.startsWith("sessions:turn:"))).toBe(true);
    expect(placed).toContain("entries:heading");
    expect(placed.filter((key) => key.startsWith("entry:") || key.startsWith("line:"))).toEqual([]);
    // Every target this frame offers is a control, and every one of them is
    // mounted: nothing offers itself to a pointer and then does nothing.
    for (const key of placed.filter((one) => frame.targetable(one))) {
      expect(frame.node(key)).toBe(nodeOf(tree, key));
      expect(TURN_FACT_SUFFIXES.some((suffix) => key.endsWith(suffix))).toBe(false);
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
    const frame = yield* drawn(tree, view);
    expect(frame.keys.filter((key) => key === "sessions:heading")).toHaveLength(1);
    expect(frame.targetable("sessions:heading")).toBe(true);
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
      yield* admissionOf(standing, session, WIDE),
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
      expect(
        key === "drawer:open" ||
          key.startsWith("drawer:") ||
          key === "footer:history" ||
          key === "footer:exit",
      ).toBe(true);
    }
    // The one History node, reachable from inside rather than duplicated beside.
    expect([...seen]).toContain("footer:history");
    // And the way out, on the same terms: a modal contains focus, so leaving the
    // command has to be reachable from inside it or not at all.
    expect([...seen]).toContain("footer:exit");
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
      const frame = yield* drawn(tree, view);
      // No dedicated location display, at any size: no candidate, no mounted
      // node, and no cell carrying it. The route itself is untouched — hidden is
      // not dropped, and it still encodes exactly as the grammar writes it.
      expect(frame.keys.filter((key) => key.startsWith("location:"))).toEqual([]);
      expect(frame.keys.map((key) => frame.cell(key) ?? "").join("")).not.toContain("xmd://");
      expect(view.location).toBe(encodeLocation(view.state.route));
    }
    // Smaller than narrow draws its refusal and offers nothing to activate.
    const tiny = yield* drawn(
      tree,
      reading(onSessions(session), session, { columns: 40, rows: 10 }),
    );
    expect(tiny.committed.manifest.profile).toBe("too-small");
    expect(tiny.committed.rendered.map.targets).toEqual([]);
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
      // Nothing opened by itself: the request is a fact on its turn, and no
      // drawer is up to answer it with.
      expect(shows(terminal, "[Allow once]")).toBe(false);

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

      // The drawer is gone from the screen, and focus is on the turn that was
      // waiting rather than on whatever opened the drawer.
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
      // pressed: it is off the screen, and focus is back on the turn that was
      // waiting.
      expect(shows(terminal, "Escape or close denies")).toBe(false);
      expect(focusedOn(terminal, "review ·")).toBe(true);

      // And the session is still live: dismissing one request cancelled nothing,
      // so the other conversation is still there to be seen.
      expect(shows(terminal, "build")).toBe(true);
      // And the reading is still the live head rather than a frozen position.
      expect(shows(terminal, "[live]")).toBe(false);
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
      // Arriving opened nothing and moved nobody: no drawer is up.
      expect(shows(terminal, "Escape or close denies")).toBe(false);

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
    const replFrame = yield* drawn(tree, replView);
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
    const onSessionsNow = yield* acted(onRepl, pressed, session);
    expect(onSessionsNow.route.surface).toBe("sessions");
    const sessionsView = reading(onSessionsNow, session, NARROW);
    const sessionsFrame = yield* drawn(tree, sessionsView);
    // The entry outlet is absent; the control that goes to it is not.
    expect(mountedKeys(tree).filter((key) => key.startsWith("entry:"))).toEqual([]);
    expect(mountedKeys(tree).filter((key) => key.startsWith("scope:"))).toEqual([]);
    yield* focusTo(tree, "entries:heading");
    const back = yield* activate(tree);
    expect(back).toEqual({ kind: "select-surface", surface: "entries" });
    expect(yield* pointed(tree, sessionsFrame, "entries:heading")).toEqual(back);
    expect((yield* acted(onSessionsNow, back, session)).route.surface).toBe("entries");
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
    const moved = yield* acted(onRepl, yield* activate(tree), session);
    const sessionsView = reading(moved, session, NARROW);
    yield* applied(tree, sessionsView);
    const key = `sessions:request:${request.key}`;
    const at = yield* scrolledTo(moved, session, key);
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
    const whole = yield* sessionKeysOf(reading(standing, session, WIDE));
    const first = reading(standing, session, NARROW);
    const shown = yield* sessionKeysOf(first);
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
    expect((yield* drawn(tree, first)).node(key)).toBe(undefined);

    // Scrolling reaches it, and the control it becomes is the exact one that
    // answers this request — by pointer, resolved from the frame that drew it.
    const at = yield* scrolledTo(standing, session, key);
    const view = reading(at, session, NARROW);
    const frame = yield* drawn(tree, view);
    const placed = frame.node(key);
    expect(placed).toBeDefined();
    expect(frame.targetable(key)).toBe(true);
    expect(yield* pointed(tree, frame, key)).toEqual({
      kind: "select-permission",
      request: request.key,
    });
    // The window controls never scroll away from whoever is using them.
    expect(frame.node("sessions:earlier")).toBeDefined();
    expect(frame.node("sessions:later")).toBeDefined();
    expect(frame.node("sessions:heading")).toBeDefined();

    // And scrolling back recovers what was there before, rather than leaving a
    // window that only travels one way.
    let back = at;
    for (let press = 0; press < 40 && back.viewports.sessions > 0; press += 1) {
      back = yield* acted(back, { kind: "scroll-sessions", delta: -1 }, session);
    }
    expect(back.viewports.sessions).toBe(0);
    expect(yield* sessionKeysOf(reading(back, session, NARROW))).toEqual(shown);
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
    const shown = yield* sessionKeysOf(reading(standing, session, NARROW));
    const beyond = session.agent.requests.find(
      (candidate) => !shown.includes(`sessions:request:${candidate.key}`),
    );
    if (beyond === undefined) {
      throw new Error("every request was inside the first window");
    }
    const scrolled = yield* scrolledTo(standing, session, `sessions:request:${beyond.key}`);
    expect(scrolled.viewports.sessions).toBeGreaterThan(0);

    // Filtering is a different list, so the window starts again at its first
    // row rather than at a number taken against the other one.
    const filtered = yield* acted(
      scrolled,
      { kind: "select-session", session: "stub:builder" },
      session,
    );
    expect(filtered.viewports.sessions).toBe(0);
    expect((yield* acted(filtered, { kind: "all-sessions" }, session)).viewports.sessions).toBe(0);

    // A window cannot be scrolled past the end of the reading it is over, and
    // what is stored is what is being shown: one press back moves it.
    let far = scrolled;
    for (let press = 0; press < 60; press += 1) {
      far = yield* acted(far, { kind: "scroll-sessions", delta: 1 }, session);
    }
    const furthest = far.viewports.sessions;
    const stepped = yield* acted(far, { kind: "scroll-sessions", delta: -1 }, session);
    expect(stepped.viewports.sessions).toBe(furthest - 1);
    expect(yield* sessionKeysOf(reading(stepped, session, NARROW))).not.toEqual(
      yield* sessionKeysOf(reading(far, session, NARROW)),
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
    const frame = yield* drawn(tree, view);
    const body = NARROW.rows - 7;
    expect(frame.inRegion("content").length).toBeLessThanOrEqual(body);

    // Both ways off this screen are drawn and pointable.
    for (const key of ["sessions:heading", "entries:heading"]) {
      expect(frame.node(key)).toBeDefined();
      expect(frame.targetable(key)).toBe(true);
    }
    expect(yield* pointed(tree, frame, "entries:heading")).toEqual({
      kind: "select-surface",
      surface: "entries",
    });

    // And so is the outlet the route selected — not merely present in it: a
    // control of the reading itself is placed, offered to a pointer, and asks
    // for what that turn asks for.
    const turns = frame.keys
      .filter((key) => key.startsWith("sessions:turn:"))
      .map((key) => ({ key, targetable: frame.targetable(key) }));
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

    expect(frame.node("sessions:earlier")).toBeDefined();
    expect(frame.node("sessions:later")).toBeDefined();
    // The dedicated location shows none of itself and reserves nothing for it:
    // every row of this narrow outlet belongs to the reading.
    expect(frame.keys.filter((key) => key.startsWith("location:"))).toEqual([]);
    // Every row this frame describes is one it places: nothing is mounted with
    // nowhere to be.
    for (const key of (yield* keysOf(view)).filter((one) => one.startsWith("sessions:"))) {
      expect(frame.node(key)).toBeDefined();
    }

    // And the outlet stays usable at this size rather than merely present: the
    // recorded turn's own control is reached by walking the window, and asks
    // for a position in the history — the one action neither surface selector
    // can ask for.
    const recordedKey = (yield* keysSelecting(reading(drafted, session, WIDE), "marker")).find(
      (key) => key.startsWith("sessions:turn:"),
    );
    expect(recordedKey).toBeDefined();
    const walked = yield* scrolledTo(drafted, session, recordedKey ?? "");
    const scrolled = reading(walked, session, NARROW);
    const scrolledFrame = yield* drawn(tree, scrolled);
    expect(scrolledFrame.targetable(recordedKey ?? "")).toBe(true);
    expect((yield* pointed(tree, scrolledFrame, recordedKey ?? "")).kind).toBe("select-marker");
    // Walking it changed no location and took no control off the screen.
    expect(scrolled.location).toBe(view.location);
    for (const key of ["sessions:heading", "entries:heading"]) {
      expect(scrolledFrame.targetable(key)).toBe(true);
    }
  });

  it("U6: a shrinking draft row repaints cleanly, and is a complete row", function* () {
    const { session } = yield* asking({
      review: { streaming: true },
      build: { streaming: true },
      check: {},
    });
    yield* until(session, "all three Prompts being observed", () => observed(session) === 3);
    yield* until(session, "one turn being recorded", () => recorded(session) === 1);

    // Two drafts whose line counts have different numbers of digits, so the row
    // that says how many lines are hidden gets shorter as the draft does. The
    // draft is the row of this screen whose length changes, and these are two
    // separate facts about it: what the terminal ends up showing, and what this
    // application described for it to show.
    const standing = onSessions(session);
    const longer = withDraft(standing, "x\n".repeat(1200));
    const shorter = withDraft(standing, "x\n".repeat(999));

    const tree = yield* useReplTree<ReplAction>();
    const renderer = yield* useReplRenderer(NARROW);
    /** Everything written to this one terminal, in order. */
    const written: Uint8Array[] = [];

    const first = reading(longer, session, NARROW);
    written.push(yield* painted(renderer, tree, first));
    expect(draftRowIn(screenFrom(written))).toContain("[1200 lines]");

    // The same terminal, drawn again, with nothing clearing it between the two.
    // What comes back is the shorter count and nothing of the longer one.
    const second = reading(shorter, session, NARROW);
    written.push(yield* painted(renderer, tree, second));

    const after = draftRowIn(screenFrom(written));
    expect(after).toContain("[999 lines]");
    expect(after).not.toContain("1200");

    // Cell for cell, what a renderer that had never drawn the longer reading
    // produces for the shorter one — blanks and all. This is the assertion that
    // discriminates: a row that kept the tail of the count it used to carry
    // reads the same as this one until the two screens are compared.
    const fresh = yield* scoped(function* (): Operation<readonly string[]> {
      const other = yield* useReplRenderer(NARROW);
      const otherTree = yield* useReplTree<ReplAction>();
      return screenFrom([yield* painted(other, otherTree, reading(shorter, session, NARROW))]);
    });
    expect(screenFrom(written)).toEqual(fresh);

    // And the row this application described is itself a complete row, as wide
    // as the ones around it — the full-width contract the draft shares with
    // every other row of its region, rather than one inherited from whatever
    // draws it.
    const drafted = (yield* describedBy(second)).find((one) => one.key === "footer:input");
    expect(drafted).toBeDefined();
    expect((drafted?.label ?? "").length).toBeGreaterThanOrEqual(NARROW.columns - 2);

    // The dedicated location is drawn nowhere, and reserves nothing: a draft
    // this long would otherwise be the longest thing on the screen.
    expect((yield* describedBy(second)).filter((one) => one.key.startsWith("location:"))).toEqual(
      [],
    );
    expect(screenFrom(written).some((row) => row.includes("xmd://"))).toBe(false);
    // And the route itself is unchanged: hidden is not dropped.
    expect(second.location).toBe(encodeLocation(second.state.route));

    // And the screen is still one a person can use: both ways off it, and a
    // control of the reading itself.
    const usable = yield* drawn(tree, second);
    for (const key of ["sessions:heading", "entries:heading"]) {
      expect(usable.targetable(key)).toBe(true);
    }
    const outlet = usable.keys.filter(
      (key) => key.startsWith("sessions:turn:") && usable.targetable(key),
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
      at = yield* acted(at, { kind: "scroll-sessions", delta: 1 }, session);
    }
    const furthest = at.viewports.sessions;
    expect(furthest).toBeGreaterThan(0);

    // One row taller holds one row more, so the last window starts one row
    // earlier and the frame is already drawing that. The stored number is now
    // past it.
    const taller: ReplTerminalSize = { columns: NARROW.columns, rows: NARROW.rows + 1 };
    const before = yield* sessionKeysOf(reading(at, session, taller));
    const pressed = yield* acted(at, { kind: "scroll-sessions", delta: -1 }, session, taller);
    // Moved, rather than spending the press normalizing state nobody can see.
    expect(yield* sessionKeysOf(reading(pressed, session, taller))).not.toEqual(before);
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

    const opened = yield* acted(
      onSessions(session),
      { kind: "select-permission", request: request.key },
      session,
    );
    const tree = yield* useReplTree<ReplAction>();
    // More content than the smallest accepted drawer can place, so the first
    // window is a prefix and the rest is reached by scrolling.
    const firstWindow = yield* drawerKeysOf(reading(opened, session, NARROW));
    expect(firstWindow.length).toBeLessThan(SEVEN_CHOICES.length);

    const reached: string[] = [];
    let at = opened;
    for (let press = 0; press < 20; press += 1) {
      const view = reading(at, session, NARROW);
      const frame = yield* drawn(tree, view);
      for (const choice of SEVEN_CHOICES) {
        const key = `drawer:permission:choice:${choice.optionId}`;
        const placed = frame.node(key);
        if (placed !== undefined && !reached.includes(choice.optionId)) {
          // Placed means pointable: a choice a person can read is a choice they
          // can take.
          expect(frame.targetable(key)).toBe(true);
          expect(yield* pointed(tree, frame, key)).toEqual({
            kind: "choose-permission",
            request: request.key,
            option: choice.optionId,
          });
          reached.push(choice.optionId);
        }
      }
      // Leaving is never scrolled away from, whatever the window is showing.
      expect(frame.node("drawer:close")).toBeDefined();
      // What the window is not showing is in no target map at all.
      for (const key of drawerContentKeys) {
        const described = (yield* keysOf(view)).includes(key);
        if (!described) {
          expect(frame.node(key)).toBe(undefined);
          expect(nodeOf(tree, key)).toBe(undefined);
        }
      }
      if (reached.length === SEVEN_CHOICES.length) {
        break;
      }
      at = yield* acted(at, { kind: "scroll", delta: 1 }, session);
    }
    // Every one of them, in the order the provider offered them.
    expect(reached).toEqual(SEVEN_CHOICES.map((choice) => choice.optionId));

    // And taking one calls the authority exactly once.
    const chose = reduceRepl(
      at,
      { kind: "choose-permission", request: request.key, option: "never" },
      session.model,
      liveReading(session),
      yield* admissionOf(at, session, NARROW),
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
    let at = yield* acted(
      onSessions(session),
      { kind: "select-permission", request: request.key },
      session,
    );
    at = yield* acted(at, { kind: "scroll", delta: 1 }, session);
    at = yield* acted(at, { kind: "scroll", delta: 1 }, session);
    expect(at.viewports.permission).toBeGreaterThan(0);

    const tree = yield* useReplTree<ReplAction>();
    const view = reading(at, session, NARROW);
    const frame = yield* drawn(tree, view);
    // Still there, whatever the window is showing, and it denies this request
    // rather than meaning "this changed nothing".
    const closing = yield* pointed(tree, frame, "drawer:close");
    expect(closing).toEqual({ kind: "dismiss-permission", request: request.key });
    const dismissed = reduceRepl(
      at,
      closing,
      session.model,
      liveReading(session),
      yield* admissionOf(at, session, NARROW),
    );
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
    let at = yield* acted(
      onSessions(session),
      { kind: "select-permission", request: request.key },
      session,
    );
    for (let press = 0; press < 20; press += 1) {
      at = yield* acted(at, { kind: "scroll", delta: 1 }, session);
    }
    const furthest = at.viewports.permission;
    expect(furthest).toBeGreaterThan(0);

    // One row taller holds one row more, so the last window starts one row
    // earlier and the drawer is already showing that. The stored number is now
    // past it, and the first press has to move what is drawn.
    const taller: ReplTerminalSize = { columns: NARROW.columns, rows: NARROW.rows + 1 };
    const before = yield* drawerWindowOf(reading(at, session, taller));
    const pressed = yield* acted(at, { kind: "scroll", delta: -1 }, session, taller);
    expect(yield* drawerWindowOf(reading(pressed, session, taller))).not.toEqual(before);
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
    const frame = yield* drawn(tree, view);

    // A conversation whose provider key ends in `:text`.
    const conversation = "sessions:conversation:stub:text";
    expect(yield* keysOf(view)).toContain(conversation);
    yield* focusTo(tree, conversation);
    const pressed = yield* activate(tree);
    expect(pressed).toEqual({ kind: "select-session", session: "stub:text" });
    expect(yield* pointed(tree, frame, conversation)).toEqual(pressed);

    // And every option named after one of those facts.
    const opened = yield* acted(
      standing,
      { kind: "select-permission", request: request.key },
      session,
    );
    const drawer = reading(opened, session, WIDE);
    const drawerFrame = yield* drawn(tree, drawer);
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
    const replFrame = yield* drawn(tree, onRepl);
    const fact = replFrame.node(`sessions:request:${request.key}`);
    expect(fact).toBeDefined();
    expect(replFrame.targetable(`sessions:request:${request.key}`)).toBe(false);

    // Inside the drawer, what a person decides *about* is read the same way.
    const opened = yield* acted(
      onSessions(session),
      { kind: "select-permission", request: request.key },
      session,
    );
    const drawer = reading(opened, session, WIDE);
    const drawerFrame = yield* drawn(tree, drawer);
    for (const key of drawerContentKeys) {
      expect(drawerFrame.node(key)).toBeDefined();
      expect(drawerFrame.targetable(key)).toBe(false);
    }
    // A turn's own facts and a retained audit are lines wherever they appear.
    const sessions = reading(onSessions(session), session, WIDE);
    const sessionsFrame = yield* drawn(tree, sessions);
    for (const key of sessionsFrame.keys) {
      if (TURN_FACT_SUFFIXES.some((suffix) => key.endsWith(suffix))) {
        expect(sessionsFrame.targetable(key)).toBe(false);
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

/**
 * Wait until the screen satisfies this, or say what it showed instead.
 *
 * Bounded by the same real-time deadline every other wait here uses, and it
 * reports the rendered footer on timeout: a wait that only says it timed out
 * leaves whoever reads it guessing which half of the claim failed.
 */
function* untilScreen(
  terminal: Terminal,
  what: string,
  ready: (terminal: Terminal) => boolean,
): Operation<void> {
  const deadline = Date.now() + DEADLOCK_MS;
  while (!ready(terminal)) {
    if (Date.now() > deadline) {
      throw new Error(
        `the screen never reached ${what}. footer=` +
          JSON.stringify(
            screenOf(terminal)
              .slice(-9)
              .map((line) => line.trim()),
          ),
      );
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
  let waiting: ((result: IteratorResult<Uint8Array, void>) => void) | undefined;
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
    *write(bytes: Uint8Array): Operation<void> {
      terminal.presented.push(new Uint8Array(bytes));
      if (!holding) {
        // A write that completed, which still costs the caller a turn.
        yield* sleep(0);
        return;
      }
      holding = false;
      const held = withResolvers<void>();
      terminal.holdPresent = { release: held.resolve };
      yield* held.operation;
    },
    writeNow(): void {
      terminal.resets += 1;
    },
    setRaw(raw: boolean): void {
      terminal.raw.push(raw);
    },
    input(): Stream<Uint8Array, void> {
      return resource<Subscription<Uint8Array, void>>(function* (provide) {
        let open = false;
        // Registered before the reader is taken, so a scope cancelled between
        // the two leaves nothing holding this terminal's input.
        yield* ensure(() => {
          if (!open) {
            return;
          }
          open = false;
          terminal.readers -= 1;
          // Actively cancelled: a cleanup that waited for the outstanding read
          // to end on its own would need another keystroke to get one.
          const resolve = waiting;
          waiting = undefined;
          resolve?.({ done: true, value: undefined });
        });
        terminal.readers += 1;
        open = true;
        yield* provide({
          *next(): Operation<IteratorResult<Uint8Array, void>> {
            // Always one suspension per chunk, buffered or not: the reader turns
            // one chunk into many decoded events, and draining a buffer without
            // yielding hands them over faster than the scanner takes them.
            const pending = withResolvers<IteratorResult<Uint8Array, void>>();
            const head = queue.shift();
            if (head !== undefined) {
              pending.resolve({ done: false, value: head });
            } else if (ended) {
              pending.resolve({ done: true, value: undefined });
            } else {
              waiting = pending.resolve;
            }
            return yield* pending.operation;
          },
        });
      });
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
  // Created and removed by the scope that uses it, like the terminal and the
  // session beside it. A row that leaves a data root behind has not finished
  // owning what it made, however green it is.
  const root = yield* useTempDirectory("xmd-repl-agents-");
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
 * Whether a frame a person could actually use has been drawn.
 *
 * Not merely that bytes arrived: a reset and an empty presentation are both
 * frames and neither is a screen. The contextual status row is described only
 * once a width has been measured, so with the draft row and a way out beside it
 * this says the command is up and showing a measured frame.
 */
function usableFrame(terminal: Terminal): boolean {
  const rows = screenOf(terminal);
  return (
    rows.some((line) => line.includes(" \u00b7 ")) &&
    rows.some((line) => line.includes(DRAFT_PROMPT)) &&
    rows.some((line) => line.includes("[exit]") || line.includes("[history]"))
  );
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
    if (usableFrame(terminal)) {
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

describe("U1 — a row's rectangle does not bound its text (#875 R1)", () => {
  beforeAll(() => useTempFileCompiler());

  /** A prompt longer than any sidebar this product draws. */
  const LONG = "deploy the whole fleet and then write up everything that happened";

  it("TL11: a long turn label keeps its state inside the row's own measured cells", function* () {
    const { session } = yield* asking({ [LONG]: { queued: true } }, "deny-all", onePromptAt(LONG));
    yield* until(session, "the queued turn being observed", () => observed(session) === 1);

    const tree = yield* useReplTree<ReplAction>();
    const view = reading(initialState("agents"), session, WIDE);
    const frame = yield* drawn(tree, view);
    const key = yield* turnKeyed(view, LONG);
    const at = frame.boundsOf(key);
    const cell = frame.cell(key);
    expect(at).toBeDefined();
    expect(cell).toBeDefined();
    if (at === undefined || cell === undefined) {
      return;
    }

    // Pre-assert: the prompt really is longer than the row, so there is
    // something for the row to have fitted.
    expect(LONG.length).toBeGreaterThan(at.width);
    // The cells first: what the engine actually wrote, inside the rectangle this
    // frame published for this row and in the cells around it. A rectangle does
    // not bound its text, so the row being the right width proves nothing on its
    // own — the state has to be in the row's own cells, and nowhere else.
    const grid = createGrid();
    grid.apply(frame.committed.rendered.output);
    const beside = {
      x: at.x + at.width,
      y: at.y,
      width: view.size.columns - (at.x + at.width),
      height: 1,
    };
    // Nothing of this row reached the column beside it or the row under it.
    expect(grid.textIn(beside).join("")).not.toContain("queued");
    expect(grid.textIn(beside).join("")).not.toContain("everything that happened");
    // Nor onto the rows under it, where an unbounded label in a fixed-width row
    // pays itself out.
    expect(
      grid.textIn({ x: at.x, y: at.y + 1, width: at.width, height: 3 }).join(""),
    ).not.toContain("queued");
    // And the state is in the row, where a reader looks for it and a pointer
    // aimed at this row's published bounds reaches it.
    expect(grid.textIn(at).join("")).toContain("queued");

    // The row also says nothing wider than it is.
    expect(cell).toContain("queued");
    expect(cell.length).toBeLessThanOrEqual(at.width);

    // The complete semantic turn data is unchanged. What the row shows is fitted;
    // what the product holds is the whole prompt.
    expect(session.agent.turns.map((turn) => turn.prompt)).toEqual([LONG]);
  });
});

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
    expect(yield* turnRows(before)).toHaveLength(2);
    const firstRow = yield* turnKeyed(before, "one");
    const secondRow = yield* turnKeyed(before, "two");
    expect(firstRow).not.toBe(secondRow);
    expect(yield* labelOf(before, "one")).toContain("completed, recorded");
    expect(yield* labelOf(before, "two")).toContain("not recorded yet");

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
    expect(yield* turnRows(after)).toHaveLength(2);
    expect(yield* labelOf(after, "one")).toContain("completed, recorded");
    expect(yield* labelOf(after, "two")).toContain("completed, recorded");
    // Each row resolved to its own entry's record, so each shows its own prompt
    // and its own text.
    expect(yield* detailOf(after, "one", "text")).toContain("one done");
    expect(yield* detailOf(after, "two", "text")).toContain("two done");
    // Publication preserved each mounted slot: the rows a person was reading a
    // moment ago are the rows they are reading now.
    expect(yield* turnKeyed(after, "one")).toBe(firstRow);
    expect(yield* turnKeyed(after, "two")).toBe(secondRow);
    // And the conversation the provider named is still one conversation, holding
    // both entries' turns.
    expect(yield* conversationRows(after)).toEqual(["sessions:conversation:stub:planner"]);
    expect(session.model.sessions.map((one) => one.sessionKey)).toEqual(["stub:planner"]);
    expect(session.model.sessions[0]?.turns).toHaveLength(2);
  });
});

/** The transcript lines one view draws, in order, excluding the live overlay. */
function* transcriptLines(view: ReplView): Operation<string[]> {
  return (yield* describedBy(view))
    .filter((one) => one.key.startsWith("line:") && !one.key.startsWith("line:live:"))
    .map((one) => one.label.trim())
    .filter((label) => label.length > 0);
}

/** The catalog rows one view describes, in the order it describes them. */
function* catalogRows(view: ReplView): Operation<Array<{ key: string; label: string }>> {
  return (yield* describedBy(view)).filter((one) => one.key.startsWith("entry:"));
}

/** The label of the catalog row for one entry key. */
function* catalogLabel(view: ReplView, entry: string): Operation<string> {
  const found = (yield* catalogRows(view)).find((one) => one.key === `entry:${entry}`);
  if (found === undefined) {
    throw new Error(`this catalog has no row for ${entry}`);
  }
  return found.label;
}

describe("EU1 — selecting an entry moves the transcript locus and nothing else", () => {
  beforeAll(() => useTempFileCompiler());

  /** Two entries, each with one recorded turn in one provider conversation. */
  function* twoRecordedEntries(): Operation<{
    session: ReplSession;
    stub: Stub;
    holder: ReplExecution;
  }> {
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
    expect((yield* session.submit(onePromptAt("two"))).ok).toBe(true);
    yield* until(session, "the second entry's turn reaching its terminal event", () =>
      session.agent.turns.some((turn) => turn.state === "terminal"),
    );
    return { session, stub, holder };
  }

  /** One location as a route, failing the test rather than the assertion. */
  function decodeRoute(location: string): ReplRoute {
    const decoded = decodeLocation(location);
    if (!decoded.ok) {
      throw decoded.error;
    }
    return decoded.value;
  }

  it("UI4: a live question belongs to the entry that is still running", function* () {
    const { session, stub } = yield* twoRecordedEntries();
    stub.record("root");
    yield* until(session, "the second entry's turn being recorded", () => recorded(session) === 2);
    yield* session.join();

    // The head, where the second entry is the one that could still be asking.
    const model = session.model;
    expect(model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
    const live = { ...NO_LIVE, elicit: true };

    // Entries are serial, so only the last one a prefix admitted can still be
    // asking. A route naming an earlier one beside this drawer would draw a live
    // question over a settled transcript and attribute it to that entry.
    const wrong = resolveLocation(
      model,
      {
        ...decodeRoute(`xmd://repl/agent-interface/entries/entry-1`),
        drawers: [{ kind: "live-elicit" }],
      },
      live,
    );
    expect(wrong.ok).toBe(false);
    if (wrong.ok) {
      throw new Error("a settled entry holds no live question");
    }
    expect(wrong.error.message).toContain("has settled");

    // And the entry that is running does hold it.
    const right = resolveLocation(
      model,
      {
        ...decodeRoute(`xmd://repl/agent-interface/entries/entry-2`),
        drawers: [{ kind: "live-elicit" }],
      },
      live,
    );
    expect(right.ok).toBe(true);
  });

  it("EU1: selecting an entry changes the locus, and leaves Sessions global", function* () {
    const { session, stub } = yield* twoRecordedEntries();
    stub.record("root");
    yield* until(session, "the second entry's turn being recorded", () => recorded(session) === 2);
    yield* session.join();

    // Standing with a draft, a conversation filter, and the first entry
    // selected: everything selecting another entry must leave alone.
    let standing = withDraft(initialState("agents"), "the next one");
    standing = yield* acted(standing, { kind: "select-scope", scopes: ["entry-1"] }, session);
    standing = yield* acted(standing, { kind: "select-session", session: "stub:planner" }, session);
    const before = reading(standing, session);
    expect(before.selection.entry?.key).toBe("entry-1");
    const turnsBefore = yield* turnRows(before);
    const conversationsBefore = yield* conversationRows(before);
    const appendsBefore = session.model.turns.length;

    const selected = yield* acted(standing, { kind: "select-scope", scopes: ["entry-2"] }, session);
    const after = reading(selected, session);

    // The locus moved, and the transcript moved with it — which is what
    // "selecting an entry changes the transcript locus" means. Asserting the
    // route alone would leave both entries' rows concatenated under either
    // selection and call it a pass.
    expect(after.selection.entry?.key).toBe("entry-2");
    expect(after.selection.scope?.key).toBe("entry-2");
    expect(before.selection.entry?.key).toBe("entry-1");
    const firstRows = yield* transcriptLines(before);
    const secondRows = yield* transcriptLines(after);
    expect(firstRows.length).toBeGreaterThan(0);
    expect(secondRows.length).toBeGreaterThan(0);
    expect(firstRows).not.toEqual(secondRows);
    // Each is that entry's own reading and holds nothing of the other's: the
    // two turns say different things, so a concatenated transcript would show
    // both under both. Matched on the whole answer rather than on the word in
    // it — `import_component` contains "one", and a looser matcher passes this
    // row for the wrong reason.
    expect(firstRows).toContain("one done");
    expect(firstRows).not.toContain("two done");
    expect(secondRows).toContain("two done");
    expect(secondRows).not.toContain("one done");

    // The draft, the marker, the surface and the conversation filter all stand.
    expect(selected.draft).toBe("the next one");
    expect(selected.route.draft).toBe("the next one");
    expect(selected.route.at).toBe(undefined);
    expect(selected.route.surface).toBe("entries");
    expect(selected.route.session).toBe("stub:planner");

    // Sessions is one execution-wide chronology and selecting an entry never
    // narrows it: both entries' turns are still in it, in the same order, under
    // the one conversation the provider named.
    expect(yield* turnRows(after)).toEqual(turnsBefore);
    expect(yield* conversationRows(after)).toEqual(conversationsBefore);
    expect(yield* conversationRows(after)).toEqual(["sessions:conversation:stub:planner"]);
    expect(session.model.sessions.map((one) => one.sessionKey)).toEqual(["stub:planner"]);
    expect(session.model.sessions[0]?.turns).toHaveLength(2);
    expect(yield* labelOf(after, "one")).toBe(yield* labelOf(before, "one"));
    expect(yield* labelOf(after, "two")).toBe(yield* labelOf(before, "two"));

    // And no live execution, Agent work or history was touched by a selection.
    expect(session.model.turns).toHaveLength(appendsBefore);
    expect(session.live).toBe(false);
    expect(session.agent.requests).toEqual([]);
  });

  /** Commit one view, the way the program does before a pointer lands. */
  function* framed(
    tree: ReplTree<ReplAction>,
    view: ReplView,
    _size: ReplTerminalSize,
  ): Operation<Frame> {
    return yield* drawn(tree, view);
  }

  /**
   * What one mounted control asks for, by key and by pointer.
   *
   * Both, and asserted equal: a control a person can reach two ways has to mean
   * one thing, and a pointer is resolved against the exact frame that drew it
   * rather than against the tree.
   */
  function* asked(
    tree: ReplTree<ReplAction>,
    view: ReplView,
    size: ReplTerminalSize,
    key: string,
  ): Operation<ReplAction> {
    const frame = yield* framed(tree, view, size);
    expect([key, frame.node(key) !== undefined]).toEqual([key, true]);
    expect([key, frame.targetable(key)]).toEqual([key, true]);
    const pointer = yield* pointed(tree, frame, key);
    yield* focusTo(tree, key);
    const pressed = yield* activate(tree);
    expect(pointer).toEqual(pressed);
    return pressed;
  }

  /** One action reduced against one explicit model, refusing to carry a refusal on. */
  function* reducedAt(
    state: ReplState,
    action: ReplAction,
    model: ReplModel,
    session: ReplSession,
    size: ReplTerminalSize,
  ): Operation<ReplState> {
    const next = reduceRepl(
      state,
      action,
      model,
      liveReading(session),
      yield* admissionOf(state, session, size, model),
    );
    if (next.state.refusal !== undefined) {
      throw new Error(`${action.kind} was refused: ${next.state.refusal}`);
    }
    return next.state;
  }

  it("ER1: a narrow round trip to Sessions keeps the entry, the draft and the filter", function* () {
    const { session, stub, holder } = yield* twoRecordedEntries();
    stub.record("root");
    yield* until(session, "the second entry's turn being recorded", () => recorded(session) === 2);
    yield* session.join();

    // Read at one retained position, so this round trip carries history state
    // alongside the selection, the draft and the conversation filter. The last
    // one, because what each entry's transcript holds has to be distinguishable
    // for the locus below to be a claim about which entry is being read.
    const marker = session.model.checkpoints[session.model.checkpoints.length - 1]?.marker;
    if (marker === undefined) {
      throw new Error("this journal offers at least one position");
    }
    const model = yield* projectedAt(holder, marker);
    expect(model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
    expect(model.sessions.map((one) => one.sessionKey)).toEqual(["stub:planner"]);

    const drafted = withDraft(initialState("agents"), "the next one");
    const standing: ReplState = Object.freeze({
      ...drafted,
      route: Object.freeze({
        ...drafted.route,
        at: marker,
        inspect: true,
        session: "stub:planner",
      }),
    });
    const tree = yield* useReplTree<ReplAction>();

    // 1. Select the second entry through its own mounted catalog row.
    const catalog = reading(standing, session, NARROW, undefined, model);
    expect(yield* asked(tree, catalog, NARROW, "entry:entry-2")).toEqual({
      kind: "select-scope",
      scopes: ["entry-2"],
    });
    const onEntry = yield* reducedAt(
      standing,
      { kind: "select-scope", scopes: ["entry-2"] },
      model,
      session,
      NARROW,
    );
    const entryView = reading(onEntry, session, NARROW, undefined, model);
    expect(entryView.selection.entry?.key).toBe("entry-2");
    // The locus this round trip has to come back to.
    const locus = yield* transcriptLines(entryView);
    expect(locus).toContain("two done");
    expect(locus).not.toContain("one done");

    // 2. Go to Sessions through the mounted surface control, which a narrow
    //    frame keeps outside the outlet it leaves.
    expect(yield* asked(tree, entryView, NARROW, "sessions:heading")).toEqual({
      kind: "select-surface",
      surface: "sessions",
    });
    const onSessions = yield* reducedAt(
      onEntry,
      { kind: "select-surface", surface: "sessions" },
      model,
      session,
      NARROW,
    );

    // Everything it was carrying is still carried, and the location says so.
    expect(onSessions.route.surface).toBe("sessions");
    expect(onSessions.route.scopes).toEqual(["entry-2"]);
    expect(onSessions.draft).toBe("the next one");
    expect(onSessions.route.draft).toBe("the next one");
    expect(onSessions.route.session).toBe("stub:planner");
    expect(onSessions.route.at).toBe(marker);
    expect(onSessions.route.inspect).toBe(true);
    const sessionsView = reading(onSessions, session, NARROW, undefined, model);
    expect(sessionsView.location).toContain("/sessions/entry-2");
    expect(sessionsView.selection.entry?.key).toBe("entry-2");

    // Sessions is still the execution's whole chronology: both entries' turns,
    // under the one conversation the provider named — and exactly the reading it
    // is with no entry selected, so selecting one narrowed nothing.
    expect(yield* turnRows(sessionsView)).toHaveLength(2);
    expect(yield* labelOf(sessionsView, "one")).toContain("recorded");
    expect(yield* labelOf(sessionsView, "two")).toContain("recorded");
    expect(yield* conversationRows(sessionsView)).toEqual(["sessions:conversation:stub:planner"]);
    const unselected = reading(
      Object.freeze({ ...standing, route: Object.freeze({ ...onSessions.route, scopes: [] }) }),
      session,
      NARROW,
      undefined,
      model,
    );
    expect(yield* sessionKeysOf(sessionsView)).toEqual(yield* sessionKeysOf(unselected));

    // 3. And back, through the other mounted surface control, to the same locus.
    expect(yield* asked(tree, sessionsView, NARROW, "entries:heading")).toEqual({
      kind: "select-surface",
      surface: "entries",
    });
    const back = yield* reducedAt(
      onSessions,
      { kind: "select-surface", surface: "entries" },
      model,
      session,
      NARROW,
    );
    expect(back.route.surface).toBe("entries");
    expect(back.route.scopes).toEqual(["entry-2"]);
    expect(back.draft).toBe("the next one");
    expect(back.route.session).toBe("stub:planner");
    expect(back.route.at).toBe(marker);
    const returned = reading(back, session, NARROW, undefined, model);
    expect(returned.selection.entry?.key).toBe("entry-2");
    expect(yield* transcriptLines(returned)).toEqual(locus);
    // One location either way.
    expect(returned.location).toBe(entryView.location);
  });

  it("EU1: entry keys and mounted nodes survive publication and an outcome change", function* () {
    const { session, stub } = yield* twoRecordedEntries();
    const tree = yield* useReplTree<ReplAction>();

    // The second entry's root cannot close until its Prompt publishes, so the
    // catalog honestly says it has not settled.
    const before = reading(initialState("agents"), session);
    expect((yield* catalogRows(before)).map((one) => one.key)).toEqual([
      "entry:entry-1",
      "entry:entry-2",
    ]);
    expect(yield* catalogLabel(before, "entry-1")).toContain("ok");
    expect(yield* catalogLabel(before, "entry-2")).toContain("unfinished");
    yield* applied(tree, before);
    const nodes = ["entry-1", "entry-2"].map((key) => nodeOf(tree, `entry:${key}`));
    expect(nodes.every((node) => node !== undefined)).toBe(true);

    stub.record("root");
    yield* until(session, "the second entry's turn being recorded", () => recorded(session) === 2);
    yield* session.join();

    // The outcome changed under it, which is the point: a row whose identity
    // came from its place in the window would have moved, and a row keyed by
    // its entry does not.
    const after = reading(initialState("agents"), session);
    expect((yield* catalogRows(after)).map((one) => one.key)).toEqual([
      "entry:entry-1",
      "entry:entry-2",
    ]);
    expect(yield* catalogLabel(after, "entry-2")).toContain("ok");
    expect(yield* catalogLabel(after, "entry-2")).not.toContain("unfinished");
    yield* applied(tree, after);
    expect(["entry-1", "entry-2"].map((key) => nodeOf(tree, `entry:${key}`))).toEqual(nodes);
  });
});

/**
 * A permission arriving on Entries says so and takes nothing (#870 UI14).
 *
 * Permission stays Sessions-owned. Arrival is a fact on the turn that is waiting,
 * and the screen's whole job here is to say that the fact exists and where it is
 * answered — not to go there. A screen that routed, opened the drawer or moved
 * focus would take a person off the entry they were reading to answer something
 * they had not asked to see.
 */
describe("U2 — a pending permission announces itself without taking the screen", () => {
  beforeAll(() => useTempFileCompiler());

  it("UI14: the frame says a permission waits in Sessions, and changes no route or focus", function* () {
    const { session } = yield* asking({
      review: { streaming: true, permission: { toolCallId: "call-1", kind: "edit" } },
    });

    // Reading an entry, with a draft, before anything is pending.
    const before = Object.freeze({
      ...initialState("agents"),
      draft: "a draft nobody may take",
      route: Object.freeze({ ...initialState("agents").route, draft: "a draft nobody may take" }),
    });
    const quiet = reading(before, session);
    const surface = quiet.state.route.surface;

    yield* until(session, "a request waiting", () => session.agent.requests.length === 1);

    // The same state, read again now that a request is pending. Nothing about
    // where the person is has changed.
    const after = reading(before, session);
    expect(after.state.route.surface).toBe(surface);
    expect(after.state.route.drawers).toEqual([]);
    expect(after.state.route.session).toBe(before.route.session);
    expect(after.state.route.at).toBe(before.route.at);
    expect(after.state.draft).toBe("a draft nobody may take");
    expect(after.state.permission).toBe(before.permission);
    // The location is the same string it was: a pending request is process-local
    // and is carried in no canonical member.
    expect(after.location).toBe(quiet.location);

    // And the frame says it, naming where it is answered rather than going there.
    const rows = yield* describedBy(after);
    const guidance = rows.find((one) => one.key === "guidance")?.label ?? "";
    expect(guidance).toContain("waiting for permission");
    expect(guidance).toContain("open Sessions");
    // Said, not done: the permission drawer is not mounted on this surface.
    expect(rows.some((one) => one.key.startsWith("drawer:permission:"))).toBe(false);

    // The control that answers it is the one Sessions already had. Crossing to it
    // is a thing the person does, and then the request is there to be settled.
    const moved = onSessions(session, before);
    const sessions = yield* describedBy(reading(moved, session));
    expect(sessions.some((one) => one.key.startsWith("sessions:request:"))).toBe(true);
    // And the draft crossed with them.
    expect(moved.draft).toBe("a draft nobody may take");
  });
});

/**
 * Put focus on the entry draft, the way the guidance row says to (#870 C3).
 *
 * There is no label to aim at: what the draft draws is its own prompt, and a
 * focused field renders its marker immediately before it. The draft's prompt is
 * the only one on this screen that is itself a marker.
 */
function* focusTheDraft(terminal: Terminal, limit = 240): Operation<void> {
  for (let press = 0; press <= limit; press += 1) {
    if (screenOf(terminal).some((line) => line.includes(">> "))) {
      return;
    }
    terminal.feed("\t");
    yield* settled(12);
  }
  throw new Error(
    `focus never reached the entry draft in ${limit} presses. screen=` +
      JSON.stringify(
        screenOf(terminal)
          .slice(-9)
          .map((line) => line.trim()),
      ),
  );
}

/**
 * The exact source of every entry this execution admitted (#870 C3).
 *
 * Read from the file rather than from the screen, because what a catalog row
 * proves is that an entry exists — not which bytes became it. The draft
 * clearing and `2.` appearing are both true of an entry admitted from the wrong
 * source, so neither is the claim.
 *
 * Through the product's own reader, so the records are *parsed* rather than
 * trusted: a journal is whatever is on disk, and annotating `JSON.parse` would
 * give those bytes a type without ever checking they have it.
 */
function* admittedSources(hostRoot: string): Operation<readonly string[]> {
  const directory = join(hostRoot, "xmd", "repl");
  const files = yield* readdir(directory);
  // One execution, so one file. More than one would mean this row read a
  // history it did not write, and picking the first would hide that.
  expect(files).toHaveLength(1);
  const events = yield* readRecords(join(directory, files[0] ?? ""));
  const projected = projectRepl(events);
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value.entries.map((entry) => entry.source);
}

/**
 * Exactly what the draft row is holding (#870 C3).
 *
 * Read off the bottom-most row that carries the draft's own prompt, because the
 * draft owns the last footer row at every size and shares it with nothing. Exact
 * rather than a containment check: the claim is that what somebody typed survived
 * byte for byte, and `contains` would pass on a draft that had grown a character.
 */
function draftOn(terminal: Terminal): string {
  const rows = screenOf(terminal);
  for (let row = rows.length - 1; row >= 0; row -= 1) {
    const line = rows[row] ?? "";
    const at = line.lastIndexOf(DRAFT_PROMPT);
    if (at !== -1) {
      return line.slice(at + DRAFT_PROMPT.length).trimEnd();
    }
  }
  return "";
}

/**
 * A draft survives a permission and is still somebody's to finish (#870 C3).
 *
 * Preservation on arrival is proved elsewhere, and so is the settlement itself.
 * What neither says is whether what a person had typed is still *theirs*
 * afterwards — a draft that survived as an unreachable string on the screen
 * would satisfy both of those rows and none of the promise. So this one keeps
 * going: it answers the request, finds the draft again through the ordinary ring,
 * types more into it, and submits it as the next entry.
 *
 * At both sizes, because the narrow frame is the one where the draft shares its
 * region with every control on the screen.
 */
describe("U2 — a draft outlives a permission and is still editable", () => {
  beforeAll(() => useTempFileCompiler());

  for (const size of [{ columns: 160, rows: 36 }, NARROW]) {
    it(`C3: at ${size.columns}x${size.rows} the draft survives settling, edits, and becomes Entry 2`, function* () {
      const stub = createStub({
        review: {
          streaming: true,
          permission: { toolCallId: "call-1", title: "Write", kind: "edit" },
        },
        build: { streaming: true },
        check: { queued: true },
      });
      const { terminal, install } = recordingTerminal(size);

      yield* scoped(function* (): Operation<void> {
        yield* install();
        yield* immediateClock();
        yield* useStub(stub);
        const hostRoot = yield* useTemporaryHost();

        const running = yield* spawn(function* (): Operation<void> {
          const ran = yield* runReplProgram({ profile: PROFILE });
          if (!ran.ok) {
            throw ran.error;
          }
        });
        yield* untilDrawn(terminal);

        // One entry, which is what will ask for the permission.
        terminal.bytes(BYTES.encode(THREE_SPAWNS));
        yield* settled(20);
        terminal.feed("\r");
        yield* settled(40);

        // Given the turns to actually run the document's three spawns before the
        // screen is read: the first Prompt has to reach the provider and come
        // back, and polling from the turn after submission starves it.
        yield* settled(60);
        // That a request is waiting is read from the one row that says what the
        // execution is doing, because that row is on the screen at both sizes —
        // the chronology the request lives on is not: a narrow frame mounts one
        // routed outlet, and this one is routed to Entries.
        // Read from the one row that says what the execution is doing, because
        // that row is on the screen at both sizes — the chronology the request
        // lives on is not: a narrow frame mounts one routed outlet and this route
        // selects Entries. Matched on the instruction rather than on the state
        // phrase, because the narrow state is the compact `Entry 1 permission`
        // and the wide one is `Entry 1 waiting for permission`.
        yield* untilScreen(terminal, "the request being announced", (one) =>
          shows(one, "open Sessions"),
        );
        // Arrival opened nothing, which is the row before this one's claim. Read
        // off the screen rather than the location: at 72 columns the location is
        // drawn over several rows and says how much of itself it is not showing,
        // so there is no single line to parse it out of.
        expect(shows(terminal, "[Allow once]")).toBe(false);

        // 1. The next entry, typed while the request is waiting and before the
        // drawer is opened over it. Focus returns to the draft on its own once
        // the first entry is admitted.
        const TYPED = "C3-KEPT";
        yield* focusTheDraft(terminal);
        terminal.bytes(BYTES.encode(TYPED));
        yield* settled(30);
        expect(draftOn(terminal)).toBe(TYPED);

        // 2. Answered once, through the ordinary controls and the one authority.
        yield* pressUntil(terminal, "Sessions");
        terminal.feed("\r");
        yield* settled(40);
        yield* pressUntil(terminal, "asks: Write");
        terminal.feed("\r");
        yield* settled(40);
        yield* untilScreen(terminal, "the permission drawer", (one) => shows(one, "[Allow once]"));
        yield* pressUntil(terminal, "[Allow once]");
        terminal.feed("\r");
        yield* answered(stub, "call-1");
        expect(stub.answers.get("call-1")).toBe(1);
        yield* settled(40);

        // 3. Byte for byte what was typed, and on the screen.
        expect(draftOn(terminal)).toBe(TYPED);
        expect(shows(terminal, TYPED)).toBe(true);

        // 4. Found again the way the row says to find it, and still editable: a
        // draft nobody can get back to is a draft that was not really kept.
        yield* focusTheDraft(terminal);
        const EDITED = `${TYPED}-EDITED`;
        terminal.bytes(BYTES.encode("-EDITED"));
        yield* settled(30);
        expect(draftOn(terminal)).toBe(EDITED);

        // 5. And it is the thing that becomes the next entry, once the one that
        // asked for the permission has finished and been joined.
        // Back to Entries to read its catalog, which a narrow frame only mounts
        // when the route selects it.
        yield* pressUntil(terminal, "Entries");
        terminal.feed("\r");
        yield* settled(40);
        // Not `[ok]`, which is the retained close: a close is recorded while the
        // task that wrote it is still coming down, and a submission taken in that
        // window has nowhere to go. The row that says the next entry may start is
        // the one that means the teardown finished too (#870 UI11).
        yield* untilScreen(terminal, "the next entry becoming startable", (one) =>
          shows(one, "Ready for Entry 2"),
        );
        expect(shows(terminal, "1. [ok] entry-1")).toBe(true);
        yield* focusTheDraft(terminal);
        terminal.feed("\r");
        yield* untilScreen(terminal, "the second entry", (one) => shows(one, "2. "));
        // Submitted means consumed: the draft is the *next* entry's, and there is
        // no next one typed yet.
        yield* untilScreen(terminal, "the draft being spent", (one) => draftOn(one) === "");

        // And the file says which bytes became that entry. An entry appearing and
        // a draft clearing are both true of one admitted from the wrong source,
        // so this is the assertion that actually closes the journey.
        const sources = yield* admittedSources(hostRoot);
        expect(sources).toHaveLength(2);
        expect(sources[1]).toBe(EDITED);
        if (size.columns > NARROW.columns) {
          // Where there is a transcript column, the exact source is readable as
          // what the entry rendered.
          yield* untilScreen(terminal, "the edited source having run", (one) => shows(one, EDITED));
        }

        terminal.end();
        yield* running;
      });
    });
  }
});
