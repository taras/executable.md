/**
 * Tier WRH14 — the runner's four methods, and the handoff between two of them.
 *
 * A begin transition hands back a storage handle. An attachment needs the
 * Workspace runtime for the *same* run, over the same connection — and two
 * clients on two owners can hold handles whose run id, root and anchor are
 * identical, so nothing a handle says about itself can establish that. What
 * establishes it is where the handle came from.
 *
 * So this file is about which handles attach and which do not. An attachment
 * that succeeds here has opened the run from the exact link its own acquisition
 * produced, taken the provenance of that handle's own journal, and installed
 * the coordinator for it — every one of which has to line up, or the attachment
 * raises instead. What a real owner does with the commit such an attachment
 * produces is proved against one in `tests/cloudflare/remote-workspace.vitest.ts`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok, type Operation, scoped, until } from "effection";
import { mkdir, writeFile } from "node:fs/promises";
import { collect, execute, inlineSource } from "@executablemd/core";
import { API, useHostFiles } from "@executablemd/runtime";
import type { HostFilesEvent } from "@executablemd/runtime";
import type { Json } from "@executablemd/durable-streams";
import { encodeBase64 } from "../src/cloudflare/encoding.ts";
import { cloudflareReadLink, cloudflareRunLink } from "../src/cloudflare/client.ts";
import { cloudflareLifecycleLink } from "../src/cloudflare/lifecycle-link.ts";
import { type OwnerSocket, type SocketListener, useOwnerConnection } from "../src/remote/client.ts";
import { captureWorkspace, type CapturedWorkspace } from "../src/remote/materialize.ts";
import { runnerFiles, useRunnerTrees } from "../src/deno/remote-files.ts";
import { WorkflowLifecycle } from "../src/lifecycle/api.ts";
import type { ExecutorLock } from "../src/lifecycle/api.ts";
import type { WorkflowExecutionTransitions } from "../src/lifecycle/execution.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { useRemoteWorkflowRunner } from "../src/deno/remote-runner.ts";
import type { RemoteRunnerOwner, RemoteWorkflowRunner } from "../src/deno/remote-runner.ts";
import type { RemoteReadPlane } from "../src/remote/read.ts";
import { WorkflowRequestError } from "../src/storage/errors.ts";
import { installedHost, RUN_ID, type Script } from "./support/remote-lifecycle-host.ts";

/** One scripted owner, and every run its acquisitions were opened for. */
function ownerOf(script: Script = {}): { owner: RemoteRunnerOwner; acquisitions: string[] } {
  const acquisitions: string[] = [];
  const host = installedHost({ ...script, opened: acquisitions });
  return {
    acquisitions,
    owner: {
      runId: RUN_ID,
      admit: (runId: string) => host.admit(runId),
      // deno-lint-ignore require-yield
      *reads(runId: string) {
        return Ok(readPlane(runId));
      },
      delivery: {
        // deno-lint-ignore require-yield
        *wait(): Operation<never> {
          throw new Error("PLANTED-DELIVERY-WAIT-REACHED");
        },
        // deno-lint-ignore require-yield
        *retain(): Operation<never> {
          throw new Error("PLANTED-DELIVERY-RETAIN-REACHED");
        },
      },
    },
  };
}

/**
 * One read plane, which answers nothing and takes nothing.
 *
 * What the tests below need of it is that installing it and asking it a
 * question require no acquisition; what it would answer is the read plane's own
 * contract and is proved where that is under test.
 */
function unanswered(): never {
  throw new WorkflowRequestError("this scripted plane answers no read");
}

function readPlane(runId: string): RemoteReadPlane {
  return {
    runId,
    // deno-lint-ignore require-yield
    *inspect() {
      return unanswered();
    },
    // deno-lint-ignore require-yield
    *history() {
      return unanswered();
    },
    // deno-lint-ignore require-yield
    *forkSource() {
      return unanswered();
    },
  };
}

/** One runner over one scripted owner. */
function assembled(owner: RemoteRunnerOwner, scratch: string): Operation<RemoteWorkflowRunner> {
  return useRemoteWorkflowRunner({ owner, scratchRoot: `/tmp/xmd-remote-runner-${scratch}` });
}

/** Take this run's acquisition, or say why it could not be taken. */
function* acquired(): Operation<ExecutorLock> {
  const taken = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
  if (!taken.ok) {
    throw taken.error;
  }
  if (taken.value.kind !== "acquired") {
    throw new Error("expected the executor acquisition to be taken");
  }
  return taken.value.lock;
}

/** Begin one execution, and hand back the handle it produced. */
function* opened(
  transitions: WorkflowExecutionTransitions,
  lock: ExecutorLock,
): Operation<WorkflowRunDatabase> {
  const begun = yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
  if (!begun.ok) {
    throw begun.error;
  }
  return begun.value.database;
}

/** What an attachment runs. Reaching it at all is the claim. */
// deno-lint-ignore require-yield
function* attached(): Operation<string> {
  return "attached";
}

/** Attach one handle through one runner, and report what came back. */
function* attaching(runner: RemoteWorkflowRunner, handle: WorkflowRunDatabase): Operation<string> {
  try {
    return yield* scoped(() => runner.attach(handle, attached()));
  } catch (error) {
    return error instanceof Error ? error.message : "other";
  }
}

function planted(): never {
  throw new Error("PLANTED-FOREIGN-HANDLE-READ");
}

/** A handle nothing opened: shaped like one, and one nothing may read. */
function foreignHandle(): WorkflowRunDatabase {
  return {
    get record() {
      return planted();
    },
    get retrieval() {
      return planted();
    },
    get journal() {
      return planted();
    },
    readJournalEntries: planted,
    transact: planted,
    replaceRetrievalMetadata: planted,
    readDocumentExecutions: planted,
  };
}

/**
 * One owner, scripted at the wire.
 *
 * Everything above it is production code: the real client, the real lifecycle,
 * the real database handle, the real coordinator and the real runner
 * facilities. What this stands in for is the object that would answer — so what
 * a test can say afterwards is what the runner actually sent it, and what it
 * committed.
 */
function scriptedOwner(captured: CapturedWorkspace) {
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
          repositories: [],
          worktrees: [],
          agentSessions: [],
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
function* startingTree(): Operation<CapturedWorkspace> {
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

/** One runner over a scripted owner reached through the production client. */
function* wired(captured: CapturedWorkspace): Operation<{
  owner: ReturnType<typeof scriptedOwner>;
  runner: RemoteWorkflowRunner;
}> {
  const owner = scriptedOwner(captured);
  const connection = yield* useOwnerConnection(owner.socket);
  let identifier = 0;
  const next = () => `command-${(identifier += 1)}`;
  const reads = cloudflareReadLink(connection, next, RUN_ID);
  const runner = yield* useRemoteWorkflowRunner({
    owner: {
      runId: RUN_ID,
      // deno-lint-ignore require-yield
      *admit() {
        return Ok({
          link: cloudflareRunLink(connection, next, RUN_ID),
          lifecycle: cloudflareLifecycleLink(connection, reads, next),
          // deno-lint-ignore require-yield
          *close(): Operation<void> {},
        });
      },
      // deno-lint-ignore require-yield
      *reads(runId: string) {
        return Ok(readPlane(runId));
      },
      delivery: {
        // deno-lint-ignore require-yield
        *wait(): Operation<never> {
          throw new Error("PLANTED-DELIVERY-WAIT-REACHED");
        },
        // deno-lint-ignore require-yield
        *retain(): Operation<never> {
          throw new Error("PLANTED-DELIVERY-RETAIN-REACHED");
        },
      },
    },
    scratchRoot: "/tmp/xmd-remote-runner-live",
  });
  return { owner, runner };
}

/**
 * The ambient host filesystem a runtime entrypoint installs, watched.
 *
 * The real provider rather than a stand-in, at the position a host installs it
 * and with a working directory a workflow run must never resolve against. What
 * a test says afterwards is whether a document reached it at all.
 */
function* useHostSpy(): Operation<HostFilesEvent[]> {
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
function published(commits: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return commits.filter((intent) => {
    const publication = intent["publication"];
    return publication !== null && publication !== undefined;
  });
}

/** One authored document, executed as this run's root inside the attachment. */
function document(source: string, database: WorkflowRunDatabase): Operation<Json> {
  return scoped(function* () {
    return yield* collect(yield* execute({ ...inlineSource(source), stream: database.journal }));
  });
}

describe("a runner for a run whose storage is somewhere else", () => {
  it("attaches the handle its own lifecycle opened, and no other", function* () {
    const outcome = yield* scoped(function* () {
      const first = ownerOf();
      const second = ownerOf();
      const one = yield* assembled(first.owner, "one");
      const transitions = yield* one.useRunHost();
      const database = yield* opened(transitions, yield* acquired());
      // A second runner over a second owner, with an acquisition and a handle
      // of its own. Its scripted owner answers with the same record, root and
      // anchor, so the two handles agree about everything except where they
      // came from.
      return yield* scoped(function* () {
        const other = yield* assembled(second.owner, "two");
        const theirs = yield* other.useRunHost();
        const another = yield* opened(theirs, yield* acquired());
        return {
          own: yield* attaching(one, database),
          theirs: yield* attaching(other, another),
          crossed: yield* attaching(other, database),
          back: yield* attaching(one, another),
          foreign: yield* attaching(one, foreignHandle()),
          acquisitions: [...first.acquisitions, ...second.acquisitions],
        };
      });
    });
    // Attaching succeeded, which means the run was opened from the exact link
    // this runner's acquisition produced, the provenance of that handle's own
    // journal was taken, and the coordinator was installed for it.
    expect(outcome.own).toBe("attached");
    expect(outcome.theirs).toBe("attached");
    // Neither runner can attach the other's handle, in either direction.
    expect(outcome.crossed).toContain("not opened by this remote host");
    expect(outcome.back).toContain("not opened by this remote host");
    expect(outcome.foreign).toContain("not opened by this remote host");
    // One acquisition per runner, and neither of them for the other's run.
    expect(outcome.acquisitions).toEqual([RUN_ID, RUN_ID]);
  });

  it("makes an authored File write a remote Workspace effect", function* () {
    const outcome = yield* scoped(function* () {
      const captured = yield* startingTree();
      const before = captured.root.rootId;
      const { owner, runner } = yield* wired(captured);
      const transitions = yield* runner.useRunHost();
      const database = yield* opened(transitions, yield* acquired());

      // The ambient host filesystem, installed the way a runtime entrypoint
      // installs it and outside the attachment. A workflow document must never
      // reach it.
      const host = yield* useHostSpy();

      const output = yield* runner.attach(
        database,
        document(
          ["# Remote", "", '<File path="NOTES.md">written by the document</File>'].join("\n"),
          database,
        ),
      );
      return { output: String(output), host, owner, before };
    });

    // The document ran to completion — `<File>` renders nothing, so what it
    // wrote is visible in what the owner was asked to commit, below — and the
    // ambient host filesystem was never asked for anything at all.
    expect(outcome.output.trimEnd()).toBe("# Remote");
    expect(outcome.host).toEqual([]);
    // It materialized the exact retained root, then proposed one commit: the
    // new root and the journal row describing the effect, together.
    const asked = outcome.owner.sent.map((request) => request["command"]);
    expect(asked).toContain("mappings");
    expect(asked).toContain("root");
    const proposals = published(outcome.owner.commits);
    expect(proposals).toHaveLength(1);
    const intent = proposals[0] ?? {};
    expect(intent["expectedWorkspaceRootId"]).toBe(outcome.before);
    // One transaction carried both halves: the file the document wrote, and
    // the journal row describing the effect that wrote it.
    expect(Array.isArray(intent["events"]) && intent["events"]).toHaveLength(1);
    expect(String(intent["events"])).toContain("workspace_file");
    expect(JSON.stringify(intent["publication"])).toContain("/NOTES.md");
    // And the owner's frontier moved to what it published, which is what a
    // later read of this run observes.
    expect(outcome.owner.currentRoot).not.toBe(outcome.before);
    expect(intent["publication"]).toEqual(
      expect.objectContaining({ proposedWorkspaceRootId: outcome.owner.currentRoot }),
    );
  });

  it("installs the whole live set, and resolves a document's paths inside the run", function* () {
    const outcome = yield* scoped(function* () {
      const captured = yield* startingTree();
      const { owner, runner } = yield* wired(captured);
      const transitions = yield* runner.useRunHost();
      const database = yield* opened(transitions, yield* acquired());
      const host = yield* useHostSpy();
      // `<Dir>` is the lexical half of the composition and `<File>` is the
      // document filesystem: a write inside a directory the document named
      // proves both, and proves the path resolved inside the run's own
      // Workspace rather than against the host working directory above.
      const output = yield* runner.attach(
        database,
        document(
          [
            "# Remote",
            "",
            '<Dir path="docs">',
            "",
            '  <File path="inner.md">nested</File>',
            "",
            "</Dir>",
          ].join("\n"),
          database,
        ),
      );
      return { output: String(output), host, owner };
    });

    expect(outcome.host).toEqual([]);
    const proposals = published(outcome.owner.commits);
    expect(proposals).toHaveLength(1);
    // The file landed under the directory the document named, inside the run.
    expect(JSON.stringify(proposals[0]?.["publication"])).toContain("/docs/inner.md");
  });

  it("keeps a refused, failed or cancelled attachment to one owner transaction", function* () {
    const outcomes = yield* scoped(function* () {
      /** One document write, under an owner scripted to answer this way. */
      function* attempt(
        script: (owner: ReturnType<typeof scriptedOwner>) => void,
        body?: (result: string) => Operation<string>,
      ): Operation<{ said: string; commits: number; root: string; before: string }> {
        return yield* scoped(function* () {
          const captured = yield* startingTree();
          const { owner, runner } = yield* wired(captured);
          const transitions = yield* runner.useRunHost();
          const database = yield* opened(transitions, yield* acquired());
          script(owner);
          let said: string;
          try {
            const rendered = yield* runner.attach(
              database,
              document(
                ["# Remote", "", '<File path="NOTES.md">written by the document</File>'].join("\n"),
                database,
              ),
            );
            said = body === undefined ? String(rendered) : yield* body(String(rendered));
          } catch (error) {
            said = error instanceof Error ? `raised:${error.name}` : "raised:other";
          }
          return {
            said,
            commits: published(owner.commits).length,
            attempts: owner.commits.filter((intent) => intent["publication"] !== null).length,
            root: owner.currentRoot,
            before: captured.root.rootId,
          };
        });
      }

      return {
        // The owner refuses the commit: nothing is promoted, and the run is
        // still on the root it started from.
        refused: yield* attempt((owner) => owner.refuse("command:stale-root")),
        // The answer never arrives: whether the owner committed is exactly what
        // cannot be known, and nothing here claims it did.
        lost: yield* attempt((owner) => owner.lose()),
        // The document fails after its own effect committed. The effect's
        // transaction is the one visible outcome; nothing else is sent.
        failed: yield* attempt(
          () => undefined,
          // deno-lint-ignore require-yield
          function* (): Operation<string> {
            throw new Error("PlantedDocumentFailure");
          },
        ),
      };
    });

    // A refused commit leaves the frontier where it was, and the run learns it
    // rather than being told the write succeeded.
    expect(outcomes.refused.root).toBe(outcomes.refused.before);
    expect(outcomes.refused.commits).toBe(1);
    expect(outcomes.refused.said).toContain("raised:");
    // A lost answer is the same: one attempt, and no claim either way.
    expect(outcomes.lost.root).toBe(outcomes.lost.before);
    expect(outcomes.lost.commits).toBe(1);
    expect(outcomes.lost.said).toContain("raised:");
    // A document that failed afterwards published its effect and nothing else.
    expect(outcomes.failed.commits).toBe(1);
    expect(outcomes.failed.root).not.toBe(outcomes.failed.before);
    expect(outcomes.failed.said).toBe("raised:Error");
  });

  it("reads and delivers without taking an acquisition", function* () {
    const outcome = yield* scoped(function* () {
      const scripted = ownerOf();
      const built = yield* assembled(scripted.owner, "planes");
      yield* built.useLifecycle();
      yield* built.useDelivery();
      const inspected = yield* trapped(WorkflowLifecycle.operations.inspect(RUN_ID));
      return {
        inspected,
        // Nothing was acquired to install either plane or to answer with them.
        acquisitions: scripted.acquisitions,
      };
    });
    // The scripted plane answers no read, which is the plane refusing rather
    // than an acquisition that was never taken.
    expect(outcome.inspected).toContain("answers no read");
    expect(outcome.acquisitions).toEqual([]);
  });
});

/** Run one operation and report what it refused with, if it refused. */
function* trapped(operation: Operation<unknown>): Operation<string> {
  try {
    yield* operation;
    return "answered";
  } catch (error) {
    return error instanceof Error ? error.message : "other";
  }
}
