/**
 * `xmd plan` — the trusted host around the plan command document
 * (specs/plan-command-spec.md).
 *
 * Every invocation executes exactly one root document — the packaged plan
 * command document — and produces one thing: the approved program's source.
 *
 * ```text
 * fixed command preflight
 *   -> exclusively create the --journal file, when one was named
 *   -> execute the exact packaged plan command document, reporting each of its
 *      phases on stderr as it happens — the catalog is built inside it
 *   -> await that execution and provider teardown
 *   -> structurally validate the returned source again
 *   -> deliver those exact bytes, in exactly one of two ways:
 *        (default)          write the source to stdout
 *        --output           exclusively create the file
 * ```
 *
 * Nothing after that delivery starts. Whether the approved program ever runs is
 * the caller's own composition — `xmd plan … | xmd run -`, or an `--output`
 * artifact given to a later `xmd run` — so the command that wrote a program
 * never also decides when it happens.
 *
 * What a person is asked, how many drafts may be repaired, how many may be
 * reviewed and what happens when nobody approves anything are not here. They are
 * in `src/documents/Plan.md`, the packaged `<Plan>` Component, written in the
 * open where they can be read and argued with. This module is what an authored
 * workflow cannot be trusted to do for
 * itself: settle the command line, build the ceiling the assistant runs under,
 * answer honestly about a draft, and hold the boundary between text an agent
 * wrote and source this host will hand over.
 */

import { Err, Ok, scoped, until, useScope } from "effection";
import type { Operation, Result } from "effection";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";

import type { SyntaxCatalog } from "@executablemd/core";
import type { AcpxProviderDependencies } from "@executablemd/acp";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableStream } from "@executablemd/durable-streams";
import { cwd } from "@executablemd/runtime";

import type { AuthorshipStack } from "./agent-stack.ts";
import {
  DEFAULT_AUTHORSHIP_ROOT,
  planAgentContext,
  ProgressDeliveryError,
  runPlanCommandDocument,
} from "./authorship-profile.ts";
import type { ProgressOutput } from "./authorship-profile.ts";
import { createPlanJournal, journalRefusal } from "./plan-journal.ts";
import {
  planComponentDeclaration,
  planComponentDescription,
  structuralValidation,
} from "./plan-component.ts";
import type { StructuralValidation } from "./plan-component.ts";
import type { MachineSessionAssembly } from "./session-coordinator.ts";
import { describeError } from "./props.ts";
import { renderSyntaxMarkdown } from "./syntax.ts";

/**
 * The identity approved text runs under.
 *
 * Owned by the Component module, because the structural admission inside `<Plan>`
 * reads the same bytes under the same identity: a position reading
 * `(<plan>:5:1)` means the same thing whichever gate produced it.
 */
export { PLAN_IDENTITY } from "./plan-component.ts";

/** What one `xmd plan` invocation was asked to do. */
export interface PlanCommand {
  /** The request, byte for byte, as fixed grammar preserved it. */
  request: string;
  include: string[];
  /** Where the approved Plan is written, when the caller asked for a file. */
  output?: string;
  /** The logical assistant-session name, when the caller chose one. */
  session?: string;
  /** Show each generated draft and each failed check's diagnostics. */
  verbose: boolean;
  /** Where the diagnostic record of this authorship goes, when one was asked for. */
  journal?: string;
  /** Who writes the Plan, settled before the command began. */
  stack: AuthorshipStack;
}

/** What the host supplies. Every entry is a decision only a host can make. */
export interface PlanDependencies {
  /** What this host states about machine-wide agent sessions, if anything. */
  sessions?: MachineSessionAssembly;
  /** What the profile's provider is built on, beyond the host's own assembly. */
  acp?: AcpxProviderDependencies;
  /** The run profile's complete structured vocabulary. */
  catalog(includes: readonly string[]): Operation<SyntaxCatalog>;
  /** Who answers the review question. */
  installElicitation(): Operation<void>;
  /**
   * Where planning progress goes, and whether that destination is a terminal.
   *
   * Both are the entrypoint's facts about its own `process.stderr`. Nothing
   * here detects a runtime or inspects a terminal, and no document reaches
   * either answer.
   */
  progress: ProgressOutput;
  /**
   * Create the diagnostic journal `--journal` named, or refuse.
   *
   * Absent is {@link createPlanJournal}, which exclusively creates the path and
   * appends the ordinary JSONL — and is what production uses. A harness that
   * has to prove what a refused entry leaves behind supplies its own, because a
   * filesystem will not fail a write on request.
   */
  journal?(path: string): Operation<Result<DurableStream>>;
  /**
   * Where this host keeps its profile session directories.
   *
   * Absent is the ordinary host default. A harness that owns a temporary tree
   * names that tree here, which is the only way anything but production selects
   * one — there is no flag, no environment variable and no contextual Api to
   * reach, so a document cannot move where the ceiling lives.
   */
  authorshipRoot?: string;
  /**
   * How this invocation decides a candidate is structurally a program.
   *
   * Absent is the canonical answer below. One dependency, and the same one the
   * declaration is built with, so the draft check, the admission inside `<Plan>`
   * and the gate this command keeps after that document has torn down are the
   * same question asked three times rather than three questions that happen to
   * agree today.
   */
  validate?: StructuralValidation;
}

/**
 * Run the command, and report the process status it earned.
 *
 * Every phase is behind a returned value rather than behind a flag another
 * phase reads, so a refusal cannot be followed by the work it refused.
 */
export function* runPlan(command: PlanCommand, deps: PlanDependencies): Operation<number> {
  // The journal is the first thing this command establishes, because a path
  // somebody kept is the one refusal that has to cost nothing: it happens
  // before the catalog is built, before a session directory is placed, before
  // the provider starts an agent, before anybody is asked to review and before
  // any artifact exists, and it leaves that file byte-identical.
  let stream: DurableStream;
  if (command.journal === undefined) {
    stream = new InMemoryStream();
  } else {
    const created = yield* (deps.journal ?? createPlanJournal)(command.journal);
    if (!created.ok) {
      console.error(created.error.message);
      return 1;
    }
    stream = created.value;
  }

  // The command document lives and dies inside that call's scope. Leaving it
  // closes the Prompt tasks, the provider and the Elicitation provider, so a
  // teardown failure raises out here — before the admission and before the
  // output file.
  const session = command.session ?? invocationSessionName();
  // Read from what the caller wrote, not from the shape of the name. Only a
  // session somebody can ask for again needs its directory to outlive the
  // invocation, and only the host knows whether somebody named one.
  const explicitSession = command.session !== undefined;
  const root = deps.authorshipRoot ?? DEFAULT_AUTHORSHIP_ROOT;
  // Built before the declaration exists, and handed to it: the packaged `<Plan>`
  // description is the declaration an ordinary run resolves, so what the draft
  // check, the admission and the gate below all ask about is the profile the
  // approved program would actually run in.
  const validate =
    deps.validate ?? structuralValidation(command.include, [yield* planComponentDescription()]);

  let authored: Result<string>;
  try {
    // Taken before the execution, because two of the things this command does
    // are the host's rather than the Component's — putting this build's adapter on
    // disk, and opening the review form — and both run a command, which the
    // ceiling the Component installs refuses to everything inside it.
    const host = yield* useScope();
    // The one Agent context this invocation can supply, settled before the
    // declaration exists so nothing the document does can reach or replace it.
    const context = planAgentContext(command.stack, deps.acp);
    const declaration = yield* planComponentDeclaration({
      surface: "command",
      // The adapter root resolves no repository component, and neither does the
      // Component it invokes. A Plan's own components are the caller's business,
      // and the final gate below is where they are resolved.
      includes: command.include,
      context,
      authorshipRoot: root,
      session,
      explicitSession,
      verbose: command.verbose,
      host,
      installElicitation: deps.installElicitation,
      // Built when `<PlanInputs>` asks, which is what lets an authored phase
      // announce the preparation before it happens. It is still sealed: the
      // catalog the agent is shown is the one this command renders, and no prop
      // on the thin adapter could supply another.
      *catalog() {
        return renderSyntaxMarkdown(yield* deps.catalog(command.include));
      },
      validate,
    });

    authored = yield* runPlanCommandDocument({
      request: command.request,
      session,
      explicitSession,
      root,
      context,
      declaration,
      stream,
      progress: deps.progress,
    });
  } catch (error) {
    console.error(describeError(error));
    return 1;
  }

  if (!authored.ok) {
    // Progress delivery is the one failure this command cannot report through
    // the stream that failed to report it. A later write may still land — a
    // pipe that closed once is not a stream that refuses forever — so the
    // diagnostic is offered there and nowhere else: an approved Plan's own sink
    // is not a fallback channel for a message about progress.
    if (authored.error instanceof ProgressDeliveryError) {
      yield* deps.progress.write(`${authored.error.message}\n`);
      return 1;
    }
    // A refused journal entry is what ended authorship, and the durable
    // runtime's own account of it names an event rather than the file a person
    // asked for. Reported from the cause chain, so this replaces nothing but
    // the failure it actually is.
    const refused = journalRefusal(authored.error);
    console.error((refused ?? authored.error).message);
    return 1;
  }

  // The returned Plan is untrusted again. Whatever the command document concluded
  // about a candidate — and however recently `<AdmitPlan>` concluded it — these
  // are the bytes a later `xmd run` would execute, and the tree they resolve
  // against has had a whole teardown to move since. So they are checked once
  // more, as though nothing had ever validated them.
  const admitted = yield* validate(authored.value);
  if (admitted.outcome === "invalid") {
    console.error(
      `the approved document does not validate:\n` +
        JSON.stringify({ validation: admitted }, null, 2),
    );
    return 1;
  }

  const source = authored.value;
  if (command.output !== undefined) {
    // An existing path is refused and nothing after it happens: what somebody
    // kept is left exactly as it was.
    const written = yield* writeOutput(command.output, source);
    if (!written.ok) {
      console.error(written.error.message);
      return 1;
    }
    return 0;
  }

  // The approved Plan is the result. It goes to stdout exactly as the agent
  // wrote it — no fence, no heading, no trailing newline of this command's —
  // so a caller can pipe it into `xmd run -`, a file, a diff or another
  // program. A caller who named `--output` already has it, and gets a quiet
  // command instead.
  process.stdout.write(source);
  return 0;
}

/**
 * A logical session name nothing else can name.
 *
 * The conversation belongs to this invocation: a second `xmd plan` places a
 * different session rather than continuing this one, and a request nobody meant
 * to repeat never arrives in a history it did not create. `--session` replaces
 * it when a caller wants the provider's ordinary continuation instead.
 *
 * Exported for the suite that pins the generated shape. Nothing outside this
 * package names it, and a caller reaches it through no command line.
 */
export function invocationSessionName(): string {
  return `xmd-plan:${randomUUID()}`;
}

/**
 * Create the destination and write the approved Plan, or refuse.
 *
 * Exclusive creation, so an existing path is left exactly as it is and the
 * command stops rather than replacing work somebody kept. There is no
 * check-then-write: the open is the check.
 */
function* writeOutput(path: string, source: string): Operation<Result<void>> {
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
          `${target} already exists — choose another --output path; the approved Plan was ` +
            "not written",
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
    return Err(new Error(`could not write the approved Plan: ${describeError(error)}`));
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
