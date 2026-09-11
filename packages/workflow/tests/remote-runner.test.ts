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
import { Ok, type Operation, scoped, sleep, spawn, suspend } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { cloudflareReadLink, cloudflareRunLink } from "../src/cloudflare/client.ts";
import { cloudflareLifecycleLink } from "../src/cloudflare/lifecycle-link.ts";
import { WorkflowLifecycle } from "../src/lifecycle/api.ts";
import type { ExecutorLock } from "../src/lifecycle/api.ts";
import type { WorkflowExecutionTransitions } from "../src/lifecycle/execution.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { useRemoteWorkflowRunner } from "../src/deno/remote-runner.ts";
import type { RemoteRunnerOwner, RemoteWorkflowRunner } from "../src/deno/remote-runner.ts";
import type { RemoteReadPlane } from "../src/remote/read.ts";
import { WorkflowRequestError } from "../src/storage/errors.ts";
import { installedHost, type Script } from "./support/remote-lifecycle-host.ts";
import {
  document,
  published,
  RUN_ID,
  scriptedOwner,
  type ScriptedRetention,
  startingTree,
  useHostSpy,
} from "./support/remote-owner-script.ts";
import { useOwnerConnection } from "../src/remote/client.ts";
import { transactAgentSessions, workspaceHostFor } from "../src/workspace/effects.ts";
import type { CapturedWorkspace } from "../src/remote/materialize.ts";
import { locatorFingerprintOf } from "../src/composition/locator.ts";
import { agentSessionKey } from "../src/storage/agent-session.ts";
import { durableRun, type Workflow } from "@executablemd/durable-streams";

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

/** One runner over a scripted owner reached through the production client. */
function* wired(
  captured: CapturedWorkspace,
  retained: ScriptedRetention = {},
): Operation<{
  owner: ReturnType<typeof scriptedOwner>;
  runner: RemoteWorkflowRunner;
}> {
  const owner = scriptedOwner(captured, retained);
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

  it("reads the retained Workspace an ephemeral attachment needs, and keeps nothing", function* () {
    /** A repository this owner already retains, at a path the root contains. */
    const stored = {
      record: {
        name: "app",
        locatorFingerprint: locatorFingerprintOf("https://git.example.invalid/octo/app.git"),
        requestedBase: null,
        creationCommit: "9".repeat(40),
        primaryBranch: "main",
        objectFormat: "sha1",
        checkoutPath: "/docs",
      },
      locator: "https://git.example.invalid/octo/app.git",
    };

    const outcome = yield* scoped(function* () {
      const captured = yield* startingTree();
      const { owner, runner } = yield* wired(captured, { repositories: [stored] });
      const transitions = yield* runner.useRunHost();
      const database = yield* opened(transitions, yield* acquired());
      return yield* runner.attach(
        database,
        (function* (): Operation<Record<string, unknown>> {
          // Exactly what a Repository reattachment asks of the run: the record
          // that names the checkout, and the bytes at it. No Deno lease, no
          // Deno private workspace, and no transaction held while it reads.
          const read = yield* workspaceHostFor(database).read(function* (view) {
            const record = view.metadata.readRepository("app");
            const entries = yield* view.filesystem.readdir("/");
            const readme = yield* view.filesystem.readTextFile("/README.md");
            return {
              named: record?.record.checkoutPath,
              locator: record?.locator,
              entries: entries.map((entry) => entry.name).toSorted(),
              readme,
            };
          });
          if (!read.ok) {
            throw read.error;
          }
          return { ...read.value, commits: published(owner.commits).length };
        })(),
      );
    });

    // The retained record and the retained bytes, from the owner's own
    // snapshot and the root it named.
    expect(outcome["named"]).toBe("/docs");
    expect(outcome["locator"]).toBe("https://git.example.invalid/octo/app.git");
    expect(outcome["entries"]).toEqual(["README.md", "docs"]);
    expect(outcome["readme"]).toBe("starting\n");
    // Nothing durable happened: no proposal, no publication, no mapping.
    expect(outcome["commits"]).toBe(0);
  });

  it("retains an Agent-session mapping at the owner, in one transaction", function* () {
    // The key is derived from the identity rather than chosen: a record whose
    // key does not follow from what it names is one no owner retains.
    const identity = {
      provider: "acpx",
      agentCommand: "/usr/bin/claude",
      sessionIdentity: "expansion-1",
    };
    const session = {
      ...identity,
      sessionKey: agentSessionKey(identity),
      policy: "policy-1",
      assertion: { kind: "acp", value: "conversation-1" },
      createdAt: "2026-09-10T00:00:00.000Z",
    };

    const outcomes = yield* scoped(function* () {
      /** One Agent-session body, under an owner that already retains this. */
      function* attempt(
        retained: ScriptedRetention,
        body: (sessions: {
          read(key: string): unknown;
          commit(record: typeof session): void;
        }) => Operation<string>,
      ): Operation<{ said: string; mappings: number; publications: number }> {
        return yield* scoped(function* () {
          const captured = yield* startingTree();
          const { owner, runner } = yield* wired(captured, retained);
          const transitions = yield* runner.useRunHost();
          const database = yield* opened(transitions, yield* acquired());
          let said: string;
          try {
            said = yield* runner.attach(
              database,
              (function* (): Operation<string> {
                const committed = yield* transactAgentSessions(database, body);
                return committed.ok ? committed.value : `refused:${committed.error.name}`;
              })(),
            );
          } catch (error) {
            said = error instanceof Error ? `raised:${error.name}` : "raised:other";
          }
          const mapped = owner.commits.filter((intent) => {
            const mappings = intent["mappings"];
            return Array.isArray(mappings) && mappings.length > 0;
          });
          return {
            said,
            mappings: mapped.length,
            publications: published(owner.commits).length,
          };
        });
      }

      return {
        // Nothing retained yet: the mapping is staged and the owner commits it.
        retained: yield* attempt({}, function* (sessions) {
          sessions.commit(session);
          return "committed";
        }),
        // The same mapping already retained: reading it is enough, and there is
        // nothing for the owner to decide.
        already: yield* attempt({ agentSessions: [session] }, function* (sessions) {
          return sessions.read(session.sessionKey) === undefined ? "absent" : "read";
        }),
        // A different conversation under the same identity: refused where the
        // rules live, and never sent.
        conflicting: yield* attempt(
          { agentSessions: [session] },
          // deno-lint-ignore require-yield
          function* (sessions) {
            sessions.commit({ ...session, assertion: { kind: "acp", value: "another" } });
            return "committed";
          },
        ),
        // A body that failed after staging sends no mapping at all.
        failed: yield* attempt(
          {},
          // deno-lint-ignore require-yield
          function* (sessions) {
            sessions.commit(session);
            throw new Error("PlantedAgentFailure");
          },
        ),
      };
    });

    // One mapping-only transaction, and no Workspace proposal with it.
    expect(outcomes.retained.said).toBe("committed");
    expect(outcomes.retained.mappings).toBe(1);
    expect(outcomes.retained.publications).toBe(0);
    // Reading what the owner admitted stages nothing.
    expect(outcomes.already.said).toBe("read");
    expect(outcomes.already.mappings).toBe(0);
    // A conflicting assertion never replaces the retained one.
    expect(outcomes.conflicting.said).toContain("refused:");
    expect(outcomes.conflicting.mappings).toBe(0);
    // And a failure before the commit retains nothing.
    expect(outcomes.failed.said).toContain("refused:");
    expect(outcomes.failed.mappings).toBe(0);
  });

  it("cancels an in-flight attachment without proposing anything", function* () {
    const outcome = yield* scoped(function* () {
      const captured = yield* startingTree();
      const { owner, runner } = yield* wired(captured);
      const transitions = yield* runner.useRunHost();
      const database = yield* opened(transitions, yield* acquired());
      const reached = { inside: false };
      // The attachment is halted while the document is inside its own effect,
      // which is where a real cancellation arrives: between the mutation and
      // the commit the collector would have sent.
      const running = yield* spawn(() =>
        runner.attach(
          database,
          (function* (): Operation<string> {
            const binding = workspaceHostFor(database);
            yield* (function* (): Operation<void> {
              const effect = binding.create(
                { type: "workspace", name: "cancelled" },
                function* (filesystem): Operation<Json> {
                  yield* filesystem.writeFile("/NOTES.md", "never committed\n", 0o644);
                  reached.inside = true;
                  // Nothing settles this: the halt below is what ends it.
                  yield* suspend();
                  return "unreachable";
                },
              );
              function* workflow(): Workflow<void> {
                yield effect;
              }
              return yield* durableRun(workflow, { stream: database.journal });
            })();
            return "unreachable";
          })(),
        ),
      );
      // Let the effect get inside its mutation, then halt the attachment.
      while (!reached.inside) {
        yield* sleep(1);
      }
      yield* running.halt();
      return { owner, inside: reached.inside };
    });

    // The document got as far as writing into its attempt, and the owner was
    // never asked to commit any of it.
    expect(outcome.inside).toBe(true);
    expect(published(outcome.owner.commits)).toEqual([]);
    // The attachment's own scope is over, so the temporary trees it
    // materialized into are gone with it.
    expect(outcome.owner.commits.every((intent) => intent["publication"] === null)).toBe(true);
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
