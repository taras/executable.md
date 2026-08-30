/**
 * `xmd prompt` — the trusted host around the prompt command document
 * (specs/prompt-command-spec.md).
 *
 * The command owns two root document executions with a complete scope boundary
 * between them:
 *
 * ```text
 * fixed command preflight
 *   -> build the run-profile syntax catalog
 *   -> execute the exact packaged prompt command document
 *   -> await that execution and provider teardown
 *   -> validate the returned source again
 *   -> optionally save the exact bytes
 *   -> execute retainedSource("<prompt>", source) through the ordinary run path
 * ```
 *
 * What a person is asked, how many drafts may be repaired, how many may be
 * reviewed and what happens when nobody approves anything are not here. They are
 * in `src/documents/prompt-command.md`, written in the open, where they can be
 * read and argued with. This module is what a policy cannot be trusted to do for
 * itself: settle the command line, build the ceiling the assistant runs under,
 * answer honestly about a draft, and hold the boundary between text an agent
 * wrote and a program this host runs.
 *
 * Two kinds of failure are told apart throughout, because they have different
 * remedies. A *draft* failure is something the agent wrote, so the prompt
 * command document is told the facts and may ask for another draft. A *caller*
 * failure is something the command line or the environment said, so it raises
 * out of the validator and ends that execution: no draft the agent could write
 * would fix it, and a policy that could catch it could call it feedback.
 */

import { Err, Ok, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  agentIdentityComponents,
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
  SyntaxCatalog,
} from "@executablemd/core";
import type { AcpxProviderDependencies } from "@executablemd/acp";
import { cwd } from "@executablemd/runtime";

import type { AgentStack } from "./agent-stack.ts";
import { DEFAULT_PROFILE_ROOT, runPromptCommandDocument } from "./prompt-profile.ts";
import type { CandidateAssessment } from "./prompt-profile.ts";
import type { MachineSessionAssembly } from "./session-coordinator.ts";
import {
  buildBindings,
  describeError,
  extractPropsArgs,
  resolvePropsFromSources,
} from "./props.ts";
import type { Binding, Extraction } from "./props.ts";
import { reportFailure } from "./report.ts";
import { renderSyntaxMarkdown, useRunProfileRegistry } from "./syntax.ts";
import {
  isReservedOption,
  signatureFailure,
  signatureOf,
  strayPropertyValue,
} from "./prompt-args.ts";
import type { OptionSignature, PromptScan } from "./prompt-args.ts";

/**
 * The identity approved text runs under.
 *
 * Deliberate and fixed, the way `<eval>` is for an inline document: the bytes
 * came from an agent, not from a file, and a source position reading
 * `(<prompt>:5:1)` says so. It affects positions and diagnostics only —
 * components, includes and every relative filesystem operation still resolve
 * from the contextual working directory.
 */
export const PROMPT_IDENTITY = "<prompt>";

/** The approved bytes, and the props resolved under exactly those bytes. */
export interface PromptExecution {
  root: RootDocumentSource;
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
  /** The logical assistant-session name, when the caller chose one. */
  session?: string;
  /**
   * The Agent configuration this invocation settled, before the command ran.
   *
   * Settled by the caller rather than here, because the execution that follows
   * approval is configured from the same answer: two resolutions of one command
   * line is two chances to read `DEFAULT_AGENT_NAME` differently.
   */
  stack: AgentStack;
}

/** What the host supplies. Every entry is a decision only a host can make. */
export interface PromptDependencies {
  /** What this host states about machine-wide agent sessions, if anything. */
  sessions?: MachineSessionAssembly;
  /** What the profile's provider is built on, beyond the host's own assembly. */
  acp?: AcpxProviderDependencies;
  /** The run profile's complete structured vocabulary. */
  catalog(includes: readonly string[]): Operation<SyntaxCatalog>;
  /** Who answers the review question. */
  installElicitation(): Operation<void>;
  /**
   * Where this host keeps its profile session directories.
   *
   * Absent is the ordinary host default. A harness that owns a temporary tree
   * names that tree here, which is the only way anything but production selects
   * one — there is no flag, no environment variable and no contextual Api to
   * reach, so a document cannot move where the ceiling lives.
   */
  profileRoot?: string;
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

/** The codes that say the root's own declaration could not be read. */
const DECLARATION_CODES: ReadonlySet<DocumentValidationCode> = new Set<DocumentValidationCode>([
  "source-unreadable",
  "source-invalid",
  "target-invalid",
  "frontmatter-invalid",
  "props-declaration-invalid",
  "returns-declaration-invalid",
]);

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

  let syntax: string;
  try {
    syntax = renderSyntaxMarkdown(yield* deps.catalog(command.include));
  } catch (error) {
    console.error(describeError(error));
    return 1;
  }

  // Every supplied individual option's shape, as the first draft that bound it
  // declared it. Frozen while the Plan is being written and carried into the
  // final gate, so the bytes that run are checked against the command line that
  // was written rather than against whichever draft happened to be last.
  const frozen = new Map<string, OptionSignature>();

  // The command document lives and dies inside that call's scope. Leaving it
  // closes the Prompt tasks, the provider and the Elicitation provider, so a
  // teardown failure raises out here — before the validation, the save and the
  // execution that would otherwise already have happened.
  let authored: Result<string>;
  try {
    authored = yield* runPromptCommandDocument({
      request,
      syntax,
      session: command.session ?? invocationSessionName(),
      // Read from what the caller wrote, not from the shape of the name. Only a
      // session somebody can ask for again needs its directory to outlive the
      // invocation, and only the host knows whether somebody named one.
      explicitSession: command.session !== undefined,
      root: deps.profileRoot ?? DEFAULT_PROFILE_ROOT,
      stack: command.stack,
      ...(deps.acp === undefined ? {} : { acp: deps.acp }),
      installElicitation: deps.installElicitation,
      assess: (source) => assess(command, frozen, source),
    });
  } catch (error) {
    console.error(describeError(error));
    return 1;
  }

  if (!authored.ok) {
    console.error(authored.error.message);
    return 1;
  }

  // The returned Plan is untrusted again. Whatever the command document concluded
  // about a candidate, these are the bytes that would run, and they are checked
  // as though nothing had ever validated them.
  const admitted = yield* assessCandidate(command, frozen, authored.value);
  if (admitted.kind === "terminal") {
    console.error(admitted.error.message);
    return 1;
  }
  if (admitted.kind === "repairable") {
    console.error(
      `the approved document does not validate:\n${JSON.stringify(admitted.defects, null, 2)}`,
    );
    return 1;
  }

  const source = authored.value;
  if (command.save !== undefined) {
    const saved = yield* saveSource(command.save, source);
    if (!saved.ok) {
      console.error(saved.error.message);
      return 1;
    }
  }

  const executed = yield* deps.execute({
    root: retainedSource(PROMPT_IDENTITY, source),
    props: admitted.props,
  });
  if (!executed.ok) {
    // Reported exactly as `xmd run` reports the same failure: what ran is one
    // ordinary document, and how it failed is not this command's news to
    // rephrase. A runtime failure ends the command here — there is nothing for
    // the command document to reconsider about a Plan you already approved.
    reportFailure(executed.error);
    return 1;
  }
  return 0;
}

/**
 * A logical session name nothing else can name.
 *
 * The conversation belongs to this invocation: a second `xmd prompt` places a
 * different session rather than continuing this one, and a request nobody meant
 * to repeat never arrives in a history it did not create. `--session` replaces
 * it when a caller wants the provider's ordinary continuation instead.
 */
function invocationSessionName(): string {
  return `xmd-prompt:${randomUUID()}`;
}

/**
 * The host's answer about one draft, in the shape the command document reads.
 *
 * A caller-source failure raises rather than answering. That is the whole of
 * the classification the command document can observe: it sees facts about drafts,
 * and it never sees an argument the command line got wrong.
 */
function* assess(
  command: PromptCommand,
  frozen: Map<string, OptionSignature>,
  source: string,
): Operation<CandidateAssessment> {
  const outcome = yield* assessCandidate(command, frozen, source);
  if (outcome.kind === "terminal") {
    throw outcome.error;
  }
  if (outcome.kind === "valid") {
    return { valid: true, diagnostics: {} };
  }
  return { valid: false, diagnostics: outcome.defects as unknown as Json };
}

/**
 * Everything decidable about one candidate, in the order that keeps a caller's
 * mistake from being taught to the agent.
 *
 * The registry is installed here, around the two questions that need it, rather
 * than around the command document: validation and the catalog have to agree
 * about what `<Agent>` is, and that document has no business reaching a
 * vocabulary it only describes.
 */
function* assessCandidate(
  command: PromptCommand,
  frozen: Map<string, OptionSignature>,
  candidate: string,
): Operation<CandidateOutcome> {
  return yield* scoped(function* (): Operation<CandidateOutcome> {
    yield* useRunProfileRegistry();
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
  });
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
