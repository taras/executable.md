/**
 * Whitespace normalization middleware (spec §9.4).
 *
 * Stateful middleware that tracks trailing newlines across output() calls.
 * Collapses doubled blank lines at segment boundaries without needing the
 * full document.
 *
 * Mutable closure state (trailingNewlines) is safe because the middleware
 * is scoped per useNormalizedOutput() call — one instance per document
 * run, not shared across concurrent scopes.
 */

import type { Operation } from "effection";
import { useScope } from "effection";
import { EMA } from "../api.ts";

export function* useNormalizedOutput(): Operation<void> {
  let trailingNewlines = 0;
  const scope = yield* useScope();

  scope.around(EMA, {
    *output([text], next) {
      let normalized = text;

      // Strip trailing whitespace on each line
      normalized = normalized.replace(/[ \t]+\n/g, "\n");

      // Collapse leading newlines if previous write already ended
      // with enough to form a blank line
      if (trailingNewlines >= 2) {
        normalized = normalized.replace(/^\n+/, "\n");
      }

      // Collapse runs of 3+ newlines within a single write
      normalized = normalized.replace(/\n{3,}/g, "\n\n");

      // Track trailing newlines for next call
      const match = normalized.match(/\n+$/);
      trailingNewlines = match ? match[0].length : 0;

      yield* next(normalized);
    },
  });
}
