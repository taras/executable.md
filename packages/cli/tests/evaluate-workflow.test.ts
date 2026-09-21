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
 * Workspace-bound ceiling, a basis that advances with the run, and the released
 * `source` spelling — which the ordinary profile refuses and this one accepts
 * without comment.
 *
 * It runs against the real attachment rather than the `xmd workflow` command
 * line: a run started from the command boundary needs a git repository with a
 * committed definition, and a row that silently degraded when that was
 * unavailable would assert nothing. The command boundary itself is Tier WAL's.
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

  it("FE23: Git's directory entry is the exact identity retained history holds", function* () {
    // Written out here rather than compared against the implementation, so a
    // change to either side is a change to this row. Every released journal
    // holds these strings: the origin a released build recorded, the revision
    // it recorded, and the version-1 alias whose grant this entry answers for.
    const entry = gitDirectoryEntry();
    expect(entry.name).toBe("Dir");
    expect(entry.identity).toEqual({
      origin: "@executablemd/workflow/composition",
      key: "Dir",
      revision: "3",
    });
    expect(Reflect.get(entry, "legacy")).toEqual(["@executablemd/workflow/composition/dir-v2#Dir"]);
    // It is the directory capability, not some other entry wearing the name.
    expect(Reflect.get(entry, "capability")).toBe("directory:ensure");
  });

  it("FE19: `source` and `text` behave identically here, and neither warns", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const aliased = yield* createRun();
      const alias = yield* runDocument(
        aliased,
        `<File path="notes.md">${NOTE}</File>\n\n` +
          `<Evaluate source={'<File path="notes.md" />\\n'} as="answer" />\n\n` +
          `<Json value={answer} />\n`,
      );

      expect(alias.failure).toBe(undefined);
      const aliasText = String(alias.output);
      expect(aliasText).toContain(NOTE);
      // Silently: no deprecation sentence anywhere in the run's output.
      expect(aliasText).not.toContain("earlier spelling");
      expect(aliasText).not.toContain("deprecated");

      const canonical = yield* createRun({ runId: "canonical" });
      const direct = yield* runDocument(
        canonical,
        `<File path="notes.md">${NOTE}</File>\n\n` +
          `<Evaluate text={'<File path="notes.md" />\\n'} as="answer" />\n\n` +
          `<Json value={answer} />\n`,
      );

      expect(direct.failure).toBe(undefined);
      // Identical behavior: the two spellings state the same argument.
      expect(String(direct.output)).toBe(aliasText);
    });
  });

  it("FE19: `program` is a spelling no profile has", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const attempt = yield* runDocument(
        database,
        `<Evaluate program={'<File path="notes.md" />\\n'} />\n`,
      );

      expect(attempt.failure).not.toBe(undefined);
      expect(String(attempt.failure)).toMatch(/program|additional/i);
    });
  });

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
