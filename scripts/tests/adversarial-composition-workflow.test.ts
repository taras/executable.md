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
  readonly planVerdict: Record<string, unknown>;
  /** One verdict per implementation iteration, in order. */
  readonly implementationVerdicts: readonly Record<string, unknown>[];
  /** One proposal per implementation iteration, in order. */
  readonly proposals: readonly Record<string, unknown>[];
  /** Observation envelopes returned before the proposal envelope. */
  readonly observations: readonly string[];
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
        return respond(store, request);
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
): Operation<Suspending> {
  return scoped(function* () {
    const transitions = yield* useWorkflowRunHost({ root });
    const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
    if (!acquired.ok) {
      throw acquired.error;
    }
    if (acquired.value.kind !== "acquired") {
      throw new Error(`the run ${RUN_ID} already has a live workflow executor`);
    }
    const lock = acquired.value.lock;
    const begun = yield* transitions.begin(
      lock,
      action === "start"
        ? {
            runId: RUN_ID,
            action,
            creation: { definition: definition(), base: "main", props: PROPS },
          }
        : { runId: RUN_ID, action },
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
function answer(root: string, suspensionId: string, value: Json): Operation<void> {
  return scoped(function* () {
    yield* useWorkflowInputDelivery({ root });
    const delivered = yield* WorkflowInputDelivery.operations.deliver({
      runId: RUN_ID,
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
      planVerdict: { passed: true, review: "REVIEW-PASS", revisionPrompt: "" },
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
      observations: [],
    });
    const turns = attempt.trace.calls.map((turn) => classify(turn.content));

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
    const sessions = attempt.trace.calls.map((turn) => turn.session);
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

  /**
   * AC3 — the revision loop, driven to where the composition stops.
   *
   * The scenario asked for is two full iterations ending in a numbered update
   * of one pull request. What the composition does is publish the first
   * iteration, review it, take the revision turn, commit the second iteration
   * — and then refuse its own second `<Git.Push>`.
   *
   * That refusal is shipped behaviour, not a fixture accident:
   * `<Git.Push>` reconciles a destination ref to one exact commit, so a
   * destination holding any other commit is a conflict, and the commit it
   * holds here is the one this same run published one iteration earlier
   * (`packages/workflow/tests/git-push.test.ts` states the same rule against a
   * branch someone else moved). `Implementation.md` pushes the same
   * `props.branch` on every pass, so the numbered-update contract its prose
   * reasons about at length is unreachable through the effects it writes.
   *
   * This case therefore asserts the whole ordered sequence up to that refusal,
   * and pins the refusal itself: what is proven is where the composition
   * stops, and that it stops without forcing anything.
   */
  it("AC3: a revision iteration commits, and the composition refuses its own second push", function* () {
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
      planVerdict: { passed: true, review: "REVIEW-PASS", revisionPrompt: "" },
      implementationVerdicts: [FIRST_VERDICT, SECOND_VERDICT],
      proposals: [FIRST_PROPOSAL, SECOND_PROPOSAL],
      observations: [],
    });
    // Both iterations ran, in authored order: the first envelope, its verdict
    // and review checkpoint, the revision turn in the same implementor
    // session, and the second iteration's own envelope.
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
    ]);

    // Every turn of both iterations went to the session its document names,
    // and the revision turn went to the same implementor session that made the
    // proposal it revises.
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
    ]);

    // The complete ordered forge trace. The first iteration observes the
    // remote, publishes, observes the pull requests from this head, creates
    // one, and reads all three evidence collections — the checks read looking
    // the pull request up first, because the head it reads checks at is the
    // one the host reports rather than one this run asserts. The second
    // iteration reaches exactly one call: the observation its push makes.
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
    ]);

    // The complete ordered effect sequence the run retained. Each iteration
    // admits its proposal, writes it, stages it and commits it before any
    // remote effect, and the pull request follows the push of its own
    // iteration rather than standing beside it.
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
    ]);

    // Two commits, and they are different commits: the second iteration's
    // proposal was admitted and performed rather than replaying the first.
    const made = commits(attempt.events);
    expect(made).toHaveLength(2);
    expect(made[0]).not.toBe(made[1]);

    // The one pull request this forge holds is the first iteration's, opened
    // from the commit the first `<Git.Commit>` retained and the first
    // `<Git.Push>` published — matching evidence from its own iteration.
    expect(forged.store.pullRequests).toHaveLength(1);
    const [opened] = forged.store.pullRequests;
    expect(opened?.number).toBe(1);
    expect(opened?.headSha).toBe(made[0]);
    expect(opened?.title).toBe(FIRST_PROPOSAL.title);
    expect(opened?.body).toContain(FIRST_PROPOSAL.report);
    expect(opened?.body).not.toContain(SECOND_PROPOSAL.report);

    // The revision turn carried the first iteration's own verdict, so the
    // second iteration was asked for by the review it answers.
    const revision = attempt.trace.calls.find((turn) => classify(turn.content) === "revision");
    expect(revision?.content).toContain(FIRST_VERDICT.review);
    expect(revision?.content).toContain(FIRST_VERDICT.revisionPrompt);

    // And there the composition stops. The second push is refused as a
    // conflict against the commit this run itself published, so no second
    // pull-request call is made and the numbered update never happens.
    expect(attempt.failure).toContain("already holds state this effect conflicts with");
    expect(forged.calls.filter((forgeCall) => forgeCall.startsWith("pulls:"))).toEqual([
      "pulls:list",
      "pulls:list",
      "pulls:create",
      "pulls:lookup",
    ]);

    // Nothing was forced: the remote still holds the first iteration's commit,
    // and the second iteration's commit was never published.
    const refs = remoteRefs(remote);
    expect(refs.get("refs/heads/agent/adversarial-implementation")).toBe(made[0]);
    expect([...refs.values()]).not.toContain(made[1]);
  });

  /**
   * AC4 — what the reviewer is shown, and what a resume can reach.
   *
   * The projection half is provable in full: the exact retained reads reach
   * both the reviewing planner's prompt and the material the checkpoint
   * assesses, byte for byte. The replay half is not, and the reason is
   * recorded here rather than worked around.
   */
  it("AC4: the retained evidence reaches the reviewer, and a resume cannot reach it", function* () {
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
      planVerdict: { passed: true, review: "REVIEW-PASS", revisionPrompt: "" },
      implementationVerdicts: [SECOND_VERDICT],
      proposals: [FIRST_PROPOSAL],
      observations: [],
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

    // The resume cannot reach the reads, and the reason is not the reads.
    //
    // `Implementation.md` admits its proposal with `<Evaluate>`, whose
    // fragment performs a durable write, and a run cannot replay past an
    // `<Evaluate>` whose fragment performed a durable effect: the replayed
    // root terminates at the retained `generated_xmd` and never re-offers the
    // effect the fragment performed, so every element written after it —
    // including all three evidence reads — is unreachable on a resume.
    //
    // The same document with the same wait and no `<Evaluate>` resumes and
    // completes, and so does one whose evaluated fragment performs no durable
    // effect, so what this pins is the effect-bearing fragment rather than
    // suspension, delivery or replay in general.
    const resumed = yield* attemptRun(root, "resume", forged, script);
    // It diverges at the position of the write the evaluated fragment
    // performed — the generated `health.md` — which is the first thing after
    // the retained `generated_xmd` the replayed root fails to offer.
    expect(resumed.failure).toContain("Divergence");
    expect(resumed.failure).toContain("expected workspace_file");
    expect(resumed.failure).toContain("health.md");
    expect(resumed.output).toBeUndefined();

    // What can still be said about the reads: the resumed attempt asked the
    // evidence provider nothing. That is consistent with retention, and it is
    // not proof of it — the execution died before the reads were positioned —
    // so the retention claim stays open rather than being claimed here.
    expect(forged.calls.slice(before).filter(isRead)).toEqual([]);
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
      planVerdict: { passed: true, review: "REVIEW-PASS", revisionPrompt: "" },
      implementationVerdicts: [DEFERRING_VERDICT],
      proposals: [FIRST_PROPOSAL],
      observations: [],
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
      planVerdict: { passed: true, review: "REVIEW-PASS", revisionPrompt: "" },
      implementationVerdicts: [FIXING_VERDICT],
      proposals: [FIRST_PROPOSAL],
      observations: [],
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
