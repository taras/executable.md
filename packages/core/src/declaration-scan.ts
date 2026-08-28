/**
 * Where a trusted harness follows its own declaration scan
 * (specs/testing-spec.md).
 *
 * A harness that reads a construct's children in two passes — a prefix of
 * declarations, then the assertion content — has to decide which elements are
 * declarations. Recognizing the *definition* is not enough on its own, because
 * a structural construct expands its descendants without ever resolving a
 * component: an `<If>` in the prefix would otherwise hand a declaration written
 * inside it the same standing as one written beside it, and a declaration is
 * what installs a child's providers.
 *
 * So placement is reported here. Expansion says when a segment list begins and
 * ends, innermost last, and a harness counting those calls knows whether the
 * element it is being asked about is a direct child of the list it is scanning
 * or something a construct reached on its own.
 *
 * This carries no authority. What a scanner records is data it reads back from
 * its own closure, so a second one installed further in follows an expansion
 * nobody is asking about.
 */

import { createContext } from "effection";
import type { Context, Result } from "effection";

import type { AnswerConfiguration } from "./answers.ts";

/**
 * What an `<Answers>` element is, where a scan met it.
 *
 * `parse` the first time the declaration prefix reaches one, `parsed` when the
 * assertion pass re-expands one already read, and `misplaced` for one the scan
 * reached only because a construct expanded it. A scanner that answers nothing
 * leaves the element an ordinary region.
 */
export type AnswersPlacement = "parse" | "parsed" | "misplaced";

export interface DeclarationScanner {
  /** One segment list has begun expanding. */
  enterList(): void;
  /** …and has finished, on a failure as well as on a completion. */
  exitList(): void;
  /** Whether the `<Answers>` written at `site` configures a child. */
  declaresAnswers(site: string): AnswersPlacement | undefined;
  /** The configuration that declaration produced, or why it is malformed. */
  recordAnswers(site: string, configuration: Result<AnswerConfiguration>): void;
}

export const DeclarationScan: Context<DeclarationScanner | undefined> = createContext<
  DeclarationScanner | undefined
>("core.declaration.scan", undefined);
