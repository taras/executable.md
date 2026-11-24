import { createHash } from "node:crypto";
import { isJsonObject } from "./json.ts";
import type { Json, JsonObject } from "./types.ts";

export const FILE_WINDOW_LIMIT = 4096;

export type FileReadSelection = {
  readonly path: string;
  readonly lines?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly revision?: string;
};

export function fileRevision(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 24);
}

export function fileReadSelection(value: JsonObject): FileReadSelection {
  const { path, lines, offset, limit, revision } = value;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    Object.keys(value).some(
      (name) => !["path", "lines", "offset", "limit", "revision"].includes(name),
    )
  ) {
    throw new Error("Give a File path and an optional range.");
  }
  if (
    (offset !== undefined &&
      (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) ||
    (limit !== undefined &&
      (typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > FILE_WINDOW_LIMIT)) ||
    (revision !== undefined && (typeof revision !== "string" || !/^[a-f0-9]{24}$/.test(revision)))
  ) {
    throw new Error(
      "Give a nonnegative offset, a positive bounded limit and a valid file revision.",
    );
  }
  if (lines === undefined) {
    return { path, offset, limit, revision };
  }
  if (offset !== undefined) {
    throw new Error("Choose a line range or a character offset.");
  }
  if (typeof lines === "string" && lineRange(lines) !== undefined) {
    return { path, lines, limit, revision };
  }
  throw new Error('Give a one-based line such as "42" or an inclusive range such as "38:46".');
}

export function fileReadArguments(props: JsonObject): FileReadSelection {
  if (props.request === undefined) {
    return fileReadSelection(props);
  }
  if (!isJsonObject(props.request) || Object.keys(props).length !== 1) {
    throw new Error("Pass a file read request by itself.");
  }
  return fileReadSelection(props.request);
}

function lineRange(value: string): [number, number] | undefined {
  const match = /^([1-9][0-9]*)(?::([1-9][0-9]*))?$/.exec(value);
  if (match === null) {
    return undefined;
  }
  const first = Number(match[1]);
  const last = Number(match[2] ?? match[1]);
  return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first <= last
    ? [first, last]
    : undefined;
}

export function textWindow(text: string, offset: number, limit: number): string {
  let index = 0;
  let result = "";
  for (const point of text) {
    if (index >= offset + limit) {
      break;
    }
    if (index >= offset) {
      result += point;
    }
    index += 1;
  }
  return result;
}

export function readFileWindow(text: string, selection: FileReadSelection): string {
  const { lines, offset, limit } = selection;
  if (lines === undefined) {
    return offset === undefined && limit === undefined
      ? text
      : textWindow(text, offset ?? 0, limit ?? FILE_WINDOW_LIMIT);
  }
  const range = lineRange(lines);
  if (range === undefined) {
    throw new Error("Invalid line range.");
  }
  const [first, last] = range;
  let start = 0;
  for (let line = 1; line < first; line += 1) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      return "";
    }
    start = newline + 1;
  }
  let end = start;
  for (let line = first; line <= last; line += 1) {
    const newline = text.indexOf("\n", end);
    if (newline === -1) {
      end = text.length;
      break;
    }
    end = newline + 1;
  }
  return limit === undefined
    ? text.slice(start, end)
    : textWindow(text.slice(start, end), 0, limit);
}
