/**
 * Terminal ANSI formatting middleware (spec §9.5).
 *
 * Converts markdown text to ANSI-colored terminal text using marked-terminal.
 * Synchronous only — async: false, no promises.
 */

import type { Operation } from "effection";
import { useScope } from "effection";
import { Marked } from "marked";
// @ts-ignore -- marked-terminal has no type declarations
import { markedTerminal } from "marked-terminal";
import { EMA } from "../api.ts";

export function* useTerminalOutput(): Operation<void> {
  // markedTerminal() returns a marked extension object ({ renderer, useNewRenderer })
  const marked = new Marked(markedTerminal());
  const scope = yield* useScope();

  scope.around(EMA, {
    *output([text], next) {
      const formatted = marked.parse(text, { async: false }) as string;
      yield* next(formatted);
    },
  });
}
