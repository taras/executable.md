import { applyUnifiedDiff, sourceLines, UnifiedDiffError } from "@executablemd/core/host";
import type { SourceLine } from "@executablemd/core/host";

export interface TodoItem {
  readonly text: string;
  readonly completed: boolean;
}

export interface TodoDocument {
  readonly source: string;
  readonly lines: readonly SourceLine[];
  readonly tasks: readonly number[];
  readonly items: readonly TodoItem[];
  readonly openItems: number;
  readonly newline: string;
}

export class TodoEditError extends Error {
  override name = "TodoEditError";
}

export function parseTodo(source: string): TodoDocument {
  const lines = sourceLines(source);
  const items: TodoItem[] = [];
  const tasks: number[] = [];
  let openItems = 0;
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
    const completed = task[1] !== " ";
    if (!completed) {
      openItems++;
    }
    items.push(Object.freeze({ text: task[2], completed }));
  }
  return Object.freeze({
    source,
    lines: Object.freeze(lines.map((line) => Object.freeze(line))),
    tasks: Object.freeze(tasks),
    items: Object.freeze(items),
    openItems,
    newline: lines.find((line) => line.end !== "")?.end ?? "\n",
  });
}

function images(text: string): boolean {
  const literal = text.replace(/(`+)([\s\S]*?)\1/g, "").replace(/\\[\s\S]/g, "");
  return /!\[[^\]]*\](?:\(|\[)/.test(literal);
}

function todoSource(lines: readonly SourceLine[]): string {
  if (lines.slice(0, -1).some((line) => line.end === "")) {
    throw new TodoEditError("todo.md: a line without a final newline must be last.");
  }
  return lines.map((line) => line.text + line.end).join("");
}

export function todoDiff(before: string, after: string): string {
  const old = sourceLines(before);
  const next = sourceLines(after);
  const signature = (line: SourceLine): string => JSON.stringify([line.text, line.end]);
  function positions(lines: readonly SourceLine[]): Map<string, number[]> {
    const found = new Map<string, number[]>();
    for (const [index, line] of lines.entries()) {
      const key = signature(line);
      const offsets = found.get(key) ?? [];
      offsets.push(index);
      found.set(key, offsets);
    }
    return found;
  }
  const oldPositions = positions(old);
  const newPositions = positions(next);
  const rows: string[] = [];
  let left = 0;
  let right = 0;
  let startLeft = 0;
  let startRight = 0;
  const removed: SourceLine[] = [];
  const added: SourceLine[] = [];
  function flush(): void {
    if (removed.length === 0 && added.length === 0) {
      return;
    }
    rows.push(
      `@@ -${startLeft + (removed.length === 0 ? 0 : 1)},${removed.length} +${startRight + (added.length === 0 ? 0 : 1)},${added.length} @@`,
    );
    for (const [prefix, lines] of [
      ["-", removed],
      ["+", added],
    ] as const) {
      for (const line of lines) {
        rows.push(prefix + line.text);
        if (line.end === "") {
          rows.push("\\ No newline at end of file");
        }
      }
    }
    removed.length = 0;
    added.length = 0;
  }
  while (left < old.length || right < next.length) {
    const previous = old[left];
    const following = next[right];
    if (
      previous !== undefined &&
      following !== undefined &&
      signature(previous) === signature(following)
    ) {
      flush();
      left++;
      right++;
      continue;
    }
    if (removed.length === 0 && added.length === 0) {
      startLeft = left;
      startRight = right;
    }
    const oldMatch =
      following === undefined
        ? undefined
        : oldPositions.get(signature(following))?.find((at) => at >= left);
    const newMatch =
      previous === undefined
        ? undefined
        : newPositions.get(signature(previous))?.find((at) => at >= right);
    if (
      previous === undefined ||
      (newMatch !== undefined && (oldMatch === undefined || newMatch - right < oldMatch - left))
    ) {
      if (following !== undefined) {
        added.push(following);
        right++;
      }
    } else if (following === undefined || oldMatch !== undefined) {
      removed.push(previous);
      left++;
    } else {
      removed.push(previous);
      added.push(following);
      left++;
      right++;
    }
  }
  flush();
  return rows.length === 0 ? "" : rows.join("\n") + "\n";
}

export function applyTodoDiff(document: TodoDocument, patch: string): TodoDocument {
  try {
    return parseTodo(applyUnifiedDiff(document.source, patch, "todo.md"));
  } catch (error) {
    if (!(error instanceof UnifiedDiffError)) {
      throw error;
    }
    const message =
      error.line === undefined
        ? `todo.md: ${error.message}`
        : `todo.md:${error.line}: the diff no longer matches. Read Sidekick.Todo and prepare a fresh diff.`;
    throw new TodoEditError(message, { cause: error });
  }
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
