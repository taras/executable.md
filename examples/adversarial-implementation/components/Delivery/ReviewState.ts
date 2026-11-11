import { API, parseFilesFailure } from "@executablemd/runtime";
import type { Operation } from "effection";
import { z } from "zod";
import { retained } from "./observation.ts";
import {
  attemptSchema,
  dispositionSchema,
  executionSchema,
  holdSchema,
  outcomeSchema,
  reviewerSchema,
  selectionSchema,
} from "./records.ts";

export const props = {
  type: "object",
  properties: {
    directory: { type: "string", pattern: "^/" },
    expected: { type: "object" },
    replacement: { type: "boolean" },
  },
  required: ["directory", "expected", "replacement"],
  additionalProperties: false,
};

const input = z.strictObject({
  directory: z.string().startsWith("/"),
  expected: selectionSchema,
  replacement: z.boolean(),
});

type Selection = z.infer<typeof selectionSchema>;
type Reviewer = z.infer<typeof reviewerSchema>;
type Attempt = z.infer<typeof attemptSchema>;

function* read(cwd: string, path: string): Operation<string | null> {
  const result = yield* API.Files.operations.readTextFile({ cwd, path });
  if (result.ok) {
    return result.value;
  }
  if (parseFilesFailure(result.error)?.reason === "missing") {
    return null;
  }
  throw result.error;
}

function parsed<T>(schema: z.ZodType<T>, text: string | null): T | null {
  if (text === null) {
    return null;
  }
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function firstLine(text: string | null): string {
  return (text ?? "").split("\n")[0]?.trim() || "no failure text was retained";
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const USAGE_LIMIT_NOTICE =
  "You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
const USAGE_LIMIT_MESSAGE = `Internal error: ${USAGE_LIMIT_NOTICE}`;

type Outcome = z.infer<typeof outcomeSchema>;

/**
 * Fable's usage-limit refusal, recognized only as the whole of what the turn
 * said: the exact notice in every reading of its output, and the exact
 * provider runtime-turn diagnostic it was reported with. Any other text, a
 * matching message without that diagnostic, or a reviewer outside the Fable
 * chain is partial output and holds.
 */
function usageLimitRefusal(outcome: Outcome, fableChoices: readonly string[] | null): boolean {
  const turn = outcome.turn;
  if (
    fableChoices === null ||
    outcome.reviewer.provider !== "claude" ||
    outcome.catalog.model === null ||
    !fableChoices.includes(outcome.catalog.model) ||
    turn === null ||
    turn.state !== "failed" ||
    turn.stage !== "turn" ||
    turn.configuration !== null ||
    turn.refusal === null
  ) {
    return false;
  }
  const { requestId: _requestId, ...diagnostic } = turn.refusal.diagnostic;
  return (
    turn.refusal.agent === outcome.reviewer.provider &&
    turn.partial === USAGE_LIMIT_NOTICE &&
    turn.refusal.output === USAGE_LIMIT_NOTICE &&
    turn.refusal.closeValue === USAGE_LIMIT_NOTICE &&
    turn.refusal.message === USAGE_LIMIT_MESSAGE &&
    same(diagnostic, {
      provider: "acp",
      operation: "session/prompt",
      stage: "runtime-turn",
      code: "RUNTIME",
      origin: "runtime",
      acp: { code: -32603, message: USAGE_LIMIT_MESSAGE },
    })
  );
}

function* attempt(
  directory: string,
  position: 0 | 1,
  reviewer: Reviewer,
  assignment: unknown,
  fableChoices: readonly string[] | null,
): Operation<Attempt> {
  const files = ["assignment.json", "outcome.json", "execution.json"];
  const texts: Record<string, string | null> = {};
  for (const file of files) {
    texts[file] = yield* read(directory, file);
  }
  const evidence = files
    .filter((file) => texts[file] !== null)
    .map((file) => `${directory}/${file}`);
  const outcome = parsed(outcomeSchema, texts["outcome.json"]);
  const turn = outcome?.turn ?? null;
  const configured =
    turn !== null &&
    (turn.state === "reply" || (turn.stage === "turn" && turn.configuration === null));
  const result = (state: Attempt["state"], reason: string): Attempt => ({
    position,
    reviewer,
    model: configured ? (outcome?.catalog.model ?? null) : null,
    state,
    reason,
    evidence,
  });
  const recorded = texts["assignment.json"];
  if (recorded === null) {
    return result("reserved", "The attempt is reserved without its assignment.");
  }
  if (!same(parsed(z.unknown(), recorded), assignment)) {
    return result("held", "The attempt assignment differs from the review selection.");
  }
  const executionText = texts["execution.json"];
  if (executionText === null) {
    return result(
      "reserved",
      "The attempt has no joined execution; its completion and provider release are unknown.",
    );
  }
  const execution = parsed(executionSchema, executionText);
  if (execution === null) {
    return result("held", "The retained execution record is malformed.");
  }
  if (execution.status === "failed") {
    return result(
      "held",
      `The attempt failed outside the provider operation: ${firstLine(execution.failure)}`,
    );
  }
  if (outcome === null || !same(outcome.reviewer, reviewer)) {
    return result("held", "The joined execution has no matching retained outcome.");
  }
  const catalog = outcome.catalog;
  if (catalog.state === "failed") {
    return result("eligible", `Option inspection failed: ${firstLine(catalog.failure)}`);
  }
  if (catalog.state === "unavailable") {
    return result(
      "eligible",
      `The advertised catalog offers none of ${catalog.choices.join(", ")} (advertised: ${catalog.advertised === null ? "no model choice" : catalog.advertised.join(", ") || "none"}). No review prompt was sent.`,
    );
  }
  if (turn === null) {
    return result("held", "The selected model has no retained turn outcome.");
  }
  if (turn.state === "reply") {
    return result("review", "The reviewer returned a joined reply.");
  }
  if (turn.terminal === "cancelled") {
    return result(
      "held",
      "The provider reported the review turn cancelled, which is not evidence that the reviewer is unavailable.",
    );
  }
  if (usageLimitRefusal(outcome, fableChoices)) {
    return result(
      "eligible",
      "Fable reported its usage limit: the turn said exactly that notice, with the matching provider diagnostic, and no review output.",
    );
  }
  if (turn.partial.trim() !== "") {
    return result(
      "held",
      "The failed turn produced partial review output; it is retained for reconciliation.",
    );
  }
  return result(
    "eligible",
    turn.configuration !== null
      ? `The provider refused the ${turn.configuration.setting} configuration (${turn.configuration.reason}) before the review turn.`
      : turn.stage === "session"
        ? `The provider could not establish the review session: ${firstLine(turn.failure)}`
        : `The provider turn failed without review output: ${firstLine(turn.failure)}`,
  );
}

function assignmentFor(selection: Selection, reviewer: Reviewer) {
  return {
    work: selection.work,
    revision: selection.revision,
    reviewer,
    acceptance: selection.policy.acceptance,
    responseSchema: selection.responseSchema,
    ...(selection.maxResponseCorrections === undefined
      ? {}
      : { maxResponseCorrections: selection.maxResponseCorrections }),
  };
}

function transitionFor(selection: Selection, primary: Attempt) {
  return {
    schema: "delivery-review-transition.v1",
    work: selection.work,
    revision: selection.revision,
    from: selection.reviewers[0]?.reviewer,
    to: selection.reviewers[1]?.reviewer,
    reason: primary.reason,
    evidence: primary.evidence,
  };
}

export default function* ReviewState(value: unknown): Operation<unknown> {
  const { directory, expected, replacement } = input.parse(value);
  return yield* retained("delivery-review-state", z.record(z.string(), z.unknown()), () =>
    observe(directory, expected, replacement),
  );
}

function* observe(
  directory: string,
  expected: Selection,
  replacement: boolean,
): Operation<unknown> {
  const selectionText = yield* read(directory, "selection.json");
  const recorded = parsed(selectionSchema, selectionText);
  const selection =
    selectionText === null
      ? "absent"
      : recorded !== null && same(recorded, expected)
        ? "matches"
        : "mismatch";
  const empty = {
    selection,
    chain: expected.chain,
    attempts: [],
    candidate: null,
    effective: null,
    transition: null,
  };
  if (selection !== "matches") {
    return { ...empty, next: "uncertain", hold: null };
  }
  const [first, second] = expected.reviewers;
  if (first === undefined) {
    return { ...empty, next: "uncertain", hold: null };
  }
  const primary = yield* attempt(
    directory,
    0,
    first.reviewer,
    assignmentFor(expected, first.reviewer),
    expected.chain === "fable-astra" ? first.choices : null,
  );
  const attempts: Attempt[] = [primary];
  let candidate: { position: number; directory: string; reviewer: Reviewer } | null = {
    position: 0,
    directory,
    reviewer: first.reviewer,
  };
  let next: string;
  const transition =
    second !== undefined && primary.state === "eligible" ? transitionFor(expected, primary) : null;
  if (replacement) {
    const replacementDirectory = `${directory}/replacement`;
    if (second === undefined || transition === null) {
      candidate = null;
      next = "uncertain";
    } else {
      const transitionText = yield* read(replacementDirectory, "transition.json");
      const proven =
        transitionText !== null && same(parsed(z.unknown(), transitionText), transition);
      const replaced = yield* attempt(
        replacementDirectory,
        1,
        second.reviewer,
        assignmentFor(expected, second.reviewer),
        null,
      );
      const evidence =
        transitionText === null
          ? replaced.evidence
          : [`${replacementDirectory}/transition.json`, ...replaced.evidence];
      const settled: Attempt = proven
        ? { ...replaced, evidence }
        : {
            ...replaced,
            evidence,
            state: transitionText === null ? "reserved" : "held",
            reason:
              transitionText === null
                ? "The replacement is reserved without its retained transition."
                : "The replacement transition differs from the primary attempt's eligible failure.",
          };
      attempts.push(settled);
      candidate = proven
        ? { position: 1, directory: replacementDirectory, reviewer: second.reviewer }
        : null;
      next = !proven
        ? "uncertain"
        : settled.state === "review"
          ? "reconcile"
          : settled.state === "eligible"
            ? "exhausted"
            : "uncertain";
    }
  } else {
    next =
      primary.state === "review"
        ? "reconcile"
        : primary.state === "eligible"
          ? second === undefined
            ? "exhausted"
            : "replace"
          : "uncertain";
  }
  const holdText = yield* read(directory, "hold.json");
  const dispositionText = yield* read(directory, "disposition.json");
  const holdRecord = parsed(holdSchema, holdText);
  const disposition = parsed(dispositionSchema, dispositionText);
  const hold =
    holdText === null
      ? null
      : {
          record: holdRecord,
          valid:
            holdRecord !== null &&
            holdRecord.work === expected.work &&
            holdRecord.revision === expected.revision &&
            holdRecord.chain === expected.chain &&
            (dispositionText === null ||
              (disposition !== null && same(disposition.hold, holdRecord))),
          answer: disposition?.answer ?? null,
          evidence: [
            `${directory}/hold.json`,
            ...(dispositionText === null ? [] : [`${directory}/disposition.json`]),
          ],
        };
  return {
    selection,
    chain: expected.chain,
    attempts,
    candidate,
    effective: next === "reconcile" ? candidate : null,
    transition,
    next,
    hold,
  };
}
