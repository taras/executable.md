/**
 * The real REPL command, run on a terminal this test owns.
 *
 * `runReplProgram` opens the repository, validates the route, opens one
 * session, acquires this execution's Sidekick and runs the screen. Only the
 * transport under the agent provider, the host's storage and the terminal under
 * the renderer are replaced, and each replacement exposes the seam a case
 * holds: a presentation held or failed, a resize between two size reads, an
 * append or its operation held open.
 */

import { action, ensure, resource, sleep, spawn, until, withResolvers } from "effection";
import type { Operation, Result, Stream, Subscription } from "effection";
import { appendFile, open as openFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { installReplHost } from "../../src/repl-assembly.ts";
import { ReplHost } from "../../src/repl/host.ts";
import { installReplTerminal } from "../../src/repl/terminal-host.ts";
import type { ReplTerminalCapabilities } from "../../src/repl/terminal-host.ts";
import type { ReplTerminalSize } from "../../src/repl/terminal.ts";
import { runReplProgram } from "../../src/repl/program.ts";
import type { ReplOutcome } from "../../src/repl/program.ts";
import { assembleReplProfile } from "../../src/repl-profile.ts";
import type { ReplProfileAssembly } from "../../src/repl-profile.ts";
import { resolveAgentStack } from "../../src/agent-stack.ts";
import { NO_PLUGINS } from "../../src/plugin-host.ts";
import { pairedReplRepository } from "../../src/repl/sidekick/repository.ts";
import { PAIRED_DIRECTORY } from "../../src/repl/sidekick/history.ts";
import type { SidekickRecord } from "../../src/repl/sidekick/history.ts";
import { projectRepl } from "../../src/repl/model.ts";
import type { ReplModel } from "../../src/repl/model.ts";
import { REPL_DIRECTORY } from "../../src/repl/storage.ts";
import type { PairedReplRepository } from "../../src/repl/sidekick/repository.ts";
import { API, useHostFiles } from "@executablemd/runtime";
import { ReplEntryHost } from "../../src/repl-entry-installation.ts";
import type { ReplEntryInstallation } from "../../src/repl-entry-installation.ts";
import type { AcpxProviderDependencies } from "@executablemd/acp";
import { useTempFileCompiler, useNormalizedOutput } from "@executablemd/core";
import { createFakeAcp, makeRegistry, makeStore } from "./fake-acp.ts";
import type { FakeAcp } from "./fake-acp.ts";
import { useTemporary } from "../fixtures/repl/issue-883/sidekick-harness.ts";
import { useTerminalScreen } from "./terminal-screen.ts";
import type { TerminalScreen } from "./terminal-screen.ts";

const BYTES = new TextEncoder();

/**
 * The sizes a churning drag passes through, all of them drawable.
 *
 * Four, cycled, so consecutive reads never answer with the same size twice —
 * and none of them is below the minimum, because what this exercises is a frame
 * being outrun rather than the refusal a too-small window shows.
 */
const DRAGGED: readonly ReplTerminalSize[] = [
  { columns: 160, rows: 36 },
  { columns: 120, rows: 30 },
  { columns: 100, rows: 26 },
  { columns: 84, rows: 22 },
];

/** A terminal the test drives completely. */
export interface Terminal {
  /** Every presentation the program attempted, in order, including one still held. */
  readonly presented: Uint8Array[];
  /**
   * How many presentations have completed.
   *
   * A presentation reaches the screen when its write finishes, not when it is
   * attempted: a held write is in `presented` and not yet on the screen, and a
   * write that failed or was cancelled never reaches it.
   */
  readonly drawn: number;
  /** How many waits are subscribed to the next completed presentation. */
  readonly waiting: number;
  /**
   * When set, the next presentation blocks here until it is released.
   *
   * The seam the frame-order control needs: while a frame is being written, the
   * stream must not have been told that frame was applied.
   */
  holdPresent: { release(): void } | undefined;
  size: ReplTerminalSize;
  /** How many times the program has asked this terminal how big it is. */
  sized: number;
  /**
   * How many chunks have been fed to this terminal's input.
   *
   * What a row needs to say "and nothing was pressed": an assertion that the
   * screen updated on its own holds only if no keystroke could have caused it,
   * and a comment saying so is not evidence.
   */
  fed: number;
  readonly raw: boolean[];
  resets: number;
  listeners: number;
  readers: number;
  /** The screen the completed presentations drew, once installed. */
  readonly screen: TerminalScreen | undefined;
  feed(text: string): void;
  bytes(raw: Uint8Array): void;
  /** Make the next presentation block, so a test can look at the frame stream. */
  holdNextPresent(): void;
  /** Make the next presentation fail with this error, as a broken terminal does. */
  failNextPresent(error: Error): void;
  resized(size: ReplTerminalSize): void;
  /**
   * Resize *between* two of the program's size reads.
   *
   * A window dragged while a frame is being prepared is exactly this: the read
   * the frame was resolved against reports one size, and every read after it
   * reports another. `after` counts reads from now, and the read that triggers
   * it still answers with the size that is going away.
   */
  resizeAfterRead(after: number, next: ReplTerminalSize): void;
  /**
   * Move the terminal on *every* one of the next `reads` size reads.
   *
   * A window still being dragged. Each read answers with the size that was
   * there and leaves a different one behind it, so every preparation the
   * program takes is invalidated before it can revalidate — which is what
   * exhausting a frame's rebuild budget looks like from outside. The last of
   * those reads settles on `settled` and the churn is over.
   */
  churnSize(reads: number, settled: ReplTerminalSize): void;
  /** How many churned reads are still owed, so a test can wait for the end. */
  churning(): number;
  end(): void;
  /**
   * Say the command drawing on this terminal has returned.
   *
   * A wait for the screen cannot be satisfied by a command that is no longer
   * drawing, so every pending one wakes and reports how it ended.
   */
  stopped(failure: Error | undefined): void;
  /** How the command ended, once {@link stopped} has said so. */
  readonly ending: { readonly failure: Error | undefined } | undefined;
  /** Settles once more than `count` presentations have completed, or the command stopped. */
  after(count: number): Operation<void>;
}

export function recordingTerminal(
  size: ReplTerminalSize = { columns: 160, rows: 36 },
  interactive = true,
): {
  terminal: Terminal;
  install(): Operation<void>;
} {
  const queue: Uint8Array[] = [];
  const watchers = new Set<() => void>();
  const wakers = new Set<() => void>();
  let waiting: ((result: IteratorResult<Uint8Array, void>) => void) | undefined;
  let ended = false;
  let screen: TerminalScreen | undefined;
  let drawn = 0;
  let ending: { readonly failure: Error | undefined } | undefined;

  let holding = false;
  let failing: Error | undefined;
  let dragging: { after: number; next: ReplTerminalSize } | undefined;
  let churn: { left: number; settled: ReplTerminalSize } | undefined;
  const wake = (): void => {
    for (const one of [...wakers]) {
      one();
    }
  };
  const terminal: Terminal = {
    presented: [],
    get drawn() {
      return drawn;
    },
    get waiting() {
      return wakers.size;
    },
    get screen() {
      return screen;
    },
    get ending() {
      return ending;
    },
    holdPresent: undefined,
    size,
    sized: 0,
    fed: 0,
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
    failNextPresent(error: Error): void {
      failing = error;
    },
    bytes(raw: Uint8Array): void {
      terminal.fed += 1;
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
      screen?.resize(next);
      for (const watcher of watchers) {
        watcher();
      }
    },
    resizeAfterRead(after: number, next: ReplTerminalSize): void {
      dragging = { after: terminal.sized + after, next };
    },
    churnSize(reads: number, settled: ReplTerminalSize): void {
      churn = { left: reads, settled };
    },
    churning(): number {
      return churn?.left ?? 0;
    },
    end(): void {
      ended = true;
      const resolve = waiting;
      if (resolve !== undefined) {
        waiting = undefined;
        resolve({ done: true, value: undefined });
      }
    },
    stopped(failure: Error | undefined): void {
      ending = { failure };
      wake();
    },
    after(count: number): Operation<void> {
      return action<void>((resolve) => {
        if (drawn > count || ending !== undefined) {
          resolve();
          return () => {};
        }
        const one = (): void => resolve();
        wakers.add(one);
        return () => {
          wakers.delete(one);
        };
      });
    },
  };

  const host: ReplTerminalCapabilities = {
    interactive: () => interactive,
    size: () => {
      terminal.sized += 1;
      const reported = terminal.size;
      if (churn !== undefined) {
        churn.left -= 1;
        // Always a different size from the one just answered with, so no
        // preparation can be revalidated against the size it was measured for.
        const next = churn.left > 0 ? DRAGGED[churn.left % DRAGGED.length] : churn.settled;
        if (churn.left <= 0) {
          churn = undefined;
        }
        // Set rather than announced. The host's own resize watcher reads the
        // size from inside its listener, so announcing here would re-enter this
        // read and drain the whole drag in one call. Nothing needs the
        // announcement: the frame being outrun is already reading again.
        terminal.size = next;
        screen?.resize(next);
      } else if (dragging !== undefined && terminal.sized >= dragging.after) {
        const { next } = dragging;
        dragging = undefined;
        terminal.resized(next);
      }
      return reported;
    },
    *write(bytes: Uint8Array): Operation<void> {
      const written = new Uint8Array(bytes);
      terminal.presented.push(written);
      if (failing !== undefined) {
        const failure = failing;
        failing = undefined;
        throw failure;
      }
      if (holding) {
        holding = false;
        const held = withResolvers<void>();
        terminal.holdPresent = { release: held.resolve };
        yield* held.operation;
      } else {
        // A write that completed, which still costs the caller a turn.
        yield* sleep(0);
      }
      if (screen === undefined) {
        throw new Error("this terminal was written to before it was installed");
      }
      screen.feed(written);
      drawn += 1;
      wake();
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

  return {
    terminal,
    *install(): Operation<void> {
      screen = yield* useTerminalScreen(terminal.size);
      yield* installReplTerminal(host);
    },
  };
}

/** How long any mounted wait gives something before it says it never happened. */
export const MOUNTED_DEADLINE_MS = 15_000;

/**
 * The same wait for something that is not on the screen.
 *
 * A file landing, a provider being asked, a job joining: facts a row needs
 * before it reads cells, and none of them are drawn.
 */
export function* awaited(what: string, settled_: () => boolean): Operation<void> {
  const deadline = Date.now() + MOUNTED_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (settled_()) {
      return;
    }
    yield* sleep(10);
  }
  throw new Error(`${what} never happened within ${MOUNTED_DEADLINE_MS}ms`);
}

/**
 * The same wait again, for a fact only an operation can read.
 *
 * What is on disk is the case in point. A row drawn on the screen and a record
 * published in the history are two different moments: the Sidekick's words are
 * shown as soon as it has said them, and the reply they belong to is saved
 * after the entry it carries has been evaluated. A row that waited for the
 * screen and then read the file would be asking about the second moment having
 * waited for the first.
 */
export function* awaitedFact(what: string, held: () => Operation<boolean>): Operation<void> {
  const deadline = Date.now() + MOUNTED_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (yield* held()) {
      return;
    }
    yield* sleep(10);
  }
  throw new Error(`${what} never happened within ${MOUNTED_DEADLINE_MS}ms`);
}

/**
 * One append this case is holding open, and when it actually started.
 *
 * Two observations rather than one, because "asked for" and "in flight" are
 * different moments and only the second one is a gate: the movable writer's own
 * count is raised inside the host's append, so a case that released before the
 * append started would have held nothing and proved nothing about ordering.
 */
export interface HeldAppend {
  /** Settles once this append is genuinely in flight. */
  started(): Operation<void>;
  /** Whether it has started. */
  readonly inFlight: boolean;
  /** Whether it has been let go. */
  readonly released: boolean;
  /** Let it finish. */
  release(): void;
}

/**
 * The seam a case holds a real record open at.
 *
 * Inside the host's `appendRecord`, before the bytes are written, which is the
 * only place that makes a held append genuinely in flight: the movable writer's
 * count is already raised and the storage handoff's wait has something to wait
 * for. A gate that held the caller instead would be a gate on the test.
 */
export interface AppendGate {
  /** Every path an append actually reached, in order. */
  readonly reached: string[];
  /** How many appends have reached this path. */
  reaching(path: string): number;
  /**
   * Hold the next append this predicate accepts.
   *
   * The next one rather than all of them, so a case holds the record it means
   * to and everything behind it keeps writing.
   */
  holdNext(accepts: (path: string, record: string) => boolean): HeldAppend;
  /**
   * What the installed host calls for every append, and nothing else calls.
   *
   * Promises on both sides because the host's own append is defined in them:
   * this is the boundary, and `until` suspends the appending task on what comes
   * back exactly as it suspends on the write itself.
   */
  around(path: string, record: string): Promise<void> | undefined;
}

export function appendGate(): AppendGate {
  const reached: string[] = [];
  const pending: Array<{
    accepts: (path: string, record: string) => boolean;
    arrived(): void;
    waiting: Promise<void>;
  }> = [];

  return {
    reached,
    reaching(path: string): number {
      return reached.filter((one) => one === path).length;
    },
    holdNext(accepts: (path: string, record: string) => boolean): HeldAppend {
      let letGo = (): void => {};
      let announce = (): void => {};
      let inFlight = false;
      let released = false;
      const waiting = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      const arrival = new Promise<void>((resolve) => {
        announce = resolve;
      });
      pending.push({
        accepts,
        arrived: (): void => {
          inFlight = true;
          announce();
        },
        waiting,
      });
      return {
        *started(): Operation<void> {
          yield* until(arrival);
        },
        get inFlight(): boolean {
          return inFlight;
        },
        get released(): boolean {
          return released;
        },
        release(): void {
          released = true;
          letGo();
        },
      };
    },
    around(path: string, record: string): Promise<void> | undefined {
      const index = pending.findIndex((one) => one.accepts(path, record));
      if (index === -1) {
        return undefined;
      }
      const [held] = pending.splice(index, 1);
      held.arrived();
      return held.waiting;
    },
  };
}

/**
 * One append held *inside* the operation that owns it.
 *
 * The difference from {@link HeldAppend} is the whole point of it: that gate
 * holds a Promise the host has already been handed, so cancelling the wait
 * leaves the write scheduled and releasing afterwards still performs it. This
 * one holds the contextual operation `ReplHost.operations.appendRecord` *is*,
 * before anything physical happens — so halting whatever owns that operation
 * unwinds the hold and the record is never written at all.
 */
export interface HeldOperation {
  /** Settles once this append's own operation is suspended in the hold. */
  started(): Operation<void>;
  /** Whether it is suspended in the hold now. */
  readonly holding: boolean;
  /** Whether the operation holding it came down without appending. */
  readonly abandoned: boolean;
  /** Let it go on and perform the append. */
  release(): void;
}

/**
 * A hold at the contextual operation boundary, for a case about cancellation.
 *
 * Installed as ordinary middleware over the host Api at the instrumentation
 * band, so the implementation underneath is the product's own and what this
 * adds is a suspension in front of it. `appended` is the physical record: a
 * path lands in it only once the host has actually written, which is what lets
 * a row assert that nothing was written rather than that nothing was read.
 */
export interface OperationGate {
  /** Every append the host physically performed, in order. */
  readonly appended: readonly { readonly path: string; readonly record: string }[];
  /** Hold the next append this predicate accepts, in its own operation. */
  holdNext(accepts: (path: string, record: string) => boolean): HeldOperation;
  /** Install the middleware. The mounted host calls this; cases do not. */
  install(): Operation<void>;
}

export function operationGate(): OperationGate {
  const appended: { path: string; record: string }[] = [];
  const pending: {
    accepts: (path: string, record: string) => boolean;
    begin(): void;
    settle(): void;
    waiting: Operation<void>;
  }[] = [];

  return {
    appended,
    holdNext(accepts) {
      const arrival = withResolvers<void>();
      const letGo = withResolvers<void>();
      let holding = false;
      let abandoned = false;
      let appendedHere = false;
      pending.push({
        accepts,
        begin: () => {
          holding = true;
          arrival.resolve();
        },
        settle: () => {
          holding = false;
          abandoned = !appendedHere;
          // Resolved on the way out as well, so a release that arrives after
          // this operation came down has nothing left waiting on it.
          letGo.resolve();
        },
        waiting: letGo.operation,
      });
      return {
        *started(): Operation<void> {
          yield* arrival.operation;
        },
        get holding(): boolean {
          return holding;
        },
        get abandoned(): boolean {
          return abandoned;
        },
        release(): void {
          appendedHere = true;
          letGo.resolve();
        },
      };
    },
    *install(): Operation<void> {
      yield* ReplHost.around(
        {
          appendRecord: ([path, record], next) => ({
            *[Symbol.iterator]() {
              const at = pending.findIndex((one) => one.accepts(path, record));
              if (at === -1) {
                yield* next(path, record);
                appended.push({ path, record });
                return;
              }
              const [held] = pending.splice(at, 1);
              // Registered before the hold is taken, so an operation halted
              // while suspended here still says what became of it — and a
              // release that arrives afterwards has nothing to resolve.
              yield* ensure(function* (): Operation<void> {
                held.settle();
              });
              held.begin();
              yield* held.waiting;
              yield* next(path, record);
              appended.push({ path, record });
            },
          }),
        },
        { at: "max" },
      );
    },
  };
}

/** One mounted command, and everything a case needs to drive and read it. */

export interface MountedRepl {
  /** The terminal the program drew on, and the keyboard a case types with. */
  readonly terminal: Terminal;
  /** The scripted agent behind the Sidekick's own provider. */
  readonly fake: FakeAcp;
  /** Where the executions live, for a case that reads the files. */
  readonly repository: PairedReplRepository;
  /** The repository root, for a case that lists what is on disk. */
  readonly root: string;
  /** The profile this command runs under. */
  readonly profile: ReplProfileAssembly;
  /** The append gate, where this command's host was installed with one. */
  readonly gate: AppendGate | undefined;
  /** The operation-level append gate, where this host was installed with one. */
  readonly operations: OperationGate | undefined;
  /** The command's own outcome, once it has returned. */
  outcome(): Result<ReplOutcome> | undefined;
}

/** One installed REPL host, and the handles a case reopens or reads it with. */
export interface MountedHost {
  /** The repository root the command itself resolves. */
  readonly root: string;
  /** The scripted agent behind the Sidekick's own provider. */
  readonly fake: FakeAcp;
  /** The profile the command runs under. */
  readonly profile: ReplProfileAssembly;
  /** The executions on disk, for a case that opens one itself. */
  readonly repository: PairedReplRepository;
  /** The append gate, where this host was installed with one. */
  readonly gate: AppendGate | undefined;
  /** The operation-level append gate, where this host was installed with one. */
  readonly operations: OperationGate | undefined;
}

/** The agent the scripted provider answers for. */
export const MOUNTED_AGENT = "scribe";

/**
 * A second agent this registry also knows, for a row about replacement.
 *
 * Known to the registry so that choosing it is a real replacement rather than
 * an availability refusal: what makes a replacement fail has to be the thing a
 * row is about, not a name nothing could ever resolve.
 */
export const OTHER_MOUNTED_AGENT = "scrivener";

/**
 * Install one REPL host over a directory nothing else uses, and a scripted agent.
 *
 * The profile is the product's: `assembleReplProfile` builds it from a resolved
 * agent stack exactly as the command does, so the Sidekick assembly under test
 * is the constrained one the command would install — no tools, no servers,
 * deny-all, strict, no prompt customization — with this fake under it.
 */
export function* useMountedHost(
  options: {
    /** A gate over the host's appends, for a case that holds a real record. */
    readonly gate?: AppendGate;
    /**
     * A gate over the *operation* each append is, for a case about cancelling.
     *
     * Beside the Promise gate rather than instead of it: one holds the write
     * the host was handed and the other holds the operation that would hand it
     * over, and only the second is something a halt can take back.
     */
    readonly operations?: OperationGate;
    /**
     * A data root that already holds a history, rather than a fresh one.
     *
     * For a case whose history has to be one an earlier *process* left behind:
     * those are produced by the recovery phases, and the only way to mount the
     * command over one is to point this host at the root they wrote.
     */
    readonly dataRoot?: string;
    /**
     * The entry default and the Sidekick's own agent, as two selections.
     *
     * Both default to {@link MOUNTED_AGENT}, which is what every row that does
     * not care about the distinction already runs under. A case that does care
     * names them separately and they travel the production path: the entry
     * default through `resolveAgentStack`, the Sidekick's through
     * `assembleReplProfile` — the same two inputs the flags settle.
     */
    readonly defaultAgent?: string;
    readonly sidekickAgent?: string;
    readonly projectCwd?: string;
    readonly includes?: readonly string[];
    readonly entryInstallation?: ReplEntryInstallation;
    readonly hostFiles?: boolean;
    readonly agentCwd?: AcpxProviderDependencies["agentCwd"];
  } = {},
): Operation<MountedHost> {
  yield* useNormalizedOutput();
  const gate = options.gate;
  const directory = options.projectCwd;
  if (directory !== undefined) {
    yield* API.Env.around(
      {
        *cwd() {
          return directory;
        },
      },
      { at: "min" },
    );
  }
  if (options.hostFiles === true) {
    yield* useHostFiles();
  }
  if (options.entryInstallation !== undefined) {
    yield* ReplEntryHost.set(options.entryInstallation);
  }
  // An entry's eval block compiles through a module the host supplies, so a
  // harness without it would run entries that fail for a reason no row is about.
  yield* useTempFileCompiler();
  const dataRoot = options.dataRoot ?? (yield* useTemporary("xmd-repl-mounted-"));
  yield* installReplHost({
    dataRoot: () => dataRoot,
    environment: () => [
      { label: "runtime", value: "a controlled mounted host" },
      { label: "xmd", value: "0.0.0-mounted" },
    ],
    identify: () => randomBytes(8).toString("hex"),
    createExclusive: (path) => openFile(path, "wx").then((handle) => handle.close()),
    appendRecord: (path, record) => {
      const held = gate?.around(path, record);
      const written = (held ?? Promise.resolve()).then(() => appendFile(path, record));
      return gate === undefined
        ? written
        : written.then(() => {
            gate.reached.push(path);
          });
    },
  });
  // Over the installed implementation, at the instrumentation band, so the
  // thing a case can halt is the operation the product performs rather than a
  // Promise the host has already been given.
  if (options.operations !== undefined) {
    yield* options.operations.install();
  }
  const fake = createFakeAcp();
  const stack = yield* resolveAgentStack(
    {
      agentProvider: "acpx",
      defaultAgent: options.defaultAgent ?? MOUNTED_AGENT,
      approveAll: false,
      approveReads: false,
      denyAll: false,
    },
    undefined,
  );
  if (!stack.ok) {
    throw stack.error;
  }
  const profile = yield* assembleReplProfile(stack.value, NO_PLUGINS, {
    ...(options.includes === undefined ? {} : { includes: options.includes }),
    acp: {
      ...(options.agentCwd === undefined ? {} : { agentCwd: options.agentCwd }),
      createRuntime: fake.create,
      sessionStore: makeStore(),
      agentRegistry: makeRegistry({
        [MOUNTED_AGENT]: `${MOUNTED_AGENT}-cmd`,
        [OTHER_MOUNTED_AGENT]: `${OTHER_MOUNTED_AGENT}-cmd`,
      }),
    },
    // Named to the profile rather than left to the environment: the Sidekick
    // assembly is built with it, and a conversation opened under an agent this
    // registry does not know would fail as an availability refusal before it
    // ever reached the fake.
    sidekickAgent: options.sidekickAgent ?? MOUNTED_AGENT,
    planWriterRoot: yield* useTemporary("xmd-repl-mounted-plan-"),
  });
  // The directory the command itself resolves, so a case that writes a file for
  // the command to find writes it where the command actually looks.
  const root = join(dataRoot, ...REPL_DIRECTORY);
  return {
    root,
    fake,
    profile,
    repository: pairedReplRepository(root),
    gate,
    operations: options.operations,
  };
}

/**
 * Run the real command on a terminal this case owns, and hand back the handles.
 *
 * Spawned, because the command runs until somebody leaves: a case feeds keys,
 * reads cells and then asks for Exit or Control-C. The outcome is readable
 * afterwards, which is what a release row needs. It returns as soon as the
 * command is spawned, before anything is drawn.
 */
export function* useMountedRepl(
  options: {
    readonly sidekickAcp?: string;
    readonly size?: ReplTerminalSize;
    readonly location?: string;
    /** A host already installed, for a case that reopens the same root. */
    readonly host?: MountedHost;
    /** A gate over the host's appends, when this call installs the host. */
    readonly gate?: AppendGate;
    /** A gate over each append's own operation, when this call installs the host. */
    readonly operations?: OperationGate;
    /** A data root that already holds a history, when this call installs the host. */
    readonly dataRoot?: string;
    /** The entry default, when this call installs the host. */
    readonly defaultAgent?: string;
    /** The Sidekick's own agent, when this call installs the host. */
    readonly sidekickAgent?: string;
    readonly projectCwd?: string;
    readonly includes?: readonly string[];
    readonly entryInstallation?: ReplEntryInstallation;
    readonly hostFiles?: boolean;
    readonly agentCwd?: AcpxProviderDependencies["agentCwd"];
  } = {},
): Operation<MountedRepl> {
  const host =
    options.host ??
    (yield* useMountedHost({
      ...(options.gate === undefined ? {} : { gate: options.gate }),
      ...(options.operations === undefined ? {} : { operations: options.operations }),
      ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
      ...(options.defaultAgent === undefined ? {} : { defaultAgent: options.defaultAgent }),
      ...(options.sidekickAgent === undefined ? {} : { sidekickAgent: options.sidekickAgent }),
      ...(options.projectCwd === undefined ? {} : { projectCwd: options.projectCwd }),
      ...(options.includes === undefined ? {} : { includes: options.includes }),
      ...(options.entryInstallation === undefined
        ? {}
        : { entryInstallation: options.entryInstallation }),
      ...(options.hostFiles === undefined ? {} : { hostFiles: options.hostFiles }),
      ...(options.agentCwd === undefined ? {} : { agentCwd: options.agentCwd }),
    }));
  const recording = recordingTerminal(options.size ?? { columns: 160, rows: 36 });
  yield* recording.install();
  const settledOutcome: { value?: Result<ReplOutcome> } = {};
  yield* spawn(function* (): Operation<void> {
    const outcome = yield* runReplProgram({
      profile: host.profile,
      ...(options.sidekickAcp === undefined ? {} : { sidekickAcp: options.sidekickAcp }),
      ...(options.location === undefined ? {} : { location: options.location }),
    });
    settledOutcome.value = outcome;
    recording.terminal.stopped(outcome.ok ? undefined : outcome.error);
  });
  return {
    terminal: recording.terminal,
    fake: host.fake,
    repository: host.repository,
    root: host.root,
    profile: host.profile,
    gate: host.gate,
    operations: host.operations,
    outcome: () => settledOutcome.value,
  };
}

/**
 * The one execution this command published, by name.
 *
 * Discovered rather than told: a fresh command mints its own identifier, and a
 * row that named one would be naming the fixture's bookkeeping instead of the
 * execution the product created.
 */
export function* mountedExecution(repl: MountedRepl): Operation<string> {
  const published = yield* until(readdir(join(repl.root, PAIRED_DIRECTORY)));
  if (published.length !== 1) {
    throw new Error(`one execution was expected on disk, and there are ${published.length}`);
  }
  return published[0];
}

/** What is actually on disk for this command: its chat, and its entry history. */
export function* mountedReading(repl: MountedRepl): Operation<{
  readonly execution: string;
  readonly chat: readonly SidekickRecord[];
  readonly model: ReplModel;
}> {
  const execution = yield* mountedExecution(repl);
  const opened = yield* repl.repository.open(execution);
  if (opened.chat.form !== "paired") {
    throw new Error("this execution has no published chat history to read");
  }
  const projected = projectRepl(yield* opened.stream.readAll());
  if (!projected.ok) {
    throw projected.error;
  }
  return { execution, chat: opened.chat.records, model: projected.value };
}
