/**
 * #290 criterion 6 — an exhausted planning loop.
 *
 * `Planning` declares `<Loop name="planning" max={5}>`, so exercising every
 * failing iteration costs twenty agent turns in one invocation. That does not
 * fit the fixed twenty-second `<Test>` timeout when each turn is an ACP round
 * trip, so the run happens here instead: the real `Planning` component, one
 * execution, one contextual working directory, and a synchronous stub root
 * Agent provider in place of the transport.
 *
 * Nothing about the document under test changes. The component resolves from
 * the workflow directory exactly as `xmd test` resolves it, including the
 * test-local `Agent.AddDir` stub, and the loop bound is the one the workflow
 * ships.
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
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import { execute, installAgentComponents, Agent } from "@executablemd/core";
import type {
  AgentPromptEvent,
  AgentProviderFactory,
  AgentProviderOptions,
  Json,
  PromptOptions,
  Session,
} from "@executablemd/core";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const WORKFLOW = path.resolve(HERE, "../../workflows/adversarial-implementation");
/** The same search path `xmd test` derives for a document in `tests/`. */
const COMPONENT_DIRS = [path.join(WORKFLOW, "tests"), WORKFLOW];

const MAX_ITERATIONS = 5;

/** Which prompt a turn is, read from the text the document actually sent. */
type Turn = "plan" | "verdict" | "assessment" | "revision" | "sentinel";

function classify(content: string): Turn {
  if (content.includes("Revise the implementation plan using this review:")) {
    return "revision";
  }
  if (content.includes("Investigate the registered checkout.")) {
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
}

function sessionName(options: PromptOptions | undefined): string {
  const session = options?.session;
  if (typeof session === "object" && session !== null && "sessionKey" in session) {
    return String((session as Session).sessionKey);
  }
  return typeof session === "string" ? session : "<none>";
}

/**
 * A verdict that fails validly, and an assessment that explicitly continues.
 * Neither is malformed: a repair loop and an exhausted planning loop are
 * different bounds, and this run exercises only the second.
 */
function reply(turn: Turn, round: number): string {
  switch (turn) {
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

function stubProvider(calls: Call[]): AgentProviderFactory {
  const rounds = new Map<Turn, number>();
  return function* (options) {
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *agent([name]) {
          return name ?? options.defaultAgent;
        },
        // deno-lint-ignore require-yield
        *session([name]) {
          return { sessionKey: `${name ?? "default"}`, cwd: "/" };
        },
        // deno-lint-ignore require-yield
        *prompt([content, promptOptions]) {
          const turn = classify(content);
          const round = (rounds.get(turn) ?? 0) + 1;
          rounds.set(turn, round);
          calls.push({ turn, session: sessionName(promptOptions), content });
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
  worktree="."
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

function* runPlanning(): Operation<{ value: Json; calls: Call[] }> {
  const calls: Call[] = [];
  const dir = path.join(os.tmpdir(), `xmd-290-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    const options: AgentProviderOptions = { defaultAgent: "stub", permissionMode: "deny-all" };
    yield* installAgentComponents({ rootProvider: { factory: stubProvider(calls), options } });

    const root = path.join(dir, "exhaustion-root.md");
    yield* writeTextFile(root, ROOT);
    const execution = yield* execute({
      path: root,
      stream: new InMemoryStream(),
      componentDirs: COMPONENT_DIRS,
    });
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    if (!result.ok) {
      throw result.error;
    }
    return { value: result.value, calls };
  });
}

describe("#290 criterion 6 — an exhausted planning loop", () => {
  it("runs five failing iterations and returns the exhausted pair without authorizing anything", function* () {
    const { value, calls } = yield* runPlanning();
    const returned = value as Record<string, Json>;

    // Exactly twenty calls: no sixth iteration, and the sentinel never ran.
    expect(calls).toHaveLength(MAX_ITERATIONS * 4);
    expect(calls.filter((call) => call.turn === "sentinel")).toHaveLength(0);

    // Five of each turn, in the order the document writes them.
    const expected = Array.from({ length: MAX_ITERATIONS }).flatMap(() => [
      "plan",
      "verdict",
      "assessment",
      "revision",
    ]);
    expect(calls.map((call) => call.turn)).toEqual(expected);

    // Each turn reaches the session the document routes it to, and the
    // revision goes back to the implementor's own conversation.
    const sessions = new Map(calls.map((call) => [call.turn, call.session]));
    expect(sessions.get("plan")).toBe("implementor");
    expect(sessions.get("revision")).toBe("implementor");
    expect(sessions.get("verdict")).toBe("planner");
    expect(sessions.get("assessment")).toBe("user-checkpoint");

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
