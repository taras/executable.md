/**
 * Issue #774 POC — the deterministic fake pane and synthetic session files.
 *
 * The fake pane implements the same `PaneProbe` the tmux provider would, over a
 * structural state a test controls directly: a generation, a process, a
 * terminal, a mode, client-activity and output-event counters, and an event
 * epoch. It also holds two facts the real provider could never expose — whether
 * the pane is *actually* busy and whether a person is *actually* typing — and
 * those are readable only by the assertions, never by the convergence algorithm.
 * If the algorithm ever pastes while either is true, the fake records it and the
 * test fails.
 *
 * It also models the two ways the final guard can go wrong on a real server: a
 * command that fails outright (declined) and one that half-succeeds so bytes may
 * have gone but the whole delivery is unproved (uncertain). A test arms either.
 *
 * The synthetic-file helpers write append-only provider records in the exact
 * shapes the two observers accept, so a test can build acceptance, completion, a
 * partial tail, truncation, rotation, an ambiguous identity, a wrong identity, a
 * wrong project and an unsupported shape without a real agent.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { appendFile, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  GuardOutcome,
  PaneProbe,
  PaneSnapshot,
  PasteRequest,
} from "../../../poc/repl/convergence.ts";
import { structurallyEqual } from "../../../poc/repl/convergence.ts";

/** One paste the fake actually performed, with the hidden truth at that instant. */
export interface FakeDelivery {
  readonly buffer: string;
  readonly bytes: string;
  /** True only if a paste happened while the pane was actually busy. Must never be. */
  readonly whileBusy: boolean;
  /** True only if a paste happened while a person was actually typing. Must never be. */
  readonly whileManual: boolean;
}

/** The fake pane: a `PaneProbe` plus the controls and ground truth a test reads. */
export interface FakePane {
  readonly probe: PaneProbe;
  /** Every paste that reached the pane, in order. */
  readonly deliveries: readonly FakeDelivery[];
  /** How many times the guard declined a paste. */
  readonly declines: number;
  /** How many named buffers are still loaded (a delivery removes its own). */
  pendingBuffers(): number;
  /** Bump the event epoch: any observable pane event. */
  event(): void;
  /** A visible client acted (a person moved the cursor, scrolled, typed). */
  clientActivity(): void;
  /** The pane produced output. */
  output(): void;
  /** Set the hidden truth that the pane is busy on a turn. */
  setBusy(busy: boolean): void;
  /** Set the hidden truth that a person is typing. */
  setManual(active: boolean): void;
  /** Put the pane into (or out of) a mode such as copy-mode. */
  setMode(mode: string): void;
  /** Replace the pane: a new generation at the same ordinal. */
  replace(): void;
  /** The pane's process exited. */
  kill(): void;
  /** Run `mutate` the next time the fake crosses a barrier (may do async work). */
  armBarrier(mutate: () => Operation<void>): void;
  /** Run `mutate` the next time a buffer is loaded (just before the guarded paste). */
  armLoad(mutate: () => void): void;
  /** Make the next guarded paste fail its server-side command with this outcome. */
  armGuardFailure(kind: "declined" | "uncertain"): void;
}

/** Options for a fresh fake pane. */
export interface FakePaneOptions {
  readonly generation?: number;
  readonly bracketedPasteSupported?: boolean;
}

/** Build a fake pane in an idle, usable state. */
export function createFakePane(options: FakePaneOptions = {}): FakePane {
  let generation = options.generation ?? 1;
  let pid = 4321;
  let terminal = "ttys021";
  let alive = true;
  let mode = "";
  let foregroundProcess = 4321;
  let clientActivityCount = 0;
  let outputEvents = 0;
  let epoch = 0;
  let busy = false;
  let manual = false;
  let declines = 0;
  const deliveries: FakeDelivery[] = [];
  const buffers = new Map<string, string>();
  let barrierTrap: (() => Operation<void>) | undefined;
  let loadTrap: (() => void) | undefined;
  let guardFailure: "declined" | "uncertain" | undefined;

  function snapshot(): PaneSnapshot {
    return {
      generation,
      pid: alive ? pid : -1,
      terminal: alive ? terminal : "",
      alive,
      mode,
      foregroundProcess,
      clientActivity: clientActivityCount,
      outputEvents,
      epoch,
    };
  }

  const probe: PaneProbe = {
    // deno-lint-ignore require-yield
    *snapshot(): Operation<PaneSnapshot> {
      return snapshot();
    },
    *barrier(): Operation<void> {
      const trap = barrierTrap;
      barrierTrap = undefined;
      if (trap !== undefined) {
        yield* trap();
      }
      // A barrier is an acknowledged round-trip; the yield models that wait
      // without changing any structural fact by itself.
      yield* until(Promise.resolve());
    },
    *loadBuffer(buffer, path): Operation<void> {
      const trap = loadTrap;
      loadTrap = undefined;
      if (trap !== undefined) {
        trap();
      }
      const bytes = new TextDecoder().decode(yield* until(readFile(path)));
      buffers.set(buffer, bytes);
    },
    // deno-lint-ignore require-yield
    *deleteBuffer(buffer): Operation<void> {
      buffers.delete(buffer);
    },
    // deno-lint-ignore require-yield
    *guardedPaste(guard: PaneSnapshot, delivery: PasteRequest): Operation<GuardOutcome> {
      // The recheck and the paste happen with no suspension between them: the
      // current state is read and compared, and a matching guard pastes at once.
      const current = snapshot();
      if (!structurallyEqual(guard, current) || guard.epoch !== current.epoch) {
        declines += 1;
        return { outcome: "declined", reason: "guard-changed" };
      }
      if (!current.alive) {
        declines += 1;
        return { outcome: "declined", reason: "pane-unavailable" };
      }
      const failure = guardFailure;
      guardFailure = undefined;
      if (failure === "declined") {
        declines += 1;
        return { outcome: "declined", reason: "tmux-command-failed" };
      }
      if (failure === "uncertain") {
        // The buffer pasted but the submit key could not be proved sent.
        return { outcome: "uncertain", reason: "submit-unacknowledged" };
      }
      const bytes = buffers.get(delivery.buffer) ?? "";
      deliveries.push({ buffer: delivery.buffer, bytes, whileBusy: busy, whileManual: manual });
      return { outcome: "pasted" };
    },
  };

  return {
    probe,
    get deliveries() {
      return deliveries;
    },
    get declines() {
      return declines;
    },
    pendingBuffers() {
      return buffers.size;
    },
    event() {
      epoch += 1;
    },
    clientActivity() {
      clientActivityCount += 1;
      epoch += 1;
    },
    output() {
      outputEvents += 1;
      epoch += 1;
    },
    setBusy(value) {
      busy = value;
    },
    setManual(value) {
      manual = value;
    },
    setMode(value) {
      mode = value;
      epoch += 1;
    },
    replace() {
      generation += 1;
      pid += 1;
      terminal = `ttys0${20 + generation}`;
      epoch += 1;
    },
    kill() {
      alive = false;
      epoch += 1;
    },
    armBarrier(mutate) {
      barrierTrap = mutate;
    },
    armLoad(mutate) {
      loadTrap = mutate;
    },
    armGuardFailure(kind) {
      guardFailure = kind;
    },
  };
}

// --- Synthetic provider records ------------------------------------------------

/** A Claude `user` record carrying the exact attempted text under `sessionId`. */
export function claudeUser(sessionId: string, text: string, turn?: string): string {
  return line({
    type: "user",
    sessionId,
    ...(turn === undefined ? {} : { requestId: turn }),
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/** A Claude `assistant` record, optionally grouped under a turn's `requestId`. */
export function claudeAssistant(sessionId: string, text: string, turn?: string): string {
  return line({
    type: "assistant",
    sessionId,
    ...(turn === undefined ? {} : { requestId: turn }),
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/** The explicit Claude completion boundary, optionally grouped under a turn. */
export function claudeResult(sessionId: string, turn?: string): string {
  return line({
    type: "result",
    sessionId,
    subtype: "success",
    ...(turn === undefined ? {} : { requestId: turn }),
  });
}

/** A Claude `user` record whose message has no readable text: an unsupported shape. */
export function claudeUnsupported(sessionId: string): string {
  return line({ type: "user", sessionId, message: { role: "user" } });
}

/** The Codex `session_meta` header naming the thread identity and its project. */
export function codexMeta(id: string, project?: string): string {
  return line({
    type: "session_meta",
    payload: { id, ...(project === undefined ? {} : { cwd: project }) },
  });
}

/** A Codex `user_message` event carrying the exact attempted text. */
export function codexUser(text: string): string {
  return line({ type: "event_msg", payload: { type: "user_message", message: text } });
}

/** A Codex `agent_message` event. */
export function codexAgent(text: string): string {
  return line({ type: "event_msg", payload: { type: "agent_message", message: text } });
}

/** The Codex completion boundary. */
export function codexComplete(): string {
  return line({ type: "event_msg", payload: { type: "task_complete" } });
}

/** A Codex `user_message` with no message text: an unsupported shape. */
export function codexUnsupported(): string {
  return line({ type: "event_msg", payload: { type: "user_message" } });
}

/** One newline-terminated JSON record. */
function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

/** Write the given records to a file, replacing whatever was there. */
export function writeRecords(path: string, records: readonly string[]): Operation<void> {
  return (function* (): Operation<void> {
    yield* until(writeFile(path, records.join(""), "utf8"));
  })();
}

/** Append records to a file, as a provider appends to its own session file. */
export function appendRecords(path: string, records: readonly string[]): Operation<void> {
  return (function* (): Operation<void> {
    yield* until(appendFile(path, records.join(""), "utf8"));
  })();
}

/** Append a partial (unterminated) record fragment, as a mid-write file has. */
export function appendPartial(path: string, fragment: string): Operation<void> {
  return (function* (): Operation<void> {
    yield* until(appendFile(path, fragment, "utf8"));
  })();
}

/** Truncate a file to `bytes`, modelling a provider file cut short. */
export function truncateFile(path: string, bytes: number): Operation<void> {
  return (function* (): Operation<void> {
    yield* until(truncate(path, bytes));
  })();
}

/** Replace a file with a fresh one at a new inode, modelling rotation. */
export function rotateFile(path: string, records: readonly string[]): Operation<void> {
  return (function* (): Operation<void> {
    const staged = `${path}.rotated`;
    yield* until(writeFile(staged, records.join(""), "utf8"));
    yield* until(rename(staged, path));
  })();
}

/** The byte length of a set of records, for a truncation offset. */
export function byteLength(records: readonly string[]): number {
  return new TextEncoder().encode(records.join("")).length;
}

/** A file path inside a provider directory named for a Claude session. */
export function claudeSessionPath(directory: string, sessionId: string): string {
  return join(directory, `${sessionId}.jsonl`);
}

/** A file path inside a provider directory for a Codex rollout. */
export function codexRolloutPath(directory: string, label: string): string {
  return join(directory, `rollout-${label}.jsonl`);
}
