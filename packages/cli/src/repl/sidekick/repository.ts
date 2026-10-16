/**
 * Which of the two storage shapes an execution is in, and opening it as that.
 *
 * `journal.ts` owns the single-file format and knows nothing about chat;
 * `history.ts` owns the Sidekick protocol and knows nothing about choosing
 * between formats. This is the one place that does both, which is also why it
 * is a module of its own rather than an addition to either: a repository that
 * imported the chat protocol *and* was imported by it would be a cycle, and the
 * thing being decided here — which shape is on disk — belongs to neither side.
 *
 * Two shapes, and the distinction is not optional anywhere downstream. A new
 * execution is published as a pair from the start, because its creator is the
 * only writer that may establish one and doing it later would mean upgrading a
 * history that was this CLI's own from the beginning. An execution already held
 * in the older single file stays in it, readable and unconverted, until its
 * first explicit Sidekick message — which is what keeps reopening a chat free
 * of writes and free of provider work.
 */

import { exists } from "@effectionx/fs";
import type { Operation } from "effection";

import { movableWriter, openExecutionFile, readRecords } from "../journal.ts";
import type { MovableWriter, ReplRepository } from "../journal.ts";
import { executionPath } from "../journal.ts";
import { ReplHost } from "../host.ts";
import {
  openPair,
  pairedEntryStream,
  pairedLocation,
  publishPair,
  SidekickHistoryError,
  upgradeExecution,
} from "./history.ts";
import type { OwnerRecord, PairedLocation, SidekickRecord, SidekickWriter } from "./history.ts";

/**
 * What one execution's chat storage is.
 *
 * A required member rather than an optional one, so every caller faces the
 * question: a `legacy` execution has no chat history yet and a `paired` one
 * does, and code that treated the difference as an absent field would be code
 * that silently did nothing for half the executions it was given.
 */
export type ReplChatStorage =
  | {
      readonly form: "paired";
      readonly location: PairedLocation;
      readonly owner: OwnerRecord;
      readonly writer: SidekickWriter;
      /** Every record the pair already held when it was opened. */
      readonly records: readonly SidekickRecord[];
    }
  | {
      readonly form: "legacy";
      /** The older single file, which is still the whole of this history. */
      readonly path: string;
    };

/**
 * The shape a Sidekick may actually be written to.
 *
 * Named because the owner takes exactly this: a conversation needs a writer and
 * the records already in the file, and a legacy execution has neither until its
 * first explicit message publishes a pair.
 */
export type PairedChatStorage = Extract<ReplChatStorage, { readonly form: "paired" }>;

/** One execution the REPL can show, in whichever shape holds it. */
export interface PairedReplExecution {
  readonly id: string;
  /**
   * The entry writer, which is stable across an upgrade.
   *
   * Movable rather than a file, so an entry already running when its execution
   * is upgraded keeps the object it was handed and never holds a writer to the
   * superseded path.
   */
  readonly stream: MovableWriter;
  readonly chat: ReplChatStorage;
}

/** Where a set of executions live, in either shape. */
export interface PairedReplRepository extends ReplRepository {
  create(): Operation<PairedReplExecution>;
  open(execution: string): Operation<PairedReplExecution>;
  /**
   * Publish a pair for an execution still held in the older single file.
   *
   * The caller is the root, which has already stopped admitting entries: this
   * performs the handoff and nothing about deciding when it is safe to.
   */
  upgrade(execution: PairedReplExecution): Operation<PairedReplExecution>;
}

export function pairedReplRepository(root: string): PairedReplRepository {
  return {
    *create(): Operation<PairedReplExecution> {
      // Published as a pair immediately. Its creator is the only writer that
      // may establish one, and `publishPair` creates both files exclusively, so
      // two processes racing for the same name is a refusal rather than a merge
      // — the same guarantee the single-file format took from exclusive create.
      const execution = yield* ReplHost.operations.identify();
      const published = yield* publishPair(root, execution, { body: "", events: [] });
      return {
        id: execution,
        stream: movableWriter(published.entries),
        chat: {
          form: "paired",
          location: published.location,
          owner: { kind: "owner", version: 1, execution },
          writer: published.sidekick,
          records: [],
        },
      };
    },

    *open(execution: string): Operation<PairedReplExecution> {
      const location = pairedLocation(root, execution);
      const legacy = executionPath(root, execution);
      if (yield* exists(location.directory)) {
        // A directory that exists is a pair, whether or not it is a usable one.
        // It never falls back to the older file: a newer-format location does
        // not become a legacy execution because its chat history disappeared,
        // and starting a second history beside a broken pair is how one history
        // becomes two.
        const opened = yield* openPair(root, execution, legacy);
        return {
          id: execution,
          stream: movableWriter(opened.entries),
          chat: {
            form: "paired",
            location: opened.location,
            owner: opened.owner,
            writer: opened.sidekick,
            records: opened.records,
          },
        };
      }
      // Opened exactly as it is, with no conversion, no append and nothing
      // asked of a provider.
      const held = yield* openExecutionFile(root, execution);
      return {
        id: held.id,
        stream: movableWriter(held.stream),
        chat: { form: "legacy", path: legacy },
      };
    },

    *upgrade(execution: PairedReplExecution): Operation<PairedReplExecution> {
      if (execution.chat.form === "paired") {
        throw new SidekickHistoryError(
          "this execution already has a paired history, so there is nothing to upgrade.",
        );
      }
      const published = yield* upgradeExecution(
        root,
        execution.id,
        execution.chat.path,
        execution.stream,
      );
      return {
        id: execution.id,
        // The same facade, now pointing at the new file. Handing back a second
        // one would leave every task that already holds this one writing to the
        // path the pair just superseded.
        stream: execution.stream,
        chat: {
          form: "paired",
          location: published.location,
          owner: { kind: "owner", version: 1, execution: execution.id },
          writer: published.sidekick,
          records: yield* published.sidekick.readAll(),
        },
      };
    },
  };
}
