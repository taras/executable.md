import { Lexer } from "marked";
import type { Token } from "marked";
import type { ReplTokenRun } from "../description.ts";
import type { ReplPresentationRole } from "../presentation-style.ts";

function visible(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (character) =>
    character === "\t" ? "    " : `\\u{${character.codePointAt(0)?.toString(16)}}`,
  );
}

export function todoInline(source: string): readonly ReplTokenRun[] {
  const runs: ReplTokenRun[] = [];
  function walk(tokens: readonly Token[], role: ReplPresentationRole): void {
    for (const token of tokens) {
      if (
        (token.type === "strong" || token.type === "em" || token.type === "link") &&
        "tokens" in token &&
        token.tokens !== undefined
      ) {
        walk(
          token.tokens,
          token.type === "strong" ? "source-heading" : token.type === "em" ? "todo-em" : role,
        );
      } else {
        const text =
          token.type === "codespan" || token.type === "escape" || token.type === "text"
            ? "text" in token && typeof token.text === "string"
              ? token.text
              : token.raw
            : token.raw;
        runs.push({ text: visible(text), token: token.type === "codespan" ? "xmd-value" : role });
      }
    }
  }
  walk(Lexer.lexInline(source), "source");
  return Object.freeze(runs.map((run) => Object.freeze(run)));
}
