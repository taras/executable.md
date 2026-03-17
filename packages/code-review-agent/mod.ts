/**
 * @executablemd/code-review-agent
 *
 * Provides `parseDiff` — transforms raw git diff output into a typed PR
 * object for use by EMA review components.
 */

export { parseDiff } from "./src/parse-diff.ts";
export type { PR, DiffFile, DiffHunk, DiffLine } from "./src/types.ts";
