/**
 * `xmd prompt` — ask the configured agent for a document, prove it is one, let
 * a person decide, and then run it (specs/prompt-command-spec.md).
 *
 * The command adds authorship around one ordinary document; it adds no second
 * execution model. Everything before approval happens with no journal, no
 * durable identity and no execution: generation is a conversation, and a
 * conversation is not a run.
 *
 * The lifecycle is one ordered ownership chain, and no phase after the first
 * failure begins:
 *
 * ```text
 * fixed CLI preflight
 *   -> structured syntax catalog
 *   -> fresh generator session
 *   -> candidate props + validation
 *   -> automatic repair, at most three turns
 *   -> live approval or human revision
 *   -> generator teardown
 *   -> optional exclusive save
 *   -> ordinary in-memory document execution
 * ```
 *
 * Two kinds of failure are told apart throughout, because they have different
 * remedies. A *candidate* failure is something the agent wrote, so the agent is
 * asked to write it again with the validation facts. A *caller* failure is
 * something the command line or the environment said, so it terminates: teaching
 * the agent about it would spend a repair turn on a defect the agent cannot fix.
 */

import { Err, Ok, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  agentIdentityComponents,
  elicit,
  inspectDocument,
  retainedSource,
  validateDocument,
} from "@executablemd/core";
import type {
  DocumentValidation,
  DocumentValidationCode,
  Json,
  PropsSchema,
  RootDocumentSource,
  Session,
  SyntaxCatalog,
} from "@executablemd/core";
import type { AcpxProvider, AcpxProviderDependencies } from "@executablemd/acp";
import { cwd } from "@executablemd/runtime";

import { resolveAgentStack, useGeneratorAgent } from "./agent-stack.ts";
import type { AgentStack } from "./agent-stack.ts";
import type { AgentFlags } from "./agent-config.ts";
import type { MachineSessionAssembly } from "./session-coordinator.ts";
import {
  buildBindings,
  describeError,
  extractPropsArgs,
  resolvePropsFromSources,
} from "./props.ts";
import type { Binding, Extraction } from "./props.ts";
import { renderSyntaxMarkdown, useRunProfileRegistry } from "./syntax.ts";
import {
  isReservedOption,
  signatureFailure,
  signatureOf,
  strayPropertyValue,
} from "./prompt-args.ts";
import type { OptionSignature, PromptScan } from "./prompt-args.ts";

/**
 * The identity generated text runs under.
 *
 * Deliberate and fixed, the way `<eval>` is for an inline document: the bytes
 * came from an agent, not from a file, and a source position reading
 * `(<prompt>:5:1)` says so. It affects positions and diagnostics only —
 * components, includes and every relative filesystem operation still resolve
 * from the contextual working directory.
 */
export const PROMPT_IDENTITY = "<prompt>";

/** How many replacement drafts one candidate may be asked for automatically. */
export const REPAIR_TURNS = 3;

/** The approved bytes, and the props resolved under exactly those bytes. */
export interface PromptExecution {
  root: RootDocumentSource;
  props: Record<string, Json>;
}

/** What review approved: the exact candidate, and its own resolved props. */
interface ApprovedPrompt {
  source: string;
  props: Record<string, Json>;
}

/** What one `xmd prompt` invocation was asked to do. */
export interface PromptCommand {
  /** The argv this invocation holds, and the props source for every candidate. */
  argv: string[];
  /** What fixed grammar established about that argv. */
  scan: PromptScan;
  include: string[];
  /** Where the approved source is written before it runs, when asked for. */
  save?: string;
  agent: AgentFlags;
}

/** What the host supplies. Every entry is a decision only a host can make. */
export interface PromptDependencies {
  /** What this host states about machine-wide agent sessions, if anything. */
  sessions?: MachineSessionAssembly;
  /** What the generator provider is built on, beyond the host's own assembly. */
  acp?: AcpxProviderDependencies;
  /** The run profile's complete structured vocabulary. */
  catalog(includes: readonly string[]): Operation<SyntaxCatalog>;
  /** Who answers the review question. */
  installElicitation(): Operation<void>;
  /** Run the approved document the way this host runs any supplied one. */
  execute(approved: PromptExecution): Operation<Result<void>>;
}

/** The prompt-owned findings that are not core's to report. */
interface PromptDiagnostic {
  code: "generated-binding-collision" | "root-props-unreadable";
  message: string;
}

/** Everything definite that is wrong with one candidate. */
interface CandidateDefects {
  /** Core's complete versioned answer, whenever core produced one. */
  validation?: DocumentValidation;
  /** What this command found about the options the candidate generates. */
  prompt?: PromptDiagnostic;
}

type CandidateOutcome =
  | { kind: "valid"; props: Record<string, Json> }
  | { kind: "repairable"; defects: CandidateDefects }
  | { kind: "terminal"; error: Error };

/** A candidate offered for review, and what may be decided about it. */
type ReviewSubject =
  | { candidate: string; valid: true; props: Record<string, Json> }
  | { candidate: string; valid: false; defects: CandidateDefects };

interface ReviewDecision {
  decision: "approve" | "revise" | "abort";
  feedback?: string;
}

/** The codes that say the root's own declaration could not be read. */
const DECLARATION_CODES: ReadonlySet<DocumentValidationCode> = new Set<DocumentValidationCode>([
  "source-unreadable",
  "source-invalid",
  "target-invalid",
  "frontmatter-invalid",
  "props-declaration-invalid",
  "returns-declaration-invalid",
]);

const ABORTED = "xmd prompt: aborted at review — nothing was saved and nothing ran";

/**
 * Run the command, and report the process status it earned.
 *
 * Every phase is behind a returned value rather than behind a flag another
 * phase reads, so a refusal cannot be followed by the work it refused.
 */
export function* runPrompt(command: PromptCommand, deps: PromptDependencies): Operation<number> {
  const { scan } = command;
  if (scan.error !== undefined || scan.request === undefined) {
    console.error(scan.error ?? 'xmd prompt requires one request — `xmd prompt "<what you want>"`');
    return 1;
  }
  const request = scan.request;

  const stack = yield* resolveAgentStack(command.agent, deps.sessions);
  if (!stack.ok) {
    console.error(stack.error.message);
    return 1;
  }

  let instructions: string;
  try {
    instructions = generatorInstructions(yield* deps.catalog(command.include));
  } catch (error) {
    console.error(describeError(error));
    return 1;
  }

  // The generator lives and dies inside this scope. Leaving it is what closes
  // the provider, so a teardown failure is raised here — before the save and
  // the execution that would otherwise already have happened.
  let approved: Result<ApprovedPrompt>;
  try {
    approved = yield* scoped(function* (): Operation<Result<ApprovedPrompt>> {
      yield* deps.installElicitation();
      // The same vocabulary the catalog just described. Validation and the
      // catalog read one registry, so a component the generator was told about
      // is one validation resolves.
      yield* useRunProfileRegistry();
      const provider = yield* useGeneratorAgent(stack.value, instructions, deps.acp);
      const session = yield* provider.session(generatorSessionName());
      return yield* author(command, provider, session, request);
    });
  } catch (error) {
    console.error(describeError(error));
    return 1;
  }

  if (!approved.ok) {
    console.error(approved.error.message);
    return 1;
  }

  const { source, props } = approved.value;
  if (command.save !== undefined) {
    const saved = yield* saveSource(command.save, source);
    if (!saved.ok) {
      console.error(saved.error.message);
      return 1;
    }
  }

  const executed = yield* deps.execute({
    root: retainedSource(PROMPT_IDENTITY, source),
    props,
  });
  if (!executed.ok) {
    console.error(executed.error.message);
    return 1;
  }
  return 0;
}

/**
 * A logical session name nothing else can name.
 *
 * The conversation belongs to this invocation: a second `xmd prompt` places a
 * different session rather than continuing this one, and a request nobody meant
 * to repeat never arrives in a history it did not create.
 */
function generatorSessionName(): string {
  return `xmd-prompt:${randomUUID()}`;
}

/**
 * What the generator session is told once, before it is asked anything.
 *
 * The catalog is the run profile's own, rendered by the same renderer
 * `xmd syntax` uses — including its statement that a repository TypeScript
 * component's contract was not read, which is the honest thing to tell a writer
 * about a component nobody imported.
 */
export function generatorInstructions(catalog: SyntaxCatalog): string {
  return [
    "You write complete executable Markdown root documents. Each user message is a",
    "request for one document.",
    "",
    "Every answer is replacement document source and nothing else: no enclosing code",
    "fence, no explanation, and no prose around it. What you return is written to a",
    "file and executed exactly as you wrote it.",
    "",
    "A repair request carries the validation facts about the document you last sent.",
    "Answer it with another complete replacement document, not a patch and not a",
    "description of the change.",
    "",
    "The catalog below is the complete vocabulary available in the working directory",
    "this command runs in and in its configured include paths. Nothing outside it is",
    "available.",
    "",
    renderSyntaxMarkdown(catalog),
  ].join("\n");
}

/**
 * The authorship loop: draft, repair, review, revise.
 *
 * Each draft — the first one, and each answer to a human revision — starts its
 * own repair budget. A human revision has no numeric bound: the person asking
 * for changes is the one deciding when to stop.
 */
function* author(
  command: PromptCommand,
  provider: AcpxProvider,
  session: Session,
  request: string,
): Operation<Result<ApprovedPrompt>> {
  const frozen = new Map<string, OptionSignature>();
  let draft = yield* runTurn(provider, session, request);

  while (true) {
    if (!draft.ok) {
      return draft;
    }
    let candidate = draft.value;
    let budget = REPAIR_TURNS;
    let subject: ReviewSubject | undefined;

    while (subject === undefined) {
      const outcome = yield* evaluate(command, frozen, candidate);
      if (outcome.kind === "terminal") {
        return Err(outcome.error);
      }
      if (outcome.kind === "valid") {
        subject = { candidate, valid: true, props: outcome.props };
        break;
      }
      if (budget === 0) {
        subject = { candidate, valid: false, defects: outcome.defects };
        break;
      }
      budget -= 1;
      const repaired = yield* runTurn(provider, session, repairRequest(outcome.defects));
      if (!repaired.ok) {
        return repaired;
      }
      candidate = repaired.value;
    }

    const decided = yield* review(subject);
    if (!decided.ok) {
      return decided;
    }
    const decision = decided.value;
    if (decision.decision === "abort") {
      return Err(new Error(ABORTED));
    }
    if (decision.decision === "approve") {
      if (!subject.valid) {
        // The schema an exhausted candidate is offered has no approve value, so
        // an answer carrying one came from somewhere the question did not.
        return Err(
          new Error(
            "the review provider approved a document that does not validate, which the " +
              "question did not offer — nothing was saved and nothing ran",
          ),
        );
      }
      return Ok({ source: subject.candidate, props: subject.props });
    }
    draft = yield* runTurn(provider, session, revisionRequest(decision.feedback ?? ""));
  }
}

/**
 * One turn, consumed whole inside the provider's scope.
 *
 * Only a terminal `completed` produces a candidate. A failed, cancelled or
 * unavailable turn is a generation failure however much text it emitted, and the
 * partial text is discarded rather than presented: half a program is not one.
 */
function* runTurn(
  provider: AcpxProvider,
  session: Session,
  content: string,
): Operation<Result<string>> {
  return yield* scoped(function* (): Operation<Result<string>> {
    try {
      const subscription = yield* provider.promptStream(content, { session });
      let status: string | undefined;
      let stopReason: string | undefined;
      let failure: Error | undefined;
      let next = yield* subscription.next();
      while (!next.done) {
        const event = next.value;
        if (event.type === "terminal") {
          status = event.status;
          stopReason = event.stopReason;
          failure = event.error;
        }
        next = yield* subscription.next();
      }
      if (status !== "completed") {
        return Err(turnFailure(status, stopReason, failure));
      }
      return Ok(next.value);
    } catch (error) {
      return Err(toError(error));
    }
  });
}

function turnFailure(
  status: string | undefined,
  stopReason: string | undefined,
  failure: Error | undefined,
): Error {
  const detail =
    failure?.message ?? (stopReason === undefined ? undefined : `stop reason ${stopReason}`);
  const outcome = status ?? "produced no terminal event";
  return new Error(
    `the agent did not complete the turn (${outcome})` +
      (detail === undefined ? "" : `: ${detail}`) +
      " — nothing was reviewed, saved or run",
  );
}

/**
 * Everything decidable about one candidate, in the order that keeps a caller's
 * mistake from being taught to the agent.
 */
function* evaluate(
  command: PromptCommand,
  frozen: Map<string, OptionSignature>,
  candidate: string,
): Operation<CandidateOutcome> {
  const root = retainedSource(PROMPT_IDENTITY, candidate);
  const includes = command.include;
  const components = agentIdentityComponents();

  // Whether the root declares itself readably. Inspection would raise on a
  // malformed declaration, and recovering a code from an exception's prose is
  // exactly what the structured answer exists to replace.
  const declaration = yield* validateDocument({ ...root, includes, components });
  if (declaration.diagnostics.some((entry) => DECLARATION_CODES.has(entry.code))) {
    return { kind: "repairable", defects: { validation: declaration } };
  }

  let propsSchema: PropsSchema;
  try {
    propsSchema = (yield* inspectDocument(root)).props;
  } catch (error) {
    return {
      kind: "repairable",
      defects: { prompt: { code: "root-props-unreadable", message: describeError(error) } },
    };
  }

  let bindings: Binding[];
  try {
    bindings = buildBindings(propsSchema);
  } catch (error) {
    return {
      kind: "repairable",
      defects: {
        prompt: { code: "generated-binding-collision", message: describeError(error) },
      },
    };
  }

  // Before a single token is extracted: an option that changed shape would
  // otherwise reach forward and read the `--raw` written after it as its value.
  const drift = signatureFailure(frozen, bindings);
  if (drift !== undefined) {
    return { kind: "terminal", error: new Error(drift) };
  }
  const stray = strayPropertyValue(command.scan.occurrences, bindings);
  if (stray !== undefined) {
    return { kind: "terminal", error: new Error(stray) };
  }

  let extraction: Extraction;
  let props: Record<string, Json>;
  try {
    extraction = extractPropsArgs(command.argv, bindings, { reserved: isReservedOption });
    props = yield* resolvePropsFromSources({ propsSchema, bindings, extraction });
  } catch (error) {
    return { kind: "terminal", error: toError(error) };
  }

  for (const supplied of extraction.individual) {
    frozen.set(supplied.binding.option, signatureOf(supplied.binding));
  }

  const validation = yield* validateDocument({ ...root, props, includes, components });
  if (validation.outcome === "invalid") {
    return { kind: "repairable", defects: { validation } };
  }
  return { kind: "valid", props };
}

/**
 * The repair turn: the fixed instruction, and the facts, as data.
 *
 * Core's own versioned value travels whole. Nothing here renders a diagnostic
 * into prose and nothing parses one back out, so what the agent reads is what
 * validation concluded rather than a summary of it.
 */
function repairRequest(defects: CandidateDefects): string {
  return [
    "The document you sent does not validate. Send a complete replacement document",
    "that fixes every defect below. Reply with document source only.",
    "",
    fenced("json", JSON.stringify(defects, null, 2)),
  ].join("\n");
}

function revisionRequest(feedback: string): string {
  return [
    "A person reviewed the document and asked for this change:",
    "",
    feedback,
    "",
    "Send a complete replacement document. Reply with document source only.",
  ].join("\n");
}

/**
 * Ask a person, and read the one answer.
 *
 * The whole candidate is shown exactly as it will run, inside a fence chosen to
 * be longer than any backtick run the candidate holds — arbitrary source cannot
 * close a fence it cannot spell. Machinery stays out of what the person reads:
 * the schema, the session and the repair budget are none of their business.
 */
function* review(subject: ReviewSubject): Operation<Result<ReviewDecision>> {
  const decisions = subject.valid ? ["approve", "revise", "abort"] : ["revise", "abort"];
  const message = subject.valid
    ? [
        "The agent wrote this document. Approve it to run it, ask for a change, or abort.",
        "",
        fenced("md", subject.candidate),
      ].join("\n")
    : [
        "The agent could not produce a document that validates. Ask for a change, or abort.",
        "",
        fenced("md", subject.candidate),
        "",
        "Validation reported these defects:",
        "",
        fenced("json", JSON.stringify(subject.defects, null, 2)),
      ].join("\n");

  try {
    const answer = yield* elicit({
      message,
      schema: reviewSchema(decisions),
      label: "PromptReview",
    });
    return readDecision(answer);
  } catch (error) {
    return Err(toError(error));
  }
}

function reviewSchema(decisions: readonly string[]): Json {
  return {
    type: "object",
    title: "Review the generated document",
    properties: {
      decision: {
        type: "string",
        title: "Decision",
        enum: [...decisions],
      },
      feedback: {
        type: "string",
        title: "Feedback",
        description: "What to change. Required when asking for a revision.",
      },
    },
    required: ["decision"],
    additionalProperties: false,
    if: { properties: { decision: { const: "revise" } }, required: ["decision"] },
    then: { properties: { feedback: { type: "string", minLength: 1 } }, required: ["feedback"] },
  };
}

/** Read the provider's answer rather than assert it. */
function readDecision(answer: Json): Result<ReviewDecision> {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    return Err(new Error("the review provider answered with something that is not a decision"));
  }
  const decision = answer.decision;
  if (decision !== "approve" && decision !== "revise" && decision !== "abort") {
    return Err(new Error("the review provider answered with no decision"));
  }
  const feedback = answer.feedback;
  return Ok({
    decision,
    ...(typeof feedback === "string" ? { feedback } : {}),
  });
}

/**
 * A fence long enough that the body cannot close it. Three backticks at least,
 * and one more than the longest run the body holds.
 */
function fenced(language: string, body: string): string {
  let longest = 2;
  for (const run of body.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  const delimiter = "`".repeat(longest + 1);
  return [`${delimiter}${language}`, body, delimiter].join("\n");
}

/**
 * Create the destination and write the approved bytes, or refuse.
 *
 * Exclusive creation, so an existing path is left exactly as it is and the run
 * stops rather than replacing work somebody kept. There is no check-then-write:
 * the open is the check.
 */
function* saveSource(path: string, source: string): Operation<Result<void>> {
  const target = resolve(yield* cwd(), path);
  let handle: FileHandle;
  try {
    handle = yield* until(open(target, "wx"));
  } catch (error) {
    const existing =
      error instanceof Error &&
      (("code" in error && error.code === "EEXIST") || error.message.startsWith("EEXIST:"));
    if (existing) {
      return Err(
        new Error(
          `${target} already exists — choose another --save path; the approved document was ` +
            "not written and nothing ran",
        ),
      );
    }
    return Err(new Error(`could not create ${target}: ${describeError(error)}`));
  }

  const written = yield* writeAll(handle, source);
  const closed = yield* closeHandle(handle, target);
  if (!written.ok) {
    return written;
  }
  return closed;
}

function* writeAll(handle: FileHandle, source: string): Operation<Result<void>> {
  try {
    yield* until(handle.writeFile(source, "utf8"));
    return Ok(undefined);
  } catch (error) {
    return Err(new Error(`could not write the approved document: ${describeError(error)}`));
  }
}

function* closeHandle(handle: FileHandle, target: string): Operation<Result<void>> {
  try {
    yield* until(handle.close());
    return Ok(undefined);
  } catch (error) {
    return Err(new Error(`could not close ${target}: ${describeError(error)}`));
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
