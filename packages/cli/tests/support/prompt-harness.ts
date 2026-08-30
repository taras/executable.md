/**
 * The deterministic seams `xmd prompt` is proven against.
 *
 * Every phase the command owns is driven in process: the ACPX runtime is the
 * scriptable fake, the review provider is a scripted `Elicitation` handler, the
 * catalog and the execution are recorded, and the contextual working directory
 * is a temporary one. No live agent, browser, or network belongs in this
 * evidence.
 *
 * Each recorder is a tripwire as well as a fake. A refusal is proven by the
 * phases that stayed at zero, never by empty output — a command that printed
 * nothing and still opened a session would pass such a check.
 */

import { Elicitation } from "@executablemd/core";
import type { ElicitationRequest, SyntaxCatalog } from "@executablemd/core";
import { Ok } from "effection";
import type { Operation, Result } from "effection";
import { ensure, scoped, until } from "effection";
import { ensureDir, rm } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, useHostFiles } from "@executablemd/runtime";
import { PROMPT_PROFILE_SESSIONS } from "../../src/prompt-profile.ts";
import { syntaxCatalog } from "../../src/syntax.ts";
import type { PromptDependencies, PromptExecution } from "../../src/prompt.ts";
import { createFakeAcp, makeRegistry, makeStore } from "./fake-acp.ts";
import type { FakeAcp, FakeStore } from "./fake-acp.ts";

/** The agent every prompt case drives, and the command it resolves to. */
export const AGENT = "scripted-agent";

/** One review answer, scripted. */
export interface ScriptedReview {
  decision: "approve" | "revise" | "abort";
  feedback?: string;
  /** Answer with this instead, to drive a response the schema rejects. */
  raw?: unknown;
}

export interface PromptHarness {
  fake: FakeAcp;
  /** Every catalog request, by the includes it was made with. */
  catalogCalls: string[][];
  /** Every review request a provider was asked, in order. */
  reviews: ElicitationRequest[];
  /** Every approved execution that reached the executor. */
  executions: PromptExecution[];
  /** What the executor answers with, once each, then `Ok`. */
  executionResults: Result<void>[];
  /** Review answers, taken in order. Running out is a test defect, not a case. */
  script(review: ScriptedReview): void;
  /** The dependencies `runPrompt` is driven with. */
  deps: PromptDependencies;
}

export function createPromptHarness(options?: {
  /** Replace the catalog entirely, for a case about catalog failure. */
  catalog?: (includes: readonly string[]) => Operation<SyntaxCatalog>;
  /**
   * The ACPX session store this invocation reads and writes.
   *
   * One store shared by two harnesses is two invocations of the command against
   * one provider's memory, which is the only way to observe whether a named
   * session is continued or created a second time.
   */
  store?: FakeStore;
}): PromptHarness {
  const fake = createFakeAcp();
  const catalogCalls: string[][] = [];
  const reviews: ElicitationRequest[] = [];
  const executions: PromptExecution[] = [];
  const executionResults: Result<void>[] = [];
  const answers: ScriptedReview[] = [];

  const harness: PromptHarness = {
    fake,
    catalogCalls,
    reviews,
    executions,
    executionResults,
    script(review) {
      answers.push(review);
    },
    deps: {
      acp: {
        createRuntime: fake.create,
        sessionStore: options?.store ?? makeStore(),
        agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
      },
      *catalog(includes) {
        catalogCalls.push([...includes]);
        return yield* (options?.catalog ?? syntaxCatalog)(includes);
      },
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
      // deno-lint-ignore require-yield
      *execute(approved) {
        executions.push(approved);
        return executionResults.shift() ?? Ok(undefined);
      },
    },
  };
  return harness;
}

/**
 * A temporary directory that is also the contextual working directory.
 *
 * Both, because the two answer different questions: session placement and
 * `--save` resolve the contextual one, while a real file has to live somewhere.
 */
export function* useWorkingDirectory<T>(body: (dir: string) => Operation<T>): Operation<T> {
  const dir = join(tmpdir(), `xmd-prompt-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* useProfileDirectories();
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
    return yield* body(dir);
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
 * Leave the host's profile session directories as this case found them.
 *
 * A profile directory is deliberately durable — its stable identity is what
 * `--session` continues — so a suite that made a few dozen of them under the
 * developer's own home directory would be leaving litter behind. Only entries
 * that appeared while the case ran are removed, so a directory somebody else
 * owns is never touched.
 */
function* useProfileDirectories(): Operation<void> {
  const before = new Set(yield* listSessionDirectories());
  yield* ensure(function* () {
    for (const name of yield* listSessionDirectories()) {
      if (!before.has(name)) {
        yield* rm(join(PROMPT_PROFILE_SESSIONS, name), { recursive: true, force: true });
      }
    }
  });
}

function* listSessionDirectories(): Operation<string[]> {
  try {
    return yield* until(readdir(PROMPT_PROFILE_SESSIONS));
  } catch {
    return [];
  }
}
