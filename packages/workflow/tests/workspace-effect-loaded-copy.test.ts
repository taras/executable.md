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
  InMemoryStream,
  type Json,
  type Result,
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
import { FORGE_EFFECT, reconcileForgeEffect, withForgeProvider } from "../src/forge/effect.ts";
import type { ForgeProvider } from "../src/forge/api.ts";
import { ForgeProviderError } from "../src/forge/errors.ts";
import type {
  ForgeCompletion,
  ForgeEffectRequest,
  ForgeObservation,
  ForgeReconciliationRecord,
} from "../src/forge/records.ts";

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

const FORGE_RUN: WorkflowRun = Object.freeze({
  runId: "run-297-loaded-copy",
  base: "main",
  pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
});

const FORGE_SOURCE = "<Effect />\n";

const FORGE_REQUEST: ForgeEffectRequest = Object.freeze({
  kind: "pull-request",
  inputs: { head: "release-1.4", base: "main" },
  naturalKey: { head: "release-1.4", base: "main" },
});

const FORGE_COMPATIBLE: ForgeObservation = Object.freeze({
  state: "compatible",
  preState: { number: 41 },
  observations: { number: 41 },
  result: { number: 41 },
});

/** The private forge invocation Api, addressed by its stable name from outside. */
const ForgeInvocationWitness = createApi<{ coordinate(request: unknown): Operation<unknown> }>(
  "executablemd.workflow.forge.invocation",
  {
    // deno-lint-ignore require-yield
    *coordinate(): Operation<unknown> {
      throw new Error("the witness handler did not delegate");
    },
  },
);

interface LoadedForgeCopy {
  withForgeProvider: typeof withForgeProvider;
  reconcileForgeEffect: typeof reconcileForgeEffect;
}

function loadedForgeCopy(value: unknown): value is LoadedForgeCopy {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "withForgeProvider") === "function" &&
    typeof Reflect.get(value, "reconcileForgeEffect") === "function"
  );
}

/**
 * A second physical copy of this package's shared source, loaded as its own
 * module graph.
 *
 * The whole shared tree is copied rather than the four forge modules, because
 * what the copy must reach — the run, the journal and the canonical encoding —
 * is exactly what a real second copy reaches. The host adapter is left behind:
 * this boundary names no host, so a copy of it needs none.
 */
function* physicalForgeCopy(): Operation<LoadedForgeCopy> {
  const directory = yield* until(Deno.makeTempDir({ prefix: "xmd-workflow-forge-copy-" }));
  yield* ensure(() => rm(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const entries = yield* glob({ root: source, patterns: ["**/*.ts"], exclude: ["deno/**"] });
  expect(entries.length).toBeGreaterThan(4);
  for (const entry of entries) {
    const destination = join(directory, entry.path);
    yield* ensureDir(dirname(destination));
    yield* writeTextFile(destination, yield* readTextFile(join(source, entry.path)));
  }
  const copy = yield* until(import(pathToFileURL(join(directory, "forge/effect.ts")).href));
  if (!loadedForgeCopy(copy)) {
    throw new Error("the physical workflow package copy did not export its forge surface");
  }
  expect(copy.reconcileForgeEffect).not.toBe(reconcileForgeEffect);
  return copy;
}

interface ForgeAttempt {
  readonly records: ForgeReconciliationRecord[];
  readonly failures: unknown[];
}

function forgeAttempt(): ForgeAttempt {
  return { records: [], failures: [] };
}

function useForgeEffectComponent(seen: ForgeAttempt): Operation<void> {
  return registerComponents([
    {
      name: "Effect",
      origin: "tier-dlf",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        try {
          seen.records.push(yield* reconcileForgeEffect(FORGE_REQUEST));
        } catch (error) {
          seen.failures.push(error);
          throw error;
        }
        return "";
      },
    },
  ]);
}

function* forgeDocument(stream: InMemoryStream): Operation<unknown> {
  return yield* collect(
    yield* executeInstalled({ ...inlineSource(FORGE_SOURCE), stream }, [
      retainedWorkflowInstallation(FORGE_RUN),
    ]),
  );
}

/** Invoke one member of a capability that arrived as an untyped value. */
function callCapability(value: unknown, method: string, ...args: unknown[]): Operation<unknown> {
  const member = Reflect.get(Object(value), method);
  if (typeof member !== "function") {
    throw new Error(`the forge capability has no ${method}`);
  }
  return Reflect.apply(member, value, args) as Operation<unknown>;
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
 * Tier DLF — physical forge package composition.
 *
 * The shared external-effect boundary is reached from two directions at once: a
 * workflow host installs its forge provider, and a repository `.ts` component
 * loaded from disk asks for a reconciliation. Those are two physical copies of
 * this package, and they compose only because both address the same stable
 * names. What must not compose is authority: the copy that installed the
 * provider holds the credential, and nothing that merely looks like the
 * capability can answer a phase.
 */
describe("Tier DLF — physical forge package composition", () => {
  it("DLF1: one copy's provider serves the other copy's reconciliation", function* () {
    const copy = yield* physicalForgeCopy();
    const stream = new InMemoryStream();
    const observed: unknown[] = [];
    const captured: unknown[] = [];
    const refusals: unknown[] = [];
    const seen = forgeAttempt();

    const provider: ForgeProvider = {
      *observe(request): Operation<EffectionResult<ForgeObservation>> {
        observed.push(request);
        return Ok(FORGE_COMPATIBLE);
      },
      // deno-lint-ignore require-yield
      *perform(): Operation<EffectionResult<ForgeCompletion>> {
        throw new Error("the copy performed where nothing may be performed");
      },
    };

    yield* scoped(function* () {
      yield* useForgeEffectComponent(seen);
      yield* ForgeInvocationWitness.around({
        *coordinate([request], next): Operation<unknown> {
          const invocation = Reflect.get(Object(request), "invocation");
          captured.push(invocation);
          // The capability travels through this middleware while it is still
          // live, and the credential does not. Each attempt here happens before
          // the copy's own handler has consumed anything, so a refusal is the
          // credential check answering rather than a spent invocation.
          refusals.push(yield* raised(callCapability(invocation, "inspect", Object.freeze({}))));
          refusals.push(
            yield* raised(
              callCapability(invocation, "answer", Object.freeze({}), Ok(FORGE_COMPATIBLE)),
            ),
          );
          // A copy of the capability is a different object holding no authority
          // of its own, so it refuses on the same terms.
          refusals.push(
            yield* raised(callCapability({ ...Object(invocation) }, "inspect", Object.freeze({}))),
          );
          return yield* next(request);
        },
      });
      // The provider is installed by the physically separate copy; the
      // reconciliation the document reaches is this copy's canonical one.
      yield* copy.withForgeProvider(provider, forgeDocument(stream));
    });

    expect(refusals).toHaveLength(3);
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(ForgeProviderError);
    }

    // The refused attempts consumed nothing: the copy's provider still served
    // the phase, and the run still published exactly one record.
    expect(seen.failures).toEqual([]);
    expect(observed).toHaveLength(1);
    expect(seen.records[0]?.decision).toBe("adopted");
    expect(
      stream
        .snapshot()
        .filter((event) => event.type === "yield" && event.description.type === FORGE_EFFECT),
    ).toHaveLength(1);

    // And the capability is stale once its invocation is over, whoever holds it.
    const invocation = captured[0];
    expect(typeof Reflect.get(Object(invocation), "inspect")).toBe("function");
    expect(yield* raised(callCapability(invocation, "inspect", Object.freeze({})))).toBeInstanceOf(
      ForgeProviderError,
    );
  });

  it("DLF2: the other copy's reconciliation runs under this copy's provider", function* () {
    const copy = yield* physicalForgeCopy();
    const stream = new InMemoryStream();
    const observed: unknown[] = [];
    const records: unknown[] = [];
    const failures: unknown[] = [];

    const provider: ForgeProvider = {
      *observe(request): Operation<EffectionResult<ForgeObservation>> {
        observed.push(request);
        return Ok(FORGE_COMPATIBLE);
      },
      // deno-lint-ignore require-yield
      *perform(): Operation<EffectionResult<ForgeCompletion>> {
        throw new Error("the canonical provider performed where nothing may be performed");
      },
    };

    yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Effect",
          origin: "tier-dlf",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            try {
              records.push(yield* copy.reconcileForgeEffect(FORGE_REQUEST));
            } catch (error) {
              failures.push(error);
              throw error;
            }
            return "";
          },
        },
      ]);
      yield* withForgeProvider(provider, forgeDocument(stream));
    });

    expect(failures).toEqual([]);
    expect(observed).toHaveLength(1);
    expect(records).toHaveLength(1);
  });
});
