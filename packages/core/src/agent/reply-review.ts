/**
 * Asking a trusted foreground host whether to keep one withheld reply.
 *
 * A held conversation whose completed reply secret detection withheld has
 * already done the safe thing: the turn is journaled as a withheld completion
 * and that record stands whatever happens next. Only then, outside any
 * publication transaction, does the turn's own task ask this operation. A host
 * with nobody in front of it installs nothing, and the built-in terminal
 * answers for it: withhold.
 *
 * The question is a contextual operation, not a callback on a request. A
 * trusted host installs middleware for it beside its publisher; the turn calls
 * the chain with a hold Agent made for this one invocation; and a decision
 * counts only when the middleware hands it to the terminal it was given,
 * together with that same hold, while the turn is still waiting on it. What a
 * handler returns is never read, a hold kept past its turn settles nothing, a
 * second settlement is ignored, and no request property, attached client,
 * authored `<Elicit>` or replayed record reaches this terminal at all.
 *
 * What the hold shows is for the local screen and nothing else: the rule,
 * where in the reply it matched, a masked excerpt, and — only while the turn
 * is waiting — the matched text itself, for a person who explicitly asks to
 * see it. None of it is journaled, rendered by Core or attached to an error.
 */

import { createApi } from "@effectionx/context-api";
import type { Api } from "@effectionx/context-api";
import { ensure } from "effection";
import type { Operation } from "effection";
import type { AgentPromptHandle } from "./publication.ts";
import type { SecretSpan } from "../secrets/scanner.ts";
import type { SourceRange } from "../document-targets.ts";
import type { ElicitChoiceSelection } from "../approved-generated-source.ts";

/** Where feedback places an acknowledged answer from one question. */
export interface FeedbackSlice extends SourceRange {
  readonly coroutineId: string;
  readonly index: number;
}

/** One finding in a withheld reply, as a local reviewer may show it. */
export interface AgentReplyFinding {
  /** The rule that matched. */
  readonly ruleId: string;
  /** The rule's message identifier. */
  readonly messageId: string;
  /** Where in the reply the match begins: one-based line and column. */
  readonly line: number;
  readonly column: number;
  /**
   * A masked excerpt: the text around the match on its own line, with the
   * match itself replaced. Control characters are already replaced, so the
   * excerpt is safe to draw as text — and it still carries reply text nobody
   * has reviewed, which is why it is shown on the local screen only.
   */
  readonly excerpt: { readonly before: string; readonly masked: string; readonly after: string };
}

/** What a host decides about one withheld reply. */
export type AgentReplyDecision = "accept" | "withhold";

/**
 * One withheld reply waiting for a local decision.
 *
 * Made by Agent for one invocation of the review and good for that invocation
 * only. Holding one grants nothing: it is settled through the terminal the
 * reviewer was handed, and only while the turn is still waiting.
 */
export interface AgentReplyHold {
  /** What this host's own publisher `begin()` returned for the turn. */
  readonly begun: AgentPromptHandle;
  readonly findings: readonly AgentReplyFinding[];
  /**
   * The matched text of one finding, for an explicit local Reveal.
   *
   * Answers nothing once the turn has stopped waiting. A reveal changes what
   * the local screen draws and nothing else: it is not a decision.
   */
  reveal(finding: number): string | undefined;
  /**
   * After an accepted reply's evaluation, say where the next turn's text
   * carries the answer that evaluation's own question selected.
   *
   * `text` is exactly what the host hands that turn, and `slices` are where
   * in it the answer sits. Agent keeps this only for the very next turn of the
   * same conversation, only when the evaluation of exactly the accepted
   * source selected an approved choice, and only while nothing else has run;
   * otherwise it answers false and grants nothing.
   */
  carry(text: string, slices: readonly FeedbackSlice[]): boolean;
  selectedElicitation(selection: ElicitChoiceSelection): void;
}

/** A trusted host's local reviewer. */
export interface AgentReplyReviewer {
  /**
   * Present one withheld reply, and hand the decision to `decide` once.
   *
   * `decide` is the terminal for this invocation. Returning without calling it
   * leaves the reply withheld, which is also what closing the question means.
   */
  review(
    hold: AgentReplyHold,
    decide: (decision: AgentReplyDecision) => Operation<void>,
  ): Operation<void>;
}

interface ReplyReviewApi {
  review(hold: AgentReplyHold, decision: AgentReplyDecision | undefined): Operation<void>;
}

/** What Agent knows about each hold it issued, and whether it was decided. */
const REVIEW = "agent.reply-review";
const ReplyReview: Api<ReplyReviewApi> = createApi<ReplyReviewApi>(REVIEW, {
  // deno-lint-ignore require-yield
  *review(): Operation<void> {},
});

/**
 * Install this host's local reviewer for the conversations it opens.
 *
 * A host act, reached through `@executablemd/core/host` and installed as one
 * of the conversation's own installations, beside its prompt publisher.
 */
export function* useAgentReplyReview(reviewer: AgentReplyReviewer): Operation<void> {
  yield* ReplyReview.around({
    *review([hold, _decision], next) {
      let delegated = false;
      yield* reviewer.review(hold, function* (decision) {
        if (delegated) {
          return;
        }
        delegated = true;
        yield* next(hold, decision);
      });
    },
  });
}

/** What the turn hands the review: the reply, where it matched, and its turn. */
export interface ReviewRequest {
  readonly text: string;
  readonly spans: readonly SecretSpan[];
  readonly begun: AgentPromptHandle;
  readonly carry: AgentReplyHold["carry"];
  readonly selectedElicitation: AgentReplyHold["selectedElicitation"];
}

/**
 * Ask the installed reviewer about one withheld reply, and answer only what
 * reached the terminal for this invocation.
 *
 * The hold is live for exactly this call. However it ends — decided, returned
 * without a decision, failed or halted — it is dead afterwards, and a reveal
 * or settlement through it answers nothing.
 */
export function* askReplyReview(
  request: ReviewRequest,
): Operation<{ readonly decision: AgentReplyDecision; readonly hold: AgentReplyHold }> {
  let live = true;
  let decided: AgentReplyDecision | undefined;
  const findings = Object.freeze(
    request.spans.map((span) => Object.freeze(findingOf(request.text, span, request.spans))),
  );
  const hold: AgentReplyHold = Object.freeze({
    begun: request.begun,
    findings,
    reveal(finding: number): string | undefined {
      const span = request.spans[finding];
      return live && span !== undefined ? request.text.slice(span.start, span.end) : undefined;
    },
    carry: request.carry,
    selectedElicitation: request.selectedElicitation,
  });
  yield* ensure(() => {
    live = false;
  });
  const terminal = createApi<ReplyReviewApi>(REVIEW, {
    // deno-lint-ignore require-yield
    *review(answered, decision): Operation<void> {
      if (
        live &&
        answered === hold &&
        decided === undefined &&
        (decision === "accept" || decision === "withhold")
      ) {
        decided = decision;
      }
    },
  });
  yield* terminal.operations.review(hold, undefined);
  live = false;
  return { decision: decided ?? "withhold", hold };
}

/** How much of the line a masked excerpt keeps on each side of the match. */
const EXCERPT = 24;

/** One span, as the safe description a local reviewer draws. */
function findingOf(
  text: string,
  span: SecretSpan,
  spans: readonly SecretSpan[],
): AgentReplyFinding {
  const before = text.slice(0, span.start);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.split("\n").length;
  const nextLine = text.indexOf("\n", span.end);
  const lineEnd = nextLine < 0 ? text.length : nextLine;
  return {
    ruleId: span.ruleId,
    messageId: span.messageId,
    line,
    column: span.start - lineStart + 1,
    excerpt: {
      before: maskedExcerpt(text, spans, Math.max(lineStart, span.start - EXCERPT), span.start),
      masked: "•".repeat(8),
      after: maskedExcerpt(text, spans, span.end, Math.min(lineEnd, span.end + EXCERPT)),
    },
  };
}

function maskedExcerpt(
  text: string,
  spans: readonly SecretSpan[],
  start: number,
  end: number,
): string {
  let excerpt = "";
  for (let at = start; at < end; at += 1) {
    excerpt += spans.some((span) => span.start <= at && at < span.end) ? "•" : text[at];
  }
  return printable(excerpt);
}

/** Text with every control character replaced, so it can only be drawn as text. */
function printable(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
}
