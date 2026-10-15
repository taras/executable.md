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
import { scoped } from "effection";
import type { Operation } from "effection";
import { collect, inlineSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { evaluationProfile, withWorkflowWorkspace } from "@executablemd/workflow/deno";
import { gitDirectoryEntry } from "@executablemd/git";
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
          return yield* collect(
            yield* executeInstalled({ ...inlineSource(source), stream: database.journal }, [
              // The bundled XMD workflow profile: Git supplies `<Dir>`.
              {
                evaluation: yield* evaluationProfile(database, {
                  directory: gitDirectoryEntry(),
                }),
              },
            ]),
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
  it("FE22: the directory capability is the host's, and Git is what supplies it", function* () {
    // `<Dir>` belongs to `@executablemd/git`. Workflow states no entry for it
    // at all now, so a generic Workflow host composing this profile has no
    // directory capability — and the XMD workflow profile has one because Git
    // hands it over, not because Workflow kept a copy.
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();

      const generic = yield* evaluationProfile(database);
      const names = (generic.write ?? []).map((entry) => entry.name);
      // Non-empty, so "no Dir" is an absence among entries rather than an
      // empty table that would satisfy the claim by containing nothing.
      expect(names.length > 0).toBe(true);
      expect(names).not.toContain("Dir");

      // And the position is the contract: a retained continuation compares
      // this table position by position, so the supplied entry sits exactly
      // between the file write and the file delete.
      const bundled = yield* evaluationProfile(database, { directory: gitDirectoryEntry() });
      expect((bundled.write ?? []).map((entry) => entry.name)).toEqual([
        "File",
        "Dir",
        "File.Delete",
      ]);
    });
  });

  it("FE23: Git's directory entry admits core's own Dir and states no identity", function* () {
    // What this host decides is that a workflow run has a `<Dir>` at all. What
    // admitting it grants is core's: the identity and the effect its paired
    // spelling runs under are on the declaration that owns the component, so
    // there is nothing here for a host to restate or to move.
    const entry = gitDirectoryEntry();
    expect(entry.name).toBe("Dir");
    expect(Object.keys(entry)).not.toContain("identity");
    expect(Object.keys(entry)).not.toContain("legacy");
    // It is the directory capability, not some other entry wearing the name.
    expect(Reflect.get(entry, "capability")).toBe("directory:ensure");
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
