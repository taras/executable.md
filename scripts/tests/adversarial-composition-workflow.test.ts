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
import { call, race, scoped } from "effection";
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
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { useHostFiles } from "@executablemd/runtime";
import {
  createSuspensionController,
  evaluationComponents,
  useWorkflowInputDelivery,
  useWorkflowRunHost,
} from "@executablemd/workflow/deno";
import type { SuspensionNotice } from "@executablemd/workflow/deno";
// The broad attachment, the way every in-package suite reaches it. The
// published wrapper beside it projects only what a host outside the package
// owns, and deliberately offers no member for a substituted Git host or
// Git-host transport — which is exactly what a leaf substitution is.
import { withWorkflowWorkspace } from "../../packages/workflow/src/deno/workspace/host.ts";
import type { WorkflowWorkspaceOptions } from "../../packages/workflow/src/deno/workspace/host.ts";
import {
  parseWorkflowDefinition,
  SUSPENSION_REQUEST,
  WorkflowInputDelivery,
  WorkflowLifecycle,
} from "@executablemd/workflow";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { retainedWorkflowInstallation } from "../../packages/workflow/src/run.ts";
import {
  createRun,
  useStorageRoot,
  withStorage,
} from "../../packages/cli/tests/support/workflow-run.ts";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { remoteRefs, useBareRemote } from "../../packages/workflow/tests/support/git-remotes.ts";
import type { BareRemote } from "../../packages/workflow/tests/support/git-remotes.ts";
import { countingHost } from "../../packages/workflow/tests/support/composition.ts";
import { gitHubStore, respond } from "../../packages/workflow/tests/support/github.ts";
import type { GitHubStore } from "../../packages/workflow/tests/support/github.ts";
import { gitHubSource } from "../../packages/workflow/src/deno/composition/github.ts";
import { parseGitHostReconciliationRecord } from "../../packages/workflow/src/git-host/records.ts";
import type { GitHostReconciliationRecord } from "../../packages/workflow/src/git-host/records.ts";
import type {
  GitHubAccess,
  GitHubHttpRequest,
  GitHubHttpResponse,
} from "../../packages/workflow/src/deno/composition/github.ts";
import type {
  GitInvocation,
  GitOutcome,
  RepositoryHost,
} from "../../packages/workflow/src/deno/composition/host.ts";

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "workflows",
  "adversarial-implementation",
);

const ROOT_PATH = "workflows/adversarial-implementation/start.md";

/**
 * The line only a real read of `README.md` can put into a later prompt.
 *
 * Nothing else renders it: not an instruction file, not a scripted reply, not
 * a proposal. A prompt that carries it carries it because this run performed
 * the read the implementor asked for.
 */
const README_LINE = "Deployment note: the health route is not documented yet.";

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
  | "revision"
  | "planRevision"
  | "repair"
  | "unknown";

function classify(content: string): Turn {
  // Every marker below is text the prompt itself renders, not prose around it:
  // a marker taken from a document's explanation matches nothing at run time.
  if (content.includes("Determine whether the user must be involved to")) {
    return "checkpoint";
  }
  if (content.includes("Correct your previous response without changing its meaning")) {
    return "repair";
  }
  if (content.includes("Produce a user-validated design handoff")) {
    return "discovery";
  }
  if (content.includes("Confirm,\n        refute, or amend the implementation theory")) {
    return "plan";
  }
  if (content.includes("You cannot open this repository")) {
    return "observation";
  }
  // Planning's revision names the plan, so it is checked first: the
  // implementation marker is not a prefix of it, but the reverse reading is the
  // easy mistake and this makes the order explicit.
  if (content.includes("Revise the implementation plan using this review:")) {
    return "planRevision";
  }
  if (content.includes("Revise the implementation using this review:")) {
    return "revision";
  }
  if (content.includes("Reviews already on it:")) {
    return "implementationVerdict";
  }
  if (content.includes("Implementation plan:")) {
    return "planVerdict";
  }
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
  for (const turn of trace.calls) {
    out.push(turn.agent ?? "", turn.session ?? "", turn.content);
    walk(turn.options);
  }
  trace.factoryOptions.forEach(walk);
  return out;
}

/**
 * The scripted replies one run needs, keyed by turn.
 *
 * The members a revision loop consumes more than once are lists, answered in
 * order and holding at the last entry. A list rather than one value because an
 * iteration that reuses the previous iteration's answer proves nothing about
 * which turn produced it: distinct entries are what make a missing or
 * misrouted turn visible instead of silently absorbed.
 */
interface Script {
  /** Assessments answer in order; a checkpoint consumes one per invocation. */
  readonly checkpoints: readonly Record<string, unknown>[];
  /** One verdict per planning round, in order. */
  readonly planVerdicts: readonly Record<string, unknown>[];
  /** One verdict per implementation iteration, in order. */
  readonly implementationVerdicts: readonly Record<string, unknown>[];
  /** One proposal per implementation iteration, in order. */
  readonly proposals: readonly Record<string, unknown>[];
  /**
   * How many observation turns this run answers before its proposal envelope.
   *
   * A count rather than a list of sources, because the source is not this
   * suite's to write: each observation turn answers with the example envelope
   * the authored prompt itself rendered, taken back out of that prompt. An
   * instruction the host cannot admit therefore fails here, in the composition
   * that ships it, rather than passing on a spelling a suite chose for it.
   */
  readonly observations: number;
}

/**
 * The observation envelope this prompt told the agent to return.
 *
 * Read out of the prompt rather than written here. What the authored stage
 * renders is an example an agent is meant to copy, so copying it is the only
 * way a suite finds out whether the host admits what the document asks for: a
 * source this suite spelled itself would prove that `<Evaluate>` admits the
 * suite's spelling, and nothing about the instruction shipped beside it.
 *
 * The proposal example is written in the same closed shape, so the envelope is
 * selected by its kind rather than by its position among the fenced blocks.
 */
function instructedObservation(prompt: string): string {
  for (const line of prompt.split("\n")) {
    const written = line.trim();
    if (!written.startsWith('{"kind": "observation"')) {
      continue;
    }
    return JSON.stringify(JSON.parse(written));
  }
  throw new Error("the observation prompt rendered no observation example to follow");
}

/** The entry this turn consumes: in order, holding at the last one. */
function at<T>(entries: readonly T[], index: number): T {
  const held = entries[Math.min(index, entries.length - 1)];
  if (held === undefined) {
    throw new Error(`the script has no entry ${index}`);
  }
  return held;
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
  let proposal = 0;
  let verdict = 0;
  let revision = 0;
  let planVerdict = 0;
  let planRevision = 0;
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
          const session =
            typeof promptOptions?.session === "object"
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
              reply = JSON.stringify(at(script.checkpoints, checkpoint));
              checkpoint += 1;
              break;
            }
            case "plan":
              reply = "PLAN-V1: add the /health route behind the existing router mount.";
              break;
            case "planVerdict":
              reply = JSON.stringify(at(script.planVerdicts, planVerdict));
              planVerdict += 1;
              break;
            case "planRevision":
              // Planning's own revision prompt binds nothing either.
              planRevision += 1;
              reply = `PLAN-REVISION-ACKNOWLEDGED-${planRevision}`;
              break;
            case "observation": {
              if (observation < script.observations) {
                observation += 1;
                reply = instructedObservation(content);
              } else {
                reply = JSON.stringify({
                  kind: "proposal",
                  source: JSON.stringify(at(script.proposals, proposal)),
                });
                proposal += 1;
              }
              break;
            }
            case "implementationVerdict":
              reply = JSON.stringify(at(script.implementationVerdicts, verdict));
              verdict += 1;
              break;
            case "revision":
              // The authored revision prompt binds nothing, so what it answers
              // is only ever rendered. It is numbered so the trace shows which
              // iteration sent it.
              revision += 1;
              reply = `REVISION-ACKNOWLEDGED-${revision}`;
              break;
            default:
              throw new Error(
                `unscripted turn: len=${content.length} opts=${JSON.stringify(
                  promptOptions ?? {},
                ).slice(0, 200)} text=${JSON.stringify(content.slice(0, 200))}`,
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
      const session: Session =
        typeof options?.session === "object"
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
  readonly events: readonly DurableEvent[];
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
              {
                path: "AGENTS.md",
                content: "Root instructions: prefer evidence over assertion.\n",
              },
              { path: "README.md", content: `# project\n\n${README_LINE}\n` },
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
      return { output, failure, trace, kinds, events };
    });
  });
}

/**
 * The Git host these scenarios name, and the two boundaries it stands behind.
 *
 * A document names a repository on `github.com`, because that is what selects
 * the shipped adapters and what a real workflow would write. Git is given a
 * bare repository beside the test instead of a network, and GitHub is the
 * small model the `<PullRequest>` and `<Issue>` suites already own, extended
 * here with the evidence endpoints the read suite cans. Everything between
 * those two boundaries — locator admission, checkout authority, this run's own
 * Push evidence, the journal scan, classification, pagination and every record
 * — is the shipped code.
 *
 * `owner/repository` rather than a prettier pair: the shared store reports
 * `html_url` under exactly that name, and the read adapter parses the
 * repository back out of the URL it is given. A store named anything else
 * would answer reads for one repository and upserts for another.
 */
const LOCATOR = "https://github.com/owner/repository";

/** The container a deferred finding is filed in. */
const TRACKER = `${LOCATOR}/issues`;

/** Where the substituted transport answers. No request leaves this process. */
const ENDPOINT = "https://api.github.test";

/**
 * The credential this forge requires, assembled rather than written.
 *
 * A literal of a credential shape is refused by this repository's secret gate
 * before it runs, and a rendered one never settles. What travels is a value the
 * scanner has no reason to recognize, and what is asserted is that it never
 * reaches a prompt.
 */
const TOKEN = `forge-${"credential"}-for-this-composition`;

/** The distinctive values one iteration's evidence read answers with. */
interface Evidence {
  readonly review: { readonly state: string; readonly body: string };
  readonly conversation: { readonly body: string };
  readonly inline: { readonly body: string; readonly path: string };
  readonly checkRun: {
    readonly name: string;
    readonly conclusion: string;
    readonly summary: string;
  };
  readonly status: {
    readonly context: string;
    readonly state: string;
    readonly description: string;
  };
}

interface Forge {
  readonly store: GitHubStore;
  /** Every forge call this run made, in order, most recent last. */
  readonly calls: string[];
  /** Every Git command the real host ran, in order. */
  readonly commands: string[][];
  readonly options: WorkflowWorkspaceOptions;
}

/** The five evidence endpoints, and nothing else this suite cans. */
const READS = ["reviews", "conversation", "inline", "check-runs", "status"] as const;

/** What this request is, in the vocabulary a scenario asserts on. */
function label(request: GitHubHttpRequest): string {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/graphql") {
    return "graphql:draft";
  }
  const parts = path.split("/");
  const tail = parts[parts.length - 1] ?? "";
  const parent = parts[parts.length - 2] ?? "";
  // The three evidence shapes are `/<collection>/<subject>/<what>`, so what
  // names the collection is two segments back rather than one: one segment back
  // is the pull request's number, or the commit the checks are read at.
  const owner = parts[parts.length - 3] ?? "";
  if (owner === "commits") {
    return `read:${tail}`;
  }
  if (tail === "reviews") {
    return "read:reviews";
  }
  if (tail === "comments") {
    return `read:${owner === "issues" ? "conversation" : "inline"}`;
  }
  const collection = tail === "pulls" || tail === "issues" ? tail : parent;
  const numbered = tail !== "pulls" && tail !== "issues";
  if (request.method === "POST") {
    return `${collection}:create`;
  }
  if (request.method === "PATCH") {
    return `${collection}:update`;
  }
  return numbered ? `${collection}:lookup` : `${collection}:list`;
}

/** Whether this call is one the pull-request evidence provider makes. */
function isRead(made: string): boolean {
  return READS.some((kind) => made === `read:${kind}`);
}

function json(body: unknown): GitHubHttpResponse {
  return { status: 200, body: JSON.stringify(body) };
}

/**
 * The transport, answering evidence itself and the rest out of the store.
 *
 * The store models the pull-request and issue calls its own suites drive; the
 * evidence endpoints are the read suite's canned answers, built here because
 * the number and the head they are about are facts only the run knows. Which
 * iteration's evidence is served advances on the reviews read, which is the
 * first of the three the stage performs.
 */
function forgeAccess(
  store: GitHubStore,
  evidence: readonly Evidence[],
  calls: string[],
): GitHubAccess {
  let reading = -1;
  const subject = (number: string) => `${ENDPOINT}/repos/owner/repository/pulls/${number}`;
  return {
    endpoint: ENDPOINT,
    // deno-lint-ignore require-yield
    *token(): Operation<string | undefined> {
      return store.token;
    },
    // deno-lint-ignore require-yield
    *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
      const made = label(request);
      calls.push(made);
      if (!isRead(made)) {
        const answered = respond(store, request);
        if (made === "pulls:create" && answered.status === 201) {
          // A pull request's head follows its branch. The store records the
          // concrete commit a creation resolved, which would then report this
          // head forever; GitHub reports a reading of the branch. Blanking it
          // is how `stored()` in the shipped `<PullRequest>` fixture spells
          // "whatever that branch holds when this is read", and a revision
          // iteration is exactly when the difference shows.
          const opened = store.pullRequests[store.pullRequests.length - 1];
          if (opened !== undefined) {
            opened.headSha = "";
          }
        }
        return answered;
      }
      if (request.headers["Authorization"] !== `Bearer ${store.token}`) {
        return { status: 401, body: JSON.stringify({ message: "Bad credentials" }) };
      }
      const parts = new URL(request.url).pathname.split("/");
      const held = made === "read:reviews" ? (reading += 1) : Math.max(reading, 0);
      const current = at(evidence, held);
      if (made === "read:check-runs" || made === "read:status") {
        const head = parts[parts.length - 2] ?? "";
        return made === "read:check-runs"
          ? json({
              total_count: 1,
              check_runs: [
                {
                  id: 41,
                  head_sha: head,
                  name: current.checkRun.name,
                  status: "completed",
                  conclusion: current.checkRun.conclusion,
                  html_url: "https://github.test/run/41",
                  started_at: "2026-08-24T03:00:00Z",
                  completed_at: "2026-08-24T03:10:00Z",
                  output: { title: null, summary: current.checkRun.summary, text: null },
                },
              ],
            })
          : json({
              sha: head,
              statuses: [
                {
                  id: 51,
                  context: current.status.context,
                  state: current.status.state,
                  description: current.status.description,
                  target_url: null,
                  created_at: "2026-08-24T04:00:00Z",
                  updated_at: "2026-08-24T04:00:00Z",
                },
              ],
            });
      }
      const number = parts[parts.length - 2] ?? "";
      if (made === "read:reviews") {
        return json([
          {
            id: 11,
            user: { login: "reviewer" },
            state: current.review.state,
            body: current.review.body,
            submitted_at: "2026-08-24T00:00:00Z",
            commit_id: null,
            html_url: "https://github.test/pr/review/11",
            pull_request_url: subject(number),
          },
        ]);
      }
      if (made === "read:conversation") {
        return json([
          {
            id: 21,
            user: { login: "watcher" },
            body: current.conversation.body,
            created_at: "2026-08-24T01:00:00Z",
            updated_at: "2026-08-24T01:00:00Z",
            html_url: "https://github.test/pr/comment/21",
            issue_url: `${ENDPOINT}/repos/owner/repository/issues/${number}`,
          },
        ]);
      }
      return json([
        {
          id: 31,
          pull_request_review_id: 11,
          user: { login: "reviewer" },
          body: current.inline.body,
          created_at: "2026-08-24T02:00:00Z",
          updated_at: "2026-08-24T02:00:00Z",
          html_url: "https://github.test/pr/inline/31",
          path: current.inline.path,
          diff_hunk: "@@ -1 +1 @@",
          commit_id: "0".repeat(40),
          original_commit_id: "0".repeat(40),
          line: 3,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          in_reply_to_id: null,
          pull_request_url: subject(number),
        },
      ]);
    },
  };
}

/**
 * The production Git host, with one locator standing in for another.
 *
 * The substitution goes both ways, because Git remembers where a checkout came
 * from and this run's own attachment check reads it back. What is replaced is
 * exactly one string in both directions.
 */
function forgeHost(remote: BareRemote, calls: string[], commands: string[][]): RepositoryHost {
  const inner = countingHost().host;
  return {
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      commands.push([...invocation.args]);
      const subcommand = invocation.args[0];
      if (subcommand === "ls-remote" || subcommand === "push") {
        calls.push(`git:${subcommand}`);
      }
      const outcome = yield* inner.git({
        ...invocation,
        args: invocation.args.map((argument) => (argument === LOCATOR ? remote.locator : argument)),
      });
      return { ...outcome, stdout: outcome.stdout.split(remote.locator).join(LOCATOR) };
    },
    useDirectory: inner.useDirectory,
  };
}

function forge(remote: BareRemote, evidence: readonly Evidence[]): Forge {
  const store = gitHubStore({ owner: "owner", repository: "repository", token: TOKEN });
  store.resolveHead = (branch) => remoteRefs(remote).get(`refs/heads/${branch}`);
  const calls: string[] = [];
  const commands: string[][] = [];
  const access = gitHubSource(forgeAccess(store, evidence, calls));
  return {
    store,
    calls,
    commands,
    options: {
      composition: { host: forgeHost(remote, calls, commands) },
      gitHubPullRequests: { allowed: [LOCATOR], access },
      gitHubIssues: { ceiling: [TRACKER], access },
    },
  };
}

/**
 * The two iterations' distinctive values.
 *
 * Every one of them is unique to its iteration, so a later correct call cannot
 * stand in for an earlier missing or misrouted one: a trace that shows the
 * second iteration's commit message under the first iteration's push, or the
 * first iteration's evidence under the second review, is a different string
 * rather than the same one twice.
 */
const FIRST_PROPOSAL = {
  changes: '<File path="health.md">the health route, first pass</File>',
  title: "Add a health endpoint",
  commitMessage: "FIRST-COMMIT add a health endpoint",
  report: "FIRST-IMPLEMENTOR-REPORT",
};

const SECOND_PROPOSAL = {
  changes: '<File path="health.md">the health route, revised</File>',
  title: "Add a health endpoint, revised",
  commitMessage: "SECOND-COMMIT revise the health endpoint",
  report: "SECOND-IMPLEMENTOR-REPORT",
};

const FIRST_VERDICT = {
  passed: false,
  review: "FIRST-REVIEW-FAIL",
  revisionPrompt: "FIRST-REVISION-PROMPT",
  findings: [],
};

const SECOND_VERDICT = {
  passed: true,
  review: "SECOND-REVIEW-PASS",
  revisionPrompt: "",
  findings: [],
};

const EVIDENCE_ONE: Evidence = {
  review: { state: "CHANGES_REQUESTED", body: "FIRST-REVIEW-BODY" },
  conversation: { body: "FIRST-CONVERSATION-BODY" },
  inline: { body: "FIRST-INLINE-BODY", path: "health.md" },
  checkRun: { name: "FIRST-CHECK", conclusion: "failure", summary: "FIRST-CHECK-SUMMARY" },
  status: { context: "FIRST-STATUS", state: "failure", description: "FIRST-STATUS-BODY" },
};

const EVIDENCE_TWO: Evidence = {
  review: { state: "APPROVED", body: "SECOND-REVIEW-BODY" },
  conversation: { body: "SECOND-CONVERSATION-BODY" },
  inline: { body: "SECOND-INLINE-BODY", path: "health.md" },
  checkRun: { name: "SECOND-CHECK", conclusion: "success", summary: "SECOND-CHECK-SUMMARY" },
  status: { context: "SECOND-STATUS", state: "success", description: "SECOND-STATUS-BODY" },
};

/**
 * The effects a scenario reasons about, in journal order.
 *
 * `import_component` and the loop bookkeeping are dropped: a bundled document
 * imports a component at every expansion, so a sequence including them says
 * more about how many times `<If>` ran than about what the composition did.
 */
const NOISE = ["import_component", "loop", "loop_iteration", "workflow_run"];

function effects(kinds: readonly string[]): string[] {
  return kinds.filter((kind) => !NOISE.includes(kind));
}

/**
 * The record each Git-host effect retained, in order.
 *
 * The reconciliation record *is* the result value — not a `record` member on
 * it — which is how `gitHostOutcomes()` in the owning suite reads it.
 */
function hostRecords(events: readonly DurableEvent[]): GitHostReconciliationRecord[] {
  return events
    .filter((event) => event.type === "yield" && event.description.type === "git_host_effect")
    .map((event) => {
      const result = Object(Reflect.get(event, "result"));
      const parsed = parseGitHostReconciliationRecord(Reflect.get(result, "value"));
      if (parsed === undefined) {
        throw new Error(`a Git-host effect retained something that is not a record`);
      }
      return parsed;
    });
}

/** Every generated-XMD record that admitted the fragment it was given. */
function admissions(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter((event) => {
    if (event.type !== "yield" || event.description.type !== "generated_xmd") {
      return false;
    }
    if (event.result.status !== "ok") {
      return false;
    }
    const value = event.result.value;
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      value.decision === "admitted"
    );
  });
}

/** The commit each `<Git.Commit>` retained, in order. */
function commits(events: readonly DurableEvent[]): string[] {
  return events
    .filter((event) => event.type === "yield" && event.description.type === "workspace_git_commit")
    .map((event) => {
      const value = Object(Reflect.get(Object(Reflect.get(event, "result")), "value"));
      return String(Reflect.get(Object(Reflect.get(value, "record")), "commit") ?? "");
    });
}

/**
 * The evidence AC4 retains, chosen so that a summary cannot pass for it.
 *
 * Punctuation and whitespace a normalizing provider would tidy: doubled
 * spaces, an interior tab, a trailing newline, parentheses and a semicolon.
 * What is asserted downstream is the exact retained value, so anything that
 * reflowed, trimmed or re-encoded it on the way to a prompt fails here.
 */
const RETAINED: Evidence = {
  review: {
    state: "CHANGES_REQUESTED",
    body: "Blocking: health.md line 3 needs a note;  two  spaces, a\ttab, and a break.\n",
  },
  conversation: { body: "Not blocking (style): rename it, maybe?  Two  spaces again.\n" },
  inline: { body: "-  looks like a bullet, is not one.\tTabbed.\n", path: "health.md" },
  checkRun: {
    name: "verify (deno)",
    conclusion: "failure",
    summary: "1 failed, 0 passed;  see the log.\n",
  },
  status: {
    context: "deploy",
    state: "error",
    description: "refused (403); retry later.\n",
  },
};

/** The assessment the approving checkpoint returns, quoted into the issue. */
const APPROVAL = "APPROVAL-THE-DEFERRAL-IS-THE-RIGHT-CALL";

/** One finding the planner classified `defer`, with distinctive material. */
const DEFERRED = {
  disposition: "defer",
  title: "FINDING-TITLE-the health route has no timeout",
  description: "FINDING-DESCRIPTION: it answers, but nothing bounds how long it takes.",
  evidence: ["FINDING-EVIDENCE-ONE: health.md line 3", "FINDING-EVIDENCE-TWO: no test covers it"],
};

/** The same shape, classified so that it is not the deferral's authority. */
const FIXED = {
  disposition: "fix",
  title: "OTHER-TITLE-the route is spelled oddly",
  description: "OTHER-DESCRIPTION: cosmetic, and already corrected.",
  evidence: ["OTHER-EVIDENCE: health.md line 1"],
};

const DEFERRING_VERDICT = {
  passed: true,
  review: "DEFERRING-REVIEW-PASS",
  revisionPrompt: "",
  findings: [DEFERRED],
};

const FIXING_VERDICT = {
  passed: true,
  review: "FIXING-REVIEW-PASS",
  revisionPrompt: "",
  findings: [FIXED],
};

/** A checkpoint that needs a person: the authored `<Elicit>` branch. */
const ASKS: Record<string, unknown> = {
  requiresUser: true,
  assessment: "ASSESSMENT-THE-REVIEW-IS-THE-USERS-CALL",
  question: "QUESTION-ACCEPT-THIS-REVIEW",
  options: ["OPTION-ACCEPT", "OPTION-DECLINE"],
  recommendation: "RECOMMENDATION-ACCEPT",
};

/** The props every forge scenario supplies, naming the substituted host. */
const PROPS = {
  request: "add a health endpoint",
  repository: LOCATOR,
  tracker: TRACKER,
};

/** The seed commit every forge scenario's remote starts from. */
const SEED = {
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
} as const;

/**
 * What a host installs for this document: the bundle, the run, and the two
 * component sets a workflow execution declares.
 */
function installation(
  database: WorkflowRunDatabase,
  components: readonly WorkflowBundleComponent[],
) {
  return [
    { bundle: { components } },
    retainedWorkflowInstallation({
      runId: database.record.runId,
      base: database.record.base,
      pinnedCommit: database.record.definition.objectId,
    }),
    {
      components: [...evaluationComponents(database, {}), ...agentIdentityComponents()],
    },
  ];
}

/** One composed run against the forge, over a real retained WorkflowRun. */
function runForge(forged: Forge, script: Script): Operation<Attempt> {
  return scoped(function* () {
    const storage = yield* useStorageRoot();
    return yield* withStorage(storage, function* () {
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
                    props: PROPS,
                  },
                  installation(database, components),
                ),
              );
            }),
            forged.options,
          );
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      });
      const events = yield* database.journal.readAll();
      const kinds = events
        .filter((event) => event.type === "yield")
        .map((event) => event.description.type);
      return { output, failure, trace, kinds, events };
    });
  });
}

/**
 * The suspending half of this suite: one run, executed more than once.
 *
 * A scenario that has to reach a durable wait cannot run the document under a
 * bare storage attachment, because what answers `<Elicit>` under a workflow
 * host is the suspension protocol: the run publishes a retained request,
 * settles `suspended`, and gives the executor lock back. So these attempts go
 * through the same three things the CLI does — the run host, a real executor
 * lock, and the shipped suspension controller — and each attempt is one
 * process's worth of work, ending where the document waited.
 */
/** The default run a single-run scenario uses; AC6 names one run per gate. */
const RUN_ID = "adversarial-composition";

function definition() {
  const parsed = parseWorkflowDefinition({
    version: 1,
    kind: "git",
    objectFormat: "sha1",
    objectId: "1".repeat(40),
    rootDocumentPath: ROOT_PATH,
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

interface Suspending extends Attempt {
  /** The wait this execution reported, or nothing when it did not wait. */
  readonly notice: SuspensionNotice | undefined;
}

/**
 * One execution of the composed root, from `start` or from `resume`.
 *
 * The controller stands in for the executor exactly as the CLI arranges it: it
 * observes a reported wait, `race` halts the execution around it, and the run
 * is settled `suspended` with a stop reason naming the retained request. An
 * execution that failed settles nothing at all, which is what a process dying
 * looks like and the state a later attempt would have to continue from.
 */
function attemptRun(
  root: string,
  action: "start" | "resume",
  forged: Forge,
  script: Script,
  runId: string = RUN_ID,
): Operation<Suspending> {
  return scoped(function* () {
    const transitions = yield* useWorkflowRunHost({ root });
    const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
    if (!acquired.ok) {
      throw acquired.error;
    }
    if (acquired.value.kind !== "acquired") {
      throw new Error(`the run ${runId} already has a live workflow executor`);
    }
    const lock = acquired.value.lock;
    const begun = yield* transitions.begin(
      lock,
      action === "start"
        ? {
            runId,
            action,
            creation: { definition: definition(), base: "main", props: PROPS },
          }
        : { runId, action },
    );
    if (!begun.ok) {
      throw begun.error;
    }
    const { database, execution } = begun.value;
    const suspension = createSuspensionController({ database });
    const components = yield* bundle();
    const source = yield* readTextFile(join(WORKFLOW, "start.md"));
    const trace: Trace = { calls: [], factoryOptions: [] };
    let output: Json | undefined;
    let failure: string | undefined;
    let notice: SuspensionNotice | undefined;

    yield* race([
      call(function* (): Operation<void> {
        try {
          yield* suspension.own(
            call(function* (): Operation<void> {
              yield* scoped(function* () {
                yield* useHostFiles();
                yield* installAgentComponents({
                  rootProvider: {
                    factory: scriptedProvider(trace, script),
                    options: { defaultAgent: "stub", permissionMode: "deny-all" },
                  },
                });
                output = yield* withWorkflowWorkspace(
                  database,
                  scoped(function* () {
                    return yield* collect(
                      yield* executeInstalled(
                        {
                          ...retainedSource(ROOT_PATH, source),
                          stream: database.journal,
                          componentDirs: [],
                          props: PROPS,
                        },
                        installation(database, components),
                      ),
                    );
                  }),
                  forged.options,
                );
              });
            }),
          );
        } catch (error) {
          // The marker that ends a waiting execution leaves through the same
          // path any other failure would, so it is not one.
          if (!suspension.entered(error)) {
            failure = error instanceof Error ? error.message : String(error);
          }
        }
      }),
      call(function* (): Operation<void> {
        notice = yield* suspension.notice;
      }),
    ]);

    if (notice !== undefined) {
      const entries = yield* database.readJournalEntries();
      const request = entries.ok
        ? entries.value.find(
            (entry) =>
              entry.event.type === "yield" &&
              entry.event.description.type === SUSPENSION_REQUEST &&
              entry.event.description.name === notice?.suspensionId,
          )
        : undefined;
      const settled = yield* transitions.settle(lock, {
        executionId: execution.executionId,
        status: "suspended",
        ...(request === undefined
          ? {}
          : { reason: { kind: "journal" as const, eventId: request.eventId } }),
      });
      if (!settled.ok) {
        throw settled.error;
      }
    } else if (failure === undefined) {
      const finished = yield* transitions.settle(lock, {
        executionId: execution.executionId,
        status: "completed",
      });
      if (!finished.ok) {
        throw finished.error;
      }
    }

    const events = yield* database.journal.readAll();
    const kinds = events
      .filter((event) => event.type === "yield")
      .map((event) => event.description.type);
    return { notice, output, failure, trace, kinds, events };
  });
}

/** Retain one typed answer for one wait, the way `xmd workflow answer` does. */
function answer(
  root: string,
  suspensionId: string,
  value: Json,
  runId: string = RUN_ID,
): Operation<void> {
  return scoped(function* () {
    yield* useWorkflowInputDelivery({ root });
    const delivered = yield* WorkflowInputDelivery.operations.deliver({
      runId,
      suspensionId,
      value,
      secretDetection: true,
    });
    if (!delivered.ok) {
      throw delivered.error;
    }
  });
}

/** The wait this attempt reported, or a failure naming what it did instead. */
function waited(attempt: Suspending): string {
  const id = attempt.notice?.suspensionId;
  if (id === undefined) {
    throw new Error(
      `the composition did not reach a durable wait: failure=${attempt.failure ?? "none"}`,
    );
  }
  return id;
}

describe("Tier AC — the adversarial workflow, composed", () => {
  it("AC0: the real root and its five stages load as one bundle", function* () {
    const components = yield* bundle();
    expect(components.map((component) => component.name).sort()).toEqual([...STAGES].sort());
    for (const component of components) {
      expect(component.content.length).toBeGreaterThan(0);
    }
    const root = yield* readTextFile(join(WORKFLOW, "start.md"));
    expect(root).toContain("<Worktree");
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
              {
                path: "AGENTS.md",
                content: "Root instructions: prefer evidence over assertion.\n",
              },
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
      planVerdicts: [{ passed: true, review: "REVIEW-PASS", revisionPrompt: "" }],
      implementationVerdicts: [
        { passed: true, review: "PR-REVIEW-PASS", revisionPrompt: "", findings: [] },
      ],
      proposals: [
        {
          changes: '<File path="health.md">the health route</File>',
          title: "Add a health endpoint",
          commitMessage: "Add a health endpoint",
          report: "IMPLEMENTOR-REPORT",
        },
      ],
      observations: 1,
    });
    const turns = attempt.trace.calls.map((turn) => classify(turn.content));

    // Authored order: discovery, the handoff checkpoint, the plan and its
    // verdict, Planning's own review checkpoint, start.md's authorization
    // checkpoint, then the implementor's exchange — one observation request and
    // the proposal envelope, which the same prompt asks for in two shapes.
    expect(turns).toEqual([
      "discovery",
      "checkpoint",
      "plan",
      "planVerdict",
      "checkpoint",
      "checkpoint",
      "observation",
      "observation",
    ]);

    // Each turn went to the session its document names.
    const sessions = attempt.trace.calls.map((turn) => turn.session);
    expect(sessions).toEqual([
      "planner",
      "user-checkpoint",
      "implementor",
      "planner",
      "user-checkpoint",
      "user-checkpoint",
      "implementor",
      "implementor",
    ]);

    // The implementor asked to see one file before proposing, and asked for it
    // the way the authored prompt told it to: what it returned is that prompt's
    // own example, copied. An example this host cannot admit stops the exchange
    // here rather than reaching the assertions below.
    const exchange = attempt.trace.calls.filter((turn) => classify(turn.content) === "observation");
    expect(exchange).toHaveLength(2);
    // Pinned as well as performed, so restoring an inadmissible spelling reads
    // as the instruction it changed rather than as a refusal further down.
    expect(instructedObservation(exchange[0]!.content)).toBe(
      JSON.stringify({ kind: "observation", source: '<File path="README.md" />' }),
    );

    // XMD performed the read, not the agent: two fragments were admitted — the
    // observation, then the proposal's own changes — and the Workspace read the
    // observation named is retained beside them.
    expect(admissions(attempt.events)).toHaveLength(2);
    const reads = attempt.events.filter(
      (event) =>
        event.type === "yield" &&
        event.description.type === "workspace_file" &&
        String(event.description.name).includes("README.md"),
    );
    expect(reads).toHaveLength(1);

    // And the result reached the agent in its *next* turn rather than the one
    // that asked, which is the whole round trip: the agent named a read, XMD
    // performed it against the run's Workspace, and the detached value came
    // back as data in the following prompt.
    expect(exchange[0]!.content).not.toContain(README_LINE);
    expect(exchange[1]!.content).toContain(README_LINE);

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

  /**
   * AC3 — one pull request, revised across two iterations.
   *
   * The whole supervised revision loop, end to end: the implementor proposes,
   * the change is admitted and committed, the branch is published, a pull
   * request is opened, the planner reviews what it holds and fails it, the
   * implementor revises in the same session, and the second publication
   * *advances* the branch it already published rather than colliding with it.
   *
   * That advance is #588. Before it, `<Git.Push>` reconciled a destination to
   * one exact commit and refused any other, so this loop stopped at its own
   * second push. Now a destination holding a commit the source contains is an
   * ordinary non-force fast-forward, and the record keeps the attested
   * relation that authorized it.
   *
   * Distinctive values throughout, so a later correct call cannot stand in for
   * an earlier missing or misrouted one.
   */
  it("AC3: a failing review revises one pull request across two iterations", function* () {
    const remote = yield* useBareRemote(SEED);
    const forged = forge(remote, [EVIDENCE_ONE, EVIDENCE_TWO]);
    const attempt = yield* runForge(forged, {
      checkpoints: [
        continues("the handoff is clear"),
        continues("the plan converged"),
        continues("the plan is authorized"),
        continues("the first review is the planner's to act on"),
        continues("the second review is the planner's to act on"),
        continues("the change is complete"),
      ],
      planVerdicts: [{ passed: true, review: "REVIEW-PASS", revisionPrompt: "" }],
      implementationVerdicts: [FIRST_VERDICT, SECOND_VERDICT],
      proposals: [FIRST_PROPOSAL, SECOND_PROPOSAL],
      observations: 0,
    });
    expect(attempt.failure).toBeUndefined();

    // Two iterations, in authored order: the first envelope, its verdict and
    // review checkpoint, the revision turn in the same implementor session,
    // then the second iteration's own envelope, verdict and checkpoint.
    expect(attempt.trace.calls.map((turn) => classify(turn.content))).toEqual([
      "discovery",
      "checkpoint",
      "plan",
      "planVerdict",
      "checkpoint",
      "checkpoint",
      "observation",
      "implementationVerdict",
      "checkpoint",
      "revision",
      "observation",
      "implementationVerdict",
      "checkpoint",
      "checkpoint",
    ]);
    expect(attempt.trace.calls.map((turn) => turn.session)).toEqual([
      "planner",
      "user-checkpoint",
      "implementor",
      "planner",
      "user-checkpoint",
      "user-checkpoint",
      "implementor",
      "planner",
      "user-checkpoint",
      "implementor",
      "implementor",
      "planner",
      "user-checkpoint",
      "user-checkpoint",
    ]);

    // The complete ordered forge trace. The second iteration observes the
    // remote and advances it, then takes the *numbered* path — look the pull
    // request up, bring it up to date, read it back — where the first created
    // one from a listing.
    expect(forged.calls).toEqual([
      "git:ls-remote",
      "git:push",
      "pulls:list",
      "pulls:list",
      "pulls:create",
      "read:reviews",
      "read:conversation",
      "read:inline",
      "pulls:lookup",
      "read:check-runs",
      "read:status",
      "git:ls-remote",
      "git:push",
      "pulls:lookup",
      "pulls:update",
      "pulls:lookup",
      "read:reviews",
      "read:conversation",
      "read:inline",
      "pulls:lookup",
      "read:check-runs",
      "read:status",
    ]);

    // The complete ordered effect sequence. Each iteration admits its
    // proposal, writes it, stages it and commits it before any remote effect,
    // and each pull request follows the push of its own iteration.
    expect(effects(attempt.kinds)).toEqual([
      "workspace_repository",
      "workspace_worktree",
      "workspace_file",
      "workspace_file",
      "agent_prompt",
      "agent_prompt",
      "agent_prompt",
      "agent_prompt",
      "agent_prompt",
      "agent_prompt",
      "agent_prompt",
      "generated_xmd",
      "workspace_file",
      "workspace_git_add",
      "workspace_git_commit",
      "git_host_effect",
      "git_host_effect",
      "pull_request_read",
      "pull_request_read",
      "pull_request_read",
      "agent_prompt",
      "agent_prompt",
      "agent_prompt",
      "agent_prompt",
      "generated_xmd",
      "workspace_file",
      "workspace_git_add",
      "workspace_git_commit",
      "git_host_effect",
      "git_host_effect",
      "pull_request_read",
      "pull_request_read",
      "pull_request_read",
      // The second verdict, its review checkpoint, and the acceptance
      // checkpoint `start.md` reaches once the loop breaks.
      "agent_prompt",
      "agent_prompt",
      "agent_prompt",
    ]);

    // Two commits, and they are different: the second proposal was admitted
    // and performed rather than replaying the first.
    const [commitA, commitB] = commits(attempt.events);
    expect(commitA).toBeDefined();
    expect(commitB).toBeDefined();
    expect(commitA).not.toBe(commitB);

    // Four Git-host effects, all successful, alternating publish and publish
    // the pull request that describes it.
    const records = hostRecords(attempt.events);
    expect(records.map((record) => record.request.kind)).toEqual([
      "git-push",
      "pull-request",
      "git-push",
      "pull-request",
    ]);
    expect(records.map((record) => record.decision)).toEqual([
      "performed",
      "performed",
      "performed",
      "performed",
    ]);

    // Push A creates the destination: nothing was there, and it published A.
    const [pushA, openPr, pushB, updatePr] = records;
    expect(pushA?.preState).toEqual({ remoteCommit: null });
    expect(pushA?.observations).toEqual({ remoteCommit: commitA });
    expect(Reflect.get(Object(pushA?.result), "sourceCommit")).toBe(commitA);

    // Push B is the ordinary non-force fast-forward #588 settled. The record
    // retains the predecessor it advanced over, the relation that made
    // advancing legitimate rather than a replacement, and the commit it left
    // there — the whole of what authorized publishing over an existing branch.
    expect(pushB?.preState).toEqual({ remoteCommit: commitA, relation: "ancestor" });
    expect(pushB?.observations).toEqual({ remoteCommit: commitB });
    expect(Reflect.get(Object(pushB?.result), "sourceCommit")).toBe(commitB);
    expect(Reflect.get(Object(pushB?.result), "observedRemoteCommit")).toBe(commitB);

    // The remote ends at B.
    expect(remoteRefs(remote).get("refs/heads/agent/adversarial-implementation")).toBe(commitB);

    // Each publication is one exact refspec, and neither forces anything nor
    // touches upstream tracking. Nothing fetched an object and nothing moved
    // local history to make the advance apply.
    const pushes = forged.commands.filter((command) => command[0] === "push");
    expect(pushes).toHaveLength(2);
    expect(pushes.map((command) => command[command.length - 1])).toEqual([
      `${commitA}:refs/heads/agent/adversarial-implementation`,
      `${commitB}:refs/heads/agent/adversarial-implementation`,
    ]);
    const everyGitCommand = forged.commands.map((command) => command.join(" "));
    for (const forbidden of ["--force", "--set-upstream", "-f "]) {
      expect(everyGitCommand.join("\n")).not.toContain(forbidden);
    }
    for (const forbidden of ["fetch", "reset", "merge", "rebase"]) {
      expect(forged.commands.map((command) => command[0])).not.toContain(forbidden);
    }

    // One pull request exists, and it was created once and updated once —
    // the numbered pass brought the existing one up to date instead of asking
    // for a second one to exist.
    expect(forged.calls.filter((made) => made === "pulls:create")).toHaveLength(1);
    expect(forged.calls.filter((made) => made === "pulls:update")).toHaveLength(1);
    expect(forged.store.pullRequests).toHaveLength(1);
    expect(Reflect.get(Object(openPr?.result), "number")).toBe(1);
    expect(Reflect.get(Object(updatePr?.result), "number")).toBe(1);

    // And the update stands on *this* iteration's Push evidence. The first
    // publication is history rather than disagreement: what the second pull
    // request retains is B's head, never A's, and the pre-state it reconciled
    // against had already advanced to B.
    expect(Reflect.get(Object(openPr?.result), "headSha")).toBe(commitA);
    expect(Reflect.get(Object(updatePr?.result), "headSha")).toBe(commitB);
    const beforeUpdate = Object(Reflect.get(Object(updatePr?.preState), "pullRequest"));
    expect(Reflect.get(beforeUpdate, "headSha")).toBe(commitB);
    expect(Reflect.get(beforeUpdate, "number")).toBe(1);

    // The second iteration's own words reached the pull request, and the
    // first iteration's did not survive as its body.
    const [held] = forged.store.pullRequests;
    expect(held?.title).toBe(SECOND_PROPOSAL.title);
    expect(held?.body).toContain(SECOND_PROPOSAL.report);
    expect(held?.body).not.toContain(FIRST_PROPOSAL.report);

    // The revision turn carried the first iteration's own verdict, so the
    // second iteration was asked for by the review it answers.
    const revision = attempt.trace.calls.find((turn) => classify(turn.content) === "revision");
    expect(revision?.content).toContain(FIRST_VERDICT.review);
    expect(revision?.content).toContain(FIRST_VERDICT.revisionPrompt);
  });

  it("AC4: the retained evidence reaches the reviewer, and survives an explicit resume", function* () {
    const root = yield* useTempDirectory("xmd-composition-runs-");
    const remote = yield* useBareRemote(SEED);
    const forged = forge(remote, [RETAINED]);
    const script: Script = {
      checkpoints: [
        continues("the handoff is clear"),
        continues("the plan converged"),
        continues("the plan is authorized"),
        ASKS,
        continues("the change is complete"),
      ],
      planVerdicts: [{ passed: true, review: "REVIEW-PASS", revisionPrompt: "" }],
      implementationVerdicts: [SECOND_VERDICT],
      proposals: [FIRST_PROPOSAL],
      observations: 0,
    };

    const started = yield* attemptRun(root, "start", forged, script);
    const suspensionId = waited(started);

    // Each collection was read once, from the provider, in authored order.
    expect(forged.calls.filter(isRead)).toEqual([
      "read:reviews",
      "read:conversation",
      "read:inline",
      "read:check-runs",
      "read:status",
    ]);
    expect(started.kinds.filter((kind) => kind === "pull_request_read")).toHaveLength(3);

    // The exact retained values, in the two places the stage sends them: the
    // reviewing planner's own prompt, and the material the checkpoint assesses.
    // Compared as the JSON text each value serializes to, so a body that was
    // trimmed, reflowed or re-encoded on the way is a different string here.
    const verdict = started.trace.calls.find(
      (turn) => classify(turn.content) === "implementationVerdict",
    );
    const material = started.trace.calls.filter(
      (turn) => classify(turn.content) === "checkpoint",
    )[3];
    expect(verdict).toBeDefined();
    expect(material).toBeDefined();
    for (const value of [
      RETAINED.review.body,
      RETAINED.conversation.body,
      RETAINED.inline.body,
      RETAINED.checkRun.summary,
      RETAINED.status.description,
      RETAINED.checkRun.name,
      RETAINED.status.context,
    ]) {
      expect(verdict?.content).toContain(JSON.stringify(value));
      expect(material?.content).toContain(JSON.stringify(value));
    }
    // The material says it carries the reads themselves, and it does: what the
    // checkpoint was handed is the same text the reviewer judged.
    expect(material?.content).toContain("These are the exact retained reads the planner reviewed");

    // Nothing the forge holds crossed into either prompt.
    expect(verdict?.content).not.toContain(TOKEN);
    expect(material?.content).not.toContain(TOKEN);

    // The run waited rather than answering itself, and gave the lock back.
    expect(started.output).toBeUndefined();

    const before = forged.calls.length;
    yield* answer(root, suspensionId, {
      proceed: true,
      response: "RESPONSE-ACCEPTED",
      rationale: "RATIONALE-THE-CHECKS-ARE-UNDERSTOOD",
    });
    // Delivery retains and executes nothing: no forge call belongs to it.
    expect(forged.calls).toHaveLength(before);

    // Everything the start execution retained, in authored order: the
    // generated admission, the write its admitted fragment performed, the
    // effects written after it, and the wait — one sequence, no reordering.
    const retained = effects(started.kinds);
    expect(retained.slice(retained.indexOf("generated_xmd"))).toEqual([
      "generated_xmd",
      "workspace_file",
      "workspace_git_add",
      "workspace_git_commit",
      "git_host_effect",
      "git_host_effect",
      "pull_request_read",
      "pull_request_read",
      "pull_request_read",
      "agent_prompt",
      "agent_prompt",
      "suspension_request",
    ]);

    const resumed = yield* attemptRun(root, "resume", forged, script);
    expect(resumed.failure).toBeUndefined();

    // The continuation completed rather than waiting again, and it reached the
    // root's accepted branch — which only the delivered decision opens.
    expect(resumed.notice).toBeUndefined();
    expect(String(resumed.output)).toContain("# Accepted");
    expect(resumed.kinds.filter((kind) => kind === "suspension_answer")).toHaveLength(1);

    // The retained sequence was continued, not rewritten: everything the start
    // execution wrote is still there in the same order, and the continuation
    // only appended — the answer it spent, and the one turn left to take.
    expect(effects(resumed.kinds).slice(0, retained.length)).toEqual(retained);
    expect(effects(resumed.kinds).slice(retained.length)).toEqual([
      "suspension_answer",
      "agent_prompt",
    ]);

    // Nothing completed ran twice. The admitted fragment's write and the
    // commit that staged it stayed at one apiece across both executions, and
    // the run holds one commit rather than a second identical one.
    for (const once of ["generated_xmd", "workspace_git_add", "workspace_git_commit"]) {
      expect(resumed.kinds.filter((kind) => kind === once)).toHaveLength(1);
    }
    expect(commits(resumed.events)).toHaveLength(1);
    expect(resumed.kinds.filter((kind) => kind === "pull_request_read")).toHaveLength(3);

    // No provider was asked anything on the way back. Not the evidence reads,
    // and not the Git host either: the whole continuation made zero forge
    // calls, so every completed provider result came from what was retained.
    expect(forged.calls.slice(before)).toEqual([]);

    // And exactly one Agent turn was taken live — the acceptance checkpoint
    // the run had not reached yet. Every earlier prompt replayed from the
    // journal rather than being asked again.
    expect(resumed.trace.calls.map((turn) => classify(turn.content))).toEqual(["checkpoint"]);
  });

  /** A checkpoint that declines: the authored `<Elicit>` branch, answered `false`. */
  interface Gate {
    /** Which `<UserCheckpoint>` invocation asks, counting from the handoff. */
    readonly index: number;
    /** The heading `start.md` renders once this gate declines. */
    readonly report: string;
    readonly name: string;
  }

  /**
   * One supervised run declined at `gate`, from start through explicit resume.
   *
   * `turns` is every Agent turn the run took *live*, across both executions. A
   * continuation replays earlier prompts from the journal rather than asking
   * them again, so neither execution's trace alone is the run's turn history.
   */
  function* declineAt(
    root: string,
    gate: Gate,
    forged: Forge,
    script: Script,
  ): Operation<{
    started: Suspending;
    resumed: Suspending;
    rationale: string;
    turns: Turn[];
  }> {
    const runId = `declined-${gate.name}`;
    const rationale = `RATIONALE-DECLINED-${gate.name.toUpperCase()}`;
    const started = yield* attemptRun(root, "start", forged, script, runId);
    const suspensionId = waited(started);
    yield* answer(
      root,
      suspensionId,
      { proceed: false, response: `RESPONSE-DECLINED-${gate.name.toUpperCase()}`, rationale },
      runId,
    );
    const resumed = yield* attemptRun(root, "resume", forged, script, runId);
    const turns = [...started.trace.calls, ...resumed.trace.calls].map((turn) =>
      classify(turn.content),
    );
    return { started, resumed, rationale, turns };
  }

  /** The checkpoint script that asks at `index` and continues everywhere else. */
  function asksAt(index: number, total = 5): readonly Record<string, unknown>[] {
    return Array.from({ length: total }, (_, at) =>
      at === index ? ASKS : continues(`checkpoint ${at} needs nobody`),
    );
  }

  /**
   * AC6 — every declined gate stops before its first unauthorized effect.
   *
   * A decline is only meaningful if it happens *before* the thing it was
   * supposed to prevent, so each case names the first effect the next stage
   * would have performed and proves the run never reached it. The rendered
   * report is checked too, but it is never the whole claim: a document can say
   * "stopped" after having already pushed.
   *
   * Every gate here is a real `<Elicit>` under the workflow host — the only way
   * to reach `proceed: false`, since the authored `<Else>` branch always parses
   * an explicit `true`. So each case is a supervised run: start, suspend,
   * deliver a typed answer out of band, resume.
   *
   * Refusal of an invalid or duplicate answer is not restated here. That is one
   * provider contract and `packages/cli/tests/workflow-suspension.test.ts`
   * "CK5: an invalid and a duplicate delivery are refused, byte for byte" owns
   * it against a production host.
   */
  it("AC6: every declined gate stops before its first unauthorized effect", function* () {
    const root = yield* useTempDirectory("xmd-declined-runs-");

    // ── the handoff is not validated ────────────────────────────────────────
    // Nothing downstream of discovery may run: no planning turn, no proposal,
    // no mutation, and no forge call of any kind.
    {
      const remote = yield* useBareRemote(SEED);
      const forged = forge(remote, [RETAINED]);
      const { resumed, rationale, turns } = yield* declineAt(
        root,
        { index: 0, name: "handoff", report: "# Stopped: the handoff was not validated" },
        forged,
        {
          checkpoints: asksAt(0),
          planVerdicts: [{ passed: true, review: "REVIEW-PASS", revisionPrompt: "" }],
          implementationVerdicts: [SECOND_VERDICT],
          proposals: [FIRST_PROPOSAL],
          observations: 0,
        },
      );
      expect(resumed.failure).toBeUndefined();

      // The first thing a validated handoff authorizes is the planning turn.
      for (const forbidden of ["plan", "planVerdict", "observation", "implementationVerdict"]) {
        expect(turns).not.toContain(forbidden);
      }
      for (const forbidden of [
        "generated_xmd",
        "workspace_git_add",
        "workspace_git_commit",
        "git_host_effect",
        "pull_request_read",
      ]) {
        expect(resumed.kinds).not.toContain(forbidden);
      }
      expect(forged.calls).toEqual([]);
      expect(forged.store.pullRequests).toHaveLength(0);
      expect(forged.store.issues).toHaveLength(0);
      expect(commits(resumed.events)).toEqual([]);
      // The report corroborates what the absent effects already proved.
      expect(String(resumed.output)).toContain("# Stopped: the handoff was not validated");
      expect(String(resumed.output)).toContain(rationale);
    }

    // ── implementation is not authorized ────────────────────────────────────
    // Planning converged and was reviewed; the first thing authorization
    // authorizes is the implementor's observation turn, and past it the
    // admitted mutation.
    {
      const remote = yield* useBareRemote(SEED);
      const forged = forge(remote, [RETAINED]);
      const { resumed, rationale, turns } = yield* declineAt(
        root,
        { index: 2, name: "authorization", report: "# Stopped: implementation was not authorized" },
        forged,
        {
          checkpoints: asksAt(2),
          planVerdicts: [{ passed: true, review: "REVIEW-PASS", revisionPrompt: "" }],
          implementationVerdicts: [SECOND_VERDICT],
          proposals: [FIRST_PROPOSAL],
          observations: 0,
        },
      );
      expect(resumed.failure).toBeUndefined();

      // Planning ran; implementation did not.
      expect(turns).toContain("plan");
      expect(turns).toContain("planVerdict");
      for (const forbidden of ["observation", "implementationVerdict", "revision"]) {
        expect(turns).not.toContain(forbidden);
      }
      for (const forbidden of [
        "generated_xmd",
        "workspace_git_add",
        "workspace_git_commit",
        "git_host_effect",
        "pull_request_read",
      ]) {
        expect(resumed.kinds).not.toContain(forbidden);
      }
      expect(forged.calls).toEqual([]);
      expect(commits(resumed.events)).toEqual([]);
      expect(String(resumed.output)).toContain("# Stopped: implementation was not authorized");
      expect(String(resumed.output)).toContain(rationale);
    }

    // ── the pull-request review is declined ─────────────────────────────────
    // One iteration published and was reviewed. Declining stops the loop, so
    // the run must never revise, never file a deferred issue, and never ask
    // for acceptance — even though the verdict itself passed.
    {
      const remote = yield* useBareRemote(SEED);
      const forged = forge(remote, [RETAINED]);
      const { resumed, rationale, turns } = yield* declineAt(
        root,
        { index: 3, name: "review", report: "# Stopped: the pull-request review was declined" },
        forged,
        {
          checkpoints: asksAt(3),
          planVerdicts: [{ passed: true, review: "REVIEW-PASS", revisionPrompt: "" }],
          implementationVerdicts: [DEFERRING_VERDICT],
          proposals: [FIRST_PROPOSAL],
          observations: 0,
        },
      );
      expect(resumed.failure).toBeUndefined();

      // Exactly one iteration ran, and exactly four checkpoints were assessed —
      // the fourth being the one that declined. No acceptance was requested.
      expect(turns.filter((turn) => turn === "observation")).toHaveLength(1);
      expect(turns.filter((turn) => turn === "checkpoint")).toHaveLength(4);
      expect(turns).not.toContain("revision");
      expect(resumed.kinds.filter((kind) => kind === "generated_xmd")).toHaveLength(1);
      expect(resumed.kinds.filter((kind) => kind === "git_host_effect")).toHaveLength(2);
      expect(commits(resumed.events)).toHaveLength(1);

      // The verdict carried a `defer` finding, and declining the review is what
      // keeps it unfiled: the authored `<IssueTracker>` sits inside the branch
      // this decision closed.
      expect(DEFERRING_VERDICT.findings[0]?.disposition).toBe("defer");
      expect(forged.calls.filter((made) => made.startsWith("issues:"))).toEqual([]);
      expect(forged.store.issues).toHaveLength(0);
      expect(String(resumed.output)).toContain("# Stopped: the pull-request review was declined");
      expect(String(resumed.output)).toContain(rationale);
    }

    // ── final acceptance is declined ────────────────────────────────────────
    // The change was completed and reviewed. Declining acceptance rejects it
    // and appends nothing: no further turn, no further effect, no forge call.
    {
      const remote = yield* useBareRemote(SEED);
      const forged = forge(remote, [RETAINED]);
      const script: Script = {
        checkpoints: asksAt(4),
        planVerdicts: [{ passed: true, review: "REVIEW-PASS", revisionPrompt: "" }],
        implementationVerdicts: [SECOND_VERDICT],
        proposals: [FIRST_PROPOSAL],
        observations: 0,
      };
      const runId = "declined-acceptance";
      const started = yield* attemptRun(root, "start", forged, script, runId);
      const suspensionId = waited(started);
      const retained = effects(started.kinds);
      const before = forged.calls.length;
      const rationale = "RATIONALE-DECLINED-ACCEPTANCE";
      yield* answer(
        root,
        suspensionId,
        { proceed: false, response: "RESPONSE-DECLINED-ACCEPTANCE", rationale },
        runId,
      );
      const resumed = yield* attemptRun(root, "resume", forged, script, runId);

      expect(resumed.failure).toBeUndefined();

      // The continuation spent the answer and did nothing else: no turn, no
      // durable effect, no forge call after it.
      expect(effects(resumed.kinds).slice(0, retained.length)).toEqual(retained);
      expect(effects(resumed.kinds).slice(retained.length)).toEqual(["suspension_answer"]);
      expect(resumed.trace.calls).toEqual([]);
      expect(forged.calls.slice(before)).toEqual([]);
      expect(forged.store.issues).toHaveLength(0);
      expect(String(resumed.output)).toContain("# Rejected at acceptance");
      expect(String(resumed.output)).toContain(rationale);
      expect(String(resumed.output)).not.toContain("# Accepted");
    }
  });

  /** Five failing rounds, each distinguishable from the others. */
  const FIVE_PLAN_VERDICTS = Array.from({ length: 5 }, (_, round) => ({
    passed: false,
    review: `PLAN-REVIEW-FAIL-${round + 1}`,
    revisionPrompt: `PLAN-REVISION-PROMPT-${round + 1}`,
  }));

  const FIVE_PROPOSALS = Array.from({ length: 5 }, (_, round) => ({
    changes: `<File path="health.md">the health route, attempt ${round + 1}</File>`,
    title: `Add a health endpoint, attempt ${round + 1}`,
    commitMessage: `ATTEMPT-${round + 1}-COMMIT add a health endpoint`,
    report: `ATTEMPT-${round + 1}-IMPLEMENTOR-REPORT`,
  }));

  const FIVE_FAILING_VERDICTS = Array.from({ length: 5 }, (_, round) => ({
    passed: false,
    review: `PR-REVIEW-FAIL-${round + 1}`,
    revisionPrompt: `PR-REVISION-PROMPT-${round + 1}`,
    findings: [],
  }));

  /**
   * AC7 — both authored loops stop at five failures and await direction.
   *
   * `<Loop max={5}>` bounds each stage, and the caller's gate reads the pair it
   * returns: a checkpoint that kept approving with a verdict that never passed
   * is exhaustion, which is neither approval nor rejection. What the composed
   * root does with that is ask, and what it must not do is proceed.
   *
   * Neither subcase suspends. Exhaustion is reached with every checkpoint
   * continuing, so there is no `<Elicit>`, no retained wait and no resume here
   * — and nothing in this suite adds one. The awaiting-direction report is the
   * end of the run, not a durable question.
   *
   * The planning subcase asserts the composed outcome rather than restating
   * `scripts/tests/adversarial-planning-workflow.test.ts`, which owns the exact
   * internal routing of those twenty turns.
   */
  it("AC7: both authored loops stop at five failures and await direction", function* () {
    // ── planning never converges ────────────────────────────────────────────
    {
      const remote = yield* useBareRemote(SEED);
      const forged = forge(remote, [RETAINED]);
      const attempt = yield* runForge(forged, {
        checkpoints: [continues("nobody is needed for any of this")],
        planVerdicts: FIVE_PLAN_VERDICTS,
        implementationVerdicts: [SECOND_VERDICT],
        proposals: [FIRST_PROPOSAL],
        observations: 0,
      });
      expect(attempt.failure).toBeUndefined();

      const turns = attempt.trace.calls.map((turn) => classify(turn.content));
      // Five rounds, each one plan, one verdict, one checkpoint and one
      // revision — the fifth revision included, because the loop ends by
      // reaching its bound rather than by breaking out of it.
      expect(turns.filter((turn) => turn === "plan")).toHaveLength(5);
      expect(turns.filter((turn) => turn === "planVerdict")).toHaveLength(5);
      expect(turns.filter((turn) => turn === "planRevision")).toHaveLength(5);
      // The handoff checkpoint plus one per round. A seventh would be
      // authorization, and authorization is exactly what exhaustion withholds.
      expect(turns.filter((turn) => turn === "checkpoint")).toHaveLength(6);

      // Every round's own review reached the implementor that had to answer it.
      const revisions = attempt.trace.calls.filter(
        (turn) => classify(turn.content) === "planRevision",
      );
      for (const [round, prompt] of revisions.entries()) {
        expect(prompt.content).toContain(`PLAN-REVIEW-FAIL-${round + 1}`);
        expect(prompt.content).toContain(`PLAN-REVISION-PROMPT-${round + 1}`);
      }

      expect(String(attempt.output)).toContain(
        "# Awaiting direction: the plan review never passed",
      );
      // Not a rejection and not an approval.
      expect(String(attempt.output)).not.toContain("# Stopped");
      expect(String(attempt.output)).not.toContain("# Accepted");

      // Nothing implementation authorizes ever ran.
      for (const forbidden of ["observation", "implementationVerdict", "revision"]) {
        expect(turns).not.toContain(forbidden);
      }
      for (const forbidden of [
        "generated_xmd",
        "workspace_git_add",
        "workspace_git_commit",
        "git_host_effect",
        "pull_request_read",
      ]) {
        expect(attempt.kinds).not.toContain(forbidden);
      }
      expect(forged.calls).toEqual([]);
      expect(commits(attempt.events)).toEqual([]);
      // And no durable wait was created to ask about it.
      expect(attempt.kinds).not.toContain("suspension_request");
    }

    // ── the pull-request review never passes ────────────────────────────────
    {
      const remote = yield* useBareRemote(SEED);
      const forged = forge(remote, [RETAINED]);
      const attempt = yield* runForge(forged, {
        checkpoints: [continues("nobody is needed for any of this")],
        planVerdicts: [{ passed: true, review: "REVIEW-PASS", revisionPrompt: "" }],
        implementationVerdicts: FIVE_FAILING_VERDICTS,
        proposals: FIVE_PROPOSALS,
        observations: 0,
      });
      expect(attempt.failure).toBeUndefined();

      const turns = attempt.trace.calls.map((turn) => classify(turn.content));
      // Checked first, because it is the claim: handoff, the one planning
      // round, authorization, and one per iteration. A ninth checkpoint would
      // be the acceptance request, and exhaustion never makes one.
      expect(turns.filter((turn) => turn === "checkpoint")).toHaveLength(8);
      expect(turns.filter((turn) => turn === "observation")).toHaveLength(5);
      expect(turns.filter((turn) => turn === "implementationVerdict")).toHaveLength(5);
      expect(turns.filter((turn) => turn === "revision")).toHaveLength(5);

      // All five authored iterations really performed their work: five
      // admitted mutations, five commits, five publications and five pull
      // requests, each with its own three evidence reads.
      expect(attempt.kinds.filter((kind) => kind === "generated_xmd")).toHaveLength(5);
      expect(attempt.kinds.filter((kind) => kind === "workspace_git_add")).toHaveLength(5);
      expect(attempt.kinds.filter((kind) => kind === "workspace_git_commit")).toHaveLength(5);
      expect(attempt.kinds.filter((kind) => kind === "git_host_effect")).toHaveLength(10);
      expect(attempt.kinds.filter((kind) => kind === "pull_request_read")).toHaveLength(15);

      const made = commits(attempt.events);
      expect(made).toHaveLength(5);
      expect(new Set(made).size).toBe(5);

      // Five publications of one branch: the first creates it, the next four
      // advance it, and the remote ends at the fifth commit.
      const records = hostRecords(attempt.events);
      const pushes = records.filter((record) => record.request.kind === "git-push");
      expect(pushes).toHaveLength(5);
      expect(pushes.map((record) => record.decision)).toEqual(Array(5).fill("performed"));
      expect(pushes[0]?.preState).toEqual({ remoteCommit: null });
      for (const [index, push] of pushes.slice(1).entries()) {
        expect(push.preState).toEqual({ remoteCommit: made[index], relation: "ancestor" });
      }
      expect(remoteRefs(remote).get("refs/heads/agent/adversarial-implementation")).toBe(made[4]);

      // One pull request, created once and brought up to date four times.
      expect(forged.calls.filter((forgeCall) => forgeCall === "pulls:create")).toHaveLength(1);
      expect(forged.calls.filter((forgeCall) => forgeCall === "pulls:update")).toHaveLength(4);
      expect(forged.store.pullRequests).toHaveLength(1);
      expect(forged.store.pullRequests[0]?.title).toBe(FIVE_PROPOSALS[4]?.title);

      // No sixth iteration, no acceptance, no deferred issue, no later effect.
      // AC5 owns the positive: a `defer` finding does file one.
      expect(turns).not.toContain("planRevision");
      expect(forged.calls.filter((forgeCall) => forgeCall.startsWith("issues:"))).toEqual([]);
      expect(forged.store.issues).toHaveLength(0);
      expect(attempt.kinds).not.toContain("suspension_request");

      expect(String(attempt.output)).toContain(
        "# Awaiting direction: the pull-request review never passed",
      );
      expect(String(attempt.output)).not.toContain("# Accepted");
      expect(String(attempt.output)).not.toContain("# Rejected at acceptance");
      // The last review is what the report carries forward.
      expect(String(attempt.output)).toContain("PR-REVIEW-FAIL-5");
    }
  });

  it("AC5: a deferred finding becomes exactly one issue, and another disposition none", function* () {
    const remote = yield* useBareRemote(SEED);
    const forged = forge(remote, [RETAINED]);
    const attempt = yield* runForge(forged, {
      checkpoints: [
        continues("the handoff is clear"),
        continues("the plan converged"),
        continues("the plan is authorized"),
        continues(APPROVAL),
        continues("the change is complete"),
      ],
      planVerdicts: [{ passed: true, review: "REVIEW-PASS", revisionPrompt: "" }],
      implementationVerdicts: [DEFERRING_VERDICT],
      proposals: [FIRST_PROPOSAL],
      observations: 0,
    });
    expect(attempt.failure).toBeUndefined();

    // The approved disposition filed exactly one issue, through exactly one
    // create. Nothing else about the run reached the tracker.
    expect(forged.calls.filter((made) => made.startsWith("issues:"))).toEqual([
      "issues:list",
      "issues:create",
    ]);
    expect(forged.store.issues).toHaveLength(1);

    const [filed] = forged.store.issues;
    const head = commits(attempt.events)[0] ?? "";
    const base = remoteRefs(remote).get("refs/heads/main") ?? "";
    expect(filed?.title).toBe(DEFERRED.title);
    for (const material of [
      DEFERRED.description,
      ...DEFERRED.evidence,
      `${LOCATOR}/pull/1`,
      "Deferred from pull request #1",
      head,
      base,
      // The user decision material the authored body quotes: the assessment
      // this checkpoint returned, and the response and rationale the
      // `<Else>` branch records when no person was needed.
      APPROVAL,
      "User response: continue",
    ]) {
      expect(filed?.body).toContain(material);
    }
    expect(head).not.toBe("");
    expect(base).not.toBe("");

    // What the authored body does *not* carry: the planner's review text. The
    // issue quotes the finding and the decision that deferred it; the review
    // itself stays in the checkpoint material the decision was made from.
    expect(filed?.body).not.toContain(DEFERRING_VERDICT.review);

    // The run went on to acceptance rather than stopping at the deferral.
    expect(typeof attempt.output).toBe("string");

    // The same stage, the same approval, one finding classified anything else:
    // no issue, and no call to the tracker at all. The deferral is what files
    // an issue, not the presence of a finding.
    const other = yield* useBareRemote(SEED);
    const otherForge = forge(other, [RETAINED]);
    const fixing = yield* runForge(otherForge, {
      checkpoints: [
        continues("the handoff is clear"),
        continues("the plan converged"),
        continues("the plan is authorized"),
        continues(APPROVAL),
        continues("the change is complete"),
      ],
      planVerdicts: [{ passed: true, review: "REVIEW-PASS", revisionPrompt: "" }],
      implementationVerdicts: [FIXING_VERDICT],
      proposals: [FIRST_PROPOSAL],
      observations: 0,
    });
    expect(fixing.failure).toBeUndefined();
    expect(otherForge.calls.filter((made) => made.startsWith("issues:"))).toEqual([]);
    expect(otherForge.store.issues).toHaveLength(0);
    // And neither run revised: a passing verdict breaks the loop, so no
    // revision turn was taken and no second push was attempted.
    for (const taken of [attempt, fixing]) {
      expect(taken.trace.calls.map((turn) => classify(turn.content))).not.toContain("revision");
    }
    expect(otherForge.calls.filter((made) => made === "git:push")).toHaveLength(1);
  });
});
