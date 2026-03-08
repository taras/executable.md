/**
 * Markdown healing (spec §2.3).
 *
 * Closes unclosed markdown constructs (bold, italic, code spans, links, etc.)
 * at segment boundaries. Runs after the boundary scanner, before interpolation.
 *
 * Pure, synchronous, stateless — no journal entry, no Effection yield.
 */
import remend from "remend";

/**
 * Heal incomplete markdown constructs in a text segment.
 *
 * `htmlTags: false` — the boundary scanner owns JSX/HTML completeness;
 * remend owns markdown construct completeness.
 *
 * Remend strips a single trailing space (setext heading heuristic).
 * Text segments are inline fragments where trailing spaces are
 * significant word separators (e.g., `"Before "` before `<Content />`),
 * so we preserve and restore the trailing space when remend removes it.
 */
export function healSegment(text: string): string {
  const hadTrailingSpace = text.length > 0 && text.endsWith(" ");
  const healed = remend(text, { htmlTags: false });
  // Restore trailing space if remend stripped it (setext heading heuristic)
  if (hadTrailingSpace && healed.length > 0 && !healed.endsWith(" ")) {
    return healed + " ";
  }
  return healed;
}
