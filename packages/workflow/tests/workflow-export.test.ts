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
import { WorkflowLifecycle } from "../mod.ts";
import { gitBlobId } from "./support/artifact-fixture.ts";
import {
  creation,
  definition,
  SHA1,
  useStorageRoot,
  withExecutorRun,
  withRunHost,
} from "./support/storage.ts";

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

function* exportRun(
  runId: string,
  stagingPath: string,
  source: XmdArtifactDefinitionClosure = closure(),
) {
  return yield* WorkflowLifecycle.operations.export({ runId, stagingPath, closure: source });
}

/** One settled run, and the storage root it lives in. */
function useSettledRun(runId = "release-1.4"): Operation<string> {
  return (function* () {
    const root = yield* useStorageRoot();
    yield* withRunHost(root, function* (transitions) {
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

    yield* withRunHost(root, function* (transitions) {
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

    const sealed = yield* withRunHost(root, function* () {
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
    const after = yield* withRunHost(root, function* () {
      return yield* WorkflowLifecycle.operations.inspect("release-1.4");
    });
    if (!after.ok) {
      throw after.error;
    }
    expect(after.value.record.status).toBe("completed");
  });

  it("XE3 refuses a closure that is not this run's definition", function* () {
    const root = yield* useSettledRun();
    const target = join(root, "wrong-source.xmd");
    const other = closure();

    const refused = yield* withRunHost(root, function* () {
      return yield* exportRun("release-1.4", target, {
        ...other,
        root: { ...other.root, rootDocumentPath: "workflows/other.md" },
      });
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error.name).toBe("WorkflowRequestError");
    expect(yield* exists(target)).toBe(false);
  });

  it("XE4 refuses an absent run without inventing one", function* () {
    const root = yield* useStorageRoot();
    const target = join(root, "absent.xmd");

    const refused = yield* withRunHost(root, function* () {
      return yield* exportRun("no-such-run", target);
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error.name).toBe("WorkflowRunNotFoundError");
    expect(yield* exists(target)).toBe(false);
  });
});
