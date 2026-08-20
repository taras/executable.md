import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { createApi } from "@effectionx/context-api";
import {
  ensure,
  Ok,
  type Operation,
  type Result as EffectionResult,
  scoped,
  until,
} from "effection";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { glob } from "@executablemd/runtime";
import {
  establishJournalProvenance,
  durableRun,
  type DurableEvent,
  InMemoryStream,
  type Json,
  type Result,
  serializeDurableEvent,
  type Workflow,
} from "@executablemd/durable-streams";
import { collect, inlineSource, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { WorkspaceCoordination, WorkspaceCoordinationProviderError } from "../src/workspace/api.ts";
import {
  type WorkspaceCoordinationAuthority,
  type WorkspaceCoordinationProvider,
  withWorkspaceCoordinationProvider,
} from "../src/workspace/effect.ts";
import { createDurableWorkspaceOperation } from "../mod.ts";
import { retainedWorkflowInstallation } from "../src/run.ts";
import type { WorkflowRun } from "../src/run.ts";
import {
  GIT_HOST_EFFECT,
  reconcileGitHostEffect,
  withGitHostProvider,
} from "../src/git-host/effect.ts";
import { GIT_HOST_API, GitHost } from "../src/git-host/api.ts";
import type {
  GitHostApi,
  GitHostCall,
  GitHostProvider,
  GitHostRoutingRequest,
} from "../src/git-host/api.ts";
import { GitHostProviderError } from "../src/git-host/errors.ts";
import {
  gitHostRequestFingerprint,
  parseGitHostReconciliationRecord,
} from "../src/git-host/records.ts";
import type {
  CompleteGitHostEffectRequest,
  GitHostCompletion,
  GitHostEffectRequest,
  GitHostObservation,
  GitHostReconciliationRecord,
} from "../src/git-host/records.ts";

interface LoadedWorkspaceCopy {
  createDurableWorkspaceOperation: typeof createDurableWorkspaceOperation;
}

function loadedWorkspaceCopy(value: unknown): value is LoadedWorkspaceCopy {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "createDurableWorkspaceOperation") === "function"
  );
}

function* physicalWorkspaceCopy(): Operation<LoadedWorkspaceCopy> {
  const directory = yield* until(Deno.makeTempDir({ prefix: "xmd-workflow-copy-" }));
  yield* ensure(() => rm(directory, { recursive: true, force: true }));
  const source = new URL("../src/workspace/", import.meta.url);
  const destination = pathToFileURL(`${directory}/`);
  yield* writeTextFile(
    new URL("api.ts", destination),
    yield* readTextFile(new URL("api.ts", source)),
  );
  yield* writeTextFile(
    new URL("effect.ts", destination),
    yield* readTextFile(new URL("effect.ts", source)),
  );
  const copy = yield* until(import(new URL("effect.ts", destination).href));
  if (!loadedWorkspaceCopy(copy)) {
    throw new Error("the physical Workspace package copy did not export its durable operation");
  }
  return copy;
}

function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

const GIT_HOST_RUN: WorkflowRun = Object.freeze({
  runId: "run-297-loaded-copy",
  base: "main",
  pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
});

const GIT_HOST_SOURCE = "<Effect />\n";

const GIT_HOST_REQUEST: GitHostEffectRequest = Object.freeze({
  kind: "pull-request",
  inputs: { head: "release-1.4", base: "main" },
  naturalKey: { head: "release-1.4", base: "main" },
});

const AUTHORIZED_OBSERVATION: GitHostObservation = Object.freeze({
  state: "compatible",
  preState: { by: "authorized-provider" },
  observations: { by: "authorized-provider" },
  result: { by: "authorized-provider" },
});

/** A second effect from the same element, so a fork's live suffix has one. */
const LATER_GIT_HOST_REQUEST: GitHostEffectRequest = Object.freeze({
  kind: "pull-request",
  inputs: { head: "release-1.5", base: "main" },
  naturalKey: { head: "release-1.5", base: "main" },
});

const ABSENT_OBSERVATION: GitHostObservation = Object.freeze({
  state: "absent",
  preState: { pullRequest: null },
});

const PERFORMED_COMPLETION: GitHostCompletion = Object.freeze({
  observations: { pullRequest: 42 },
  result: { pullRequest: 42 },
});

/**
 * One run's history as another run's, so a fork can inherit it.
 *
 * Only the Git-host record moves: its retained identity becomes the source's,
 * and the durable operation is renamed to the digest that identity produces —
 * which is what the source itself wrote and what a fork copies verbatim.
 */
function* inheritedGitHostHistory(
  events: readonly DurableEvent[],
  runId: string,
): Operation<DurableEvent[]> {
  const rewritten: DurableEvent[] = [];
  for (const event of events) {
    const record =
      event.type === "yield" &&
      event.description.type === GIT_HOST_EFFECT &&
      event.result.status === "ok"
        ? parseGitHostReconciliationRecord(event.result.value)
        : undefined;
    // The root Close goes: a completed terminal replays without entering the
    // durable body, and this history has to continue into the component.
    if (event.type === "close" && event.coroutineId === "root") {
      continue;
    }
    if (event.type !== "yield" || record === undefined) {
      rewritten.push(event);
      continue;
    }
    const request = { ...record.request, identity: { ...record.request.identity, runId } };
    rewritten.push({
      ...event,
      description: { ...event.description, name: yield* gitHostRequestFingerprint(request) },
      result: { status: "ok", value: { ...record, request } as unknown as Json },
    });
  }
  return rewritten;
}

const FORGED_OBSERVATION: GitHostObservation = Object.freeze({
  state: "compatible",
  preState: { by: "middleware-forgery" },
  observations: { by: "middleware-forgery" },
  result: { by: "middleware-forgery" },
});

/**
 * The one Git-host surface, reconstructed from its stable name alone.
 *
 * Which is how a second loaded copy composes — and, deliberately, all that
 * reconstructing the name buys.
 */
const GitHostWitness = createApi<GitHostApi>(GIT_HOST_API, {
  // deno-lint-ignore require-yield
  *route(): Operation<unknown> {
    throw new Error("the witness handler did not delegate");
  },
});

interface LoadedGitHostCopy {
  withGitHostProvider: typeof withGitHostProvider;
  reconcileGitHostEffect: typeof reconcileGitHostEffect;
}

function loadedGitHostCopy(value: unknown): value is LoadedGitHostCopy {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "withGitHostProvider") === "function" &&
    typeof Reflect.get(value, "reconcileGitHostEffect") === "function"
  );
}

/**
 * A second physical copy of this package's shared source, loaded as its own
 * module graph.
 *
 * The whole shared tree is copied rather than the four Git-host modules,
 * because what the copy must reach — the run, the journal and the canonical
 * encoding — is exactly what a real second copy reaches. The host adapter is
 * left behind: this boundary names no host, so a copy of it needs none.
 */
function* physicalGitHostCopy(): Operation<LoadedGitHostCopy> {
  const directory = yield* until(Deno.makeTempDir({ prefix: "xmd-workflow-git-host-copy-" }));
  yield* ensure(() => rm(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const entries = yield* glob({ root: source, patterns: ["**/*.ts"], exclude: ["deno/**"] });
  expect(entries.length).toBeGreaterThan(4);
  for (const entry of entries) {
    const destination = join(directory, entry.path);
    yield* ensureDir(dirname(destination));
    yield* writeTextFile(destination, yield* readTextFile(join(source, entry.path)));
  }
  const copy = yield* until(import(pathToFileURL(join(directory, "git-host/effect.ts")).href));
  if (!loadedGitHostCopy(copy)) {
    throw new Error("the physical workflow package copy did not export its Git-host surface");
  }
  expect(copy.reconcileGitHostEffect).not.toBe(reconcileGitHostEffect);
  return copy;
}

interface GitHostAttempt {
  readonly records: GitHostReconciliationRecord[];
  readonly failures: unknown[];
}

function gitHostAttempt(): GitHostAttempt {
  return { records: [], failures: [] };
}

function useGitHostEffectComponent(
  seen: GitHostAttempt,
  reconcile: typeof reconcileGitHostEffect,
): Operation<void> {
  return registerComponents([
    {
      name: "Effect",
      origin: "tier-dlg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        try {
          seen.records.push(yield* reconcile(GIT_HOST_REQUEST));
        } catch (error) {
          seen.failures.push(error);
          throw error;
        }
        return "";
      },
    },
  ]);
}

function* gitHostDocument(stream: InMemoryStream): Operation<unknown> {
  return yield* collect(
    yield* executeInstalled({ ...inlineSource(GIT_HOST_SOURCE), stream }, [
      retainedWorkflowInstallation(GIT_HOST_RUN),
    ]),
  );
}

function gitHostYields(stream: InMemoryStream): DurableEvent[] {
  return stream
    .snapshot()
    .filter((event) => event.type === "yield" && event.description.type === GIT_HOST_EFFECT);
}

describe("Tier DLC — physical Workspace package composition", () => {
  it("DLC16: provider selection composes without sharing invocation authority", function* () {
    const copy = yield* physicalWorkspaceCopy();
    const stream = new InMemoryStream();
    establishJournalProvenance(stream);
    let providers = 0;
    let transactions = 0;
    let executions = 0;
    let publications = 0;
    let capturedAuthority: WorkspaceCoordinationAuthority | undefined;
    const provider: WorkspaceCoordinationProvider = {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        providers += 1;
        transactions += 1;
        capturedAuthority = authority;
        const result: Result = { status: "ok", value: yield* authority.execute() };
        publications += 1;
        yield* authority.publish(result);
        return result;
      },
    };
    function* workflow(): Workflow<void> {
      yield copy.createDurableWorkspaceOperation(
        { type: "workspace", name: "physical-copy" },
        function* (): Operation<Json> {
          executions += 1;
          return "copied";
        },
      );
    }

    yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));

    expect({ providers, transactions, executions, publications }).toEqual({
      providers: 1,
      transactions: 1,
      executions: 1,
      publications: 1,
    });
    expect(stream.snapshot().filter((event) => event.type === "yield")).toHaveLength(1);
    if (capturedAuthority === undefined) {
      throw new Error("the provider did not receive the physical copy invocation");
    }
    expect(yield* raised(capturedAuthority.execute())).toBeInstanceOf(
      WorkspaceCoordinationProviderError,
    );
    expect(
      yield* raised(capturedAuthority.publish({ status: "ok", value: "reused" })),
    ).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(yield* raised(capturedAuthority.activateFailure(new Error("reused")))).toBeInstanceOf(
      WorkspaceCoordinationProviderError,
    );

    const refusedStream = new InMemoryStream();
    establishJournalProvenance(refusedStream);
    let refusedExecutions = 0;
    function* refusedWorkflow(): Workflow<void> {
      yield copy.createDurableWorkspaceOperation(
        { type: "workspace", name: "substituted-copy" },
        function* (): Operation<Json> {
          refusedExecutions += 1;
          return "not reached";
        },
      );
    }

    const failure = yield* scoped(function* () {
      yield* WorkspaceCoordination.around({ provider: () => Object.freeze({}) });
      return yield* raised(
        withWorkspaceCoordinationProvider(
          provider,
          durableRun(refusedWorkflow, { stream: refusedStream }),
        ),
      );
    });

    expect(Reflect.get(failure ?? {}, "name")).toBe("WorkspaceCoordinationProviderError");
    expect({ providers, transactions, refusedExecutions, publications }).toEqual({
      providers: 1,
      transactions: 1,
      refusedExecutions: 0,
      publications: 1,
    });
    expect(refusedStream.snapshot()).toEqual([]);
  });
});

/**
 * Tier DLG — physical Git-host package composition.
 *
 * The shared Git-host boundary is reached from two directions at once: a
 * workflow host installs its provider, and a repository `.ts` component loaded
 * from disk asks for a reconciliation. Those are two physical copies of this
 * package, and they compose only because both address the same stable
 * operation name.
 *
 * What must not compose is authority. Reconstructing that name from a second
 * copy buys a place in the middleware chain and nothing else: no credential, no
 * capability, no answer, and no route to the invocation's own terminal.
 */
describe("Tier DLG — physical Git-host package composition", () => {
  it("DLG1: one copy's provider serves the other copy's reconciliation", function* () {
    const copy = yield* physicalGitHostCopy();
    const stream = new InMemoryStream();
    const observed: unknown[] = [];
    const captured: unknown[] = [];
    const refused: unknown[] = [];
    const seen = gitHostAttempt();

    const provider: GitHostProvider = {
      *observe(request): Operation<EffectionResult<GitHostObservation>> {
        observed.push(request);
        return Ok(AUTHORIZED_OBSERVATION);
      },
      // deno-lint-ignore require-yield
      *perform(): Operation<EffectionResult<GitHostCompletion>> {
        throw new Error("the copy performed where nothing may be performed");
      },
    };

    yield* scoped(function* () {
      yield* useGitHostEffectComponent(seen, reconcileGitHostEffect);
      // GH10's consequence, in the loaded-copy direction: middleware built from
      // the stable name, sitting between the two copies, still authors nothing.
      yield* GitHostWitness.around({
        *route([call], next): Operation<unknown> {
          if (call.intent !== "route") {
            return yield* next(call);
          }
          captured.push(call);
          for (const attempted of [
            { intent: "inspect", routing: call } as GitHostCall,
            { intent: "answer", routing: call, answer: Ok(FORGED_OBSERVATION) } as GitHostCall,
          ]) {
            try {
              refused.push(yield* next(attempted));
            } catch (error) {
              refused.push(error);
            }
          }
          return yield* next(call);
        },
      });
      // The provider is installed by the physically separate copy; the
      // reconciliation the document reaches is this copy's canonical one.
      yield* copy.withGitHostProvider(provider, gitHostDocument(stream));
    });

    expect(seen.failures).toEqual([]);
    expect(observed).toHaveLength(1);
    expect(seen.records[0]?.decision).toBe("adopted");
    expect(seen.records[0]?.result).toEqual({ by: "authorized-provider" });
    expect(gitHostYields(stream)).toHaveLength(1);
    expect(stream.snapshot().map(serializeDurableEvent).join("")).not.toContain(
      "middleware-forgery",
    );

    // Reconstructing the name reached the chain and nothing else. The refusals
    // are the *copy's* class, not this one's — `instanceof` is wrong in exactly
    // this direction across loaded copies, which is why the closed name is what
    // identifies a condition everywhere else in this boundary too.
    expect(captured).toHaveLength(1);
    expect(refused.length).toBeGreaterThanOrEqual(2);
    for (const refusal of refused) {
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).name).toBe("GitHostProviderError");
      expect(refusal).not.toBeInstanceOf(GitHostProviderError);
    }
    for (const value of captured) {
      const call = Object(value);
      expect(Object.keys(call).sort()).toEqual(["intent", "phase", "request"]);
      expect(Object.values(call).some((member) => typeof member === "function")).toBe(false);
      expect(Object.isFrozen(call)).toBe(true);
    }

    // And a request captured here completes nothing afterwards: the exported
    // descriptor's own default is a refusal, whoever holds the request.
    const routing = captured[0];
    expect(
      yield* raised(GitHost.operations.route(routing as GitHostRoutingRequest)),
    ).toBeInstanceOf(GitHostProviderError);
  });

  it("DLG2: the other copy's reconciliation runs under this copy's provider", function* () {
    const copy = yield* physicalGitHostCopy();
    const stream = new InMemoryStream();
    const observed: unknown[] = [];
    const seen = gitHostAttempt();

    const provider: GitHostProvider = {
      *observe(request): Operation<EffectionResult<GitHostObservation>> {
        observed.push(request);
        return Ok(AUTHORIZED_OBSERVATION);
      },
      // deno-lint-ignore require-yield
      *perform(): Operation<EffectionResult<GitHostCompletion>> {
        throw new Error("the canonical provider performed where nothing may be performed");
      },
    };

    yield* scoped(function* () {
      yield* useGitHostEffectComponent(seen, copy.reconcileGitHostEffect);
      yield* withGitHostProvider(provider, gitHostDocument(stream));
    });

    expect(seen.failures).toEqual([]);
    expect(observed).toHaveLength(1);
    expect(seen.records).toHaveLength(1);
    expect(gitHostYields(stream)).toHaveLength(1);
  });

  it("DLG3: the other copy consumes an inherited record under its retained identity", function* () {
    // A fork's journal holds records its source wrote, and a Git-host effect is
    // named by a digest that includes the run id — so a copy that could not see
    // the retained identity would fingerprint an inherited record with the fork
    // id and diverge. Which physical module object asks must not decide which
    // retained history is accepted.
    const copy = yield* physicalGitHostCopy();
    const sourceRunId = "run-297-git-host-source";

    // A source run that made the effect, then the same history as that run's.
    const seedStream = new InMemoryStream();
    const seeded = gitHostAttempt();
    yield* scoped(function* () {
      yield* useGitHostEffectComponent(seeded, reconcileGitHostEffect);
      yield* withGitHostProvider(
        {
          *observe(): Operation<EffectionResult<GitHostObservation>> {
            return Ok(AUTHORIZED_OBSERVATION);
          },
          // deno-lint-ignore require-yield
          *perform(): Operation<EffectionResult<GitHostCompletion>> {
            throw new Error("nothing may be performed here");
          },
        },
        gitHostDocument(seedStream),
      );
    });
    expect(seeded.failures).toEqual([]);
    const inherited = yield* inheritedGitHostHistory(seedStream.snapshot(), sourceRunId);

    // Replayed through the *second* copy, with no provider installed at all.
    const stream = new InMemoryStream(inherited);
    const seen = gitHostAttempt();
    yield* scoped(function* () {
      yield* useGitHostEffectComponent(seen, copy.reconcileGitHostEffect);
      yield* gitHostDocument(stream);
    });

    // It consumed the exact inherited record, provider-free, under the identity
    // that record was written with.
    expect(seen.failures).toEqual([]);
    expect(seen.records).toHaveLength(1);
    expect(seen.records[0]?.request.identity.runId).toBe(sourceRunId);

    // The record and its provenance are exactly what was inherited: nothing was
    // re-authored, and no second Git-host event was appended.
    expect(gitHostYields(stream)).toHaveLength(1);
    expect(stream.snapshot().slice(0, inherited.length)).toEqual(inherited);

    // And work after it is the executing run's. A second call has no unclaimed
    // record left, so it runs live — under this run, never the source's.
    const liveStream = new InMemoryStream(inherited);
    const liveSeen = gitHostAttempt();
    const observedLive: CompleteGitHostEffectRequest[] = [];
    yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Effect",
          origin: "tier-dlg",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            for (const request of [GIT_HOST_REQUEST, LATER_GIT_HOST_REQUEST]) {
              try {
                liveSeen.records.push(yield* copy.reconcileGitHostEffect(request));
              } catch (error) {
                liveSeen.failures.push(error);
              }
            }
            return "";
          },
        },
      ]);
      yield* withGitHostProvider(
        {
          *observe(request): Operation<EffectionResult<GitHostObservation>> {
            observedLive.push(request);
            return Ok(ABSENT_OBSERVATION);
          },
          *perform(request): Operation<EffectionResult<GitHostCompletion>> {
            observedLive.push(request);
            return Ok(PERFORMED_COMPLETION);
          },
        },
        gitHostDocument(liveStream),
      );
    });

    expect(liveSeen.failures).toEqual([]);
    expect(liveSeen.records[0]?.request.identity.runId).toBe(sourceRunId);
    expect(liveSeen.records[1]?.request.identity.runId).toBe(GIT_HOST_RUN.runId);
    for (const request of observedLive) {
      expect(request.identity.runId).toBe(GIT_HOST_RUN.runId);
    }
  });
});
