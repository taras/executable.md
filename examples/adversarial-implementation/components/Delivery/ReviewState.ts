import { API, parseFilesFailure } from "@executablemd/runtime";
import type { Operation } from "effection";
import { z } from "zod";
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

function* attempt(
  directory: string,
  position: 0 | 1,
  reviewer: Reviewer,
  assignment: unknown,
): Operation<Attempt> {
  const files = ["assignment.json", "catalog.json", "outcome.json", "execution.json"];
  const texts: Record<string, string | null> = {};
  for (const file of files) {
    texts[file] = yield* read(directory, file);
  }
  const evidence = files
    .filter((file) => texts[file] !== null)
    .map((file) => `${directory}/${file}`);
  const catalog = parsed(z.object({ model: z.string().nullable() }), texts["catalog.json"]);
  const result = (state: Attempt["state"], reason: string): Attempt => ({
    position,
    reviewer,
    model: catalog?.model ?? null,
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
  if (execution.status !== "completed") {
    return result(
      "unjoined",
      `The review owner did not complete normally, so provider release is unproven: ${firstLine(execution.failure)}`,
    );
  }
  const outcome = parsed(outcomeSchema, execution.output);
  if (
    outcome === null ||
    !same(outcome.reviewer, reviewer) ||
    !same(parsed(z.unknown(), texts["outcome.json"]), outcome)
  ) {
    return result("held", "The joined execution has no matching retained outcome.");
  }
  if (outcome.stage === "other") {
    return result(
      "held",
      `The attempt failed outside the provider operation: ${firstLine(outcome.failure)}`,
    );
  }
  if (outcome.stage === "session") {
    return outcome.configuration === null
      ? result(
          "eligible",
          `The provider could not establish the review session: ${firstLine(outcome.failure)}`,
        )
      : result(
          "eligible",
          `The provider refused the ${outcome.configuration.setting} configuration (${outcome.configuration.reason}) before the review turn.`,
        );
  }
  const settled = outcome.catalog;
  if (settled === null) {
    return result("held", "The settled outcome has no option inspection.");
  }
  const inspected = { ...result("held", "pending"), model: settled.model };
  if (settled.state === "failed") {
    return { ...inspected, state: "eligible", reason: `Option inspection failed: ${firstLine(settled.failure)}` };
  }
  if (settled.state === "unavailable") {
    return {
      ...inspected,
      state: "eligible",
      reason: `The advertised catalog offers none of ${settled.choices.join(", ")} (advertised: ${settled.advertised === null ? "no model choice" : settled.advertised.join(", ") || "none"}). No review prompt was sent.`,
    };
  }
  const turn = outcome.turn;
  if (turn === null) {
    return { ...inspected, reason: "The selected model has no retained turn outcome." };
  }
  if (turn.state === "reply") {
    return { ...inspected, state: "review", reason: "The reviewer returned a joined reply." };
  }
  if (turn.partial.trim() !== "") {
    return {
      ...inspected,
      reason: "The failed turn produced partial review output; it is retained for reconciliation.",
    };
  }
  return {
    ...inspected,
    state: "eligible",
    reason:
      turn.configuration === null
        ? `The provider turn failed without review output: ${firstLine(turn.failure)}`
        : `The provider refused the ${turn.configuration.setting} configuration (${turn.configuration.reason}) before the review turn.`,
  };
}

function assignmentFor(selection: Selection, reviewer: Reviewer) {
  return {
    work: selection.work,
    revision: selection.revision,
    reviewer,
    acceptance: selection.policy.acceptance,
    responseSchema: selection.responseSchema,
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
  const selectionText = yield* read(directory, "selection.json");
  const retained = parsed(selectionSchema, selectionText);
  const selection =
    selectionText === null ? "absent" : retained !== null && same(retained, expected) ? "matches" : "mismatch";
  const empty = { selection, chain: expected.chain, attempts: [], candidate: null, effective: null, transition: null };
  if (selection !== "matches") {
    return { ...empty, next: "uncertain", hold: null };
  }
  const [first, second] = expected.reviewers;
  if (first === undefined) {
    return { ...empty, next: "uncertain", hold: null };
  }
  const primary = yield* attempt(directory, 0, first.reviewer, assignmentFor(expected, first.reviewer));
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
      const proven = transitionText !== null && same(parsed(z.unknown(), transitionText), transition);
      const replaced = yield* attempt(
        replacementDirectory,
        1,
        second.reviewer,
        assignmentFor(expected, second.reviewer),
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
      candidate = proven ? { position: 1, directory: replacementDirectory, reviewer: second.reviewer } : null;
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
            (dispositionText === null || (disposition !== null && same(disposition.hold, holdRecord))),
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
