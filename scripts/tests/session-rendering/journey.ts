/**
 * One finite session journey, owned by a single Effection scope.
 *
 * A source publishes immutable snapshots of a conversation. An ingest task
 * reduces each one the moment it arrives, and a projector renders whatever the
 * newest state says — never the snapshot that woke it, if a later one landed
 * while it was suspended. That split is the whole point: while one presentation
 * is blocked mid-projection the source keeps publishing, and what commits
 * afterwards has to be the latest completed revision rather than the backlog
 * replayed in order.
 *
 * Everything above the terminal belongs here — ordered history, stable entry
 * identity, replacement, dirty-id collapsing, which entries are visible, the
 * anchor entry, follow mode and the unread count. `@bomb.sh/tty` owns layout,
 * clipping, input decoding, resize processing and the ANSI bytes, and is asked
 * for a complete operation tree every frame.
 *
 * The entry shape is private to this module on purpose. It is not a normalized
 * entry, it is not a component prop, and nothing outside this directory may
 * grow a dependency on it.
 */

import { createQueue, ensure, Err, Ok, scoped, spawn, until, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { close, createTerm, grow, open } from "@bomb.sh/tty";
import { createInput } from "@bomb.sh/tty";
import type { Op, Term } from "@bomb.sh/tty";
import { join, relative, resolve } from "node:path";
import { readTextFile } from "@effectionx/fs";

import { DocumentOutput } from "../../../packages/core/src/api.ts";
import { collect } from "../../../packages/core/src/collect.ts";
import { execute } from "../../../packages/core/src/execute.ts";
import { inlineSource } from "../../../packages/core/src/root-source.ts";
import { registerComponents } from "../../../packages/core/src/components/registration.ts";
import { selectComponent } from "../../../packages/core/src/components/select.ts";
import { Component } from "../../../packages/core/src/component-api.ts";
import { FILES_ERROR, Files, FilesError } from "../../../packages/runtime/files.ts";
import type {
  FilePathInput,
  FileWriteSuccess,
  GlobInput,
} from "../../../packages/runtime/files.ts";
import { InMemoryStream } from "../../../packages/durable-streams/mod.ts";
import {
  blockRows,
  describeOperations,
  entryOperations,
  entrySlice,
  lexProofMarkdown,
} from "./markdown-projection.ts";
import type { Block, OperationDescription } from "./markdown-projection.ts";

/** The evidence schema this journey emits, so a reader can tell versions apart. */
export const REPORT_SCHEMA = "executablemd.proof.session-rendering/v1";

/** The dependency whose operations and bytes this proof is about. */
export const TTY_PACKAGE = "@bomb.sh/tty";
export const TTY_VERSION = "0.9.0";

/**
 * Every way this journey can be made to misbehave, and nothing else.
 *
 * Each one is a rejecting control for one row of the evidence matrix: it runs
 * in a process of its own, and the same invariant checker that admits the
 * positive journey has to reject it for the category that names the claim.
 */
export const JOURNEY_MUTATIONS = [
  "omit-component",
  "default-before-repository",
  "plain-markdown",
  "unstable-regions",
  "no-coalescing",
  "forced-follow",
  "row-offset-viewport",
  "whole-history-repaint",
  "forbidden-read",
] as const;

export type JourneyMutation = (typeof JOURNEY_MUTATIONS)[number];

export function parseJourneyMutation(value: string): JourneyMutation | undefined {
  return JOURNEY_MUTATIONS.find((mutation) => mutation === value);
}

/** The seven presentations this proof selects, in the order history holds them. */
type Presentation = "user" | "assistant" | "tool" | "permission" | "status" | "unknown" | "thought";

/**
 * The component each presentation resolves to.
 *
 * The mapping is private: a document writes the component name, and nothing
 * outside this module learns that a local discriminator chose it.
 */
const COMPONENT_OF: Record<Presentation, string> = {
  user: "Session.Message.User",
  assistant: "Session.Message.Assistant",
  tool: "Session.Message.Tool",
  permission: "Session.Message.Permission",
  status: "Session.Message.Status",
  unknown: "Session.Message.Unknown",
  thought: "Session.Message.Thought",
};

const HISTORY: readonly Presentation[] = [
  "user",
  "assistant",
  "tool",
  "permission",
  "status",
  "unknown",
  "thought",
];

/** One entry as the source publishes it. Immutable, and private to this module. */
interface Entry {
  readonly id: string;
  readonly presentation: Presentation;
  readonly revision: number;
  readonly complete: boolean;
  readonly markdown: string;
}

/** One published snapshot: the whole conversation as the source then saw it. */
type Snapshot = readonly Entry[];

const TWO_PARAGRAPHS = "First *emphasis* line.\n\nSecond line.";
const WITH_CODE = `${TWO_PARAGRAPHS}\n\n\`\`\`ts\nconst proof: number = 1;\n\`\`\``;

/** The payload each presentation carries on its first publication. */
const INITIAL_MARKDOWN: Record<Presentation, string> = {
  user: TWO_PARAGRAPHS,
  assistant: TWO_PARAGRAPHS,
  tool: WITH_CODE,
  permission: TWO_PARAGRAPHS,
  status: TWO_PARAGRAPHS,
  // Carried by an entry the initial viewport shows as well as by the tool, so
  // that the structured-content claim does not quietly depend on the view
  // having scrolled far enough to reach a fenced block.
  unknown: WITH_CODE,
  thought: TWO_PARAGRAPHS,
};

/** What every payload collapses to when the journey flattens its Markdown. */
const PLAIN_MARKDOWN = "One line of ordinary prose.";

const THOUGHT_ID = "entry-thought";

function entryId(presentation: Presentation): string {
  return `entry-${presentation}`;
}

function frozen(entries: readonly Entry[]): Snapshot {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

/** What one committed projection is: its Markdown, its blocks and its provenance. */
interface Projection {
  readonly id: string;
  readonly component: string;
  readonly componentPath: string;
  readonly revision: number;
  readonly complete: boolean;
  readonly raw: string;
  readonly blocks: readonly Block[];
}

/** One request the document filesystem boundary saw, and what the ledger said. */
export interface FilesRequest {
  readonly operation: string;
  readonly path: string;
  readonly admitted: boolean;
}

/** One rendered frame, as the report carries it. */
export interface FrameRecord {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly visible: readonly string[];
  readonly anchor: string;
  readonly follow: boolean;
  readonly unread: number;
  readonly bytes: number;
  readonly operations: readonly OperationDescription[];
}

/** One commit the projector made, in the order it made them. */
export interface CommitRecord {
  readonly id: string;
  readonly revision: number;
  readonly complete: boolean;
  readonly viewVersion: number;
}

/** Where one of the seven names resolved, asked of the resolver itself. */
export interface PresentationRecord {
  readonly component: string;
  readonly path: string;
  readonly root: string;
}

/** One committed projection, as the report carries it. */
export interface ProjectionRecord {
  readonly id: string;
  readonly component: string;
  readonly componentPath: string;
  readonly revision: number;
  readonly complete: boolean;
  readonly raw: string;
}

export interface JourneyReport {
  readonly schema: string;
  readonly dependency: { readonly name: string; readonly version: string };
  readonly authorities: Readonly<Record<string, string>>;
  readonly presentations: readonly PresentationRecord[];
  readonly projections: readonly ProjectionRecord[];
  readonly history: readonly string[];
  readonly commits: readonly CommitRecord[];
  readonly timeline: readonly string[];
  readonly barrier: {
    readonly ingestedWhileBlocked: readonly number[];
    readonly releasedAfterVersion: number;
    readonly committedAfterRelease: readonly CommitRecord[];
  };
  readonly frames: readonly FrameRecord[];
  readonly resize: {
    readonly requested: readonly { readonly width: number; readonly height: number }[];
    readonly adopted: { readonly width: number; readonly height: number };
    readonly anchorBefore: string;
    readonly anchorAfter: string;
    readonly followBefore: boolean;
    readonly followAfter: boolean;
    readonly unreadBefore: number;
    readonly unreadAfter: number;
    readonly historyBefore: readonly string[];
    readonly historyAfter: readonly string[];
  };
  readonly diff: {
    readonly incrementalBytes: number;
    readonly freshBytes: number;
    readonly neighbours: readonly string[];
    readonly neighboursBefore: readonly OperationDescription[];
    readonly neighboursAfter: readonly OperationDescription[];
  };
  readonly files: readonly FilesRequest[];
  readonly discardedProjections: number;
}

const INITIAL_WIDTH = 60;
const INITIAL_HEIGHT = 12;
const RESIZE_BATCH = [
  { width: 70, height: 14 },
  { width: 80, height: 16 },
] as const;

/** The `@bomb.sh/tty` key bytes this journey feeds through the input parser. */
const PAGE_UP = "\x1b[5~";
const END = "\x1b[F";

/** The permissions the journey reports, queried rather than assumed. */
function authorities(root: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const name of ["net", "write", "run", "sys", "ffi", "env"] as const) {
    record[name] = Deno.permissions.querySync({ name }).state;
  }
  record.read = Deno.permissions.querySync({ name: "read", path: root }).state;
  return record;
}

/**
 * The document filesystem ledger.
 *
 * Every request is recorded with the verdict it got, and only paths inside the
 * proof's own component roots are admitted. A journey that reached for anything
 * else — a provider file, a session store, a host configuration — leaves a
 * refused entry behind, which is what the forbidden-integration oracle reads.
 */
function useFilesLedger(root: string, ledger: FilesRequest[]): Operation<void> {
  function admits(input: { readonly cwd: string; readonly path: string }): boolean {
    const inside = relative(root, resolve(input.cwd, input.path));
    return inside.length > 0 && !inside.startsWith("..") && !inside.startsWith("/");
  }

  function refuse<T>(operation: "read" | "check-file-path"): Result<T> {
    return Err(
      new FilesError({
        type: FILES_ERROR,
        operation,
        phase: "lexical",
        reason: "resolved-escape",
      }),
    );
  }

  function deny<T>(operation: string, path: string): Result<T> {
    ledger.push({ operation, path, admitted: false });
    return refuse<T>("check-file-path");
  }

  return Files.around({
    // deno-lint-ignore require-yield
    *checkFilePath([input]: [FilePathInput]) {
      if (!admits(input)) {
        return deny<void>("check-file-path", input.path);
      }
      ledger.push({ operation: "check-file-path", path: input.path, admitted: true });
      return Ok(undefined);
    },
    *readTextFile([input]: [FilePathInput]) {
      if (!admits(input)) {
        return deny<string>("read", input.path);
      }
      ledger.push({ operation: "read", path: input.path, admitted: true });
      return Ok(yield* readTextFile(resolve(input.cwd, input.path)));
    },
    // deno-lint-ignore require-yield
    *writeTextFile([input]: [FilePathInput]) {
      return deny<FileWriteSuccess>("write", input.path);
    },
    // deno-lint-ignore require-yield
    *deleteFile([input]: [FilePathInput]) {
      return deny<void>("delete", input.path);
    },
    // deno-lint-ignore require-yield
    *ensureDirectory([input]: [FilePathInput]) {
      return deny<void>("ensure-directory", input.path);
    },
    // deno-lint-ignore require-yield
    *globFiles([input]: [GlobInput]) {
      return deny<string[]>("glob", input.include.join(","));
    },
    // deno-lint-ignore require-yield
    *temporaryDirectory() {
      return deny<string>("temporary-directory", "");
    },
  });
}

interface SnapshotScript {
  /** One snapshot per presentation, growing the conversation to its full history. */
  readonly initial: readonly Snapshot[];
  /** The revision whose projection blocks. */
  readonly blocking: Snapshot;
  /** Two further revisions and the completion, published while that one is held. */
  readonly whileBlocked: readonly Snapshot[];
  readonly appendOffBottom: Snapshot;
  readonly appendFollowing: Snapshot;
}

/**
 * The fixed sequence of snapshots this journey publishes.
 *
 * Everything the journey waits for is an event or a barrier and no step is
 * timed, so the same order holds under any scheduling.
 */
function journeySnapshots(mutation: JourneyMutation | undefined): SnapshotScript {
  const presentations =
    mutation === "omit-component"
      ? HISTORY.filter((presentation) => presentation !== "unknown")
      : HISTORY;
  const markdownOf = (presentation: Presentation): string =>
    mutation === "plain-markdown" ? PLAIN_MARKDOWN : INITIAL_MARKDOWN[presentation];

  let conversation: Entry[] = [];
  const initial: Snapshot[] = [];
  for (const presentation of presentations) {
    conversation = [
      ...conversation,
      {
        id: entryId(presentation),
        presentation,
        revision: 1,
        complete: true,
        markdown: markdownOf(presentation),
      },
    ];
    initial.push(frozen(conversation));
  }

  const thoughtText = (revision: number): string =>
    mutation === "plain-markdown"
      ? `${PLAIN_MARKDOWN} Revision ${revision}.`
      : `First *emphasis* line, revision ${revision}.\n\nSecond line.`;

  const revise = (revision: number, complete: boolean): Snapshot => {
    conversation = conversation.map((entry) =>
      entry.id === THOUGHT_ID
        ? { ...entry, revision, complete, markdown: thoughtText(revision) }
        : entry,
    );
    return frozen(conversation);
  };

  const blocking = revise(2, false);
  const whileBlocked = [revise(3, false), revise(4, false), revise(5, true)];

  conversation = [
    ...conversation,
    {
      id: "entry-appended",
      presentation: "status",
      revision: 1,
      complete: true,
      markdown: markdownOf("status"),
    },
  ];
  const appendOffBottom = frozen(conversation);

  conversation = [
    ...conversation,
    {
      id: "entry-final",
      presentation: "assistant",
      revision: 1,
      complete: true,
      markdown: markdownOf("assistant"),
    },
  ];

  return {
    initial,
    blocking,
    whileBlocked,
    appendOffBottom,
    appendFollowing: frozen(conversation),
  };
}

export function runJourney(options: {
  readonly root: string;
  readonly mutation?: JourneyMutation;
}): Operation<JourneyReport> {
  const { root, mutation } = options;
  return scoped(function* (): Operation<JourneyReport> {
    const ledger: FilesRequest[] = [];
    const timeline: string[] = [];
    const commits: CommitRecord[] = [];
    const frames: FrameRecord[] = [];
    const ingestedWhileBlocked: number[] = [];
    let discardedProjections = 0;
    let barrierReleased = false;

    // Cleanup is established before anything is acquired or subscribed. The tty
    // objects hold no host resource of their own — construction instantiates
    // bundled WebAssembly and performs no terminal I/O — so teardown is this
    // scope dropping its references.
    yield* ensure(() => {
      timeline.push("scope:closed");
    });

    yield* useFilesLedger(root, ledger);

    const includes =
      mutation === "default-before-repository"
        ? [join(root, "defaults"), join(root, "repository", "components")]
        : [join(root, "repository", "components"), join(root, "defaults")];

    const barrierEngaged = withResolvers<void>();
    const barrierRelease = withResolvers<void>();
    const backlogIngested = withResolvers<void>();
    let thoughtProjections = 0;

    yield* registerComponents([
      {
        name: "ProofBarrier",
        origin: "session-rendering-proof",
        description: "Holds the second Thought projection open so later revisions arrive first.",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn(): Operation<string> {
          thoughtProjections++;
          if (thoughtProjections === 2) {
            timeline.push("barrier:engaged");
            barrierEngaged.resolve();
            yield* barrierRelease.operation;
            timeline.push("barrier:resumed");
          }
          return "";
        },
      },
    ]);

    const presentations = yield* describePresentations(root, includes, mutation);

    const term = yield* until(createTerm({ width: INITIAL_WIDTH, height: INITIAL_HEIGHT }));
    const input = yield* until(createInput({ escLatency: 1 }));

    // The permitted probe: the ledger admits the proof's own component roots,
    // and the positive run is the one that shows it admitting something.
    yield* Files.operations.checkFilePath({
      cwd: root,
      path: join("defaults", "Session", "Message", "User.md"),
    });
    if (mutation === "forbidden-read") {
      yield* Files.operations.readTextFile({ cwd: root, path: "../../../../etc/hosts" });
    }

    const script = journeySnapshots(mutation);
    const snapshots = createQueue<Snapshot, void>();
    const wake = createQueue<number, void>();
    const settled = createQueue<number, void>();

    let state: Snapshot = [];
    let version = 0;
    const dirty = new Set<string>();
    const backlog: Entry[] = [];
    const order: string[] = [];
    const committed = new Map<string, Projection>();

    const gates = {
      replace: withResolvers<void>(),
      appendOffBottom: withResolvers<void>(),
      appendFollowing: withResolvers<void>(),
    };

    yield* spawn(function* source(): Operation<void> {
      for (const snapshot of script.initial) {
        snapshots.add(snapshot);
      }
      yield* gates.replace.operation;
      snapshots.add(script.blocking);
      // Published without waiting for anything to render: two later revisions
      // and the completion land while the projector is still inside the Thought
      // it started before them.
      yield* barrierEngaged.operation;
      for (const snapshot of script.whileBlocked) {
        snapshots.add(snapshot);
      }
      yield* gates.appendOffBottom.operation;
      snapshots.add(script.appendOffBottom);
      yield* gates.appendFollowing.operation;
      snapshots.add(script.appendFollowing);
    });

    yield* spawn(function* ingest(): Operation<void> {
      while (true) {
        const arrived = yield* snapshots.next();
        if (arrived.done) {
          return;
        }
        const snapshot = arrived.value;
        version++;
        for (const entry of snapshot) {
          const previous = state.find((candidate) => candidate.id === entry.id);
          if (
            previous === undefined ||
            previous.revision !== entry.revision ||
            previous.complete !== entry.complete ||
            previous.markdown !== entry.markdown
          ) {
            dirty.add(entry.id);
            if (mutation === "no-coalescing") {
              backlog.push(entry);
            }
          }
          if (!order.includes(entry.id)) {
            order.push(entry.id);
          }
        }
        state = snapshot;
        timeline.push(`ingest:v${version}`);
        if (thoughtProjections === 2 && !barrierReleased) {
          ingestedWhileBlocked.push(version);
          if (ingestedWhileBlocked.length === script.whileBlocked.length) {
            backlogIngested.resolve();
          }
        }
        wake.add(version);
      }
    });

    const viewport = { anchorIndex: 0, follow: true, unread: 0, anchorRowsFromEnd: 0 };
    let width = INITIAL_WIDTH;
    let height = INITIAL_HEIGHT;
    let currentTerm: Term = term;

    function rowsOf(id: string): number {
      const projection = committed.get(id);
      return projection === undefined ? 0 : blockRows(projection.blocks);
    }

    function bottomAnchorIndex(): number {
      let used = 0;
      let index = order.length - 1;
      while (index >= 0) {
        const rows = rowsOf(order[index]);
        if (used + rows > height && index < order.length - 1) {
          break;
        }
        used += rows;
        index--;
      }
      return index + 1;
    }

    function visibleIds(): string[] {
      const visible: string[] = [];
      let used = 0;
      for (let index = viewport.anchorIndex; index < order.length; index++) {
        const rows = rowsOf(order[index]);
        if (used + rows > height && visible.length > 0) {
          break;
        }
        used += rows;
        visible.push(order[index]);
      }
      return visible;
    }

    function rowsBefore(index: number): number {
      let rows = 0;
      for (let cursor = 0; cursor < index; cursor++) {
        rows += rowsOf(order[cursor]);
      }
      return rows;
    }

    function frameOperations(visible: readonly string[]): Op[] {
      const ops: Op[] = [
        open("viewport", { layout: { width: grow(), height: grow(), direction: "ttb" } }),
      ];
      for (const id of visible) {
        const projection = committed.get(id);
        if (projection !== undefined) {
          ops.push(...entryOperations(id, projection.blocks));
        }
      }
      ops.push(close());
      return ops;
    }

    function* render(label: string): Operation<FrameRecord> {
      if (viewport.follow) {
        viewport.anchorIndex = bottomAnchorIndex();
      }
      const visible = visibleIds();
      const ops = frameOperations(visible);
      // A whole-history repaint throws the previous frame away, which is what
      // makes every update cost a full screen instead of a diff.
      if (mutation === "whole-history-repaint") {
        currentTerm = yield* until(createTerm({ width, height }));
      }
      const result = currentTerm.render(ops);
      if (result.errors.length > 0) {
        throw new Error(`tty reported ${result.errors.length} layout error(s) on frame ${label}`);
      }
      // The output view expires on the next render or update, so it is copied
      // here rather than kept.
      const bytes = Uint8Array.from(result.output);
      const record: FrameRecord = {
        label,
        width,
        height,
        visible,
        anchor: order[viewport.anchorIndex] ?? "",
        follow: viewport.follow,
        unread: viewport.unread,
        bytes: bytes.length,
        operations: describeOperations(ops),
      };
      frames.push(record);
      return record;
    }

    function* projectOnce(entry: Entry): Operation<Projection> {
      const component = COMPONENT_OF[entry.presentation];
      const selection = yield* scoped(function* () {
        return yield* selectComponent(component, {
          includes,
          registry: yield* Component.operations.registry,
        });
      });
      const componentPath =
        selection.kind === "repository" ? relative(root, resolve(selection.path)) : selection.kind;
      const captured: string[] = [];
      yield* scoped(function* () {
        yield* DocumentOutput.around({
          *output([text, exact], next) {
            captured.push(text);
            yield* next(text, exact);
          },
        });
        yield* collect(
          yield* execute({
            ...inlineSource(`<${component}>\n${entry.markdown}\n</${component}>\n`),
            stream: new InMemoryStream(),
            includes,
            secretDetection: false,
          }),
        );
      });
      const raw = captured.join("");
      return {
        id: entry.id,
        component,
        componentPath,
        revision: entry.revision,
        complete: entry.complete,
        raw,
        blocks: lexProofMarkdown(raw),
      };
    }

    function commit(projection: Projection, shadowed: boolean): void {
      if (shadowed) {
        const shadow = `${projection.id}#${projection.revision}`;
        committed.set(shadow, projection);
        order.push(shadow);
      } else {
        committed.set(projection.id, projection);
      }
      commits.push({
        id: projection.id,
        revision: projection.revision,
        complete: projection.complete,
        viewVersion: version,
      });
    }

    /**
     * Project whatever the ingest task has reduced, and commit only that.
     *
     * A projection records the version it began with. If the source advanced
     * while it was suspended, the result describes a state nobody is looking at
     * any more, so it is dropped and the newest state is projected instead —
     * which is also why a replacement can never be appended: the commit is keyed
     * by the entry's own id.
     */
    function* drain(): Operation<void> {
      while (dirty.size > 0 || backlog.length > 0) {
        if (mutation === "no-coalescing") {
          const entry = backlog.shift();
          if (entry === undefined) {
            dirty.clear();
            continue;
          }
          commit(yield* projectOnce(entry), false);
          dirty.delete(entry.id);
          continue;
        }
        const id = [...dirty][0];
        const began = version;
        const entry = state.find((candidate) => candidate.id === id);
        if (entry === undefined) {
          dirty.delete(id);
          continue;
        }
        const projection = yield* projectOnce(entry);
        if (version !== began) {
          discardedProjections++;
          timeline.push(`project:discarded:${id}`);
          continue;
        }
        dirty.delete(id);
        commit(projection, mutation === "unstable-regions" && committed.has(id));
      }
    }

    yield* spawn(function* project(): Operation<void> {
      while (true) {
        const awoken = yield* wake.next();
        if (awoken.done) {
          return;
        }
        yield* drain();
        settled.add(version);
      }
    });

    function* settleAt(target: number): Operation<void> {
      while (true) {
        const next = yield* settled.next();
        if (next.done) {
          return;
        }
        if (next.value >= target && dirty.size === 0) {
          return;
        }
      }
    }

    const throughInitial = script.initial.length;
    yield* settleAt(throughInitial);
    yield* render("initial");

    gates.replace.resolve();
    yield* barrierEngaged.operation;
    // Ingestion has to reach the completion snapshot before the barrier opens;
    // that is what makes the coalescing claim a claim about a real backlog.
    yield* backlogIngested.operation;
    const releasedAfterVersion = version;
    barrierReleased = true;
    timeline.push("barrier:released");
    const commitsBeforeRelease = commits.length;
    barrierRelease.resolve();
    const throughReplacement = throughInitial + 1 + script.whileBlocked.length;
    yield* settleAt(throughReplacement);
    // Read the post-release commits here, while the replacement is the only
    // thing that has happened since: the claim is about what the backlog
    // collapsed to, not about everything the journey committed afterwards.
    const committedAfterRelease = commits.slice(commitsBeforeRelease);

    const beforeCompletion = frames[frames.length - 1];
    const neighbours = neighbourIds(order, THOUGHT_ID);
    const completionFrame = yield* render("thought-completion");
    const freshTerm = yield* until(createTerm({ width, height }));
    const freshResult = freshTerm.render(frameOperations(completionFrame.visible));
    const freshBytes = Uint8Array.from(freshResult.output).length;

    // Page Up until the oldest entry is the anchor. Follow is released by the
    // decoded key rather than by the loop finishing.
    const decoder = new TextEncoder();
    let presses = 0;
    while (viewport.anchorIndex > 0 && presses <= order.length) {
      presses++;
      const scan = input.scan(decoder.encode(PAGE_UP));
      for (const event of scan.events) {
        if (event.type !== "keydown" || event.code !== "PageUp") {
          continue;
        }
        if (mutation === "forced-follow") {
          continue;
        }
        viewport.follow = false;
        viewport.anchorIndex = Math.max(0, viewport.anchorIndex - Math.max(1, visibleIds().length));
      }
      if (mutation === "forced-follow") {
        break;
      }
    }
    viewport.anchorRowsFromEnd = rowsBefore(order.length) - rowsBefore(viewport.anchorIndex);
    yield* render("scrolled-to-oldest");

    gates.appendOffBottom.resolve();
    yield* settleAt(throughReplacement + 1);
    if (!viewport.follow && !visibleIds().includes(order[order.length - 1])) {
      viewport.unread++;
    }
    yield* render("appended-off-bottom");

    const anchorBefore = order[viewport.anchorIndex] ?? "";
    const followBefore = viewport.follow;
    const unreadBefore = viewport.unread;
    const historyBefore = [...order];
    currentTerm.update({ events: RESIZE_BATCH.map((size) => ({ type: "resize", ...size })) });
    const adopted = RESIZE_BATCH[RESIZE_BATCH.length - 1];
    const previousHeight = height;
    width = adopted.width;
    height = adopted.height;
    if (mutation === "row-offset-viewport") {
      // The anchor kept as a row offset rather than as an entry: a taller
      // viewport moves that offset onto a different entry, which is exactly the
      // mistake a stable anchor id cannot make.
      viewport.anchorIndex = Math.min(
        Math.max(order.length - 1, 0),
        viewport.anchorIndex + (height - previousHeight),
      );
    }
    const resizeFrame = yield* render("resized");
    // Read where the resize left things before anything else moves them: the
    // claim is about what one batch of resize events preserved, not about what
    // the rest of the journey went on to do.
    const resized = {
      requested: RESIZE_BATCH.map((size) => ({ ...size })),
      adopted: { ...adopted },
      anchorBefore,
      anchorAfter: resizeFrame.anchor,
      followBefore,
      followAfter: resizeFrame.follow,
      unreadBefore,
      unreadAfter: resizeFrame.unread,
      historyBefore,
      historyAfter: [...order],
    };

    for (const event of input.scan(decoder.encode(END)).events) {
      if (event.type === "keydown" && event.code === "End") {
        viewport.follow = true;
        viewport.unread = 0;
      }
    }
    yield* render("returned-to-bottom");

    gates.appendFollowing.resolve();
    yield* settleAt(throughReplacement + 2);
    yield* render("appended-while-following");

    return {
      schema: REPORT_SCHEMA,
      dependency: { name: TTY_PACKAGE, version: TTY_VERSION },
      authorities: authorities(root),
      presentations,
      projections: [...committed.values()].map((projection) => ({
        id: projection.id,
        component: projection.component,
        componentPath: projection.componentPath,
        revision: projection.revision,
        complete: projection.complete,
        raw: projection.raw,
      })),
      history: [...order],
      commits,
      timeline,
      barrier: {
        ingestedWhileBlocked,
        releasedAfterVersion,
        committedAfterRelease,
      },
      frames,
      resize: resized,
      diff: {
        incrementalBytes: completionFrame.bytes,
        freshBytes,
        neighbours,
        neighboursBefore: neighbours.flatMap((id) => entrySlice(beforeCompletion.operations, id)),
        neighboursAfter: neighbours.flatMap((id) => entrySlice(completionFrame.operations, id)),
      },
      files: ledger,
      discardedProjections,
    };
  });
}

/** The two entries immediately before `id` in history order. */
function neighbourIds(order: readonly string[], id: string): string[] {
  const index = order.indexOf(id);
  if (index < 2) {
    return order.filter((candidate) => candidate !== id).slice(0, 2);
  }
  return [order[index - 2], order[index - 1]];
}

/** Where each name resolved, asked of the resolver the engine itself uses. */
function* describePresentations(
  root: string,
  includes: readonly string[],
  mutation: JourneyMutation | undefined,
): Operation<PresentationRecord[]> {
  const presentations =
    mutation === "omit-component"
      ? HISTORY.filter((presentation) => presentation !== "unknown")
      : HISTORY;
  const records: PresentationRecord[] = [];
  for (const presentation of presentations) {
    const component = COMPONENT_OF[presentation];
    const selection = yield* scoped(function* () {
      return yield* selectComponent(component, {
        includes,
        registry: yield* Component.operations.registry,
      });
    });
    if (selection.kind !== "repository") {
      throw new Error(`${component} resolved to ${selection.kind}, not to a proof Markdown file`);
    }
    const path = relative(root, resolve(selection.path));
    records.push({
      component,
      path,
      root: path.startsWith("repository/components") ? "repository/components" : "defaults",
    });
  }
  return records;
}
