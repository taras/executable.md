import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/core";
import { retainsOptionalText } from "@executablemd/core/host";
import { hostFilesHandler } from "@executablemd/runtime";
import type { HostFilesAccess } from "@executablemd/runtime";
import { z } from "zod";
import type { ReplModel } from "../model.ts";

const PAGE_SIZE = 20;
const EXCERPT_SIDE = 80;
const CONTEXT_SIDE = 240;
const MAX_QUERY = 160;

const sourceSchema = z.union([
  z.strictObject({ path: z.string().min(1) }),
  z.strictObject({ entry: z.int().positive(), part: z.int().nonnegative() }),
]);
const reference = z.strictObject({
  source: sourceSchema,
  offset: z.int().nonnegative(),
});
type Source = z.infer<typeof sourceSchema>;
type SearchReference = z.infer<typeof reference>;
type Scope = "files" | "history" | "both";

export type SearchRequest = { query: string; scope?: Scope; after?: Json };

type SearchMatch = {
  source:
    | { kind: "file"; path: string }
    | { kind: "history"; entry: number; field: string; marker?: string };
  line: number;
  offset: number;
  excerpt: string;
  ref: SearchReference;
};

export type SearchPage = {
  matches: SearchMatch[];
  next: { query: string; scope: Scope; after: SearchReference } | null;
};

export type SearchContext = { source: SearchMatch["source"]; offset: number; text: string };

type ReadHistory = () => Result<ReplModel>;
type TextSource = { id: Source; label: SearchMatch["source"]; text: string };

function* historySources(model: ReplModel): Generator<TextSource> {
  for (const entry of model.entries) {
    const item = (part: number, field: string, text: string, marker?: string): TextSource => ({
      id: { entry: entry.order, part },
      label: {
        kind: "history",
        entry: entry.order,
        field,
        ...(marker === undefined ? {} : { marker }),
      },
      text,
    });
    yield item(0, "source", entry.source);
    if (entry.terminal !== undefined) {
      yield item(1, "output", entry.terminal.output);
      if (entry.terminal.message !== undefined) {
        yield item(2, "failure", entry.terminal.message);
      }
    }
    const turns = new Map(entry.turns.map((turn) => [turn.marker, turn]));
    for (const [index, record] of entry.records.entries()) {
      const part = 3 + index * 3;
      if (record.exec?.stdout !== undefined) {
        yield item(part, "stdout", record.exec.stdout, record.marker);
      }
      if (record.exec?.stderr !== undefined) {
        yield item(part + 1, "stderr", record.exec.stderr, record.marker);
      }
      const failure = turns.get(record.marker)?.failure;
      if (failure !== undefined) {
        yield item(part + 2, "promptError", failure, record.marker);
      }
    }
  }
}

function compare(left: Source, right: Source): number {
  if ("path" in left) {
    return "path" in right ? Number(left.path > right.path) - Number(left.path < right.path) : -1;
  }
  return "path" in right ? 1 : left.entry - right.entry || left.part - right.part;
}

function window(text: string, from: number, to: number): string {
  let offset = 0;
  let result = "";
  for (const point of text) {
    if (offset >= to) {
      break;
    }
    if (offset >= from) {
      result += point;
    }
    offset += 1;
  }
  return result;
}

function* readProjectText(
  files: ReturnType<typeof hostFilesHandler>,
  cwd: string,
  path: string,
): Operation<string | undefined> {
  const read = yield* files.readTextFile({ cwd, path });
  if (!read.ok || read.value.includes("\0") || !(yield* retainsOptionalText(read.value))) {
    return undefined;
  }
  return read.value;
}

export function* searchWorkspace(
  request: SearchRequest,
  access: HostFilesAccess | undefined,
  history: ReadHistory,
): Operation<Result<SearchPage>> {
  const { query, scope = "both", after } = request;
  if (
    query.length === 0 ||
    query.length > MAX_QUERY * 2 ||
    [...query].length > MAX_QUERY ||
    /[\r\n]/.test(query)
  ) {
    return Err(new Error("Search needs a single-line literal of 1 to 160 characters."));
  }
  const parsed = after === undefined ? undefined : reference.safeParse(after);
  if (parsed?.success === false) {
    return Err(new Error("Use the continuation returned by Workspace Search."));
  }
  const cursor = parsed?.data;
  const model = scope === "files" ? undefined : history();
  if (model?.ok === false) {
    return model;
  }

  const matches: SearchMatch[] = [];
  function scan(item: TextSource): boolean {
    const order = cursor === undefined ? 1 : compare(item.id, cursor.source);
    if (order < 0) {
      return false;
    }
    let offset = 0;
    let line = 1;
    let scanned = 0;
    for (
      let index = item.text.indexOf(query);
      index >= 0;
      index = item.text.indexOf(query, index + query.length)
    ) {
      for (const point of item.text.slice(scanned, index)) {
        offset += 1;
        if (point === "\n") {
          line += 1;
        }
      }
      scanned = index;
      if (order === 0 && cursor !== undefined && offset <= cursor.offset) {
        continue;
      }
      if (matches.length === PAGE_SIZE) {
        return true;
      }
      const before = item.text.slice(Math.max(0, index - EXCERPT_SIDE * 2), index);
      const end = index + query.length;
      const following = item.text.slice(end, end + EXCERPT_SIDE * 2);
      matches.push({
        source: item.label,
        offset,
        line,
        excerpt:
          [...before].slice(-EXCERPT_SIDE).join("") +
          query +
          [...following].slice(0, EXCERPT_SIDE).join(""),
        ref: { source: item.id, offset },
      });
    }
    return false;
  }

  function page(more: boolean): Result<SearchPage> {
    return Ok({
      matches,
      next: more ? { query, scope, after: matches[matches.length - 1].ref } : null,
    });
  }

  if (scope !== "history" && (cursor === undefined || "path" in cursor.source)) {
    if (access === undefined) {
      return Err(new Error("Project file search is unavailable."));
    }
    const files = hostFilesHandler({ access, excludeGitMetadata: true });
    const listing = yield* files.globFiles({
      cwd: access.project,
      include: ["**/*"],
      exclude: [".git", "**/.git/**"],
    });
    if (!listing.ok) {
      return Err(new Error("Project files could not be listed for search."));
    }
    for (const path of listing.value) {
      if (cursor !== undefined && compare({ path }, cursor.source) < 0) {
        continue;
      }
      const text = yield* readProjectText(files, access.project, path);
      if (text !== undefined && scan({ id: { path }, label: { kind: "file", path }, text })) {
        return page(true);
      }
    }
  }
  if (model?.ok) {
    for (const item of historySources(model.value)) {
      if (scan(item)) {
        return page(true);
      }
    }
  }
  return page(false);
}

export function* readSearchContext(
  ref: Json,
  access: HostFilesAccess | undefined,
  history: ReadHistory,
): Operation<Result<SearchContext>> {
  const parsed = reference.safeParse(ref);
  const unavailable = () => Err<SearchContext>(new Error("This search context is unavailable."));
  if (!parsed.success) {
    return unavailable();
  }
  const { source, offset } = parsed.data;
  const start = Math.max(0, offset - CONTEXT_SIDE);
  const end = offset + CONTEXT_SIDE + MAX_QUERY;
  if ("path" in source) {
    if (access === undefined) {
      return unavailable();
    }
    const text = yield* readProjectText(
      hostFilesHandler({ access, excludeGitMetadata: true }),
      access.project,
      source.path,
    );
    return text !== undefined
      ? Ok({
          source: { kind: "file", path: source.path },
          offset: start,
          text: window(text, start, end),
        })
      : unavailable();
  }
  const model = history();
  if (!model.ok) {
    return model;
  }
  for (const item of historySources(model.value)) {
    if (compare(item.id, source) === 0) {
      return Ok({ source: item.label, offset: start, text: window(item.text, start, end) });
    }
  }
  return unavailable();
}
