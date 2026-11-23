export interface SourceLine {
  readonly text: string;
  readonly end: string;
}

export class UnifiedDiffError extends Error {
  override name = "UnifiedDiffError";

  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(message);
  }
}

function matchesHeader(
  row: string | undefined,
  marker: string,
  prefix: string,
  path: string,
): boolean {
  if (!row?.startsWith(marker)) {
    return false;
  }
  const name = row.slice(marker.length).split("\t", 1)[0];
  return name === path || name === prefix + path;
}

export function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let at = source.indexOf("\n"); at >= 0; at = source.indexOf("\n", start)) {
    const crlf = at > start && source[at - 1] === "\r";
    lines.push({ text: source.slice(start, crlf ? at - 1 : at), end: crlf ? "\r\n" : "\n" });
    start = at + 1;
  }
  if (start < source.length) {
    lines.push({ text: source.slice(start), end: "" });
  }
  return lines;
}

function renderSourceLines(lines: readonly SourceLine[]): string {
  if (lines.slice(0, -1).some((line) => line.end === "")) {
    throw new UnifiedDiffError("a line without a final newline must be last.");
  }
  return lines.map((line) => line.text + line.end).join("");
}

interface PatchLine {
  readonly kind: string;
  readonly text: string;
  terminated: boolean;
}

interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: PatchLine[];
}

function malformed(): never {
  throw new UnifiedDiffError(
    "supply an exact, single-file unified diff and read again after a stale edit.",
  );
}

function hunks(patch: string, path: string): Hunk[] {
  const rows = patch.split(/\r?\n/);
  if (rows[rows.length - 1] === "") {
    rows.pop();
  }
  let at = 0;
  if (rows[0]?.startsWith("--- ")) {
    if (
      !matchesHeader(rows[0], "--- ", "a/", path) ||
      !matchesHeader(rows[1], "+++ ", "b/", path)
    ) {
      malformed();
    }
    at = 2;
  }
  const result: Hunk[] = [];
  while (at < rows.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(rows[at++]);
    if (header === null) {
      malformed();
    }
    const hunk: Hunk = {
      oldStart: Number(header[1]),
      oldCount: Number(header[2] ?? 1),
      newStart: Number(header[3]),
      newCount: Number(header[4] ?? 1),
      lines: [],
    };
    if (![hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount].every(Number.isSafeInteger)) {
      malformed();
    }
    while (at < rows.length && !rows[at].startsWith("@@ ")) {
      const row = rows[at++];
      if (row === "\\ No newline at end of file") {
        const previous = hunk.lines[hunk.lines.length - 1];
        if (previous === undefined || !previous.terminated) {
          malformed();
        }
        previous.terminated = false;
      } else if (/^[ +-]/.test(row)) {
        hunk.lines.push({ kind: row[0], text: row.slice(1), terminated: true });
      } else {
        malformed();
      }
    }
    if (
      hunk.lines.filter((line) => line.kind !== "+").length !== hunk.oldCount ||
      hunk.lines.filter((line) => line.kind !== "-").length !== hunk.newCount ||
      (hunk.oldCount > 0 && hunk.oldStart === 0) ||
      (hunk.newCount > 0 && hunk.newStart === 0)
    ) {
      malformed();
    }
    result.push(hunk);
  }
  if (result.length === 0) {
    malformed();
  }
  return result;
}

export function applyUnifiedDiff(source: string, patch: string, path: string): string {
  const lines = sourceLines(source);
  const newline = lines.find((line) => line.end !== "")?.end ?? "\n";
  const output: SourceLine[] = [];
  let cursor = 0;
  for (const hunk of hunks(patch, path)) {
    const start = hunk.oldStart - (hunk.oldCount === 0 ? 0 : 1);
    if (start < cursor || start > lines.length) {
      malformed();
    }
    for (; cursor < start; cursor++) {
      output.push(lines[cursor]);
    }
    if (hunk.newStart - (hunk.newCount === 0 ? 0 : 1) !== output.length) {
      malformed();
    }
    const removed: SourceLine[] = [];
    let added = 0;
    for (const line of hunk.lines) {
      if (line.kind === "+") {
        const previous = removed[added++];
        output.push({
          text: line.text,
          end: line.terminated ? previous?.end || newline : "",
        });
      } else {
        const old = lines[cursor++];
        if (old === undefined || old.text !== line.text || (old.end !== "") !== line.terminated) {
          throw new UnifiedDiffError(
            `line ${cursor}: the diff no longer matches. Read the file and prepare a fresh diff.`,
            cursor,
          );
        }
        if (line.kind === " ") {
          output.push(old);
          removed.length = 0;
          added = 0;
        } else {
          removed.push(old);
        }
      }
    }
  }
  for (; cursor < lines.length; cursor++) {
    output.push(lines[cursor]);
  }
  return renderSourceLines(output);
}

export function fencedUnifiedDiff(source: string): string | undefined {
  const match = /^\s*(`{3,}|~{3,})(?:diff|patch)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*\s*$/.exec(
    source,
  );
  if (match === null || /^(?:`{3,}|~{3,})/m.test(match[2])) {
    return undefined;
  }
  return match[2] + "\n";
}
