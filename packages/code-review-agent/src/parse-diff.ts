/**
 * parseDiff — transforms raw git diff output into a typed PR object.
 *
 * Handles: unified diff format, rename detection, binary file skipping,
 * language inference, test/config/type-declaration classification,
 * diffPreview truncation, directory computation.
 */

import type { PR, DiffFile, DiffHunk, DiffLine } from "./types.ts";

const DIFF_PREVIEW_MAX = 80_000;

// ---------------------------------------------------------------------------
// Language inference
// ---------------------------------------------------------------------------

const EXTENSION_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".xml": "xml",
  ".svg": "xml",
  ".dockerfile": "docker",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "c++",
  ".h": "c",
  ".hpp": "c++",
};

function inferLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith("/dockerfile")) return "docker";

  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "unknown";
  const ext = filePath.slice(lastDot).toLowerCase();
  return EXTENSION_LANGUAGE[ext] ?? "unknown";
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("__tests__/") ||
    lower.includes("/test/") ||
    lower.startsWith("test/")
  );
}

function isConfigFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const base = lower.split("/").pop() ?? "";
  return (
    base.includes(".config.") ||
    (base.startsWith(".") &&
      (base.endsWith("rc") ||
        base.endsWith("rc.json") ||
        base.endsWith("rc.js") ||
        base.endsWith("rc.yml") ||
        base.endsWith("rc.yaml"))) ||
    base.startsWith("tsconfig") ||
    base === "package.json" ||
    base === "package-lock.json" ||
    base === "deno.json" ||
    base === "deno.lock" ||
    base === ".gitignore" ||
    base === ".eslintignore" ||
    base === ".prettierignore"
  );
}

function isTypeDeclaration(filePath: string): boolean {
  return filePath.endsWith(".d.ts");
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Parse the `git diff --name-status` output into a map of path → status.
 * Each line is: `STATUS\tFILE` or `STATUS\tOLD\tNEW` (for renames).
 */
function parseNameStatus(raw: string): Map<string, "A" | "M" | "D" | "R" | "C"> {
  const result = new Map<string, "A" | "M" | "D" | "R" | "C">();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    const statusChar = (parts[0] ?? "")[0] as "A" | "M" | "D" | "R" | "C";
    if (!["A", "M", "D", "R", "C"].includes(statusChar)) continue;

    if (statusChar === "R" || statusChar === "C") {
      // Rename/Copy: STATUS\tOLD\tNEW — use new path
      const newPath = parts[2] ?? parts[1] ?? "";
      result.set(newPath, statusChar);
    } else {
      const filePath = parts[1] ?? "";
      result.set(filePath, statusChar);
    }
  }
  return result;
}

/**
 * Parse a unified diff (`git diff`) into DiffFile objects.
 */
function parseDiffContent(
  rawDiff: string,
  statusMap: Map<string, "A" | "M" | "D" | "R" | "C">,
): DiffFile[] {
  const files: DiffFile[] = [];

  // Split on `diff --git` headers
  const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");

    // Extract file path from the header: `a/path b/path`
    const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;
    const filePath = headerMatch[2];

    // Skip binary files
    if (section.includes("Binary files ")) continue;

    const status = statusMap.get(filePath) ?? "M";
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let addLineNo = 0;
    let removeLineNo = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      // Hunk header: @@ -old,count +new,count @@
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (hunkMatch) {
        currentHunk = { header: line, lines: [] };
        hunks.push(currentHunk);
        removeLineNo = parseInt(hunkMatch[1], 10);
        addLineNo = parseInt(hunkMatch[2], 10);
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith("+")) {
        currentHunk.lines.push({
          type: "add",
          content: line.slice(1),
          file: filePath,
          lineNumber: addLineNo,
          isTest: isTestFile(filePath),
        });
        addLineNo++;
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({
          type: "remove",
          content: line.slice(1),
          file: filePath,
          lineNumber: removeLineNo,
          isTest: isTestFile(filePath),
        });
        removeLineNo++;
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({
          type: "context",
          content: line.slice(1),
          file: filePath,
          lineNumber: addLineNo,
          isTest: isTestFile(filePath),
        });
        addLineNo++;
        removeLineNo++;
      }
      // Skip lines starting with \ (e.g., "\ No newline at end of file")
    }

    files.push({
      path: filePath,
      status,
      hunks,
      language: inferLanguage(filePath),
      isTest: isTestFile(filePath),
      isConfig: isConfigFile(filePath),
      isTypeDeclaration: isTypeDeclaration(filePath),
    });
  }

  return files;
}

/**
 * Compute unique directories at depth 2 (e.g., "src/components").
 */
function computeDirectories(files: DiffFile[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.length >= 2) {
      dirs.add(parts.slice(0, 2).join("/"));
    } else if (parts.length === 1) {
      dirs.add(".");
    }
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse raw `git diff` and `git diff --name-status` output into a typed PR object.
 *
 * @param rawDiff - Output of `git diff BASE...HEAD`
 * @param rawFiles - Output of `git diff --name-status BASE...HEAD`
 * @param meta - PR metadata (title, body, number)
 * @returns Typed PR object for use by review components
 */
export function parseDiff(
  rawDiff: string,
  rawFiles: string,
  meta: { title: string; body: string; number: string },
): PR {
  const statusMap = parseNameStatus(rawFiles);
  const files = parseDiffContent(rawDiff, statusMap);

  const allLines = files.flatMap((f) => f.hunks.flatMap((h) => h.lines));
  const added = allLines.filter((l) => l.type === "add");
  const removed = allLines.filter((l) => l.type === "remove");

  const addedSource = added.map((l) => l.content).join("\n");
  const diffPreview =
    addedSource.length > DIFF_PREVIEW_MAX ? addedSource.slice(0, DIFF_PREVIEW_MAX) : addedSource;

  return {
    files,
    added,
    removed,
    created: files.filter((f) => f.status === "A"),
    modified: files.filter((f) => f.status === "M"),
    deleted: files.filter((f) => f.status === "D"),
    directories: computeDirectories(files),
    addedSource,
    diffPreview,
    stats: {
      totalFiles: files.length,
      additions: added.length,
      deletions: removed.length,
      totalChanges: added.length + removed.length,
    },
    meta,
  };
}
