/**
 * Tier AC — the adversarial workflow composed, under a real workflow run.
 *
 * #290's suite proves the planning document's own logic. This proves the
 * composition: the real `workflows/adversarial-implementation/start.md`, the
 * real five bundled stages read from disk, the real `<Evaluate>` boundary, the
 * real retained Workspace — with only the leaf providers substituted, through
 * the public seams a host uses.
 *
 * Nothing here restates an authored document. The bundle is built from the
 * files themselves, so a stage this suite drives is the stage that ships.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { readTextFile } from "@effectionx/fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentIdentityComponents,
  collect,
  installAgentComponents,
  retainedSource,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { WorkflowBundleComponent } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import { evaluationComponents, withWorkflowWorkspace } from "@executablemd/workflow/deno";
import { createRun, useStorageRoot, withStorage } from "../../packages/cli/tests/support/workflow-run.ts";
import { useBareRemote } from "../../packages/workflow/tests/support/git-remotes.ts";

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "workflows",
  "adversarial-implementation",
);

const ROOT_PATH = "workflows/adversarial-implementation/start.md";

/** The five authored stages, read from the files that ship. */
const STAGES = ["Discovery", "Implementation", "InstructionFiles", "Planning", "UserCheckpoint"];

function* bundle(): Operation<readonly WorkflowBundleComponent[]> {
  const components: WorkflowBundleComponent[] = [];
  for (const [index, name] of STAGES.entries()) {
    const content = yield* readTextFile(join(WORKFLOW, `${name}.md`));
    components.push({
      name,
      path: `workflows/adversarial-implementation/${name}.md`,
      sourceHash: `${index + 1}`.repeat(40),
      content,
    });
  }
  return components;
}

describe("Tier AC — the adversarial workflow, composed", () => {
  it("AC0: the real root and its five stages load as one bundle", function* () {
    const components = yield* bundle();
    expect(components.map((component) => component.name).sort()).toEqual([...STAGES].sort());
    for (const component of components) {
      expect(component.content.length).toBeGreaterThan(0);
    }
    const root = yield* readTextFile(join(WORKFLOW, "start.md"));
    expect(root).toContain('<Worktree');
    expect(root).toContain("<Dir path={worktree}>");
  });

  it("AC1: the composition runs from Repository to the first Agent turn", function* () {
    const storage = yield* useStorageRoot();
    yield* withStorage(storage, function* () {
      const remote = yield* useBareRemote({
        commits: [
          {
            branch: "main",
            message: "seed the project",
            entries: [
              { path: "AGENTS.md", content: "Root instructions: prefer evidence over assertion.\n" },
              { path: "README.md", content: "# project\n" },
            ],
          },
        ],
      });
      const database = yield* createRun({});
      const components = yield* bundle();
      const source = yield* readTextFile(join(WORKFLOW, "start.md"));
      let failure: string | undefined;
      let output: Json | undefined;
      yield* scoped(function* () {
        yield* useHostFiles();
        yield* installAgentComponents({ defaultAgent: "stub", permissionMode: "deny-all" });
        try {
          output = yield* withWorkflowWorkspace(
            database,
            scoped(function* () {
              return yield* collect(
                yield* executeInstalled(
                  {
                    ...retainedSource(ROOT_PATH, source),
                    stream: database.journal,
                    componentDirs: [],
                    props: {
                      request: "add a health endpoint",
                      repository: remote.locator,
                      tracker: "https://example.invalid/p/issues",
                    },
                  },
                  [
                    { bundle: { components } },
                    {
                      components: [
                        ...evaluationComponents(database, {}),
                        ...agentIdentityComponents(),
                      ],
                    },
                  ],
                ),
              );
            }),
            {},
          );
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      });
      // Everything before the first Agent turn is composition, and all of it
      // ran: the Repository cloned the local remote, the self-closing Worktree
      // bound its path, the lexical Dir established it, and Glob and
      // InstructionFiles produced the instruction material. The run stops at
      // the first `<Prompt>` because no root Agent provider is installed here —
      // which is the seam the scripted scenarios supply.
      expect(output).toBeUndefined();
      expect(failure).toContain("Agent.agent() has no provider");

      const events = yield* database.journal.readAll();
      const kinds = events
        .filter((event) => event.type === "yield")
        .map((event) => event.description.type);
      // The composition's own effects are retained before any Agent exists.
      expect(kinds).toContain("workspace_repository");
      expect(kinds).toContain("workspace_worktree");
      // And no Agent, mutation or forge effect was reached.
      for (const forbidden of ["prompt", "generated_xmd", "git_host"]) {
        expect(kinds).not.toContain(forbidden);
      }
    });
  });
});
