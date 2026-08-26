/**
 * Tier XE — sealing one committed frontier as a portable artifact.
 *
 * Real runs, a real executor lock, a real file. What is under test is the seam
 * between a run and the container: that a frontier is chosen only while nothing
 * can append underneath it, that the source is not touched, that a closure
 * belonging to some other definition is refused, and that every refusal leaves
 * no artifact behind.
 *
 * What the container does with the snapshot afterwards is #602's suite, and is
 * not re-proved here.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists } from "@effectionx/fs";
import type { Operation } from "effection";
import { join } from "node:path";
import { readXmdArtifact } from "../src/deno/artifact/mod.ts";
import type { XmdArtifactDefinitionClosure } from "../src/artifact/types.ts";
import { Ok, scoped } from "effection";
import type { Result } from "effection";
import { WorkflowLifecycle } from "../mod.ts";
import type { WorkflowDefinitionSourceReader } from "../src/artifact/source.ts";
import { installWorkflowLifecycle } from "../src/deno/lifecycle.ts";
import type { WorkflowExecutionTransitions } from "../deno.ts";
import { installWorkflowRunStorage } from "../src/deno/provider.ts";
import { useWorkflowRunConnections } from "../src/deno/connections.ts";
import { SavepointObservation } from "../src/deno/savepoints.ts";
import { gitBlobId } from "./support/artifact-fixture.ts";
import { creation, definition, SHA1, useStorageRoot, withExecutorRun } from "./support/storage.ts";

const ROOT_DOCUMENT = "# Release\n\nnothing to see here\n";

/** The closure the fixture run's definition names, authenticated as #600 would. */
function closure(): XmdArtifactDefinitionClosure {
  return {
    root: {
      objectFormat: "sha1",
      pinnedCommit: SHA1,
      rootDocumentPath: "workflows/release.md",
      blobId: gitBlobId(ROOT_DOCUMENT),
      content: ROOT_DOCUMENT,
    },
    components: [],
  };
}

/**
 * Export through the provider-neutral surface.
 *
 * `forged` is offered on the request the way a caller holding the contextual
 * lifecycle name would offer it. The request declares no such member, and the
 * point of passing it anyway is that it reaches nothing: what gets sealed is
 * whatever the host's installed reader returns.
 */
function* exportRun(runId: string, stagingPath: string, forged?: XmdArtifactDefinitionClosure) {
  return yield* WorkflowLifecycle.operations.export({
    runId,
    stagingPath,
    ...(forged === undefined ? {} : { closure: forged }),
  });
}

/** The reader a host installs: it returns this run's real retained source. */
// deno-lint-ignore require-yield
function* honestSource(): Operation<Result<XmdArtifactDefinitionClosure>> {
  return Ok(closure());
}

/**
 * Storage and lifecycle, with the source reader this host installs.
 *
 * The reader is an installation argument, so a test that wants a different one
 * installs a different host — which is the only way to change it, and the point
 * of the boundary.
 */
function withExportHost<T>(
  root: string,
  source: WorkflowDefinitionSourceReader | undefined,
  body: (transitions: WorkflowExecutionTransitions) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const connections = yield* useWorkflowRunConnections(yield* SavepointObservation.get());
    yield* installWorkflowRunStorage({ root }, {}, connections);
    const transitions = yield* installWorkflowLifecycle(
      { root, ...(source === undefined ? {} : { definitionSource: source }) },
      connections,
    );
    return yield* body(transitions);
  });
}

/** One settled run, and the storage root it lives in. */
function useSettledRun(runId = "release-1.4"): Operation<string> {
  return (function* () {
    const root = yield* useStorageRoot();
    yield* withExportHost(root, honestSource, function* (transitions) {
      yield* withExecutorRun(
        transitions,
        { runId, action: "start", creation: creation({ definition: definition() }) },
        function* (begun, executorLock) {
          const settled = yield* transitions.settle(executorLock, {
            executionId: begun.execution.executionId,
            status: "completed",
          });
          if (!settled.ok) {
            throw settled.error;
          }
        },
      );
    });
    return root;
  })();
}

describe("exporting a workflow run", () => {
  it("XE1 refuses while an executor holds the run, and writes nothing", function* () {
    const root = yield* useStorageRoot();
    const target = join(root, "busy.xmd");

    // A host that is configured correctly, so the refusal under test is the
    // live executor rather than a missing reader.
    yield* withExportHost(root, honestSource, function* (transitions) {
      yield* withExecutorRun(
        transitions,
        { runId: "release-1.4", action: "start", creation: creation() },
        function* () {
          // Inside the hold: the run has an executor right now, so it has no
          // settled frontier to choose.
          const refused = yield* exportRun("release-1.4", target);
          expect(refused.ok).toBe(false);
          expect(refused.ok ? "" : refused.error.name).toBe("WorkflowExportBusyError");
        },
      );
    });

    expect(yield* exists(target)).toBe(false);
  });

  it("XE2 seals a settled frontier and leaves the run as it was", function* () {
    const root = yield* useSettledRun();
    const target = join(root, "evidence.xmd");

    const sealed = yield* withExportHost(root, honestSource, function* () {
      return yield* exportRun("release-1.4", target);
    });
    if (!sealed.ok) {
      throw sealed.error;
    }

    expect(sealed.value.stagingPath).toBe(target);
    expect(sealed.value.frontier.sourceRunId).toBe("release-1.4");
    expect(sealed.value.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.value.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    // Two different questions, and never the same answer by accident.
    expect(sealed.value.fileSha256).not.toBe(sealed.value.identity);

    // The artifact opens as one a stranger could open.
    const opened = yield* readXmdArtifact(target);
    if (!opened.ok) {
      throw opened.error;
    }
    expect(opened.value.identity).toBe(sealed.value.identity);
    expect(opened.value.run.runId).toBe("release-1.4");
    expect(opened.value.run.status).toBe("completed");
    expect(opened.value.definition.root.content).toBe(ROOT_DOCUMENT);
    expect(opened.value.frontier).toEqual(sealed.value.frontier);

    // The run is still there, still readable, and still says what it said.
    const after = yield* withExportHost(root, honestSource, function* () {
      return yield* WorkflowLifecycle.operations.inspect("release-1.4");
    });
    if (!after.ok) {
      throw after.error;
    }
    expect(after.value.record.status).toBe("completed");
  });

  it("XE3 refuses source the host read back that is not this run's", function* () {
    const root = yield* useSettledRun();
    const target = join(root, "wrong-source.xmd");
    const other = closure();

    // deno-lint-ignore require-yield
    const wrongRun: WorkflowDefinitionSourceReader = function* () {
      return Ok({ ...other, root: { ...other.root, rootDocumentPath: "workflows/other.md" } });
    };
    const refused = yield* withExportHost(root, wrongRun, function* () {
      return yield* exportRun("release-1.4", target);
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error.name).toBe("WorkflowRequestError");
    expect(yield* exists(target)).toBe(false);
  });

  it("XE4 seals the host's source, not a closure offered on the request", function* () {
    const root = yield* useSettledRun();
    const target = join(root, "forged.xmd");

    // Every descriptor field the run retains, arbitrary Markdown, and the blob
    // id that Markdown really hashes to — internally consistent, and offered
    // the way anything holding the contextual lifecycle name could offer it.
    const forged = closure();
    const lie = "# Not what ran\n\nthis document never executed\n";
    const sealed = yield* withExportHost(root, honestSource, function* () {
      return yield* exportRun("release-1.4", target, {
        ...forged,
        root: { ...forged.root, blobId: gitBlobId(lie), content: lie },
      });
    });
    if (!sealed.ok) {
      throw sealed.error;
    }

    const opened = yield* readXmdArtifact(target);
    if (!opened.ok) {
      throw opened.error;
    }
    // The request reached nothing: what was sealed is what the host read.
    expect(opened.value.definition.root.content).toBe(ROOT_DOCUMENT);
    expect(opened.value.definition.root.content).not.toBe(lie);
  });

  it("XE5 refuses to export at all when the host installed no reader", function* () {
    const root = yield* useSettledRun();
    const target = join(root, "no-reader.xmd");

    const refused = yield* withExportHost(root, undefined, function* () {
      return yield* exportRun("release-1.4", target);
    });

    expect(refused.ok).toBe(false);
    expect(yield* exists(target)).toBe(false);
  });

  it("XE6 refuses an absent run without inventing one", function* () {
    const root = yield* useStorageRoot();
    const target = join(root, "absent.xmd");

    const refused = yield* withExportHost(root, honestSource, function* () {
      return yield* exportRun("no-such-run", target);
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error.name).toBe("WorkflowRunNotFoundError");
    expect(yield* exists(target)).toBe(false);
  });
});
