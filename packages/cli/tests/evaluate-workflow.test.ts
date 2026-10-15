/**
 * Tier FE — `<Evaluate>` under the workflow host's own profile.
 *
 * Deno-only, and for the ordinary reason: this drives a real workflow run
 * database, which opens `node:sqlite` — unflagged under Deno, behind
 * `--experimental-sqlite` on Node 22, and absent from Bun. The exclusion is
 * recorded in `scripts/runtime-test-exclusions.ts` against issue #713.
 *
 * What only this tier can show is that the two hosts differ in their *profile*
 * and in nothing else. The component, the evaluator and the durable protocol
 * are the same ones the ordinary run uses; what the workflow adds is a
 * Workspace-bound ceiling and a basis that advances with the run. Every host
 * accepts the canonical `text` input and refuses `source` and `program`.
 *
 * It runs against the real attachment rather than the `xmd workflow` command
 * line, whose start/resume behavior is exercised separately by Tier WAL.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, useScope } from "effection";
import type { Operation } from "effection";
import { collect, inlineSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import {
  useWorkflowGenerated,
  withWorkflowWorkspace,
  workflowGeneratedSelection,
} from "@executablemd/workflow/deno";
import { gitDirectorySelection } from "@executablemd/git";
import { createRun, useStorageRoot, withStorage } from "./support/workflow-run.ts";

/**
 * Run one document with this run's Workspace attached.
 *
 * The contextual working directory is pinned somewhere the run may not reach
 * and a host Files provider is installed outside the attachment, so a read that
 * fell through to the caller's filesystem would fail rather than quietly
 * succeed.
 */
function runDocument(
  database: WorkflowRunDatabase,
  source: string,
): Operation<{ output?: Json; failure?: string }> {
  return scoped(function* () {
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return "/nowhere-the-workflow-may-reach";
        },
      },
      { at: "min" },
    );
    yield* useHostFiles();
    try {
      const output = yield* withWorkflowWorkspace(
        database,
        scoped(function* () {
          // The bundled XMD workflow selection: Git supplies `<Dir>`. Offered
          // inside the attachment, in the scope that executes the document.
          yield* useWorkflowGenerated({ components: gitDirectorySelection() });
          return yield* collect(
            yield* executeInstalled({ ...inlineSource(source), stream: database.journal }, []),
          );
        }),
      );
      return { output };
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error) };
    }
  });
}

const NOTE = "the retained note";

describe("Tier FE — the workflow host's profile", () => {
  it("FE22: `<Dir>` is the host's choice, and Git is what supplies it", function* () {
    // `<Dir>` belongs to `@executablemd/git`. Workflow offers the name not at
    // all now, so a generic Workflow host composing this selection has no
    // directory spelling — and the XMD workflow run has one because Git hands
    // it over, not because Workflow kept a copy.
    const generic = workflowGeneratedSelection();
    // Non-empty, so "no Dir" is an absence among selected names rather than an
    // empty selection that would satisfy the claim by containing nothing.
    expect(Object.keys(generic).length > 0).toBe(true);
    expect(Object.keys(generic)).not.toContain("Dir");
    // Nor any network read: `<Fetch>` joins the selection only where this host
    // bounds what a request may reach.
    expect(Object.keys(generic)).not.toContain("Fetch");

    const bundled = workflowGeneratedSelection({ components: gitDirectorySelection() });
    expect(Object.keys(bundled).toSorted()).toEqual(["Dir", "File", "File.Delete"]);
    expect(bundled.Dir).toEqual(["paired"]);
    yield* useScope();
  });

  it("FE23: Git offers core's own Dir by name and form, and states no identity", function* () {
    // What this host decides is that a workflow run has a `<Dir>` at all. What
    // offering it grants is core's: the identity and the effect its paired
    // spelling runs under are on the declaration that owns the component, so
    // there is nothing here for a host to restate or to move.
    const selection = gitDirectorySelection();
    expect(Object.keys(selection)).toEqual(["Dir"]);
    expect(selection.Dir).toEqual(["paired"]);
    yield* useScope();
  });

  it("FE19: canonical `text` repeats across fresh runs without warnings", function* () {
    let reads = 0;
    yield* API.Files.around({
      *readTextFile(args, next) {
        reads++;
        return yield* next(...args);
      },
    });
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const first = yield* createRun();
      const initial = yield* runDocument(
        first,
        `<File path="notes.md">${NOTE}</File>\n\n` +
          `<Evaluate text={'<File path="notes.md" />\\n'} as="answer" />\n\n` +
          `<Json value={answer} />\n`,
      );

      expect(initial.failure).toBe(undefined);
      const initialText = String(initial.output);
      expect(initialText).toContain(NOTE);
      // Silently: no deprecation sentence anywhere in the run's output.
      expect(initialText).not.toContain("earlier spelling");
      expect(initialText).not.toContain("deprecated");

      const canonical = yield* createRun({ runId: "canonical" });
      const direct = yield* runDocument(
        canonical,
        `<File path="notes.md">${NOTE}</File>\n\n` +
          `<Evaluate text={'<File path="notes.md" />\\n'} as="answer" />\n\n` +
          `<Json value={answer} />\n`,
      );

      expect(direct.failure).toBe(undefined);
      expect(String(direct.output)).toBe(initialText);
      expect(reads).toBe(2);
    });
  });

  for (const prop of ["source", "program"]) {
    it(`FE19: obsolete \`${prop}\` refuses before fragment effects`, function* () {
      let reads = 0;
      yield* API.Files.around({
        *readTextFile(args, next) {
          reads++;
          return yield* next(...args);
        },
      });
      const root = yield* useStorageRoot();
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        const attempt = yield* runDocument(
          database,
          `<File path="notes.md">${NOTE}</File>\n\n` +
            `<Evaluate ${prop}={'<File path="notes.md" />\\n'} />\n`,
        );

        expect(attempt.failure).not.toBe(undefined);
        expect(String(attempt.failure)).toMatch(new RegExp(`${prop}|additional`, "i"));
        expect(reads).toBe(0);
      });
    });
  }

  it("FE21: the workflow fragment reaches the run's Workspace, not the caller's disk", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // The contextual working directory is `/nowhere-the-workflow-may-reach`
      // and a host Files provider is installed outside the attachment. A read
      // that fell through to either would fail rather than find this file.
      const attempt = yield* runDocument(
        database,
        `<File path="notes.md">${NOTE}</File>\n\n` +
          `<Evaluate text={'<File path="notes.md" />\\n'} as="answer" />\n\n` +
          `<Json value={answer} />\n`,
      );

      expect(attempt.failure).toBe(undefined);
      expect(String(attempt.output)).toContain(NOTE);
    });
  });

  it("FE20: a request outside the stated ceiling is refused, and none is admitted by default", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // The production profile states no requests, so `<Fetch>` is not on the
      // allowlist at all — a different thing from admitting it and refusing
      // every request.
      const attempt = yield* runDocument(
        database,
        `<Evaluate text={'<Fetch url="https://api.example.test/one" />\\n'} />\n`,
      );

      expect(attempt.failure).not.toBe(undefined);
      expect(String(attempt.failure)).toContain("did not admit");
    });
  });
});
