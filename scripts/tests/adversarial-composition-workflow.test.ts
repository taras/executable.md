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
  Agent,
  agentIdentityComponents,
  collect,
  installAgentComponents,
  retainedSource,
} from "@executablemd/core";
import type {
  AgentPromptEvent,
  AgentProviderFactory,
  PromptOptions,
  Session,
} from "@executablemd/core";
import type { Stream } from "effection";
import { executeInstalled } from "@executablemd/core/host";
import type { WorkflowBundleComponent } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import { evaluationComponents, withWorkflowWorkspace } from "@executablemd/workflow/deno";
import { retainedWorkflowInstallation } from "../../packages/workflow/src/run.ts";
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


/** What one Agent turn was asked, and everything the request carried. */
interface Call {
  readonly agent: string | undefined;
  readonly session: string | undefined;
  readonly content: string;
  readonly options: Readonly<Record<string, unknown>>;
}

interface Trace {
  readonly calls: Call[];
  readonly factoryOptions: Record<string, unknown>[];
}

/** Which authored prompt this is, keyed on text only that prompt writes. */
type Turn =
  | "discovery"
  | "checkpoint"
  | "plan"
  | "planVerdict"
  | "observation"
  | "implementationVerdict"
  | "repair"
  | "unknown";

function classify(content: string): Turn {
  // Every marker below is text the prompt itself renders, not prose around it:
  // a marker taken from a document's explanation matches nothing at run time.
  if (content.includes("Determine whether the user must be involved to")) return "checkpoint";
  if (content.includes("Correct your previous response without changing its meaning")) {
    return "repair";
  }
  if (content.includes("Produce a user-validated design handoff")) return "discovery";
  if (content.includes("Confirm,\n        refute, or amend the implementation theory")) {
    return "plan";
  }
  if (content.includes("You cannot open this repository")) return "observation";
  if (content.includes("Reviews already on it:")) return "implementationVerdict";
  if (content.includes("Implementation plan:")) return "planVerdict";
  return "unknown";
}

/** Every string an Agent-facing value can hide in, flattened. */
function agentFacing(trace: Trace): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      out.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value !== null && typeof value === "object") {
      for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
        out.push(key);
        walk(member);
      }
    }
  };
  for (const call of trace.calls) {
    out.push(call.agent ?? "", call.session ?? "", call.content);
    walk(call.options);
  }
  trace.factoryOptions.forEach(walk);
  return out;
}


/** The scripted replies one accepted run needs, keyed by turn. */
interface Script {
  /** Assessments answer in order; a checkpoint consumes one per invocation. */
  readonly checkpoints: readonly Record<string, unknown>[];
  readonly planVerdict: Record<string, unknown>;
  readonly implementationVerdict: Record<string, unknown>;
  readonly proposal: Record<string, unknown>;
  /** Observation envelopes returned before the proposal envelope. */
  readonly observations: readonly string[];
}

/**
 * A root Agent provider that answers the authored prompts and records
 * everything it was handed.
 *
 * This is the public seam `installAgentComponents({ rootProvider })` offers, so
 * what it records is the complete Agent-facing surface: the factory's own
 * options, the agent and session selections, each prompt's text, and each
 * prompt's options.
 */
function scriptedProvider(trace: Trace, script: Script): AgentProviderFactory {
  let checkpoint = 0;
  let observation = 0;
  return function* (options) {
    trace.factoryOptions.push({ ...options });
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *agent([name]) {
          return name ?? options.defaultAgent;
        },
        // deno-lint-ignore require-yield
        *session([request]) {
          const name = typeof request === "string" ? request : request?.name;
          return { sessionKey: `${name ?? "default"}`, cwd: "/" };
        },
        // deno-lint-ignore require-yield
        *prompt([content, promptOptions]) {
          const session = typeof promptOptions?.session === "object"
            ? promptOptions.session.sessionKey
            : typeof promptOptions?.session === "string"
            ? promptOptions.session
            : undefined;
          trace.calls.push({
            agent: String(promptOptions?.agent ?? options.defaultAgent),
            session,
            content,
            options: { ...(promptOptions ?? {}) },
          });
          let reply: string;
          switch (classify(content)) {
            case "discovery":
              reply = "HANDOFF\n\nPurpose: add a health endpoint.\n";
              break;
            case "checkpoint": {
              const scripted =
                script.checkpoints[Math.min(checkpoint, script.checkpoints.length - 1)];
              checkpoint += 1;
              reply = JSON.stringify(scripted);
              break;
            }
            case "plan":
              reply = "PLAN-V1: add the /health route behind the existing router mount.";
              break;
            case "planVerdict":
              reply = JSON.stringify(script.planVerdict);
              break;
            case "observation": {
              if (observation < script.observations.length) {
                const source = script.observations[observation]!;
                observation += 1;
                reply = JSON.stringify({ kind: "observation", source });
              } else {
                reply = JSON.stringify({
                  kind: "proposal",
                  source: JSON.stringify(script.proposal),
                });
              }
              break;
            }
            case "implementationVerdict":
              reply = JSON.stringify(script.implementationVerdict);
              break;
            default:
              throw new Error(
                `unscripted turn: len=${content.length} opts=${
                  JSON.stringify(promptOptions ?? {}).slice(0, 200)
                } text=${JSON.stringify(content.slice(0, 200))}`,
              );
          }
          return stream(reply, promptOptions);
        },
      },
      { at: "min" },
    );
  };
}

function stream(
  text: string,
  options: PromptOptions | undefined,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      const session: Session = typeof options?.session === "object"
        ? options.session
        : { sessionKey: "default", cwd: "/" };
      const events: AgentPromptEvent[] = [
        { type: "started", agent: options?.agent ?? "stub", session },
        { type: "text_delta", text },
        { type: "terminal", status: "completed" },
      ];
      let index = 0;
      return {
        // deno-lint-ignore require-yield
        *next() {
          if (index < events.length) {
            return { done: false, value: events[index++]! };
          }
          return { done: true, value: text };
        },
      };
    },
  };
}

/** A checkpoint that needs no person: the authored `<Else>` continue record. */
function continues(assessment: string): Record<string, unknown> {
  return {
    requiresUser: false,
    assessment,
    question: "",
    options: [],
    recommendation: "",
  };
}


interface Attempt {
  readonly output: Json | undefined;
  readonly failure: string | undefined;
  readonly trace: Trace;
  readonly kinds: string[];
}

/** One composed run, from the shipping root, over a real retained WorkflowRun. */
function runComposition(script: Script): Operation<Attempt> {
  return scoped(function* () {
    const storage = yield* useStorageRoot();
    return yield* withStorage(storage, function* () {
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
      const trace: Trace = { calls: [], factoryOptions: [] };
      let output: Json | undefined;
      let failure: string | undefined;
      yield* scoped(function* () {
        yield* useHostFiles();
        yield* installAgentComponents({
          rootProvider: {
            factory: scriptedProvider(trace, script),
            options: { defaultAgent: "stub", permissionMode: "deny-all" },
          },
        });
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
                    retainedWorkflowInstallation({
                      runId: database.record.runId,
                      base: database.record.base,
                      pinnedCommit: database.record.definition.objectId,
                    }),
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
      const events = yield* database.journal.readAll();
      const kinds = events
        .filter((event) => event.type === "yield")
        .map((event) => event.description.type);
      return { output, failure, trace, kinds };
    });
  });
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
                    retainedWorkflowInstallation({
                      runId: database.record.runId,
                      base: database.record.base,
                      pinnedCommit: database.record.definition.objectId,
                    }),
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

  it("AC2: the composition drives all five stages to the first forge effect", function* () {
    const attempt = yield* runComposition({
      checkpoints: [continues("the handoff is clear")],
      planVerdict: { passed: true, review: "REVIEW-PASS", revisionPrompt: "" },
      implementationVerdict: {
        passed: true,
        review: "PR-REVIEW-PASS",
        revisionPrompt: "",
        findings: [],
      },
      proposal: {
        changes: '<File path="health.md">the health route</File>',
        title: "Add a health endpoint",
        commitMessage: "Add a health endpoint",
        report: "IMPLEMENTOR-REPORT",
      },
      observations: [],
    });
    const turns = attempt.trace.calls.map((call) => classify(call.content));

    // Every authored stage was reached, in authored order, through the real
    // bundle: discovery, the handoff checkpoint, the plan and its verdict, then
    // the implementor's observation/proposal envelope.
    // Authored order: discovery, the handoff checkpoint, the plan and its
    // verdict, Planning's own review checkpoint, start.md's authorization
    // checkpoint, then the implementor's first envelope.
    expect(turns).toEqual([
      "discovery",
      "checkpoint",
      "plan",
      "planVerdict",
      "checkpoint",
      "checkpoint",
      "observation",
    ]);

    // Each turn went to the session its document names.
    const sessions = attempt.trace.calls.map((call) => call.session);
    expect(sessions).toEqual([
      "planner",
      "user-checkpoint",
      "implementor",
      "planner",
      "user-checkpoint",
      "user-checkpoint",
      "implementor",
    ]);

    // The approved proposal was admitted and performed before any forge effect:
    // the generated fragment is retained, and the Workspace write landed.
    expect(attempt.kinds).toContain("generated_xmd");
    expect(attempt.kinds).toContain("workspace_file");

    // And the run stops at the first Git-host effect, which is the seam the
    // remaining scenarios supply. Nothing past it was reached.
    expect(attempt.failure).toContain("the selected Git host does not support this effect kind");

    // The Agent-facing surface carries no directory or tool authority (#302).
    const surface = agentFacing(attempt.trace).join("\n");
    for (const forbidden of [
      "additionalDirectories",
      "mcpServers",
      "workspaceRoot",
      "checkout",
      "credential",
    ]) {
      expect(surface).not.toContain(forbidden);
    }
  });
});
