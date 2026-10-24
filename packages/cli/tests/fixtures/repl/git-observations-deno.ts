import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { race, scoped, spawn, withResolvers } from "effection";
import type { Operation, Task } from "effection";
import { join, resolve } from "node:path";
import { useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { useDenoRepositoryOperations } from "@executablemd/git/deno";
import { runGit } from "../../support/fixture-git.ts";
import { replRepositoryInstallation } from "../../../src/repl/repositories/deno/provider.ts";
import { ordinaryGeneratedSelection } from "../../../src/evaluation-profile.ts";
import { ReplHost } from "../../../src/repl/host.ts";
import { openReplSession, submitReplEntry } from "../../../src/repl/session.ts";
import { entryInitialBindings } from "../../../src/repl/model.ts";
import {
  createExecutionFile,
  executionPath,
  openExecutionFile,
  readRecords,
} from "../../../src/repl/journal.ts";
import type { ReplEntryInstallation } from "../../../src/repl-entry-installation.ts";
import {
  parseReplPlacementRecord,
  REPL_REPOSITORY_PLACEMENT,
} from "../../../src/repl/repositories/placement-records.ts";
import { REPL_REPOSITORY_LOCAL } from "../../../src/repl/repositories/records.ts";
import {
  selectedByPlacement,
  parseReplObservationRecord,
} from "../../../src/repl/repositories/observation-records.ts";
import { admitReplRepositoryHistory } from "../../../src/repl/repositories/admission.ts";
import {
  useObservationLease,
  useCommonDirectoryLease,
} from "../../../src/repl/repositories/deno/leases.ts";
import {
  useFixture,
  replInstallations,
  useNodeReplHost,
  useWorkingDirectory,
  opened,
  READS_AT_ROOT,
} from "../../support/repl-git-observations.ts";
import type { Fixture } from "../../support/repl-git-observations.ts";

function* waitForRead(entered: Operation<void>, task: Task<void>): Operation<void> {
  yield* race([
    entered,
    (function* (): Operation<void> {
      yield* task;
    })(),
  ]);
}

interface D3Calls {
  native: number;
  reads: number;
  beforeRead?: () => Operation<void>;
}

function d3Factory(
  fixture: Fixture,
  path: string | undefined,
  calls: D3Calls,
): ReplEntryInstallation {
  return (owner, placement) =>
    replRepositoryInstallation(owner, {
      ...placement,
      root: join(fixture.root, "repositories"),
      observeWorktree: path,
      *operations() {
        const operations = yield* useDenoRepositoryOperations();
        return {
          ...operations,
          *ambientCheckout(from) {
            calls.native += 1;
            return yield* operations.ambientCheckout(from);
          },
          *ambientRepository(from, linkedTo) {
            calls.native += 1;
            return yield* operations.ambientRepository(from, linkedTo);
          },
          *observe(element, request, place) {
            calls.reads += 1;
            if (calls.beforeRead !== undefined) {
              yield* calls.beforeRead();
            }
            return yield* operations.observe(element, request, place);
          },
        };
      },
    });
}

function* d3Prepare(fixture: Fixture): Operation<string> {
  yield* useNodeReplHost("execution-1");
  yield* useHostFiles();
  yield* useWorkingDirectory(fixture.checkout);
  const path = join(fixture.root, "linked");
  yield* fixture.run("worktree", "add", "-b", "linked", path);
  return path;
}

function d3Reads(path: string, fixture: Fixture): string {
  return "<Dir path=" + JSON.stringify(path) + ">\n" + READS_AT_ROOT(fixture) + "\n</Dir>";
}

describe("D3 — trusted retained observation worktrees", () => {
  it("admits all four reads only after the actual entry acknowledges placement, without granting mutations", function* () {
    const fixture = yield* useFixture();
    const path = yield* d3Prepare(fixture);
    const absent = { native: 0, reads: 0 };
    yield* scoped(function* () {
      const created = yield* createExecutionFile(join(fixture.root, "absent"), "execution-1");
      const session = opened(
        yield* submitReplEntry({
          execution: created,
          projectCwd: fixture.checkout,
          entryInstallation: d3Factory(fixture, undefined, absent),
          installations: yield* replInstallations(),
          source: d3Reads(path, fixture),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      expect((yield* session.join()).ok).toBe(false);
    });
    expect(absent.reads).toBe(0);
    const calls: D3Calls = { native: 0, reads: 0 };
    const created = yield* createExecutionFile(fixture.journals, "execution-1");
    calls.beforeRead = function* () {
      const records = yield* readRecords(executionPath(fixture.journals, "execution-1"));
      expect(
        records.some(
          (event) =>
            event.type === "yield" &&
            event.description.type === REPL_REPOSITORY_PLACEMENT &&
            event.result.status === "ok" &&
            parseReplPlacementRecord(event.result.value)?.kind === "observation-worktree",
        ),
      ).toBe(true);
    };
    const session = opened(
      yield* submitReplEntry({
        execution: created,
        projectCwd: fixture.checkout,
        entryInstallation: d3Factory(fixture, path, calls),
        installations: yield* replInstallations(),
        source: d3Reads(path, fixture),
        generated: ordinaryGeneratedSelection(),
      }),
    );
    const outcome = yield* session.join();
    if (!outcome.ok) {
      throw outcome.error;
    }
    expect(calls.reads).toBe(4);
    const records = yield* readRecords(executionPath(fixture.journals, "execution-1"));
    expect(
      records.filter(
        (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_LOCAL,
      ).length,
    ).toBe(0);
    const mutation = yield* session.submit(
      "<Dir path=" + JSON.stringify(path) + '><Git.Add paths={["notes.md"]} /></Dir>',
    );
    expect(mutation.ok).toBe(true);
    expect((yield* session.join()).ok).toBe(false);
    expect(yield* fixture.run("status", "--porcelain")).toBe("");
    expect(yield* runGit(path, ["status", "--porcelain"], { home: fixture.root })).toBe("");
  });

  it("replays completed pages without discovery or ownership and requires a current grant for new reads", function* () {
    const fixture = yield* useFixture();
    const path = yield* d3Prepare(fixture);
    yield* scoped(function* () {
      const created = yield* createExecutionFile(fixture.journals, "execution-1");
      const session = opened(
        yield* submitReplEntry({
          execution: created,
          projectCwd: fixture.checkout,
          entryInstallation: d3Factory(fixture, path, { native: 0, reads: 0 }),
          installations: yield* replInstallations(),
          source: d3Reads(path, fixture),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      const result = yield* session.join();
      if (!result.ok) {
        throw result.error;
      }
    });
    const acknowledged = yield* readRecords(executionPath(fixture.journals, "execution-1"));
    const common = yield* fixture.run("rev-parse", "--git-common-dir");
    const resolvedCommon = resolve(fixture.checkout, common);
    yield* useObservationLease(resolvedCommon, path);
    const cold = { native: 0, reads: 0 };
    const file = yield* openExecutionFile(fixture.journals, "execution-1");
    const session = opened(
      yield* openReplSession({
        execution: file,
        projectCwd: fixture.checkout,
        entryInstallation: d3Factory(fixture, undefined, cold),
        installations: yield* replInstallations(),
        generated: ordinaryGeneratedSelection(),
      }),
    );
    expect(session.live).toBe(false);
    expect(cold).toEqual({ native: 0, reads: 0 });
    expect(entryInitialBindings(session.model).files).toBeDefined();
    const next = yield* session.submit(d3Reads(path, fixture));
    expect(next.ok).toBe(true);
    expect((yield* session.join()).ok).toBe(false);
    expect(cold.reads).toBe(0);
    const retained = yield* readRecords(executionPath(fixture.journals, "execution-1"));
    const placements = retained.flatMap((event) => {
      if (event.type !== "yield" || event.result.status !== "ok") {
        return [];
      }
      const record = parseReplPlacementRecord(event.result.value);
      return record?.outcome.ok && record.kind === "observation-worktree"
        ? [record.outcome.value]
        : [];
    });
    for (const event of retained) {
      if (event.type !== "yield" || event.result.status !== "ok") {
        continue;
      }
      const read = parseReplObservationRecord(event.result.value);
      if (read === undefined) {
        continue;
      }
      expect(selectedByPlacement(placements, { ...read.request, selectionCheckout: path })).toBe(
        false,
      );
    }
    const changed = retained.map((event): DurableEvent => {
      if (
        event.type !== "yield" ||
        event.result.status !== "ok" ||
        event.description.type !== REPL_REPOSITORY_PLACEMENT
      ) {
        return event;
      }
      const record = parseReplPlacementRecord(event.result.value);
      return record?.kind !== "observation-worktree"
        ? event
        : {
            ...event,
            result: {
              status: "ok",
              value: { ...JSON.parse(JSON.stringify(event.result.value)), version: 99 },
            },
          };
    });
    let refused = false;
    try {
      yield* admitReplRepositoryHistory(changed);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    yield* scoped(function* () {
      const current = { native: 0, reads: 0 };
      const currentFile = { id: "execution-1", stream: new InMemoryStream(acknowledged) };
      const currentSession = opened(
        yield* openReplSession({
          execution: currentFile,
          projectCwd: fixture.checkout,
          entryInstallation: d3Factory(fixture, path, current),
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      expect(current.native).toBe(0);
      const attempted = yield* currentSession.submit(d3Reads(path, fixture));
      expect(attempted.ok).toBe(true);
      expect((yield* currentSession.join()).ok).toBe(false);
      expect(current.native).toBeGreaterThan(0);
      expect(current.reads).toBe(0);
    });
  });

  it("holds a separate nonblocking observation lane, serializes reads, and joins cancellation", function* () {
    const fixture = yield* useFixture();
    const path = yield* d3Prepare(fixture);
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    let cleaned = false;
    let active = 0;
    let maximum = 0;
    const calls: D3Calls = {
      native: 0,
      reads: 0,
      *beforeRead() {
        active += 1;
        maximum = Math.max(maximum, active);
        try {
          entered.resolve();
          yield* release.operation;
        } finally {
          active -= 1;
          cleaned = true;
        }
      },
    };
    const task = yield* spawn(function* () {
      const created = yield* createExecutionFile(fixture.journals, "execution-1");
      const session = opened(
        yield* submitReplEntry({
          execution: created,
          projectCwd: fixture.checkout,
          entryInstallation: d3Factory(fixture, path, calls),
          installations: yield* replInstallations(),
          source:
            "<Dir path=" +
            JSON.stringify(path) +
            '><All><Spawn><Git.Files as="first" /></Spawn><Spawn><Git.Changes compare="unstaged" as="second" /></Spawn></All></Dir>',
          generated: ordinaryGeneratedSelection(),
        }),
      );
      const result = yield* session.join();
      if (!result.ok) {
        throw result.error;
      }
      throw new Error("The D3 session ended before reaching its read barrier.");
    });
    yield* waitForRead(entered.operation, task);
    const common = resolve(fixture.checkout, yield* fixture.run("rev-parse", "--git-common-dir"));
    let busy = false;
    try {
      yield* scoped(() => useObservationLease(common, path));
    } catch {
      busy = true;
    }
    expect(busy).toBe(true);
    yield* scoped(() => useCommonDirectoryLease(common));
    expect(maximum).toBe(1);
    yield* task.halt();
    expect(cleaned).toBe(true);
    expect(active).toBe(0);
    yield* scoped(() => useObservationLease(common, path));
  });

  it("surfaces startup failure before the read barrier and joins its session", function* () {
    const fixture = yield* useFixture();
    const path = yield* d3Prepare(fixture);
    const entered = withResolvers<void>();
    const calls: D3Calls = {
      native: 0,
      reads: 0,
      *beforeRead() {
        entered.resolve();
      },
    };
    let joined = false;
    let failed: Error | undefined;
    let injected = false;
    let diagnostic: unknown;
    yield* scoped(function* () {
      const task = yield* spawn(function* () {
        try {
          yield* ReplHost.around({
            *appendRecord([file, record], next) {
              if (record.includes('"kind":"observation-worktree"')) {
                injected = true;
                throw new Error("CONTROLLED_D3_STARTUP_FAILURE");
              }
              yield* next(file, record);
            },
          });
          const created = yield* createExecutionFile(fixture.journals, "execution-1");
          const session = opened(
            yield* submitReplEntry({
              execution: created,
              projectCwd: fixture.checkout,
              entryInstallation: d3Factory(fixture, path, calls),
              installations: yield* replInstallations(),
              source: d3Reads(path, fixture),
              generated: ordinaryGeneratedSelection(),
            }),
          );
          const result = yield* session.join();
          if (!result.ok) {
            failed = result.error;
            throw result.error;
          }
          throw new Error("The D3 session unexpectedly completed without a read.");
        } finally {
          joined = true;
        }
      });
      try {
        yield* waitForRead(entered.operation, task);
      } catch (error) {
        diagnostic = error;
      }
    });
    expect(injected).toBe(true);
    expect(diagnostic).toBe(failed);
    expect(failed?.message).toBe("Failed to persist durable yield event");
    expect(calls.reads).toBe(0);
    expect(joined).toBe(true);
  });

  for (const failure of ["before", "after"]) {
    it("fences " + failure + " placement append without serving a read", function* () {
      const fixture = yield* useFixture();
      const path = yield* d3Prepare(fixture);
      yield* ReplHost.around({
        *appendRecord([file, record], next) {
          const placement = record.includes('"kind":"observation-worktree"');
          if (placement && failure === "before") {
            throw new Error("CONTROLLED_PLACEMENT_APPEND");
          }
          yield* next(file, record);
          if (placement && failure === "after") {
            throw new Error("CONTROLLED_PLACEMENT_ACK_UNKNOWN");
          }
        },
      });
      const calls = { native: 0, reads: 0 };
      const created = yield* createExecutionFile(fixture.journals, "execution-1");
      const session = opened(
        yield* submitReplEntry({
          execution: created,
          projectCwd: fixture.checkout,
          entryInstallation: d3Factory(fixture, path, calls),
          installations: yield* replInstallations(),
          source: d3Reads(path, fixture),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      expect((yield* session.join()).ok).toBe(false);
      expect(calls.reads).toBe(0);
    });
  }
});
