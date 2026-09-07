/**
 * Issue #774 POC — the sequence-numbered action store.
 *
 * A Flux-style store: one immutable state, one reducer, and an append-only log
 * of the actions that produced it. Every accepted action is persisted as its own
 * file, named by its sequence number, through a staged write and a rename so a
 * crash never leaves a half-written record in the log. The directory is mode
 * `0700` and each record `0600`.
 *
 * Restart restores the store by replaying that log. Every record's complete shape
 * and legal type are parsed with a schema — a known action missing a member, an
 * unknown type, a record whose file name disagrees with its sequence number, a
 * gap, a duplicate, or any conflicting history is refused rather than read past,
 * because a store that guessed would resume a run it cannot account for.
 *
 * StarFX was evaluated as an implementation aid and deliberately not adopted:
 * the reducer and the log are small enough to own directly, and the POC must add
 * no production dependency.
 */

import { createSignal, ensure, resource, until } from "effection";
import type { Operation, Stream } from "effection";
import { ensureDir, exists, readdir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ReplAction } from "./actions.ts";
import { emptyState, reduce } from "./state.ts";
import type { ReplState } from "./state.ts";

/** One persisted log entry: the action and the sequence number it was given. */
export interface StoredAction {
  readonly seq: number;
  readonly action: ReplAction;
}

/** A retained history that cannot be trusted to replay. */
export class ReplStoreError extends Error {
  override name = "ReplStoreError";
  constructor(reason: string) {
    super(`the REPL POC store could not be restored: ${reason}`);
  }
}

/** The live handle a controller and its observers dispatch through. */
export interface ReplStore {
  /** The current immutable state. */
  state(): ReplState;
  /** The whole retained log, in order. */
  history(): readonly StoredAction[];
  /** Fold one action in, persist it, and publish the new state. */
  dispatch(action: ReplAction): Operation<ReplState>;
  /** Every state the store has published, for a consumer that watches it. */
  readonly states: Stream<ReplState, void>;
}

const IdentitySchema = z.object({
  provider: z.enum(["claude", "codex"]),
  id: z.string(),
});

const ReadinessSchema = z.enum(["unknown", "converging", "ready", "busy", "unavailable"]);

/** The complete shape of every action, so a malformed one is refused. */
const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ReplOpened"), replSession: z.string() }),
  z.object({
    type: z.literal("RoleBound"),
    key: z.string(),
    role: z.string(),
    issue: z.string(),
    identity: IdentitySchema,
    paneGeneration: z.number().int(),
  }),
  z.object({
    type: z.literal("MessageQueued"),
    key: z.string(),
    id: z.string(),
    text: z.string(),
    marker: z.string(),
  }),
  z.object({ type: z.literal("TerminalObserved"), key: z.string(), readiness: ReadinessSchema }),
  z.object({ type: z.literal("ProviderBusy"), key: z.string() }),
  z.object({ type: z.literal("ProviderIdle"), key: z.string() }),
  z.object({ type: z.literal("ConvergenceStarted"), key: z.string(), id: z.string() }),
  z.object({
    type: z.literal("ConvergenceInvalidated"),
    key: z.string(),
    id: z.string(),
    reason: z.string(),
  }),
  z.object({ type: z.literal("AttemptStarted"), key: z.string(), id: z.string() }),
  z.object({
    type: z.literal("AttemptDeclined"),
    key: z.string(),
    id: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("AttemptUncertain"),
    key: z.string(),
    id: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("UserAccepted"),
    key: z.string(),
    id: z.string(),
    eventKey: z.string(),
    identity: z.string(),
    text: z.string(),
    turn: z.string().optional(),
  }),
  z.object({
    type: z.literal("AssistantObserved"),
    key: z.string(),
    eventKey: z.string(),
    identity: z.string(),
    text: z.string(),
    turn: z.string().optional(),
  }),
  z.object({
    type: z.literal("AssistantCompleted"),
    key: z.string(),
    id: z.string(),
    eventKey: z.string(),
    identity: z.string(),
    turn: z.string().optional(),
  }),
  z.object({
    type: z.literal("ObserverAdvanced"),
    key: z.string(),
    cursor: z.number().int(),
    source: z.string(),
  }),
  z.object({ type: z.literal("PaneUnavailable"), key: z.string(), reason: z.string() }),
  z.object({ type: z.literal("ObserverRefused"), key: z.string(), reason: z.string() }),
  z.object({ type: z.literal("ReplClosed") }),
]);

const EntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  action: ActionSchema,
});

// The schema is held to the declared action union rather than the union being
// read off it: a change to either the schema stops compiling here.
const _actionSchema: z.ZodType<ReplAction> = ActionSchema;

/** A stored entry's file name: zero-padded so a lexical sort is numeric. */
function recordName(seq: number): string {
  return `${String(seq).padStart(6, "0")}.json`;
}

/** The sequence number a record file name encodes, or NaN when it encodes none. */
function seqFromName(name: string): number {
  const digits = name.slice(0, -".json".length);
  return /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
}

/**
 * Open one REPL store rooted at `dir`, restoring any retained log.
 *
 * The directory is created `0700`. A log already present is replayed to rebuild
 * the state and the next sequence number; an absent directory is a fresh store.
 */
export function useReplStore(dir: string): Operation<ReplStore> {
  return resource<ReplStore>(function* (provide) {
    yield* ensureDir(dir);
    yield* until(chmod(dir, 0o700));

    const log: StoredAction[] = yield* loadLog(dir);
    let current = emptyState();
    for (const entry of log) {
      current = reduce(current, entry.action);
    }
    current = { ...current, nextAction: log.length };

    const published = createSignal<ReplState, void>();
    yield* ensure(() => published.close());

    function* dispatch(action: ReplAction): Operation<ReplState> {
      const seq = current.nextAction;
      const entry: StoredAction = { seq, action };
      yield* persist(dir, entry);
      log.push(entry);
      current = { ...reduce(current, action), nextAction: seq + 1 };
      published.send(current);
      return current;
    }

    yield* provide({
      state: () => current,
      history: () => [...log],
      dispatch,
      states: published,
    });
  });
}

/** Read, validate and order the retained log. */
function* loadLog(dir: string): Operation<StoredAction[]> {
  if (!(yield* exists(dir))) {
    return [];
  }
  const names = (yield* readdir(dir)).filter((name) => name.endsWith(".json"));
  const entries: StoredAction[] = [];
  for (const name of names) {
    const text = yield* readTextFile(join(dir, name));
    entries.push(parseEntry(text, name));
  }
  entries.sort((left, right) => left.seq - right.seq);
  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index) {
      throw new ReplStoreError(
        entry.seq < index
          ? `a duplicate or out-of-order record at sequence ${entry.seq}`
          : `a gap before sequence ${entry.seq}`,
      );
    }
  }
  return entries;
}

/** Parse one record strictly, refusing a shape the log may not contain. */
function parseEntry(text: string, name: string): StoredAction {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ReplStoreError(`a record that is not JSON (${name})`);
  }
  const parsed = EntrySchema.safeParse(value);
  if (!parsed.success) {
    throw new ReplStoreError(
      `a malformed record (${name}): ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  const nameSeq = seqFromName(name);
  if (Number.isNaN(nameSeq) || nameSeq !== parsed.data.seq) {
    throw new ReplStoreError(`a record whose file name disagrees with its sequence (${name})`);
  }
  return { seq: parsed.data.seq, action: parsed.data.action };
}

/** Write one record through a staged file and a rename, at mode `0600`. */
function* persist(dir: string, entry: StoredAction): Operation<void> {
  const staged = join(dir, `${recordName(entry.seq)}.staged`);
  const final = join(dir, recordName(entry.seq));
  yield* writeTextFile(staged, `${JSON.stringify(entry)}\n`);
  yield* until(chmod(staged, 0o600));
  yield* until(rename(staged, final));
}

/** Remove one store's whole directory. For a POC harness cleaning up after itself. */
export function purgeStore(dir: string): Operation<void> {
  return rm(dir, { recursive: true, force: true });
}
