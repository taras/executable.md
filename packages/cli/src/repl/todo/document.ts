export interface TodoItem {
  readonly text: string;
  readonly completed: boolean;
}

interface TodoLine {
  readonly text: string;
  readonly end: string;
}

export interface TodoDocument {
  readonly source: string;
  readonly lines: readonly TodoLine[];
  readonly tasks: readonly number[];
  readonly items: readonly TodoItem[];
  readonly newline: string;
}

export class TodoEditError extends Error {
  override name = "TodoEditError";
}

function sourceLines(source: string): TodoLine[] {
  const lines: TodoLine[] = [];
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

export function parseTodo(source: string): TodoDocument {
  const lines = sourceLines(source);
  const items: TodoItem[] = [];
  const tasks: number[] = [];
  for (const [at, line] of lines.entries()) {
    if (/^[ \t]*$/.test(line.text)) {
      continue;
    }
    const task = /^- \[([ xX])\] (.*)$/.exec(line.text);
    if (task === null || task[2].trim().length === 0 || images(task[2])) {
      throw new TodoEditError(
        `todo.md:${at + 1}: use a flat '- [ ] text' or '- [x] text' task without images. Repair this line and read again.`,
      );
    }
    tasks.push(at);
    items.push(Object.freeze({ text: task[2], completed: task[1] !== " " }));
  }
  return Object.freeze({
    source,
    lines: Object.freeze(lines.map((line) => Object.freeze(line))),
    tasks: Object.freeze(tasks),
    items: Object.freeze(items),
    newline: lines.find((line) => line.end !== "")?.end ?? "\n",
  });
}

function images(text: string): boolean {
  const literal = text.replace(/(`+)([\s\S]*?)\1/g, "").replace(/\\[\s\S]/g, "");
  return /!\[[^\]]*\](?:\(|\[)/.test(literal);
}

function todoSource(lines: readonly TodoLine[]): string {
  if (lines.slice(0, -1).some((line) => line.end === "")) {
    throw new TodoEditError("todo.md: a line without a final newline must be last.");
  }
  return lines.map((line) => line.text + line.end).join("");
}

export function todoDiff(before: string, after: string): string {
  if (before === after) {
    return "";
  }
  const old = sourceLines(before);
  const next = sourceLines(after);
  const rows = [
    `@@ -${old.length === 0 ? 0 : 1},${old.length} +${next.length === 0 ? 0 : 1},${next.length} @@`,
  ];
  for (const [prefix, lines] of [
    ["-", old],
    ["+", next],
  ] as const) {
    for (const line of lines) {
      rows.push(prefix + line.text);
      if (line.end === "") {
        rows.push("\\ No newline at end of file");
      }
    }
  }
  return rows.join("\n") + "\n";
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
  throw new TodoEditError(
    "todo.md: supply an exact, single-file unified diff and read again after a stale edit.",
  );
}

function hunks(patch: string): Hunk[] {
  const rows = patch.split(/\r?\n/);
  if (rows[rows.length - 1] === "") {
    rows.pop();
  }
  let at = 0;
  if (rows[0]?.startsWith("--- ")) {
    if (
      !/^--- (?:a\/)?todo\.md(?:\t[^\r\n]*)?$/.test(rows[0]) ||
      !/^\+\+\+ (?:b\/)?todo\.md(?:\t[^\r\n]*)?$/.test(rows[1] ?? "")
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
      } else if (/^[ +\-]/.test(row)) {
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

export function applyTodoDiff(document: TodoDocument, patch: string): TodoDocument {
  const output: TodoLine[] = [];
  let cursor = 0;
  for (const hunk of hunks(patch)) {
    const start = hunk.oldStart - (hunk.oldCount === 0 ? 0 : 1);
    if (start < cursor || start > document.lines.length) {
      malformed();
    }
    output.push(...document.lines.slice(cursor, start));
    cursor = start;
    if (hunk.newStart - (hunk.newCount === 0 ? 0 : 1) !== output.length) {
      malformed();
    }
    const removed: TodoLine[] = [];
    let added = 0;
    for (const line of hunk.lines) {
      if (line.kind === "+") {
        const previous = removed[added++];
        output.push({
          text: line.text,
          end: line.terminated ? previous?.end || document.newline : "",
        });
      } else {
        const old = document.lines[cursor++];
        if (old === undefined || old.text !== line.text || (old.end !== "") !== line.terminated) {
          throw new TodoEditError(
            `todo.md:${cursor}: the diff no longer matches. Read Sidekick.Todo and prepare a fresh diff.`,
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
  output.push(...document.lines.slice(cursor));
  return parseTodo(todoSource(output));
}

export function editTodo(
  source: string,
  index: number,
  action: "rename" | "toggle" | "remove" | "up" | "down",
  text = "",
): string {
  const document = parseTodo(source);
  const lines = document.lines.map((line) => ({ ...line }));
  const at = document.tasks[index];
  if (action === "rename" && index === document.tasks.length) {
    if (text.trim().length === 0 || /[\r\n]/.test(text)) {
      throw new TodoEditError("Enter one nonempty task line.");
    }
    const end = lines.length === 0 || lines.at(-1)?.end !== "" ? document.newline : "";
    const last = lines.at(-1);
    if (last !== undefined && last.end === "") {
      last.end = document.newline;
    }
    lines.push({ text: `- [ ] ${text}`, end });
  } else if (at === undefined) {
    throw new TodoEditError("This task no longer exists. Read todo.md again.");
  } else if (action === "remove") {
    lines.splice(at, 1);
  } else if (action === "up" || action === "down") {
    const other = document.tasks[index + (action === "up" ? -1 : 1)];
    if (other !== undefined) {
      const saved = lines[at];
      lines[at] = lines[other];
      lines[other] = saved;
    }
  } else if (action === "toggle") {
    lines[at].text =
      `- [${document.items[index].completed ? " " : "x"}] ${document.items[index].text}`;
  } else {
    if (text.trim().length === 0 || /[\r\n]/.test(text)) {
      throw new TodoEditError("Enter one nonempty task line.");
    }
    lines[at].text = lines[at].text.slice(0, 6) + text;
  }
  if (document.lines.length > 0 && document.lines.at(-1)?.end === "" && lines.length > 0) {
    const last = lines[lines.length - 1];
    const separator = last.end || document.newline;
    for (const line of lines.slice(0, -1)) {
      if (line.end === "") {
        line.end = separator;
      }
    }
    last.end = "";
  }
  return parseTodo(todoSource(lines)).source;
}
