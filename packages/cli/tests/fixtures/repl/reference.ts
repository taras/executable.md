/**
 * The reference entry, executed for real.
 *
 * Every REPL test that needs a Journal gets one from here rather than from a
 * recorded file, because the projector's whole claim is that it reads what the
 * *current* runtime writes. A frozen event array would keep passing on the day
 * core changed a record's shape, which is the day the claim stopped being true.
 *
 * The entry is one document deliberately holding one of each thing this slice
 * projects: a durable evaluation that publishes JSON, one nested component
 * occurrence whose source the run retains, one generated fragment admitted from
 * a value that evaluation published, and one validated question whose answer
 * changes what the document renders after it.
 */

import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { Agent, collect, Elicitation, installAgentComponents } from "@executablemd/core";
import type {
  AgentPromptEvent,
  AgentProviderFactory,
  ElicitationRequest,
  PermissionOption,
  PromptOptions,
  Session,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { inlineSource } from "@executablemd/core";
import type { Operation, Stream } from "effection";
import { scoped } from "effection";

import { ordinaryEvaluationProfile } from "../../../src/evaluation-profile.ts";

/** Where the entry and its nested component live. */
export const REFERENCE_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));

/** The exact entry text this slice's evidence submits. */
export function referenceSource(): Operation<string> {
  return readTextFile(fileURLToPath(new URL("./entry.md", import.meta.url)));
}

/** What one reference execution produced. */
export interface ReferenceRun {
  readonly output: string;
  readonly events: DurableEvent[];
  readonly asked: ElicitationRequest[];
  readonly failure: Error | undefined;
}

/**
 * Run the reference entry once, over `stream`.
 *
 * `answer` decides what the installed provider hands back, so a test can answer,
 * refuse, or count. Failures are captured rather than raised: how far a run got
 * is most of what the negative controls are about.
 */
export function runReference(
  answer: (request: ElicitationRequest) => Operation<unknown>,
  stream: InMemoryStream = new InMemoryStream(),
): Operation<ReferenceRun> {
  return scoped(function* () {
    const asked: ElicitationRequest[] = [];
    yield* Elicitation.around(
      {
        *elicit([request]) {
          asked.push(request);
          return yield* answer(request);
        },
      },
      { at: "min" },
    );
    const source = yield* referenceSource();
    try {
      const execution = yield* executeInstalled(
        { ...inlineSource(source), stream, includes: [REFERENCE_DIRECTORY] },
        [{ evaluation: ordinaryEvaluationProfile() }],
      );
      const output = yield* collect(execution);
      return { output: String(output), events: yield* stream.readAll(), asked, failure: undefined };
    } catch (error) {
      return {
        output: "",
        events: yield* stream.readAll(),
        asked,
        failure: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });
}

/** The answer the reference journey submits. */
export const REFERENCE_ANSWER: Json = { decision: "approve" };

/** A provider that always answers the same way. */
export function answering(value: Json): (request: ElicitationRequest) => Operation<unknown> {
  // deno-lint-ignore require-yield
  return function* () {
    return value;
  };
}

/** The complete reference Journal of one settled run. */
export function* referenceEvents(): Operation<DurableEvent[]> {
  const run = yield* runReference(answering(REFERENCE_ANSWER));
  if (run.failure !== undefined) {
    throw run.failure;
  }
  return run.events;
}

/**
 * The Agent reference entry, executed for real against a scripted provider.
 *
 * One document holding one of each thing the Agent projection has to read: two
 * different agents talking in one conversation, one agent talking in two, a
 * turn that was granted permission while it ran, and a turn refused before it
 * reached a provider at all — which is the only way a retained turn has no
 * conversation to belong to.
 *
 * The provider is scripted rather than recorded, for the reason the entry above
 * is executed rather than replayed: what is under test is the projector against
 * the records the *current* runtime writes.
 */
export const AGENT_REFERENCE_SOURCE = [
  "# Agent entry",
  "",
  "The planner drafts, the builder checks, and the planner runs the build.",
  "",
  '<Agent name="planner">',
  '<Prompt text="draft the plan" session="review" />',
  "</Agent>",
  "",
  '<Agent name="builder">',
  '<Prompt text="check the plan" session="review" />',
  "</Agent>",
  "",
  '<Agent name="planner">',
  '<Prompt text="run the build" session="build" />',
  "</Agent>",
  "",
  "The last one never reaches a provider.",
  "",
  '<Prompt text="refuse: nothing to do" />',
  "",
].join("\n");

/** The choices the scripted provider offers for the build turn. */
const BUILD_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

/**
 * A provider that answers by the text it was sent.
 *
 * `refuse:` refuses before the turn starts, which is what leaves a record with
 * no session key. The build turn asks for permission, so one retained turn
 * carries an audit and the others carry none.
 */
function scriptedAgent(): AgentProviderFactory {
  const issued = new Map<string, Session>();
  return function* () {
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *agent([name]) {
          return name ?? "planner";
        },
        // deno-lint-ignore require-yield
        *session(routed) {
          const [name] = routed;
          const key = `stub:${typeof name === "string" ? name : "default"}`;
          const held = issued.get(key);
          if (held !== undefined) {
            return held;
          }
          const session: Session = { sessionKey: key, cwd: "." };
          issued.set(key, session);
          return session;
        },
        // deno-lint-ignore require-yield
        *prompt([text, options]) {
          return scriptedTurn(text, options);
        },
      },
      { at: "min" },
    );
  };
}

function scriptedTurn(
  text: string,
  options: PromptOptions | undefined,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      if (text.startsWith("refuse:")) {
        throw new Error("this provider has nothing to run that on");
      }
      const named = typeof options?.session === "string" ? options.session : "default";
      const session: Session = { sessionKey: `stub:${named}`, cwd: "." };
      const events: AgentPromptEvent[] = [
        { type: "started", agent: options?.agent ?? "planner", session },
        { type: "text_delta", text: `[${text}]` },
        { type: "terminal", status: "completed" },
      ];
      let index = 0;
      let asked = false;
      return {
        *next() {
          if (index === 1 && !asked) {
            asked = true;
            if (text.startsWith("run the build")) {
              yield* Agent.operations.requestPermission({
                session,
                toolCall: {
                  toolCallId: "call-build",
                  title: "Run npm build",
                  kind: "execute",
                  rawInput: { command: "npm run build" },
                },
                options: BUILD_OPTIONS,
              });
            }
          }
          if (index < events.length) {
            return { done: false, value: events[index++] };
          }
          return { done: true, value: `[${text}]` };
        },
      };
    },
  };
}

/** Run the Agent reference entry once, over `stream`. */
export function runAgentReference(
  stream: InMemoryStream = new InMemoryStream(),
): Operation<ReferenceRun> {
  return scoped(function* () {
    yield* installAgentComponents({
      rootProvider: {
        factory: scriptedAgent(),
        options: { defaultAgent: "planner", permissionMode: "deny-all" },
      },
    });
    try {
      const execution = yield* executeInstalled(
        { ...inlineSource(AGENT_REFERENCE_SOURCE), stream },
        [],
      );
      const output = yield* collect(execution);
      return {
        output: String(output),
        events: yield* stream.readAll(),
        asked: [],
        failure: undefined,
      };
    } catch (error) {
      return {
        output: "",
        events: yield* stream.readAll(),
        asked: [],
        failure: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });
}

/** The complete Agent reference Journal of one run. */
export function* agentReferenceEvents(): Operation<DurableEvent[]> {
  const run = yield* runAgentReference();
  return run.events;
}
