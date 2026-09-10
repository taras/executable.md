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
import { encodeBase64 } from "../../src/cloudflare/encoding.ts";
import type { OwnerSocket, SocketListener } from "../../src/remote/client.ts";
import { captureWorkspace, type CapturedWorkspace } from "../../src/remote/materialize.ts";
import { runnerFiles, useRunnerTrees } from "../../src/deno/remote-files.ts";
import type { WorkflowRunDatabase } from "../../src/storage/api.ts";

/** The run every scripted owner here answers about. */
export const RUN_ID = "5cktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";

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
  let refusal: string | undefined;
  let lost = false;

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
      journalEventId: null,
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
          journalEventId: null,
          repositories: retained.repositories ?? [],
          worktrees: [],
          agentSessions: retained.agentSessions ?? [],
        },
      };
    }
    if (command === "root") {
      return {
        outcome: "performed",
        value: { workspaceRootId: currentRoot, manifest: captured.root.manifest },
      };
    }
    if (command === "content") {
      const digest = String(request["digest"]);
      const bytes =
        request["kind"] === "manifest"
          ? captured.contents.get(digest)?.manifestBytes
          : captured.blobs.get(digest);
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
      const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
      return {
        outcome: "performed",
        value: {
          kind: request["kind"],
          digest: request["digest"],
          size: (encoded.length / 4) * 3 - padding,
        },
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
    // The owner publishes what it validated, and the frontier moves with it.
    if (publication !== null && publication !== undefined) {
      currentRoot = String(Reflect.get(publication, "proposedWorkspaceRootId"));
    }
    return {
      outcome: "performed",
      value: {
        workspaceRootId: currentRoot,
        journalEventIds: events.map((_entry, index) => `event-${index}`),
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
