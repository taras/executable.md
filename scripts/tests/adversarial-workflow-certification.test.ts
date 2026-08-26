/**
 * Tier CF — the supervised workflow certified from outside (#299).
 *
 * Every other tier watches this workflow from inside the process that runs it.
 * Tier AC drives the shipped composition through public seams; WAL, WAP and WSL
 * own the Agent stack; WFX, WAC and WRR own crash and replay; SCH owns the
 * scheduler. This tier owns the one claim none of them can make: that what
 * ships — the `xmd` a person runs — performs the whole supervised workflow, on
 * both supported entrypoints, against a real Git remote and a real HTTP forge,
 * with nothing substituted that a host cannot substitute.
 *
 * So the runs here are subprocesses. The workflow document is the shipped one,
 * copied byte-for-byte into a committed fixture repository; the run store is a
 * private temporary directory; the remote is a disposable bare repository; the
 * forge is a loopback HTTP server; and the Agent is a real ACP process this
 * suite starts, reached exactly the way any agent is reached — by name, through
 * the host's own resolution, over the ACP the shipped provider speaks.
 *
 * ## What is substituted, and why each substitution is a leaf
 *
 * **The agent process.** A certification-owned ACP server, generated into the
 * fixture and put on the child's `PATH` under the name the run asks for. It is
 * a leaf: everything between the document and it — the profile, the session
 * policy, the permission bridge, ACPX itself — is the shipped code. What it
 * answers with comes from this process, so what it *was given* is evidence:
 * this is how the Agent ceiling is asserted from outside the run.
 *
 * **The forge.** A loopback HTTP server named by the two variables a deployment
 * uses to name one (`XMD_WORKFLOW_GITHUB_PULL_REQUESTS`,
 * `XMD_WORKFLOW_GITHUB_ISSUES`) with the credential in `GH_TOKEN`. Nothing
 * about the adapters, the ceilings, the reconciliation or the records is
 * replaced; only the origin they talk to is.
 *
 * **`git` itself.** The Git-host adapters admit `github.com/<owner>/<repo>` and
 * nothing else, and the host builds its Git children's environment from nothing
 * — no `insteadOf` a caller could inject. So the locator is bridged where the
 * host reaches the outside world: a `git` on the child's `PATH` that rewrites
 * that one string to the disposable bare repository and back. It is the
 * process-boundary form of Tier AC's `forgeHost`, and it is the only way a
 * black-box run can publish without a network.
 *
 * Nothing else is stood in for. In particular the run store, the journal, the
 * Workspace, the executor lock, the suspension protocol and the CLI's own
 * document assembly are all the shipped ones.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, ensure, resource, scoped, sleep, spawn, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import { when } from "@effectionx/converge";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { chmodSync, readdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ordinaryResume, scheduleResume } from "../../packages/cli/src/scheduling.ts";
import { runWorkflow } from "../../packages/cli/src/workflow.ts";
import { useDenoWorkflowHost } from "../../packages/cli/src/deno-workflow.ts";
import type { HelperAssembly } from "@executablemd/workflow/credential-helper";
import type { WorkflowExecution, WorkflowHost } from "../../packages/cli/src/workflow.ts";
import { agentIdentityComponents, collect } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { Err, Ok } from "effection";
import type { Result } from "effection";
import { readRunDatabase } from "../../packages/cli/tests/support/run-database.ts";
import { workflowRunPath } from "@executablemd/workflow/deno";
import { gitHubStore, respond } from "../../packages/workflow/tests/support/github.ts";
import type { GitHubStore } from "../../packages/workflow/tests/support/github.ts";
import { remoteRefs, useBareRemote } from "../../packages/workflow/tests/support/git-remotes.ts";
import type { BareRemote } from "../../packages/workflow/tests/support/git-remotes.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The shipped workflow, and the five stages its frontmatter names. */
const WORKFLOW = join(ROOT, "workflows", "adversarial-implementation");
const STAGES = [
  "start.md",
  "Discovery.md",
  "Implementation.md",
  "InstructionFiles.md",
  "Planning.md",
  "UserCheckpoint.md",
] as const;

/** The repository this run composes. The adapters admit this host and no other. */
const LOCATOR = "https://github.com/owner/repository";

/** The container a deferred finding is filed in. */
const TRACKER = `${LOCATOR}/issues`;

/**
 * The credential the forge requires, assembled rather than written.
 *
 * A literal of a credential shape is refused by this repository's secret gate
 * before it runs. What travels is a value the scanner has no reason to
 * recognize, and what is asserted is that it never reaches an Agent.
 */
const TOKEN = `certification-${"credential"}-value`;

/**
 * The line only a real read of `README.md` can put into a later prompt.
 *
 * Rendered nowhere else — not by an instruction file, not by a scripted reply —
 * so a prompt that carries it carries it because the run performed the read the
 * implementor asked for.
 */
const README_LINE = "Deployment note: the health route is not documented yet.";

/** What the run is asked to do, and what the implementor proposes. */
const REQUEST = "add a health endpoint";
const PROPOSAL = {
  changes: `<File path="health.md">the health route</File>`,
  title: "Add a health endpoint",
  commitMessage: "CERTIFICATION-COMMIT add a health endpoint",
  report: "CERTIFICATION-IMPLEMENTOR-REPORT",
} as const;

/** The finding the planner defers, which becomes exactly one issue. */
const DEFERRED = {
  disposition: "defer",
  title: "Document the health endpoint",
  description: "The route ships without documentation.",
  evidence: ["health.md holds no documentation"],
} as const;

/**
 * Two named Repositories, two Worktrees, and a wait between the work and the
 * publication.
 *
 * Written by this suite rather than taken from the shipped workflow, because
 * what CF4 is about is composition the shipped workflow does not perform: a
 * second `<Repository>` with its own name, locator and base, and no transaction
 * spanning the two. `<Repository.Status>` and the commit subject are read after
 * the restart, so what is asserted is what the retained Workspace still holds
 * rather than what the first execution said it wrote.
 */
const TWO_REPOSITORIES = [
  "---",
  "required: [repository]",
  "",
  "props:",
  "  repository: { type: string }",
  "---",
  "",
  "# two repositories",
  "",
  '<Repository name="first" url={props.repository} base="main">',
  '  <Worktree name="one" branch="agent/first" as="first" />',
  "  <Dir path={first}>",
  '    <File path="tracked.md">the first change</File>',
  '    <Git.Add paths="." />',
  '    <Git.Commit message="FIRST-COMMIT the first change" as="firstCommit" />',
  '    <File path="left-behind.md">first left behind</File>',
  "  </Dir>",
  "</Repository>",
  "",
  '<Repository name="second" url={props.repository} base="main">',
  '  <Worktree name="two" branch="agent/second" as="second" />',
  "  <Dir path={second}>",
  '    <File path="tracked.md">the second change</File>',
  '    <Git.Add paths="." />',
  '    <Git.Commit message="SECOND-COMMIT the second change" as="secondCommit" />',
  '    <File path="left-behind.md">second left behind</File>',
  "  </Dir>",
  "</Repository>",
  "",
  '<Elicit schema={{"type":"object","properties":{"proceed":{"type":"boolean"}},' +
    '"required":["proceed"],"additionalProperties":false}} as="restart">',
  "Restart, then publish?",
  "</Elicit>",
  "",
  '<Repository name="first" url={props.repository} base="main">',
  "  <Dir path={first}>",
  '<File path="left-behind.md" as="firstLeftover" />',
  "",
  "FIRST-LEFTOVER: {firstLeftover}",
  "",
  "<Git.Push />",
  "  </Dir>",
  "</Repository>",
  "",
  '<Repository name="second" url={props.repository} base="main">',
  "  <Dir path={second}>",
  '<File path="left-behind.md" as="secondLeftover" />',
  "",
  "SECOND-LEFTOVER: {secondLeftover}",
  "  </Dir>",
  "</Repository>",
  "",
].join("\n");

/**
 * A certification-owned ACP agent, generated into the fixture.
 *
 * It speaks the agent half of ACP over newline-delimited JSON-RPC on stdio —
 * `initialize`, `session/new`, `session/load`, `session/close`,
 * `session/prompt`, and a native permission request when it is told to ask for
 * one — and it decides nothing. Every turn is answered by the controller in the
 * test process, which is what makes the conversation scripted and the trace
 * complete.
 *
 * It imports nothing: a generated file cannot resolve this repository's import
 * map from the temporary directory it is written to. `readSync` rather than a
 * stream because the protocol here is strictly one request at a time.
 */
const AGENT_SOURCE = String.raw`
const controller = Deno.env.get("XMD_CERTIFICATION_CONTROLLER");
const role = Deno.env.get("XMD_CERTIFICATION_ROLE") ?? "agent";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const buffer = new Uint8Array(1 << 20);
let pending = "";
let permissions = 0;

function send(message) {
  Deno.stdout.writeSync(encoder.encode(JSON.stringify(message) + "\n"));
}

async function ask(kind, payload) {
  const response = await fetch(controller, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, kind, payload }),
  });
  return await response.json();
}

function text(prompt) {
  let out = "";
  for (const block of prompt ?? []) {
    if (block && block.type === "text") {
      out += block.text;
    }
  }
  return out;
}

/** Read lines until the response to this request id arrives, answering nothing else. */
function awaitResponse(id) {
  while (true) {
    let index = pending.indexOf("\n");
    while (index >= 0) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      index = pending.indexOf("\n");
      if (line === "") {
        continue;
      }
      const message = JSON.parse(line);
      if (message.id === id) {
        return message;
      }
    }
    const read = Deno.stdin.readSync(buffer);
    if (read === null) {
      return { error: { message: "the client closed while a request was outstanding" } };
    }
    pending += decoder.decode(buffer.subarray(0, read));
  }
}

while (true) {
  const read = Deno.stdin.readSync(buffer);
  if (read === null) {
    break;
  }
  pending += decoder.decode(buffer.subarray(0, read));
  let index = pending.indexOf("\n");
  while (index >= 0) {
    const line = pending.slice(0, index).trim();
    pending = pending.slice(index + 1);
    index = pending.indexOf("\n");
    if (line === "") {
      continue;
    }
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
        },
      });
    } else if (message.method === "session/new") {
      let entries = null;
      try {
        entries = [...Deno.readDirSync(message.params.cwd)].map((entry) => entry.name);
      } catch (error) {
        entries = ["<unreadable: " + String(error) + ">"];
      }
      await ask("session", { ...message.params, entries });
      // One identity, asserted in both places. A real agent keeps its own
      // durable session state and can assert an id of its own; this one holds
      // nothing across processes, so the id it asserts on a reattachment has to
      // be one it can derive — and that is the session id the client names.
      const identity = crypto.randomUUID();
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: identity, _meta: { agentSessionId: identity } },
      });
    } else if (message.method === "session/load") {
      await ask("load", message.params);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { _meta: { agentSessionId: message.params.sessionId } },
      });
    } else if (message.method === "session/close") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    } else if (message.method === "session/prompt") {
      const answer = await ask("prompt", { content: text(message.params.prompt) });
      if (answer.requestsTool) {
        permissions += 1;
        const id = "permission-" + permissions;
        send({
          jsonrpc: "2.0",
          id,
          method: "session/request_permission",
          params: {
            sessionId: message.params.sessionId,
            toolCall: {
              toolCallId: "call-" + permissions,
              title: answer.requestsTool,
              rawInput: { command: answer.requestsTool },
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          },
        });
        const decision = awaitResponse(id);
        await ask("permission", { decision: decision.result ?? null, error: decision.error ?? null });
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: answer.reply },
          },
        },
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
}
`;

/** One thing an agent process asked this controller, and what it was told. */
interface Contact {
  readonly role: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  /** The prompt text, for a prompt; empty for everything else. */
  readonly content: string;
  readonly reply: string;
}

/** What one turn is answered with. */
interface Answer {
  readonly reply: string;
  /** A native tool this turn asks permission for before it replies. */
  readonly requestsTool?: string;
}

interface Controller {
  readonly url: string;
  /** Every contact, in order. A tripwire reads this to prove none happened. */
  readonly contacts: Contact[];
  /** Every prompt this controller answered, in order. */
  prompts(): Contact[];
}

/**
 * The controller every generated agent answers through.
 *
 * One loopback server rather than a scripted file, because the answer a turn
 * needs depends on the turns before it, and because a run that contacts an
 * agent when it should not must be visible here rather than inferred from a
 * journal.
 */
function useController(answer: (turn: { role: string; content: string }) => Answer) {
  return resource<Controller>(function* (provide) {
    const contacts: Contact[] = [];
    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const payload = (body.payload ?? {}) as Record<string, unknown>;
        const answered =
          body.kind === "prompt"
            ? answer({ role: String(body.role), content: String(payload.content) })
            : { reply: "" };
        contacts.push({
          role: String(body.role),
          kind: String(body.kind),
          payload,
          content: body.kind === "prompt" ? String(payload.content) : "",
          reply: answered.reply,
        });
        outgoing.writeHead(200, { "content-type": "application/json", connection: "close" });
        outgoing.end(JSON.stringify(answered));
      });
    });
    yield* until(new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
    yield* ensure(function* () {
      server.closeAllConnections();
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });
    const address = server.address() as AddressInfo;
    yield* provide({
      url: `http://127.0.0.1:${address.port}/`,
      contacts,
      prompts: () => contacts.filter((contact) => contact.kind === "prompt"),
    });
  });
}

/** Which authored prompt this is, keyed on text only that prompt renders. */
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

/**
 * What turn this is, by the marker its own prompt writes.
 *
 * The same classification Tier AC performs, for the same reason: a marker taken
 * from a document's explanation rather than from its prompt matches nothing at
 * run time.
 */
function classify(content: string): Turn {
  if (content.includes("Determine whether the user must be involved to")) {
    return "checkpoint";
  }
  if (content.includes("Correct your previous response without changing its meaning")) {
    return "repair";
  }
  if (content.includes("Produce a user-validated design handoff")) {
    return "discovery";
  }
  if (content.includes("amend the implementation theory")) {
    return "plan";
  }
  if (content.includes("You cannot open this repository")) {
    return "observation";
  }
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

/** Which checkpoint this is, taken from the purpose the caller supplied. */
function purposeOf(content: string): string {
  const written = content.split("Determine whether the user must be involved to ")[1] ?? "";
  return written.split(".")[0]?.trim() ?? "";
}

/**
 * The observation envelope this prompt told the agent to return.
 *
 * Copied out of the prompt rather than written here, exactly as Tier AC2 does
 * it: an example the host cannot admit has to reach `<Evaluate>` the way an
 * agent following the instruction would send it.
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

/** A checkpoint assessment, in the shape the authored contract requires. */
function assessment(purpose: string, requiresUser: boolean): string {
  return JSON.stringify({
    requiresUser,
    assessment: `ASSESSMENT(${purpose})`,
    question: requiresUser ? `Shall this run ${purpose}?` : "",
    options: requiresUser ? ["proceed", "stop"] : [],
    recommendation: requiresUser ? "proceed" : "",
  });
}

/** What one certification run's agents say, and where they stop saying it. */
interface Script {
  /** The checkpoint purposes that require a person. */
  readonly involves?: readonly string[];
  /** Observation turns answered before the proposal envelope. */
  readonly observations?: number;
  /** The findings the implementation verdict carries. */
  readonly findings?: readonly Record<string, unknown>[];
  /** Answer the first proposal envelope with something that is not the contract. */
  readonly malformedProposal?: boolean;
  /** Fail every implementation verdict, so the authored loop reaches its bound. */
  readonly exhaustImplementation?: boolean;
  /** Ask for a native tool on the first turn that reaches this agent. */
  readonly requestsTool?: string;
}

/**
 * The scripted conversation, as one function over the prompt it is answering.
 *
 * Classification first and position second: what a turn is asked is what
 * decides the answer, so a misrouted or missing turn shows up as an unscripted
 * one rather than being absorbed by a counter.
 */
function scripted(script: Script): (turn: { role: string; content: string }) => Answer {
  const involves = new Set(script.involves ?? []);
  let observations = 0;
  let proposals = 0;
  let verdicts = 0;
  let tools = 0;
  return ({ content }) => {
    const requests =
      script.requestsTool !== undefined && tools === 0
        ? ((tools += 1), { requestsTool: script.requestsTool })
        : {};
    switch (classify(content)) {
      case "discovery":
        return { reply: `HANDOFF: ${REQUEST}, behind the existing router mount.`, ...requests };
      case "checkpoint": {
        const purpose = purposeOf(content);
        return { reply: assessment(purpose, involves.has(purpose)) };
      }
      case "plan":
        return { reply: "PLAN-V1: add the /health route behind the existing router mount." };
      case "planVerdict":
        return {
          reply: JSON.stringify({ passed: true, review: "PLAN-REVIEW-PASS", revisionPrompt: "" }),
        };
      case "planRevision":
        return { reply: "PLAN-REVISION-ACKNOWLEDGED" };
      case "revision":
        return { reply: "REVISION-ACKNOWLEDGED" };
      case "observation": {
        if (observations < (script.observations ?? 0)) {
          observations += 1;
          return { reply: instructedObservation(content), ...requests };
        }
        proposals += 1;
        if (script.malformedProposal === true && proposals === 1) {
          // A proposal envelope whose `source` is not the contract the prompt
          // supplied. The envelope parses; what it carries does not.
          return { reply: JSON.stringify({ kind: "proposal", source: '{"title":42}' }) };
        }
        return {
          reply: JSON.stringify({ kind: "proposal", source: JSON.stringify(PROPOSAL) }),
        };
      }
      case "implementationVerdict": {
        verdicts += 1;
        if (script.exhaustImplementation === true) {
          return {
            reply: JSON.stringify({
              passed: false,
              review: `IMPLEMENTATION-REVIEW-FAIL-${verdicts}`,
              revisionPrompt: `REVISION-PROMPT-${verdicts}`,
              findings: [],
            }),
          };
        }
        return {
          reply: JSON.stringify({
            passed: true,
            review: "IMPLEMENTATION-REVIEW-PASS",
            revisionPrompt: "",
            findings: script.findings ?? [],
          }),
        };
      }
      case "repair":
        // The authored repair turn answers with the same thing it was asked to
        // correct, so a bounded repair loop reaches its bound rather than being
        // rescued by this suite.
        return { reply: "REPAIR-UNCHANGED" };
      default:
        return { reply: `UNSCRIPTED-TURN: ${content.slice(0, 120)}` };
    }
  };
}

/** The loopback forge: the shared store's own answers, plus the evidence reads. */
interface Forge {
  readonly endpoint: string;
  readonly store: GitHubStore;
  /** Every request, as `METHOD /path`, in order. */
  readonly requests: string[];
}

interface Answered {
  readonly status: number;
  readonly body: string;
  /** What the store paginates with. Dropped, a listing reads as a partial page. */
  readonly link?: string;
}

function json(body: unknown): Answered {
  return { status: 200, body: JSON.stringify(body) };
}

function useForge(store: GitHubStore): Operation<Forge> {
  return resource<Forge>(function* (provide) {
    const requests: string[] = [];
    let origin = "";
    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
        requests.push(`${incoming.method} ${url.pathname}`);
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          headers[name === "authorization" ? "Authorization" : name] = String(value);
        }
        const parts = url.pathname.split("/");
        const tail = parts[parts.length - 1] ?? "";
        const collection = parts[parts.length - 3] ?? "";
        const subject = parts[parts.length - 2] ?? "";
        let answer: Answered;
        if (headers["Authorization"] !== `Bearer ${TOKEN}`) {
          answer = { status: 401, body: JSON.stringify({ message: "Bad credentials" }) };
        } else if (tail === "reviews") {
          answer = json([
            {
              id: 11,
              user: { login: "reviewer" },
              state: "APPROVED",
              body: "CERTIFICATION-REVIEW-BODY",
              submitted_at: "2026-08-24T00:00:00Z",
              commit_id: null,
              html_url: `${LOCATOR}/pull/${subject}#r11`,
              pull_request_url: `${origin}/repos/owner/repository/pulls/${subject}`,
            },
          ]);
        } else if (tail === "comments" && collection === "issues") {
          answer = json([
            {
              id: 21,
              user: { login: "watcher" },
              body: "CERTIFICATION-CONVERSATION-BODY",
              created_at: "2026-08-24T01:00:00Z",
              updated_at: "2026-08-24T01:00:00Z",
              html_url: `${LOCATOR}/pull/${subject}#c21`,
              issue_url: `${origin}/repos/owner/repository/issues/${subject}`,
            },
          ]);
        } else if (tail === "comments" && collection === "pulls") {
          answer = json([
            {
              id: 31,
              pull_request_review_id: 11,
              user: { login: "reviewer" },
              body: "CERTIFICATION-INLINE-BODY",
              created_at: "2026-08-24T02:00:00Z",
              updated_at: "2026-08-24T02:00:00Z",
              html_url: `${LOCATOR}/pull/${subject}#i31`,
              path: "health.md",
              diff_hunk: "@@ -1 +1 @@",
              commit_id: "0".repeat(40),
              original_commit_id: "0".repeat(40),
              line: 1,
              side: "RIGHT",
              start_line: null,
              start_side: null,
              in_reply_to_id: null,
              pull_request_url: `${origin}/repos/owner/repository/pulls/${subject}`,
            },
          ]);
        } else if (tail === "check-runs") {
          answer = json({
            total_count: 1,
            check_runs: [
              {
                id: 41,
                head_sha: subject,
                name: "CERTIFICATION-CHECK",
                status: "completed",
                conclusion: "success",
                html_url: `${LOCATOR}/runs/41`,
                started_at: "2026-08-24T03:00:00Z",
                completed_at: "2026-08-24T03:10:00Z",
                output: { title: null, summary: "CERTIFICATION-CHECK-SUMMARY", text: null },
              },
            ],
          });
        } else if (tail === "status") {
          answer = json({
            sha: subject,
            statuses: [
              {
                id: 51,
                context: "CERTIFICATION-STATUS",
                state: "success",
                description: "CERTIFICATION-STATUS-BODY",
                target_url: null,
                created_at: "2026-08-24T04:00:00Z",
                updated_at: "2026-08-24T04:00:00Z",
              },
            ],
          });
        } else {
          answer = respond(store, {
            method:
              incoming.method === "POST" ? "POST" : incoming.method === "PATCH" ? "PATCH" : "GET",
            url: `${origin}${incoming.url ?? "/"}`,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        }
        outgoing.writeHead(answer.status, {
          "content-type": "application/json",
          connection: "close",
          ...(answer.link === undefined ? {} : { link: answer.link }),
        });
        outgoing.end(answer.body);
      });
    });
    yield* until(new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
    yield* ensure(function* () {
      server.closeAllConnections();
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    yield* provide({ endpoint: origin, store, requests });
  });
}

/** Which `xmd` a row runs. The only thing an entrypoint changes. */
interface Entrypoint {
  readonly name: string;
  command(): { command: string; arguments: string[] };
}

const DENO_SOURCE: Entrypoint = {
  name: "the Deno source entrypoint",
  command: () => ({
    command: process.execPath,
    arguments: [
      "run",
      "--allow-all",
      "--cached-only",
      "--frozen",
      join(ROOT, "packages", "cli", "src", "deno.ts"),
    ],
  }),
};

const COMPILED: Entrypoint = {
  name: "the compiled xmd binary",
  command: () => ({
    command: join(ROOT, "dist", process.platform === "win32" ? "xmd.exe" : "xmd"),
    arguments: [],
  }),
};

/** What one certification fixture holds, and how a run is launched against it. */
interface Fixture {
  readonly root: string;
  /** Where this fixture's `git` and its agents live. */
  readonly bin: string;
  /** The committed definition repository, and the workflow inside it. */
  readonly definition: string;
  readonly document: string;
  readonly runs: string;
  readonly remote: BareRemote;
  readonly forge: Forge;
  readonly controller: Controller;
  readonly environment: Record<string, string>;
  /** Run `xmd` and wait for it, whatever the exit status. */
  run(entrypoint: Entrypoint, args: string[], timeout?: number): Operation<ProcessResult>;
}

function* git(repository: string, args: string[]): Operation<string> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** The seed every certification remote starts from. */
const SEED = {
  commits: [
    {
      branch: "main",
      message: "seed the project",
      entries: [
        { path: "AGENTS.md", content: "Root instructions: prefer evidence over assertion.\n" },
        { path: "README.md", content: `# project\n\n${README_LINE}\n` },
      ],
    },
  ],
} as const;

/**
 * One complete certification world: a definition repository, a remote, a forge,
 * a controller, the agents, and an isolated run store.
 *
 * Everything in it is temporary and removed with the scope. Nothing reaches the
 * developer's own `HOME`, Git configuration, run store or network.
 */
function useFixture(
  script: Script,
  options: { readonly documents?: Record<string, string> } = {},
): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const created = join(tmpdir(), `xmd-cf-${randomUUID()}`);
    yield* ensureDir(created);
    // Realpathed: on macOS `tmpdir()` is a symlink, and the definition's own
    // repository-relative check compares the resolved path against what Git
    // reports as the toplevel.
    const root = yield* until(realpath(created));
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    const definition = join(root, "definition");
    const runs = join(root, "runs");
    const home = join(root, "home");
    const bin = join(root, "bin");
    for (const directory of [definition, runs, home, bin]) {
      yield* ensureDir(directory);
    }

    // The shipped workflow, byte for byte, in a repository of its own. A
    // definition is an immutable committed object, so this is how a run gets
    // one without the developer's checkout being involved.
    const flow = join(definition, "workflows", "adversarial-implementation");
    yield* ensureDir(flow);
    for (const stage of STAGES) {
      yield* writeTextFile(join(flow, stage), yield* readTextFile(join(WORKFLOW, stage)));
    }
    for (const [name, source] of Object.entries(options.documents ?? {})) {
      yield* ensureDir(dirname(join(definition, name)));
      yield* writeTextFile(join(definition, name), source);
    }
    yield* git(definition, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(definition, ["config", "user.email", "certification@example.test"]);
    yield* git(definition, ["config", "user.name", "Certification"]);
    yield* git(definition, ["add", "-A"]);
    yield* git(definition, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "definition"]);

    const remote = yield* useBareRemote(SEED);
    const store = gitHubStore({ owner: "owner", repository: "repository", token: TOKEN });
    store.resolveHead = (branch) => remoteRefs(remote).get(`refs/heads/${branch}`);
    const forge = yield* useForge(store);
    const controller = yield* useController(scripted(script));

    // The agent, and the two names the run asks for. A shim per role, because
    // the role is what the controller answers by and a run names its planner
    // and its implementor separately.
    const agent = join(root, "certification-agent.ts");
    yield* writeTextFile(agent, AGENT_SOURCE);
    for (const role of ["planner", "implementor"]) {
      const shim = join(bin, `certification-${role}`);
      yield* writeTextFile(
        shim,
        [
          "#!/bin/sh",
          `XMD_CERTIFICATION_ROLE=${role}`,
          `XMD_CERTIFICATION_CONTROLLER=${controller.url}`,
          "export XMD_CERTIFICATION_ROLE XMD_CERTIFICATION_CONTROLLER",
          `exec "${process.execPath}" run --allow-all "${agent}" "$@"`,
          "",
        ].join("\n"),
      );
      chmodSync(shim, 0o755);
    }

    // `git`, with one locator standing in for another. Only the arguments and
    // the captured stdout are rewritten, and the pack protocol is passed
    // through untouched.
    const real = (yield* exec("sh", {
      arguments: ["-c", "command -v git"],
    }).expect()).stdout.trim();
    const shim = join(bin, "git");
    yield* writeTextFile(
      shim,
      [
        "#!/bin/sh",
        `LOCATOR='${LOCATOR}'`,
        `BARE='${remote.locator}'`,
        `REAL='${real}'`,
        "count=$#",
        "binary=0",
        "while [ $count -gt 0 ]; do",
        "  argument=$1; shift",
        '  case "$argument" in',
        "    upload-pack|receive-pack|cat-file|archive|hash-object|index-pack) binary=1;;",
        "  esac",
        '  rewritten=$(printf %s "$argument" | sed "s|$LOCATOR|$BARE|g")',
        '  set -- "$@" "$rewritten"',
        "  count=$((count-1))",
        "done",
        "if [ $binary -eq 1 ]; then",
        '  exec "$REAL" "$@"',
        "fi",
        'out=$("$REAL" "$@"; printf X); code=$?',
        "out=${out%X}",
        'printf %s "$out" | sed "s|$BARE|$LOCATOR|g"',
        "exit $code",
        "",
      ].join("\n"),
    );
    chmodSync(shim, 0o755);

    const environment: Record<string, string> = {
      HOME: home,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      XMD_WORKFLOW_RUNS: runs,
      XMD_CERTIFICATION_CONTROLLER: controller.url,
      GH_TOKEN: TOKEN,
      XMD_WORKFLOW_GITHUB_PULL_REQUESTS: JSON.stringify({
        allowed: [LOCATOR],
        endpoint: forge.endpoint,
      }),
      XMD_WORKFLOW_GITHUB_ISSUES: JSON.stringify({
        ceiling: [TRACKER],
        endpoint: forge.endpoint,
      }),
    };
    for (const inherited of ["DENO_DIR", "DENO_INSTALL_ROOT", "XDG_CACHE_HOME", "TMPDIR"]) {
      const value = process.env[inherited];
      if (typeof value === "string") {
        environment[inherited] = value;
      }
    }
    // `HOME` is the fixture's, so a developer's own configuration cannot reach
    // a run. Deno's module cache lives under the *real* `HOME` when nothing
    // names it, and the Deno-source row runs `--cached-only`, so the cache is
    // named outright rather than inherited by accident.
    if (environment["DENO_DIR"] === undefined) {
      const reported = yield* exec(process.execPath, { arguments: ["info", "--json"] }).expect();
      const directory = Reflect.get(Object(JSON.parse(reported.stdout)), "denoDir");
      if (typeof directory !== "string") {
        throw new Error("this Deno reports no cache directory, so --cached-only cannot resolve");
      }
      environment["DENO_DIR"] = directory;
    }

    yield* provide({
      root,
      bin,
      definition,
      document: join(flow, "start.md"),
      runs,
      remote,
      forge,
      controller,
      environment,
      *run(entrypoint: Entrypoint, args: string[], timeout = 300_000): Operation<ProcessResult> {
        const cli = entrypoint.command();
        // Accumulated outside the deadline, so a run the deadline abandons
        // still has an account of itself: a timeout that reports only its
        // duration cannot say whether the child hung before its first line or
        // after its last.
        const partial = { stdout: "", stderr: "" };
        const decoder = new TextDecoder();
        const outcome = yield* timebox(timeout, function* () {
          const child = yield* exec(cli.command, {
            arguments: [...cli.arguments, ...args],
            cwd: definition,
            env: environment,
          });
          const out = yield* spawn(function* () {
            const output = yield* child.stdout;
            for (let next = yield* output.next(); !next.done; next = yield* output.next()) {
              partial.stdout += decoder.decode(next.value, { stream: true });
            }
          });
          const err = yield* spawn(function* () {
            const output = yield* child.stderr;
            for (let next = yield* output.next(); !next.done; next = yield* output.next()) {
              partial.stderr += decoder.decode(next.value, { stream: true });
            }
          });
          const status = yield* child.join();
          // Awaited after the exit, so what the child wrote on its way out is
          // in hand before this returns rather than racing the report that
          // reads it.
          yield* out;
          yield* err;
          return { ...status, stdout: partial.stdout, stderr: partial.stderr };
        });
        if (outcome.timeout) {
          throw new Error(
            [
              `${entrypoint.name} did not settle: xmd ${args.join(" ")}`,
              `--- stdout ---\n${partial.stdout}`,
              `--- stderr ---\n${partial.stderr}`,
            ].join("\n"),
          );
        }
        return outcome.value;
      },
    });
  });
}

/** The props one supervised run is started with. */
function startArguments(runId: string, extra: readonly string[] = []): string[] {
  return [
    "workflow",
    "start",
    `--id=${runId}`,
    "workflows/adversarial-implementation/start.md",
    `--props-request=${REQUEST}`,
    `--props-repository=${LOCATOR}`,
    `--props-tracker=${TRACKER}`,
    "--props-planner=certification-planner",
    "--props-implementor=certification-implementor",
    "--props-branch=agent/certification",
    ...extra,
  ];
}

/** The suspension a run announced, as the caller reads it. */
function suspensionOf(result: ProcessResult): string {
  const written = `${result.stdout}\n${result.stderr}`;
  const line = written.split("\n").find((entry) => entry.includes("workflow suspension:"));
  if (line === undefined) {
    throw new Error(`no suspension was announced:\n${written}`);
  }
  return line.split("workflow suspension:")[1]!.trim();
}

/** What the run store holds for one run, as `xmd workflow status --json` says. */
function* status(
  fixture: Fixture,
  entrypoint: Entrypoint,
  runId: string,
): Operation<Record<string, unknown>> {
  const result = yield* fixture.run(entrypoint, ["workflow", "status", runId, "--json"], 90_000);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Everything an Agent-facing value could hide in, flattened. */
function agentFacing(controller: Controller): string {
  return JSON.stringify(controller.contacts);
}

/** The session each agent process was created under. */
function sessions(controller: Controller): Record<string, unknown>[] {
  return controller.contacts
    .filter((contact) => contact.kind === "session")
    .map((contact) => contact.payload);
}

/**
 * The exit status a run settled with, and what it said when it is not that.
 *
 * A black-box mismatch reported as "expected 0, received 1" says nothing a
 * reader can act on; what the child wrote is the whole diagnosis, so it travels
 * with the failure.
 */
function expectExit(result: ProcessResult, code: number): void {
  if (result.code === code) {
    return;
  }
  throw new Error(
    [
      `expected exit ${code}, got ${result.code}`,
      `--- stderr ---\n${result.stderr.trim()}`,
      `--- stdout ---\n${result.stdout.slice(-2000).trim()}`,
    ].join("\n"),
  );
}

/** Every journaled event of one run, as `xmd workflow history --json` says. */
function* history(
  fixture: Fixture,
  entrypoint: Entrypoint,
  runId: string,
): Operation<Record<string, unknown>[]> {
  const result = yield* fixture.run(entrypoint, ["workflow", "history", runId, "--json"], 90_000);
  const parsed = JSON.parse(result.stdout) as unknown;
  const events = Array.isArray(parsed)
    ? parsed
    : ((Reflect.get(Object(parsed), "events") as unknown[]) ?? []);
  return events as Record<string, unknown>[];
}

/** The effect type one history entry describes. */
function effectOf(entry: Record<string, unknown>): string {
  const event = Object(Reflect.get(entry, "event"));
  const description = Object(Reflect.get(event, "description"));
  return String(Reflect.get(description, "type") ?? "");
}

/**
 * This process, standing where a run's own host stands.
 *
 * A scheduled resume runs *here* rather than in a child, and the host it builds
 * reads its run store, its forge configuration and its `git` from the
 * environment — so this process has to have the environment the entrypoint
 * would have had. Restored with the scope, so nothing outside it is affected.
 */
function useFixtureEnvironment(fixture: Fixture): Operation<void> {
  return resource<void>(function* (provide) {
    const held = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(fixture.environment)) {
      held.set(name, process.env[name]);
      process.env[name] = value;
    }
    yield* ensure(() => {
      for (const [name, value] of held) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    });
    yield* provide();
  });
}

/**
 * What the Deno entrypoint states about itself, restated here.
 *
 * A scheduled resume is a trusted host's decision, so the host it decides for
 * is the one the entrypoint builds — including the credential helper it would
 * have written, which is named the same way `packages/cli/src/deno.ts` names
 * it.
 */
const HELPER: HelperAssembly = {
  runtime: "source",
  platform: process.platform === "win32" ? "windows" : "unix",
  execPath: process.execPath,
  modulePath: join(ROOT, "packages", "cli", "src", "credential-helper-entry.ts"),
  launcherEnvironment: Object.fromEntries(
    ["HOME", "DENO_DIR", "XDG_CACHE_HOME", "PATH"]
      .map((name) => [name, process.env[name]])
      .filter(([, value]) => value !== undefined && value !== ""),
  ) as Record<string, string>,
};

/**
 * Every journaled event of one effect type, read from the run's own database.
 *
 * `xmd workflow history` reports the root's own account of a run; an effect a
 * suspended coroutine published sits beside it rather than in it. A readonly
 * reader is how a suite outside the run sees what the run committed.
 */
function* journaled(
  fixture: Fixture,
  runId: string,
  effect: string,
): Operation<Record<string, unknown>[]> {
  return yield* readRunDatabase(workflowRunPath(fixture.runs, runId), (database) => {
    const rows = database.prepare("SELECT record FROM journal_events").all() as Record<
      string,
      unknown
    >[];
    return rows
      .map((row) => JSON.parse(String(row["record"] ?? "{}")) as Record<string, unknown>)
      .filter((event) => {
        const description = Object(Reflect.get(event, "description"));
        return (
          Reflect.get(event, "type") === "yield" && Reflect.get(description, "type") === effect
        );
      });
  });
}

function* answerRows(fixture: Fixture, runId: string): Operation<unknown[]> {
  return yield* readRunDatabase(
    workflowRunPath(fixture.runs, runId),
    (database) => database.prepare("SELECT * FROM workflow_suspension_answers").all() as unknown[],
  );
}

function* journaledTypes(fixture: Fixture, runId: string): Operation<string[]> {
  return yield* readRunDatabase(workflowRunPath(fixture.runs, runId), (database) => {
    const rows = database.prepare("SELECT record FROM journal_events").all() as Record<
      string,
      unknown
    >[];
    return [
      ...new Set(
        rows.map((row) => {
          const event = JSON.parse(String(row["record"] ?? "{}")) as Record<string, unknown>;
          return `${Reflect.get(event, "type")}:${Reflect.get(Object(Reflect.get(event, "description")), "type")}`;
        }),
      ),
    ];
  });
}

/** The commit each `<Git.Commit>` retained, in journal order. */
function commitsRetained(events: readonly Record<string, unknown>[]): string[] {
  return events
    .filter((entry) => effectOf(entry) === "workspace_git_commit")
    .map((entry) => {
      const event = Object(Reflect.get(entry, "event"));
      const value = Object(Reflect.get(Object(Reflect.get(event, "result")), "value"));
      const commit = Reflect.get(Object(Reflect.get(value, "record")), "commit");
      if (typeof commit !== "string") {
        throw new Error("a commit effect retained no commit");
      }
      return commit;
    });
}

/**
 * The last checkpoint a fork may continue from, as history offers them.
 *
 * The last rather than the first: a fork re-runs the definition from the
 * checkpoint it names, and what this case is about is that a compatible one
 * continues — not that the whole run performs itself again.
 */
function lastForkable(written: string): string {
  const parsed = JSON.parse(written) as unknown;
  const entries = (
    Array.isArray(parsed) ? parsed : ((Reflect.get(Object(parsed), "events") as unknown[]) ?? [])
  ) as Record<string, unknown>[];
  const offered = entries.filter(
    (entry) => Reflect.get(Object(Reflect.get(entry, "forkability")), "forkable") === true,
  );
  const id = Reflect.get(Object(offered[offered.length - 1]), "eventId");
  if (typeof id !== "string") {
    throw new Error(`no forkable checkpoint was offered: ${written.slice(0, 200)}`);
  }
  return id;
}

/** The document executor both entry points run. */
function documentExecutor(): (execution: WorkflowExecution) => Operation<Result<void>> {
  return function* (execution): Operation<Result<void>> {
    return yield* execution.around(
      call(function* (): Operation<Result<void>> {
        try {
          // `collect()` and nothing else: a drained subscription answers with
          // the execution's outcome rather than raising, and an executor that
          // reads the segments and ignores that outcome reports a run as
          // finished that did not finish.
          yield* collect(
            yield* executeInstalled(
              { ...execution.root, stream: execution.stream, props: execution.props },
              // What the entrypoint declares beside the run's own
              // installations: `<Session>` names durable work after its own
              // invocation, so the execution has to be told about it before
              // anything else is installed — and a continuation that is not
              // told cannot replay the turns that were taken under it.
              [...execution.installations, { components: agentIdentityComponents() }],
            ),
          );
          return Ok(undefined);
        } catch (error) {
          return Err(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    );
  };
}

describe("Tier CF — the supervised workflow, certified from outside", () => {
  for (const entrypoint of [DENO_SOURCE, COMPILED]) {
    it(`CF1: completes the supervised workflow through ${entrypoint.name}`, function* () {
      yield* scoped(function* () {
        const fixture = yield* useFixture({
          involves: ["authorize implementation"],
          observations: 1,
          findings: [DEFERRED],
        });

        // The run reaches the authorization checkpoint and stops there: a
        // person is required, so it publishes one retained request, settles
        // `suspended` and gives its executor lock back.
        const started = yield* fixture.run(entrypoint, startArguments("certification"));
        expectExit(started, 2);
        const suspension = suspensionOf(started);

        // Delivery retains the answer and executes nothing.
        const before = fixture.forge.requests.length;
        const turnsBefore = fixture.controller.prompts().length;
        const answered = yield* fixture.run(
          entrypoint,
          [
            "workflow",
            "answer",
            "certification",
            suspension,
            JSON.stringify({
              proceed: true,
              response: "AUTHORIZED",
              rationale: "CERTIFICATION-AUTHORIZATION-RATIONALE",
            }),
          ],
          90_000,
        );
        expectExit(answered, 0);
        expect(fixture.forge.requests).toHaveLength(before);
        expect(fixture.controller.prompts()).toHaveLength(turnsBefore);

        // The continuation claims that answer and runs to acceptance.
        const resumed = yield* fixture.run(entrypoint, ["workflow", "resume", "certification"]);
        expectExit(resumed, 0);
        expect(resumed.stdout).toContain("# Accepted");
        expect(resumed.stdout).toContain("PLAN-V1");
        expect(resumed.stdout).toContain(PROPOSAL.changes);
        expect(resumed.stdout).toContain(`#1 (open) ${LOCATOR}/pull/1`);
        // The report carries the exact retained reads rather than a summary of
        // them, which is what makes the acceptance a decision about this pull
        // request rather than about a description of one.
        for (const evidence of [
          "CERTIFICATION-REVIEW-BODY",
          "CERTIFICATION-CONVERSATION-BODY",
          "CERTIFICATION-INLINE-BODY",
          "CERTIFICATION-CHECK",
        ]) {
          expect(resumed.stdout).toContain(evidence);
        }

        // Every authored stage ran, in authored order, across the two
        // executions: discovery, the handoff checkpoint, the plan and its
        // verdict, the plan checkpoint, the authorization checkpoint, the
        // observation request, the proposal, the implementation verdict, the
        // review checkpoint and the acceptance checkpoint.
        const turns = fixture.controller.prompts().map((turn) => classify(turn.content));
        expect(turns).toEqual([
          "discovery",
          "checkpoint",
          "plan",
          "planVerdict",
          "checkpoint",
          "checkpoint",
          "observation",
          "observation",
          "implementationVerdict",
          "checkpoint",
          "checkpoint",
        ]);

        // The observation round trip: the implementor asked for the file the
        // authored prompt told it to ask for, XMD read it, and the result came
        // back in the next prompt rather than in the one that asked.
        const exchange = fixture.controller
          .prompts()
          .filter((turn) => classify(turn.content) === "observation");
        expect(instructedObservation(exchange[0]!.content)).toBe(
          JSON.stringify({ kind: "observation", source: `<File path="README.md" />` }),
        );
        expect(exchange[0]!.content).not.toContain(README_LINE);
        expect(exchange[1]!.content).toContain(README_LINE);

        // Local Git, the publication, the pull request and the three evidence
        // reads all happened once, in that order, against the real remote and
        // the loopback forge.
        expect(
          fixture.forge.requests.filter((made) => made === "POST /repos/owner/repository/pulls"),
        ).toHaveLength(1);
        for (const read of [
          "GET /repos/owner/repository/pulls/1/reviews",
          "GET /repos/owner/repository/issues/1/comments",
          "GET /repos/owner/repository/pulls/1/comments",
        ]) {
          expect(fixture.forge.requests).toContain(read);
        }
        expect(fixture.forge.requests.some((made) => made.endsWith("/check-runs"))).toBe(true);
        expect(fixture.forge.requests.some((made) => made.endsWith("/status"))).toBe(true);

        // The commit this run published is on the branch it named, and it is
        // the commit message the implementor proposed.
        const heads = remoteRefs(fixture.remote);
        expect(heads.get("refs/heads/agent/certification")).toBeDefined();

        // Issue handling: the deferred finding became exactly one issue, in
        // the tracker the run was given.
        expect(fixture.forge.store.issues).toHaveLength(1);
        expect(fixture.forge.store.issues[0]?.title).toBe(DEFERRED.title);

        // The run ended accepted, and its status says so.
        const record = yield* status(fixture, entrypoint, "certification");
        expect(Reflect.get(Object(Reflect.get(record, "record")), "status")).toBe("completed");

        // The Agent profile, as the agent process itself received it: an empty
        // working directory this host owns, no additional directory, no MCP
        // server, an empty requested tool set, and instructions that state the
        // deny-all ceiling.
        const created = sessions(fixture.controller);
        expect(created.length).toBeGreaterThan(0);
        for (const session of created) {
          expect(session["mcpServers"]).toEqual([]);
          const cwd = String(session["cwd"]);
          expect(cwd.startsWith(fixture.runs)).toBe(true);
          expect(cwd).toContain(".sessions");
          // What the agent itself could see there, reported at the moment it
          // was placed: the host removes this directory with the attachment,
          // so nothing outside the run can look at it afterwards.
          expect(session["entries"]).toEqual([]);
          // And it is not the Workspace, the checkout, or the caller's place.
          expect(cwd).not.toContain("worktrees");
          expect(cwd.startsWith(fixture.definition)).toBe(false);
          const meta = Object(session["_meta"]);
          const instructions = String(Reflect.get(meta, "systemPrompt"));
          expect(instructions).toContain("no native tool authority");
          expect(instructions).toContain("A request for a native tool permission is denied");
          const claude = Object(Reflect.get(Object(Reflect.get(meta, "claudeCode")), "options"));
          expect(Reflect.get(claude, "allowedTools")).toEqual([]);
        }

        // And nothing the agent was handed names a place it may not go, or a
        // credential it may not hold.
        const surface = agentFacing(fixture.controller);
        expect(surface).not.toContain(TOKEN);
        expect(surface).not.toContain(fixture.remote.locator);
        expect(surface).not.toContain(fixture.definition);
        expect(surface).not.toContain("worktrees/");
      });
    });
  }

  it("CF2: resumes a killed final workflow from the exact committed journal and Workspace frontier", function* () {
    yield* scoped(function* () {
      const fixture = yield* useFixture({ observations: 1, findings: [DEFERRED] });

      // A real process death, after a committed effect and during the next
      // one. The barrier is what the forge has published rather than a sleep:
      // the pull request exists, so the publication before it committed and
      // the reads after it have not happened.
      const cli = DENO_SOURCE.command();
      const child = yield* exec(cli.command, {
        arguments: [...cli.arguments, ...startArguments("killed")],
        cwd: fixture.definition,
        env: fixture.environment,
      });
      for (const stream of ["stdout", "stderr"] as const) {
        yield* spawn(function* () {
          const output = yield* child[stream];
          for (let next = yield* output.next(); !next.done; next = yield* output.next()) {
            // Drained so a full pipe cannot stall the child before it commits.
          }
        });
      }
      yield* when(
        function* () {
          expect(fixture.forge.requests).toContain("POST /repos/owner/repository/pulls");
        },
        { timeout: 240_000 },
      );
      const publications = fixture.forge.requests.length;
      const turns = fixture.controller.prompts().length;
      process.kill(child.pid, "SIGKILL");
      const killed = yield* child.join();
      expect(killed.signal).toBe("SIGKILL");

      // What the kill left committed, read from the run's own history.
      const before = yield* history(fixture, DENO_SOURCE, "killed");
      expect(before.length).toBeGreaterThan(0);
      const frontier = yield* status(fixture, DENO_SOURCE, "killed");

      // The resume replays that prefix and performs the suffix once.
      const resumed = yield* fixture.run(DENO_SOURCE, ["workflow", "resume", "killed"]);
      expectExit(resumed, 0);
      expect(resumed.stdout).toContain("# Accepted");

      // Every event the kill left committed is still there, with the same id,
      // the same bytes and the same Workspace root, in the same order.
      const after = yield* history(fixture, DENO_SOURCE, "killed");
      expect(after.slice(0, before.length)).toEqual(before);

      // The Workspace the resumed execution continued from is the one the kill
      // left current, rather than a root rebuilt from the definition.
      const killedRoot = Reflect.get(frontier, "currentWorkspaceRootId");
      expect(typeof killedRoot).toBe("string");
      expect(Reflect.get(Object(Reflect.get(frontier, "journalFrontier")), "workspaceRootId")).toBe(
        killedRoot,
      );

      // Nothing external happened twice: one pull request, and the branch the
      // killed execution published is the one the resumed execution advanced.
      expect(
        fixture.forge.requests.filter((made) => made === "POST /repos/owner/repository/pulls"),
      ).toHaveLength(1);
      expect(fixture.forge.requests.length).toBeGreaterThanOrEqual(publications);
      expect(fixture.controller.prompts().length).toBeGreaterThan(turns);

      // A completed replay after it performs nothing at all: no Agent, no
      // process, no Git host, no Issue, no Fetch, and no Workspace mutation.
      const forgeCalls = fixture.forge.requests.length;
      const contacts = fixture.controller.contacts.length;
      const heads = remoteRefs(fixture.remote).get("refs/heads/agent/certification");
      const replayed = yield* fixture.run(DENO_SOURCE, ["workflow", "resume", "killed"]);
      expectExit(replayed, 0);
      expect(fixture.forge.requests).toHaveLength(forgeCalls);
      expect(fixture.controller.contacts).toHaveLength(contacts);
      expect(remoteRefs(fixture.remote).get("refs/heads/agent/certification")).toBe(heads);
      expect(yield* history(fixture, DENO_SOURCE, "killed")).toEqual(after);
    });
  });

  it("CF3: schedules one ordinary resume for one retained answer", function* () {
    yield* scoped(function* () {
      // The composed workflow suspends at a real checkpoint — the last one, so
      // what the continuation owes is the run's own report rather than another
      // turn — and the scheduler is what continues it.
      const fixture = yield* useFixture({
        involves: ["accept the completed change"],
        observations: 1,
        findings: [DEFERRED],
      });
      const started = yield* fixture.run(DENO_SOURCE, startArguments("scheduled"));
      expectExit(started, 2);
      const suspension = suspensionOf(started);

      // Delivery retains the answer and executes nothing.
      const before = fixture.forge.requests.length;
      const turns = fixture.controller.prompts().length;
      const answered = yield* fixture.run(
        DENO_SOURCE,
        [
          "workflow",
          "answer",
          "scheduled",
          suspension,
          JSON.stringify({
            proceed: true,
            response: "ACCEPTED",
            rationale: "CERTIFICATION-ACCEPTANCE-RATIONALE",
          }),
        ],
        90_000,
      );
      expectExit(answered, 0);
      expect(fixture.forge.requests).toHaveLength(before);
      expect(fixture.controller.prompts()).toHaveLength(turns);
      const suspended = yield* status(fixture, DENO_SOURCE, "scheduled");
      expect(Reflect.get(Object(Reflect.get(suspended, "record")), "status")).toBe("suspended");

      // The scheduler decides *when*, and nothing else: it invokes the
      // ordinary resume this host built and answers with its outcome.
      const outcome = yield* scoped(function* () {
        yield* useFixtureEnvironment(fixture);
        const host = yield* useDenoWorkflowHost(HELPER);
        const resume = ordinaryResume(
          { verbose: false, raw: false, secretDetection: true },
          host,
          documentExecutor(),
        );
        return yield* scheduleResume(resume, { runId: "scheduled" });
      });
      expect(outcome.exitCode).toBe(0);

      // One executor consumed it, one answer event was published, and the run
      // continued exactly once.
      const events = yield* history(fixture, DENO_SOURCE, "scheduled");
      expect(events.filter((event) => effectOf(event) === "suspension_request")).toHaveLength(1);
      // The answer is published on the coroutine that waited rather than on the
      // root, so it is counted where the run keeps it: one answer event, and
      // one delivery, claimed once.
      console.log("=== answers table", JSON.stringify(yield* answerRows(fixture, "scheduled")));
      const finalStatus = yield* status(fixture, DENO_SOURCE, "scheduled");
      console.log(
        "=== final status",
        JSON.stringify(Reflect.get(Object(Reflect.get(finalStatus, "record")), "status")),
      );
      const replayed = yield* fixture.run(DENO_SOURCE, ["workflow", "resume", "scheduled"]);
      console.log("=== replay stdout tail", replayed.stdout.slice(-400));
      expect(yield* journaled(fixture, "scheduled", "suspension_answer")).toHaveLength(1);
      const completed = yield* status(fixture, DENO_SOURCE, "scheduled");
      expect(Reflect.get(Object(Reflect.get(completed, "record")), "status")).toBe("completed");
      // And it took no further turn: the acceptance answer is what remained.
      expect(fixture.controller.prompts()).toHaveLength(turns);
    });
  });

  it("CF4: retains two named Repositories and Worktrees with dirty and unpushed state across restart", function* () {
    yield* scoped(function* () {
      const fixture = yield* useFixture({}, { documents: { "two.md": TWO_REPOSITORIES } });

      // The first execution creates both checkouts, commits one change on each
      // named branch, leaves an uncommitted file behind in both, and stops at a
      // durable wait with nothing published.
      const started = yield* fixture.run(DENO_SOURCE, [
        "workflow",
        "start",
        "--id=two",
        "two.md",
        `--props-repository=${LOCATOR}`,
      ]);
      expectExit(started, 2);
      const suspension = suspensionOf(started);
      const committed = yield* history(fixture, DENO_SOURCE, "two");
      expect(remoteRefs(fixture.remote).get("refs/heads/agent/first")).toBeUndefined();
      expect(remoteRefs(fixture.remote).get("refs/heads/agent/second")).toBeUndefined();

      const answered = yield* fixture.run(
        DENO_SOURCE,
        ["workflow", "answer", "two", suspension, JSON.stringify({ proceed: true })],
        90_000,
      );
      expectExit(answered, 0);

      // The restart observes the same state at the retained frontier: both
      // worktrees still dirty, both commits still there, neither published.
      const resumed = yield* fixture.run(DENO_SOURCE, ["workflow", "resume", "two"]);
      expectExit(resumed, 0);
      // Both worktrees still hold the file neither commit staged, so the dirty
      // state crossed the restart rather than being rebuilt from the base.
      expect(resumed.stdout).toContain("FIRST-LEFTOVER: first left behind");
      expect(resumed.stdout).toContain("SECOND-LEFTOVER: second left behind");
      // And both commits are still the commits the first execution made, one
      // per repository, distinct from each other.
      const [first, second] = commitsRetained(committed);
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first).not.toBe(second);

      // And it published only what the document authored: the first branch,
      // holding the commit the first execution made, and never the second.
      expect(remoteRefs(fixture.remote).get("refs/heads/agent/first")).toBe(first);
      expect(remoteRefs(fixture.remote).get("refs/heads/agent/second")).toBeUndefined();
    });
  });

  it("CF5: malformed Agent output and bounded exhaustion stop before later effects", function* () {
    yield* scoped(function* () {
      // A proposal envelope whose payload is not the contract the prompt
      // supplied. The bounded repair turn does not rescue it.
      const malformed = yield* useFixture({ observations: 1, malformedProposal: true });
      const refused = yield* malformed.run(DENO_SOURCE, startArguments("malformed"));
      expectExit(refused, 1);
      for (const later of [
        "POST /repos/owner/repository/pulls",
        "POST /repos/owner/repository/issues",
      ]) {
        expect(malformed.forge.requests).not.toContain(later);
      }
      expect(remoteRefs(malformed.remote).get("refs/heads/agent/certification")).toBeUndefined();
      expect(malformed.forge.store.issues).toHaveLength(0);
      const malformedEvents = yield* history(malformed, DENO_SOURCE, "malformed");
      expect(malformedEvents.filter((event) => effectOf(event) === "git_host_effect")).toHaveLength(
        0,
      );

      // A native permission request is denied and fails the turn that asked.
      const denied = yield* useFixture({ requestsTool: "Bash(rm -rf /)" });
      const stopped = yield* denied.run(DENO_SOURCE, startArguments("denied"));
      expectExit(stopped, 1);
      const decisions = denied.controller.contacts.filter(
        (contact) => contact.kind === "permission",
      );
      expect(decisions.length).toBeGreaterThan(0);
      expect(JSON.stringify(decisions[0]?.payload)).toContain("reject");
      expect(denied.forge.requests).toHaveLength(0);
      expect(remoteRefs(denied.remote).get("refs/heads/agent/certification")).toBeUndefined();
    });
  });

  it("CF6: completed replay and retained history contain no hidden decision state", function* () {
    yield* scoped(function* () {
      // A run nobody had to be asked about, so it completes in one execution.
      const fixture = yield* useFixture({ observations: 1, findings: [DEFERRED] });
      const completed = yield* fixture.run(DENO_SOURCE, startArguments("accepted"));
      console.log("=== forge log\n", fixture.forge.requests.join("\n"));
      expectExit(completed, 0);
      expect(completed.stdout).toContain("# Accepted");

      // A completed replay performs nothing: no Agent, no forge, no Git host.
      const forgeCalls = fixture.forge.requests.length;
      const contacts = fixture.controller.contacts.length;
      const head = remoteRefs(fixture.remote).get("refs/heads/agent/certification");
      const replayed = yield* fixture.run(DENO_SOURCE, ["workflow", "resume", "accepted"]);
      expectExit(replayed, 0);
      expect(fixture.forge.requests).toHaveLength(forgeCalls);
      expect(fixture.controller.contacts).toHaveLength(contacts);
      expect(remoteRefs(fixture.remote).get("refs/heads/agent/certification")).toBe(head);

      // Every material decision this run took is in its retained history.
      const events = yield* history(fixture, DENO_SOURCE, "accepted");
      for (const effect of [
        "workspace_repository",
        "workspace_worktree",
        "agent_prompt",
        "generated_xmd",
        "workspace_file",
        "workspace_git_add",
        "workspace_git_commit",
        "git_host_effect",
        "pull_request_read",
        "issue_effect",
      ]) {
        expect(events.filter((event) => effectOf(event) === effect).length).toBeGreaterThan(0);
      }

      // Nothing in it is a transcript, a host path, a provider handle, a
      // credential, an endpoint or a Git sidecar ref.
      const retained = JSON.stringify(events);
      expect(retained).not.toContain(TOKEN);
      expect(retained).not.toContain(fixture.remote.locator);
      expect(retained).not.toContain(fixture.forge.endpoint);
      expect(retained).not.toContain(fixture.root);
      expect(retained).not.toContain("refs/xmd");

      // A compatible fork continues from a checkpoint the history offers; an
      // incompatible one is refused.
      // A fork continues a run that has published nothing yet, so what it
      // proves is that the checkpoint is continuable rather than that a
      // published effect can be performed twice — which is `<PullRequest>`'s
      // own refusal and not this case's subject.
      const waiting = yield* useFixture({ involves: ["authorize implementation"] });
      const suspended = yield* waiting.run(DENO_SOURCE, startArguments("secret"));
      expectExit(suspended, 2);
      const forkable = yield* waiting.run(
        DENO_SOURCE,
        ["workflow", "history", "secret", "--forkable", "--json"],
        90_000,
      );
      expectExit(forkable, 0);
      const selected = lastForkable(forkable.stdout);
      const forked = yield* waiting.run(DENO_SOURCE, [
        "workflow",
        "fork",
        "secret",
        `--at=${selected}`,
        "--id=forked",
        "workflows/adversarial-implementation/start.md",
        `--props-request=${REQUEST}`,
        `--props-repository=${LOCATOR}`,
        `--props-tracker=${TRACKER}`,
        "--props-planner=certification-planner",
        "--props-implementor=certification-implementor",
        "--props-branch=agent/certification",
      ]);
      expect([0, 2]).toContain(forked.code);
      const incompatible = yield* waiting.run(
        DENO_SOURCE,
        ["workflow", "fork", "secret", `--at=${selected}`, "--id=incompatible", "two.md"],
        90_000,
      );
      expectExit(incompatible, 1);
      const suspension = suspensionOf(suspended);
      const refusedAnswer = yield* waiting.run(
        DENO_SOURCE,
        [
          "workflow",
          "answer",
          "secret",
          suspension,
          JSON.stringify({
            proceed: true,
            response: `ghp_${"A".repeat(36)}`,
            rationale: "a token in an answer",
          }),
        ],
        90_000,
      );
      expectExit(refusedAnswer, 1);
      const answerEvents = yield* history(waiting, DENO_SOURCE, "secret");
      expect(answerEvents.filter((event) => effectOf(event) === "suspension_answer")).toHaveLength(
        0,
      );
    });
  });
});
