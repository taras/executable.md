/**
 * #290 criterion 6 — an exhausted planning loop.
 *
 * `Planning` declares `<Loop name="planning" max={5}>`, so exercising every
 * failing iteration costs twenty agent turns in one invocation. A `<Test>` can
 * declare its own timeout (#503) and twenty seconds is only the default, so the
 * bound is not what decides this. What decides it is the evidence: the run
 * happens here because the stub root Agent provider makes the complete
 * twenty-call trace and the authorization boundary directly observable, and
 * finishes in well under a second. A long ACP scenario would take longer to
 * prove less. So: the real `Planning` component, one execution, one contextual
 * working directory, and a synchronous stub root Agent provider in place of the
 * transport.
 *
 * Nothing about the document under test changes. The component resolves from
 * the workflow directory exactly as `xmd test` resolves it, including the
 * loop bound is the one the workflow ships. No stub stands in for a directory
 * component, because #302 gives a workflow Agent none.
 *
 * What `start.md` does with the returned pair — placing `<Implementation>`
 * behind the same gate and reporting exhaustion as awaiting direction inside
 * `<Dir>` and the root `<Output>` — stays the composition probe's evidence.
 * This test proves the pair, the turns that produce it, and that a later effect
 * written behind that gate does not run.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation, Stream } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { API, useHostFiles } from "@executablemd/runtime";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import {
  agentIdentityComponents,
  Agent,
  installAgentComponents,
  isJsonObject,
} from "@executablemd/core";
// `executeInstalled` is the host boundary: declaring `<Session>` to an
// execution is a host's job, which is exactly the seam this test stands in for.
import { executeInstalled } from "@executablemd/core/host";
import type {
  AgentPromptEvent,
  AgentProviderFactory,
  AgentProviderOptions,
  JsonObject,
  PromptOptions,
  Session,
} from "@executablemd/core";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const WORKFLOW = path.resolve(HERE, "../../workflows/adversarial-implementation");
/** The same search path `xmd test` derives for a document in `tests/`. */
const COMPONENT_DIRS = [path.join(WORKFLOW, "tests"), WORKFLOW];

const MAX_ITERATIONS = 5;

/** Which prompt a turn is, read from the text the document actually sent. */
type Turn = "discovery" | "plan" | "verdict" | "assessment" | "revision" | "sentinel";

function classify(content: string): Turn {
  if (content.includes("Revise the implementation plan using this review:")) {
    return "revision";
  }
  if (content.includes("Produce a user-validated design handoff")) {
    return "discovery";
  }
  if (content.includes("amend the implementation theory against that material")) {
    return "plan";
  }
  if (content.includes("Review the plan against the handoff")) {
    return "verdict";
  }
  if (content.includes("Determine whether the user must be involved to")) {
    return "assessment";
  }
  return "sentinel";
}

interface Call {
  readonly turn: Turn;
  readonly session: string;
  readonly content: string;
  /** Everything the prompt carried besides its text. */
  readonly options: Readonly<Record<string, unknown>>;
  readonly agent: string;
}

/** The complete Agent-facing trace: what the factory, selections and prompts saw. */
interface Trace {
  readonly calls: Call[];
  readonly factoryOptions: Record<string, unknown>[];
  readonly agentSelections: (string | undefined)[];
  readonly sessionSelections: (string | undefined)[];
}

/** Every string an Agent could have observed, flattened for boundary checks. */
function agentFacingStrings(trace: Trace): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      out.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        walk(v);
      }
    }
  };
  for (const call of trace.calls) {
    out.push(call.content, call.session, call.agent);
    walk(call.options);
  }
  trace.factoryOptions.forEach(walk);
  trace.agentSelections.forEach((v) => v !== undefined && out.push(v));
  trace.sessionSelections.forEach((v) => v !== undefined && out.push(v));
  return out;
}

/** `PromptOptions.session` is `string | Session`; the union narrows on its own. */
function sessionName(options: PromptOptions | undefined): string {
  const session = options?.session;
  if (session === undefined) {
    return "<none>";
  }
  return typeof session === "string" ? session : session.sessionKey;
}

/**
 * A verdict that fails validly, and an assessment that explicitly continues.
 * Neither is malformed: a repair loop and an exhausted planning loop are
 * different bounds, and this run exercises only the second.
 */
function reply(turn: Turn, round: number): string {
  switch (turn) {
    case "discovery":
      return `HANDOFF-ROUND-${round} the route is /health.`;
    case "plan":
      return `PLAN-ROUND-${round}`;
    case "verdict":
      return JSON.stringify({
        passed: false,
        review: `REVIEW-FAIL-${round}`,
        revisionPrompt: `REVISE-${round}`,
      });
    case "assessment":
      return JSON.stringify({
        requiresUser: false,
        assessment: `ASSESSED-${round}`,
        question: "",
        options: [],
        recommendation: "Continue.",
      });
    case "revision":
      return `ACKNOWLEDGED-${round}`;
    case "sentinel":
      return "SENTINEL-RAN";
  }
}

function stubProvider(trace: Trace): AgentProviderFactory {
  const rounds = new Map<Turn, number>();
  return function* (options) {
    trace.factoryOptions.push({ ...options });
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *agent([name]) {
          trace.agentSelections.push(name);
          return name ?? options.defaultAgent;
        },
        // deno-lint-ignore require-yield
        *session([request]) {
          // #549 widened this to a request whose `name` is descriptive; a
          // string is still what a document authored, so both shapes are read
          // for the one thing this trace asserts about.
          const name = typeof request === "string" ? request : request?.name;
          trace.sessionSelections.push(name);
          return { sessionKey: `${name ?? "default"}`, cwd: "/" };
        },
        // deno-lint-ignore require-yield
        *prompt([content, promptOptions]) {
          const turn = classify(content);
          const round = (rounds.get(turn) ?? 0) + 1;
          rounds.set(turn, round);
          trace.calls.push({
            turn,
            session: sessionName(promptOptions),
            content,
            options: { ...(promptOptions ?? {}) },
            agent: String(promptOptions?.agent ?? options.defaultAgent),
          });
          return stream(reply(turn, round), promptOptions);
        },
      },
      { at: "min" },
    );
  };
}

function stream(text: string, options: PromptOptions | undefined): Stream<AgentPromptEvent, string> {
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

/**
 * The root invokes the real `Planning`, writes `start.md`'s own gate, and puts
 * a later effect behind it. A gate that admitted an exhausted plan would send
 * that prompt, and the recorder would see a twenty-first call.
 */
const ROOT = `---
returns:
  proceed: { type: boolean }
  verdictPassed: { type: boolean }
  plan: { type: string }
  review: { type: string }
  revisionPrompt: { type: string }
---

<Planning
  handoff="HANDOFF the route is /health."
  handoffCheckpoint={{proceed: true, assessment: "HANDOFF-ASSESSED", response: "approved", rationale: "clear"}}
  instructions="INSTRUCTIONS"
  planner="planner"
  implementor="implementor"
  as="planning"
/>

<If condition={planning.decision.proceed && planning.verdictPassed}>
  <Prompt agent="sentinel" text="A later durable effect behind the production gate." />
</If>

<Return value={{
  proceed: planning.decision.proceed,
  verdictPassed: planning.verdictPassed,
  plan: planning.plan,
  review: planning.review,
  revisionPrompt: planning.revisionPrompt
}} />
`;

function* runPlanning(): Operation<{ value: JsonObject; calls: Call[]; trace: Trace }> {
  const trace: Trace = { calls: [], factoryOptions: [], agentSelections: [], sessionSelections: [] };
  const calls = trace.calls;
  const dir = path.join(os.tmpdir(), `xmd-290-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    const options: AgentProviderOptions = { defaultAgent: "stub", permissionMode: "deny-all" };
    yield* installAgentComponents({ rootProvider: { factory: stubProvider(trace), options } });

    const root = path.join(dir, "exhaustion-root.md");
    yield* writeTextFile(root, ROOT);
    const execution = yield* executeInstalled({
      path: root,
      stream: new InMemoryStream(),
      componentDirs: COMPONENT_DIRS,
    }, [{ components: agentIdentityComponents() }]);
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    if (!result.ok) {
      throw result.error;
    }
    if (!isJsonObject(result.value)) {
      throw new Error(`the root returned ${JSON.stringify(result.value)}, not an object`);
    }
    return { value: result.value, calls, trace };
  });
}

describe("#290 criterion 6 — an exhausted planning loop", () => {
  it("runs five failing iterations and returns the exhausted pair without authorizing anything", function* () {
    const { value: returned, calls } = yield* runPlanning();

    // Exactly twenty calls: no sixth iteration, and the sentinel never ran.
    expect(calls).toHaveLength(MAX_ITERATIONS * 4);
    expect(calls.filter((call) => call.turn === "sentinel")).toHaveLength(0);

    // Every turn, in order, with the session it was routed to. Comparing the
    // whole twenty-entry sequence is what catches a single mis-routed round:
    // collapsing to one entry per kind would let any round but the last be
    // wrong and still match.
    const expected = Array.from({ length: MAX_ITERATIONS }).flatMap(() => [
      "plan:implementor",
      "verdict:planner",
      "assessment:user-checkpoint",
      "revision:implementor",
    ]);
    expect(calls.map((call) => `${call.turn}:${call.session}`)).toEqual(expected);

    // The outcome is uniquely exhausted. Convergence would be true/true and a
    // decline would be false; nothing else produces this pair.
    expect(returned["proceed"]).toBe(true);
    expect(returned["verdictPassed"]).toBe(false);

    // What the stage returns is round five's, not an earlier round's.
    expect(returned["plan"]).toContain(`PLAN-ROUND-${MAX_ITERATIONS}`);
    expect(returned["review"]).toBe(`REVIEW-FAIL-${MAX_ITERATIONS}`);
    expect(returned["revisionPrompt"]).toBe(`REVISE-${MAX_ITERATIONS}`);
  });

  it("carries each round's verdict into that round's revision prompt", function* () {
    const { calls } = yield* runPlanning();
    const revisions = calls.filter((call) => call.turn === "revision");
    expect(revisions).toHaveLength(MAX_ITERATIONS);
    revisions.forEach((revision, index) => {
      const round = index + 1;
      expect(revision.content).toContain(`REVIEW-FAIL-${round}`);
      expect(revision.content).toContain(`REVISE-${round}`);
      expect(revision.content).toContain(`ASSESSED-${round}`);
    });
  });
});

/**
 * The #302 boundary, proved over the same public root-provider seam.
 *
 * A root writes real instruction files, captures them with `InstructionFiles`,
 * and passes that captured text into `Discovery` and `Planning`. What an Agent
 * sees is then the whole question: the instruction paths and contents must
 * arrive, and the absolute directory they were read from must not — nor any
 * Workspace value, checkout path, directory registration or
 * `additionalDirectories` field.
 */
const BOUNDARY_ROOT = `---
returns:
  handoff: { type: string }
  plan: { type: string }
---

<InstructionFiles paths={["AGENTS.md", "nested/AGENTS.md"]} as="instructions" />

<Discovery
  instructions={instructions}
  planner="planner"
  request="Add a health endpoint"
  as="handoff"
/>

<Planning
  handoff={handoff}
  handoffCheckpoint={{proceed: true, assessment: "HANDOFF-ASSESSED", response: "approved", rationale: "clear"}}
  instructions={instructions}
  planner="planner"
  implementor="implementor"
  as="planning"
/>

<Return value={{ handoff: handoff, plan: planning.plan }} />
`;

const ROOT_INSTRUCTION = "ROOT-INSTRUCTION prefer evidence over assertion.";
const NESTED_INSTRUCTION = "NESTED-INSTRUCTION never edit a test to make it pass.";

function* runBoundary(
  inject?: (dir: string) => string,
): Operation<{ trace: Trace; dir: string }> {
  const trace: Trace = { calls: [], factoryOptions: [], agentSelections: [], sessionSelections: [] };
  const dir = path.join(os.tmpdir(), `xmd-302-${randomUUID()}`);
  yield* ensureDir(path.join(dir, "nested"));
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    // The instructions are read relative to the contextual working directory,
    // exactly as a workflow run's `<Dir>` would establish it — so the document
    // names repository-relative paths and never an absolute one.
    yield* API.Env.around({ *cwd() { return dir; } }, { at: "min" });
    yield* useHostFiles();
    yield* writeTextFile(path.join(dir, "AGENTS.md"), `${ROOT_INSTRUCTION}\n`);
    yield* writeTextFile(path.join(dir, "nested", "AGENTS.md"), `${NESTED_INSTRUCTION}\n`);

    const options: AgentProviderOptions = {
      // A mutation point: a host that leaked its work directory here would put
      // an absolute path in front of every Agent.
      defaultAgent: inject ? inject(dir) : "stub",
      permissionMode: "deny-all",
    };
    yield* installAgentComponents({ rootProvider: { factory: stubProvider(trace), options } });

    const root = path.join(dir, "boundary-root.md");
    yield* writeTextFile(root, BOUNDARY_ROOT);
    const execution = yield* executeInstalled({
      path: root,
      stream: new InMemoryStream(),
      componentDirs: COMPONENT_DIRS,
    }, [{ components: agentIdentityComponents() }]);
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    if (!result.ok) {
      throw result.error;
    }
    return { trace, dir };
  });
}

describe("#302 — an Agent reasons only over what a prompt renders", () => {
  it("carries instruction paths and contents to Discovery and both Planning prompts", function* () {
    const { trace } = yield* runBoundary();
    const seen = (turn: Turn) => trace.calls.filter((call) => call.turn === turn);

    // Discovery, the plan prompt and the verdict prompt each receive both
    // repository-relative paths and both file contents, verbatim.
    for (const turn of ["discovery", "plan", "verdict"] as Turn[]) {
      const calls = seen(turn);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.content).toContain("AGENTS.md");
        expect(call.content).toContain("nested/AGENTS.md");
        expect(call.content).toContain(ROOT_INSTRUCTION);
        expect(call.content).toContain(NESTED_INSTRUCTION);
      }
    }
  });

  it("lets no absolute directory, Workspace value or directory registration reach an Agent", function* () {
    const { trace, dir } = yield* runBoundary();
    const facing = agentFacingStrings(trace);

    // The execution's own directory is where the instructions were read from.
    // It must not appear anywhere an Agent could observe.
    for (const value of facing) {
      expect(value).not.toContain(dir);
      expect(value).not.toContain(os.tmpdir());
    }

    // Nor any directory-registration surface, by name or by field.
    const joined = facing.join("\n");
    for (const forbidden of [
      "additionalDirectories",
      "AddDir",
      "addDir",
      "workspaceRoot",
      "checkout",
      "materializ",
    ]) {
      expect(joined).not.toContain(forbidden);
    }

    // Prompt options carry only what agent selection needs.
    for (const call of trace.calls) {
      expect(Object.keys(call.options).sort()).toEqual(["agent", "session"]);
    }

    // The repository-relative paths appear only inside the rendered
    // instruction material, never as a standalone Agent-facing input.
    const standalone = facing.filter((value) => value === "AGENTS.md" || value === "nested/AGENTS.md");
    expect(standalone).toHaveLength(0);
  });

  it("trips the boundary guard when the execution's absolute directory is injected", function* () {
    const { trace, dir } = yield* runBoundary((workDir) => `stub-${workDir}`);

    // Apply the guard the clean case relies on, and prove it fails here. If it
    // did not, the assertion above would be checking nothing.
    const leaked = agentFacingStrings(trace).filter((value) => value.includes(dir));
    expect(leaked.length).toBeGreaterThan(0);
    expect(() => {
      for (const value of agentFacingStrings(trace)) {
        if (value.includes(dir)) {
          throw new Error("absolute execution directory reached an Agent-facing input");
        }
      }
    }).toThrow("absolute execution directory reached an Agent-facing input");
  });
});
