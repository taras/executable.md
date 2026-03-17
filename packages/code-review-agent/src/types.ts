/**
 * Types for the code review agent's parsed PR representation.
 *
 * `parseDiff` transforms raw `git diff` and `git diff --name-status`
 * output into these typed structures for use by review components.
 */

export interface PR {
  files: DiffFile[];
  added: DiffLine[];
  removed: DiffLine[];
  created: DiffFile[];
  modified: DiffFile[];
  deleted: DiffFile[];
  directories: Set<string>;
  /** Concatenated content of all added lines. */
  addedSource: string;
  /** addedSource truncated to 80,000 characters. */
  diffPreview: string;
  stats: {
    totalFiles: number;
    additions: number;
    deletions: number;
    totalChanges: number;
  };
  meta: {
    title: string;
    body: string;
    number: string;
  };
}

export interface DiffFile {
  path: string;
  status: "A" | "M" | "D" | "R" | "C";
  hunks: DiffHunk[];
  language: string;
  isTest: boolean;
  isConfig: boolean;
  isTypeDeclaration: boolean;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  file: string;
  lineNumber: number;
  isTest: boolean;
}
