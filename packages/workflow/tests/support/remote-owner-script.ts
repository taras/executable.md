/**
 * One owner, scripted at the wire, and what a document needs around it.
 *
 * Shared because two suites ask the same question of the same production stack
 * from two different heights: the configured public host, and the runner it
 * assembles. A second copy of this owner would be a second protocol, and the
 * day the two disagreed one of those suites would be proving nothing.
 */

import { type Operation, scoped, until } from "effection";
import { mkdir, writeFile } from "node:fs/promises";
import { collect, execute, inlineSource } from "@executablemd/core";
import { API, useHostFiles } from "@executablemd/runtime";
import type { HostFilesEvent } from "@executablemd/runtime";
import type { Json } from "@executablemd/durable-streams";
import { decodeBase64, encodeBase64 } from "../../src/cloudflare/encoding.ts";
import type { OwnerSocket, SocketListener } from "../../src/remote/client.ts";
import { captureWorkspace, type CapturedWorkspace } from "../../src/remote/materialize.ts";
import { runnerFiles, useRunnerTrees } from "../../src/deno/remote-files.ts";
import type { WorkflowRunDatabase } from "../../src/storage/api.ts";

/** The run every scripted owner here answers about. */
export const RUN_ID = "5cktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";

/** How many entries one anchored page carries, so paging is exercised at all. */
const JOURNAL_PAGE = 2;

/**
 * One owner, scripted at the wire.
 *
 * Everything above it is production code: the real client, the real lifecycle,
 * the real database handle, the real coordinator and the real runner
 * facilities. What this stands in for is the object that would answer — so what
 * a test can say afterwards is what the runner actually sent it, and what it
 * committed.
 */
export interface ScriptedRetention {
  /** Repositories this owner already retains, as its snapshot reports them. */
  readonly repositories?: readonly Record<string, unknown>[];
  /** Agent sessions this owner already retains. */
  readonly agentSessions?: readonly Record<string, unknown>[];
}

export function scriptedOwner(captured: CapturedWorkspace, retained: ScriptedRetention = {}) {
  const sent: Record<string, unknown>[] = [];
  const commits: Record<string, unknown>[] = [];
  let currentRoot = captured.root.rootId;
  let currentManifest = captured.root.manifest;
  let refusal: string | undefined;
  let lost = false;
  // What this owner has accepted, as it would then hold it. A commit that is
  // performed moves the root, keeps the bytes it was staged, and merges the
  // mappings it validated — so a later coherent snapshot answers with what the
  // run actually became rather than with what it started as.
  const blobs = new Map<string, Uint8Array>(captured.blobs);
  const manifests = new Map<string, Uint8Array>();
  for (const [digest, content] of captured.contents) {
    manifests.set(digest, content.manifestBytes);
  }
  const staged = new Map<string, Uint8Array>();
  /**
   * The filtered journal, as the owner keeps it.
   *
   * Each entry carries the id this owner minted for it and the Workspace root
   * the transaction that appended it selected — the publication's proposed root
   * when it published one, and the root the transaction expected when it did
   * not. A root and a mapping beside an empty journal is not a state a real
   * owner can reach, so this keeps all three or none.
   */
  const journal: { eventId: string; record: string; workspaceRootId: string }[] = [];
  let minted = 0;
  const repositories = new Map<string, Record<string, unknown>>();
  const worktrees = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  for (const stored of retained.repositories ?? []) {
    const record = stored["record"];
    if (record !== null && typeof record === "object") {
      repositories.set(String(Reflect.get(record, "name")), stored);
    }
  }
  for (const record of retained.agentSessions ?? []) {
    sessions.set(String(record["sessionKey"]), record);
  }

  function frontier(): Record<string, unknown> {
    return {
      record: {
        runId: RUN_ID,
        definition: {
          version: 1,
          kind: "git",
          objectFormat: "sha1",
          objectId: "0".repeat(40),
          rootDocumentPath: "README.md",
        },
        base: "main",
        props: {},
        status: "running",
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
      retrieval: null,
      workspaceRootId: currentRoot,
      journalEventId: journal.at(-1)?.eventId ?? null,
    };
  }

  function begun(executionId: string): Record<string, unknown> {
    return {
      frontier: frontier(),
      // Exactly the members an execution that has not stopped declares.
      execution: { executionId, startedAt: "2026-09-10T00:00:01.000Z" },
      replay: false,
      recovered: null,
    };
  }

  function answer(request: Record<string, unknown>): Record<string, unknown> {
    const command = request["command"];
    if (command === "open" || command === "frontier") {
      return { outcome: "performed", value: frontier() };
    }
    if (command === "begin") {
      // A lifecycle answer is one of three fields and never two: the value, a
      // refusal, or the immutable fields a creation conflicts on.
      return {
        outcome: "performed",
        value: {
          conflict: null,
          refusal: null,
          value: begun(String(request["executionId"])),
        },
      };
    }
    if (command === "mappings") {
      return {
        outcome: "performed",
        value: {
          workspaceRootId: currentRoot,
          journalEventId: journal.at(-1)?.eventId ?? null,
          repositories: [...repositories.values()],
          worktrees: [...worktrees.values()],
          agentSessions: [...sessions.values()],
        },
      };
    }
    if (command === "journal") {
      // One anchored page per request, continuing exactly where the client
      // says it is. The anchor is the terminal event the frontier named, so a
      // page that ran past it or stopped short of it would be a history no
      // reader could assemble.
      const anchorEventId = request["anchorEventId"];
      const afterEventId = request["afterEventId"] ?? null;
      const from =
        afterEventId === null
          ? 0
          : journal.findIndex((entry) => entry.eventId === afterEventId) + 1;
      if (from === 0 && afterEventId !== null) {
        throw new Error("the runner asked to continue from an event this owner never minted");
      }
      const page = journal.slice(from, from + JOURNAL_PAGE);
      return {
        outcome: "performed",
        value: {
          anchorEventId,
          afterEventId,
          entries: page.map((entry, index) => ({
            eventId: entry.eventId,
            previousEventId: index === 0 ? afterEventId : (page[index - 1]?.eventId ?? null),
            record: entry.record,
            workspaceRootId: entry.workspaceRootId,
          })),
          done: from + page.length >= journal.length,
        },
      };
    }
    if (command === "root") {
      return {
        outcome: "performed",
        value: { workspaceRootId: currentRoot, manifest: currentManifest },
      };
    }
    if (command === "content") {
      const digest = String(request["digest"]);
      const bytes = request["kind"] === "manifest" ? manifests.get(digest) : blobs.get(digest);
      if (bytes === undefined) {
        throw new Error("asked for content this owner does not hold");
      }
      return {
        outcome: "performed",
        value: {
          kind: request["kind"],
          digest,
          size: bytes.length,
          bytes: encodeBase64(bytes),
        },
      };
    }
    if (command === "stage") {
      const encoded = String(request["bytes"] ?? "");
      const bytes = decodeBase64(encoded);
      // Held until a commit adopts them, exactly as staged bytes are: a
      // proposal that is refused leaves nothing behind.
      staged.set(`${String(request["kind"])}:${String(request["digest"])}`, bytes);
      return {
        outcome: "performed",
        value: { kind: request["kind"], digest: request["digest"], size: bytes.length },
      };
    }
    if (command === "settle") {
      return { outcome: "performed", value: { status: "completed" } };
    }
    commits.push(request);
    const publication = request["publication"];
    // Scripted for the Workspace proposal rather than for every append: an
    // owner that refused the run's own journal rows would end the document
    // before it ever reached the effect under test.
    const proposing = publication !== null && publication !== undefined;
    if (lost && proposing) {
      return { outcome: "lost" };
    }
    if (refusal !== undefined && proposing) {
      return { outcome: "refused", refusal };
    }
    const events = Array.isArray(request["events"]) ? request["events"] : [];
    // The owner publishes what it validated, and everything moves with it: the
    // pointer, the content it was staged, and the mappings it accepted. A
    // later snapshot then answers with the run as it now is.
    if (publication !== null && publication !== undefined) {
      currentRoot = String(Reflect.get(publication, "proposedWorkspaceRootId"));
      currentManifest = String(Reflect.get(publication, "proposedManifest"));
      const held = Reflect.get(publication, "content");
      for (const piece of Array.isArray(held) ? held : []) {
        const kind = String(Reflect.get(piece, "kind"));
        const digest = String(Reflect.get(piece, "digest"));
        const bytes = staged.get(`${kind}:${digest}`);
        if (bytes === undefined) {
          throw new Error(`the runner published ${kind} ${digest} without staging it`);
        }
        (kind === "manifest" ? manifests : blobs).set(digest, bytes);
      }
    }
    for (const mapping of Array.isArray(request["mappings"]) ? request["mappings"] : []) {
      const kind = String(Reflect.get(mapping, "kind"));
      const record = Reflect.get(mapping, "record");
      if (record === null || typeof record !== "object") {
        throw new Error("the runner proposed a mapping with no record");
      }
      if (kind === "repository") {
        // Retained the way a snapshot reports one: the record, and the locator
        // beside it, which the owner keeps out of the record itself.
        repositories.set(String(Reflect.get(record, "name")), {
          record,
          locator: Reflect.get(mapping, "locator") ?? null,
        });
      }
      if (kind === "worktree") {
        worktrees.set(
          `${String(Reflect.get(record, "repositoryName"))}/${String(Reflect.get(record, "name"))}`,
          record as Record<string, unknown>,
        );
      }
      if (kind === "agent-session") {
        sessions.set(String(Reflect.get(record, "sessionKey")), record as Record<string, unknown>);
      }
    }
    staged.clear();
    // Appended in the same step that moved the root and merged the mappings:
    // the events, each carrying the root this transaction selected.
    for (const record of events) {
      minted += 1;
      journal.push({
        eventId: `owner-event-${minted}`,
        record: String(record),
        workspaceRootId: currentRoot,
      });
    }
    return {
      outcome: "performed",
      value: {
        workspaceRootId: currentRoot,
        journalEventIds: journal.slice(journal.length - events.length).map((e) => e.eventId),
      },
    };
  }

  const listeners = new Map<string, Set<SocketListener>>();
  const socket: OwnerSocket = {
    send(data: string): void {
      const request: Record<string, unknown> = JSON.parse(data);
      sent.push(request);
      const response = answer(request);
      if (response["outcome"] === "lost") {
        for (const listener of listeners.get("close") ?? []) {
          listener({});
        }
        return;
      }
      for (const listener of listeners.get("message") ?? []) {
        listener({ data: JSON.stringify({ id: request["id"], ...response }) });
      }
    },
    close(): void {},
    addEventListener(type, listener): void {
      const found = listeners.get(type) ?? new Set<SocketListener>();
      found.add(listener);
      listeners.set(type, found);
    },
    removeEventListener(type, listener): void {
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    socket,
    sent,
    commits,
    get currentRoot(): string {
      return currentRoot;
    },
    /** The filtered journal this owner retains, as it would answer a read. */
    entries(): readonly { eventId: string; record: string; workspaceRootId: string }[] {
      return journal.map((entry) => ({ ...entry }));
    },
    refuse(reason: string): void {
      refusal = reason;
    },
    lose(): void {
      lost = true;
    },
  };
}

/** A small starting tree, captured so the scripted owner can serve it. */
export function* startingTree(): Operation<CapturedWorkspace> {
  const files = runnerFiles();
  const trees = yield* useRunnerTrees();
  const root = yield* trees.create("source");
  yield* until(writeFile(`${root}/README.md`, "starting\n", { mode: 0o644 }));
  yield* until(mkdir(`${root}/docs`, { mode: 0o755 }));
  return yield* captureWorkspace(
    files,
    (logical) => (logical === "/" ? root : `${root}${logical}`),
    (reason) => {
      throw new Error(reason);
    },
  );
}

/**
 * The ambient host filesystem a runtime entrypoint installs, watched.
 *
 * The real provider rather than a stand-in, at the position a host installs it
 * and with a working directory a workflow run must never resolve against. What
 * a test says afterwards is whether a document reached it at all.
 */
export function* useHostSpy(): Operation<HostFilesEvent[]> {
  const seen: HostFilesEvent[] = [];
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd(): Operation<string> {
        return "/nowhere-the-workflow-may-reach";
      },
    },
    { at: "min" },
  );
  yield* useHostFiles({ observe: (event) => seen.push(event) });
  return seen;
}

/**
 * The commits that proposed a Workspace, out of everything the owner was asked
 * to commit.
 *
 * A run's journal lives on its owner, so every ordinary append — the root
 * import, a component import, the terminal — reaches it as a commit of its own.
 * What a Workspace effect adds to one is the publication, and that is what
 * these tests are counting.
 */
export function published(commits: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return commits.filter((intent) => {
    const publication = intent["publication"];
    return publication !== null && publication !== undefined;
  });
}

/** One authored document, executed as this run's root inside the attachment. */
export function document(source: string, database: WorkflowRunDatabase): Operation<Json> {
  return scoped(function* () {
    return yield* collect(yield* execute({ ...inlineSource(source), stream: database.journal }));
  });
}
