/**
 * The deterministic seams `xmd plan` is proven against.
 *
 * Every phase the command owns is driven in process: the ACPX runtime is the
 * scriptable fake, the review provider is a scripted `Elicitation` handler, the
 * symbols and the execution are recorded, and the contextual working directory
 * is a temporary one. No live agent, browser, or network belongs in this
 * evidence.
 *
 * Each recorder is a tripwire as well as a fake. A refusal is proven by the
 * phases that stayed at zero, never by empty output — a command that printed
 * nothing and still opened a session would pass such a check.
 */

import { Elicitation } from "@executablemd/core";
import type { DocumentValidation, ElicitationRequest, SyntaxSymbols } from "@executablemd/core";
import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { ensure, scoped, useScope } from "effection";
import { ensureDir, rm } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, useHostFiles } from "@executablemd/runtime";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import type { EmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import { syntaxSymbols } from "../../src/syntax.ts";
import { planComponentDeclaration } from "../../src/plan-component.ts";
import type { PlanSurface, StructuralValidation } from "../../src/plan-component.ts";
import { planAgentContext } from "../../src/authorship-profile.ts";
import type { AuthorshipStack } from "../../src/agent-stack.ts";
import type { SyntaxSymbolsProvider, DeclaredMarkdownComponent } from "@executablemd/core/host";
import type { PlanDependencies } from "../../src/plan.ts";
import { createFakeAcp, makeRegistry, makeStore } from "./fake-acp.ts";
import type { FakeAcp, FakeStore } from "./fake-acp.ts";

/** The agent every plan case drives, and the command it resolves to. */
export const AGENT = "scripted-agent";

/** The answer a case that is not about validation wants: this is a program. */
// deno-lint-ignore require-yield
const SOUND: StructuralValidation = function* (): Operation<DocumentValidation> {
  return { version: 1, outcome: "valid", diagnostics: [], invocations: [] };
};

/**
 * The embedded adapters a case's Agent stack carries.
 *
 * Nothing is ever written beneath this root: materialization happens only for an
 * agent this build carries a snapshot for, and every case drives
 * {@link AGENT}. Naming a temporary root anyway is what keeps a case that came
 * to resolve `codex` from installing an adapter under the developer's own home.
 */
export const ADAPTERS: EmbeddedAdapters = createEmbeddedAdapters(
  join(tmpdir(), `xmd-plan-adapters-${randomUUID()}`),
);

/**
 * One review answer, scripted.
 *
 * The values are the words a person reads and the words the provider answers
 * with: the workflow keeps no internal spelling behind them.
 */
export interface ScriptedReview {
  decision: "Approve" | "Request changes" | "Stop";
  feedback?: string;
  /** Answer with this instead, to drive a response the schema rejects. */
  raw?: unknown;
}

export interface PlanHarness {
  fake: FakeAcp;
  /** Every symbols request, by the includes it was made with. */
  symbolCalls: string[][];
  /** Every review request a provider was asked, in order. */
  reviews: ElicitationRequest[];
  /**
   * Every progress chunk the stated stderr accepted, in arrival order.
   *
   * Chunks rather than a joined string, because when a phase arrives is the
   * whole point of most of these rows: a case that only read the transcript
   * could not tell progressive delivery from one buffered summary.
   */
  progress: string[];
  /** Review answers, taken in order. Running out is a test defect, not a case. */
  script(review: ScriptedReview): void;
  /** The dependencies `runPlan` is driven with. */
  deps: PlanDependencies;
}

export function createPlanHarness(options: {
  /**
   * Where this harness keeps its profile session directories.
   *
   * Required, and always a tree the case itself created: a suite that fell back
   * to the host default would be reading and removing directories under the
   * developer's own home, and two cases running close together could not tell
   * whose was whose.
   */
  authorshipRoot: string;
  /** Replace the symbols entirely, for a case about their failure. */
  symbols?: (includes: readonly string[]) => Operation<SyntaxSymbols>;
  /**
   * The ACPX session store this invocation reads and writes.
   *
   * One store shared by two harnesses is two invocations of the command against
   * one provider's memory, which is the only way to observe whether a named
   * session is continued or created a second time.
   */
  store?: FakeStore;
  /** What this case's host states about its own stderr. Absent is a pipe. */
  terminal?: boolean;
  /**
   * Refuse a progress chunk, standing where a broken pipe would.
   *
   * An operation rather than a predicate, because a case about failing *while a
   * turn is live* has to wait for that turn: a synchronous answer would race the
   * producer, and the row would sometimes prove nothing. Called with every chunk
   * in arrival order; an error is that write failing, and the chunk is not
   * recorded as accepted.
   */
  refuseProgress?: (chunk: string, index: number) => Operation<Error | undefined>;
}): PlanHarness {
  const fake = createFakeAcp();
  const symbolCalls: string[][] = [];
  const reviews: ElicitationRequest[] = [];
  const answers: ScriptedReview[] = [];
  const progress: string[] = [];
  let offered = 0;

  const harness: PlanHarness = {
    fake,
    symbolCalls,
    reviews,
    progress,
    script(review) {
      answers.push(review);
    },
    deps: {
      progress: {
        terminal: options.terminal === true,
        *write(chunk) {
          const index = offered;
          offered += 1;
          const refusal =
            options.refuseProgress === undefined
              ? undefined
              : yield* options.refuseProgress(chunk, index);
          if (refusal !== undefined) {
            return Err(refusal);
          }
          progress.push(chunk);
          return Ok(undefined);
        },
      },
      acp: {
        createRuntime: fake.create,
        sessionStore: options.store ?? makeStore(),
        agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
      },
      *symbols(includes) {
        symbolCalls.push([...includes]);
        return yield* (options.symbols ?? syntaxSymbols)(includes);
      },
      authorshipRoot: options.authorshipRoot,
      *installElicitation() {
        yield* Elicitation.around(
          {
            // deno-lint-ignore require-yield
            *elicit([request], _next) {
              reviews.push(request);
              const answer = answers.shift();
              if (answer === undefined) {
                throw new Error("the case scripted no answer for this review");
              }
              if (answer.raw !== undefined) {
                return answer.raw;
              }
              return {
                decision: answer.decision,
                ...(answer.feedback === undefined ? {} : { feedback: answer.feedback }),
              };
            },
          },
          { at: "min" },
        );
      },
    },
  };
  return harness;
}

/**
 * A temporary directory that is also the contextual working directory.
 *
 * Both, because the two answer different questions: session placement and
 * `--output` resolve the contextual one, while a real file has to live
 * somewhere.
 */
export function* useWorkingDirectory<T>(
  body: (dir: string, authorshipRoot: string) => Operation<T>,
): Operation<T> {
  const dir = join(tmpdir(), `xmd-plan-${randomUUID()}`);
  // A sibling rather than a child: the working directory is what the approved
  // document writes into and what several cases read back, and a profile root
  // inside it would show up in those listings.
  const authorshipRoot = `${dir}-profile`;
  yield* ensureDir(dir);
  yield* ensureDir(authorshipRoot);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    // Recursive, and safe because it is: everything under this root was created
    // by this scope, so nothing here can reach a directory another case or a
    // real invocation owns.
    yield* ensure(() => rm(authorshipRoot, { recursive: true, force: true }));
    yield* API.Env.around({
      // deno-lint-ignore require-yield
      *cwd() {
        return dir;
      },
    });
    // The provider `API.Files` has no host default for, installed exactly where
    // the runtime entrypoint installs it: a document that reaches the
    // filesystem must reach the caller's, or fail.
    yield* useHostFiles();
    return yield* body(dir, authorshipRoot);
  });
}

/**
 * Environment values this scope answers with, delegating every other name.
 *
 * Delegation matters: the agent stack reads `DEFAULT_AGENT_NAME` through the
 * same Api, and answering `undefined` for everything would make a case about
 * `XMD_PROPS` quietly also be a case about the default agent.
 */
export function* useEnvironment(values: Record<string, string>): Operation<void> {
  yield* useRecordedEnvironment([], values);
}

/**
 * The same environment, with every name it was asked recorded in order.
 *
 * What a resolution costs is visible only as the reads it performs: a value
 * settled once and handed to both consumers reads its name once, while two
 * consumers each settling their own read it twice and agree only by accident.
 */
export function* useRecordedEnvironment(
  reads: string[],
  values: Record<string, string>,
): Operation<void> {
  yield* API.Env.around({
    *env([name], next) {
      reads.push(name);
      if (Object.hasOwn(values, name)) {
        return values[name];
      }
      return yield* next(name);
    },
  });
}

/** How many times one name was read. */
export function timesRead(reads: readonly string[], name: string): number {
  return reads.filter((read) => read === name).length;
}

/**
 * A temporary tree this scope creates, owns and removes whole.
 *
 * Owning it is what makes recursive removal safe: everything under it was made
 * by this scope, so nothing here can reach a directory another case — or a real
 * invocation — is using. A case uses it as an authorship root directly, or as
 * the home a real host places `.xmd` beneath.
 */
export function* useAuthorshipRoot<T>(body: (root: string) => Operation<T>): Operation<T> {
  const root = join(tmpdir(), `xmd-plan-profile-${randomUUID()}`);
  yield* ensureDir(root);
  return yield* scoped(function* () {
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    return yield* body(root);
  });
}

/** What one case declares `<Plan>` with, and what it recorded. */
export interface PlanDeclarationHarness {
  fake: FakeAcp;
  /** Every candidate the Component asked about, in order. */
  checked: string[];
  /** Every review request a provider was asked, in order. */
  reviews: ElicitationRequest[];
  /** The declaration to attach to an execution. */
  declaration: DeclaredMarkdownComponent;
  /**
   * The symbols this case's execution describes.
   *
   * Attached to the execution rather than to the declaration, because that is
   * where the profile a document is shown is now settled: `<Syntax />` is
   * public, canonical core owns it, and what it answers with is the execution's
   * own.
   */
  symbols: SyntaxSymbolsProvider;
  /** How many times that provider was asked. */
  symbolCalls: number;
  /** Review answers, taken in order. Running out is a test defect, not a case. */
  script(review: ScriptedReview): void;
}

/**
 * The `<Plan>` declaration a case runs a document against.
 *
 * The same Component bytes production ships, with the seams a case owns: the
 * scriptable ACPX runtime, a scripted review, a recorded draft answer, and an
 * authorship root the case created. Nothing here is a second implementation — the
 * declaration reads `Plan.md` through the packaged loader, exactly as the
 * command and an ordinary run do.
 */
export function* planDeclarationHarness(options: {
  surface: PlanSurface;
  authorshipRoot: string;
  includes?: readonly string[];
  /**
   * The symbols this case's execution describes, in place of the default below.
   *
   * A case that needs to know *when* they were read supplies this, which is the
   * only way to tell an authored phase that precedes the read from one that
   * follows it.
   */
  symbols?: () => Operation<SyntaxSymbols>;
  /**
   * How this case answers the one structural question the Component asks.
   *
   * The default finds every candidate sound, so what a case reading `checked`
   * observes is the Component's control flow rather than validation's answers.
   */
  validate?: StructuralValidation;
  /** The logical name the command surface fixes. */
  session?: string;
  explicitSession?: boolean;
  /** Whether the command surface asked for drafts and check diagnostics. */
  verbose?: boolean;
  /** Absent leaves the harness with no stack at all, as `xmd test` has none. */
  stack?: AuthorshipStack | null;
  store?: FakeStore;
}): Operation<PlanDeclarationHarness> {
  const fake = createFakeAcp();
  const checked: string[] = [];
  const reviews: ElicitationRequest[] = [];
  const answers: ScriptedReview[] = [];

  const declaration = yield* planComponentDeclaration({
    surface: options.surface,
    includes: options.includes ?? [],
    // The production Agent context, built from the stack a case states and this
    // harness's own ACPX seams. `stack: null` is a host that settled none, which
    // is what `xmd test` at its own root and an unconfigured run child are.
    context: planAgentContext(
      options.stack === null
        ? undefined
        : (options.stack ?? {
            provider: "acpx",
            defaultAgent: AGENT,
            adapters: ADAPTERS,
          }),
      {
        createRuntime: fake.create,
        sessionStore: options.store ?? makeStore(),
        agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
      },
    ),
    authorshipRoot: options.authorshipRoot,
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.explicitSession === undefined ? {} : { explicitSession: options.explicitSession }),
    ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
    host: yield* useScope(),
    *installElicitation() {
      yield* Elicitation.around(
        {
          // deno-lint-ignore require-yield
          *elicit([request], _next) {
            reviews.push(request);
            const answer = answers.shift();
            if (answer === undefined) {
              throw new Error("the case scripted no answer for this review");
            }
            if (answer.raw !== undefined) {
              return answer.raw;
            }
            return {
              decision: answer.decision,
              ...(answer.feedback === undefined ? {} : { feedback: answer.feedback }),
            };
          },
        },
        { at: "min" },
      );
    },
    // The deterministic seam standing where production's answer goes, recording
    // every candidate it was asked about — the draft check's and the
    // admission's alike, which is every time these bytes are decided on.
    // deno-lint-ignore require-yield
    *validate(candidate: string): Operation<DocumentValidation> {
      checked.push(candidate);
      return yield* (options.validate ?? SOUND)(candidate);
    },
  });

  const harness: PlanDeclarationHarness = {
    fake,
    checked,
    reviews,
    declaration,
    symbolCalls: 0,
    *symbols(): Operation<SyntaxSymbols> {
      harness.symbolCalls += 1;
      if (options.symbols !== undefined) {
        return yield* options.symbols();
      }
      return CASE_CATALOG;
    },
    script(review) {
      answers.push(review);
    },
  };
  return harness;
}

/**
 * The vocabulary a case's execution describes, unless it states another.
 *
 * One entry, so the rendered catalog carries a marker a prompt assertion can
 * look for without depending on the whole run profile being assembled.
 */
export const CASE_CATALOG: SyntaxSymbols = {
  version: 2,
  categories: [
    { kind: "structural", entries: [] },
    {
      kind: "built-in",
      entries: [
        {
          kind: "component",
          name: "File",
          origin: { kind: "registered", origin: "@executablemd/core", reserved: false },
          sourceKind: "registered",
          inspectability: "complete",
          forms: ["self-closing", "paired"],
          props: { type: "object", properties: {}, additionalProperties: false },
          captures: [],
          returnMode: "text",
          returns: { type: "string" },
        },
      ],
    },
    { kind: "user-provided", entries: [] },
  ],
};
