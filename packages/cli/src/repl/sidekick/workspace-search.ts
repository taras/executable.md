import { Err, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/core";
import {
  SEARCH_PAGE_SIZE,
  fileReadArguments,
  searchProjectFiles,
  observeFileWindow,
  retainsOptionalText,
  searchText,
  textWindow,
  validSearchQuery,
} from "@executablemd/core/host";
import { useHostFiles } from "@executablemd/runtime";
import type { HostFilesAccess } from "@executablemd/runtime";
import { z } from "zod";
import type { ReplModel } from "../model.ts";

const sourceSchema = z.union([
  z.strictObject({ path: z.string().min(1) }),
  z.strictObject({ entry: z.int().positive(), part: z.int().nonnegative() }),
]);
const reference = z.strictObject({
  source: sourceSchema,
  offset: z.int().nonnegative(),
});
type Source = z.infer<typeof sourceSchema>;
type SearchPosition = z.infer<typeof reference>;
export type HistoryReader =
  | "REPL.Entry.Source"
  | "REPL.Entry.Output"
  | "REPL.Entry.Prompt"
  | "REPL.Entry.Journal";
type ReaderRef = { reader: HistoryReader | "REPL.File.Read" | "File"; args: Json };
type Scope = "files" | "history" | "both";

export type SearchRequest = { query: string; scope?: Scope; after?: Json };

type SearchMatch = {
  source:
    | { kind: "file"; path: string }
    | { kind: "history"; entry: number; field: string; marker?: string };
  line: number;
  offset: number;
  excerpt: string;
  ref: ReaderRef;
};

export type SearchPage = {
  matches: SearchMatch[];
  next: { query: string; scope: Scope; after: SearchPosition } | null;
};

export type HistoryWindow = { source: SearchMatch["source"]; offset: number; text: string };

type ReadHistory = () => Result<ReplModel>;
type TextSource = {
  id: Source;
  label: Extract<SearchMatch["source"], { kind: "history" }>;
  reader: HistoryReader;
  text: string;
};

function* historySources(model: ReplModel): Generator<TextSource> {
  for (const entry of model.entries) {
    const item = (
      part: number,
      field: string,
      text: string,
      reader: HistoryReader,
      marker?: string,
    ): TextSource => ({
      reader,
      id: { entry: entry.order, part },
      label: {
        kind: "history",
        entry: entry.order,
        field,
        ...(marker === undefined ? {} : { marker }),
      },
      text,
    });
    yield item(0, "source", entry.source, "REPL.Entry.Source");
    if (entry.terminal !== undefined) {
      yield item(1, "output", entry.terminal.output, "REPL.Entry.Output");
      if (entry.terminal.message !== undefined) {
        yield item(2, "failure", entry.terminal.message, "REPL.Entry.Journal");
      }
    }
    const turns = new Map(entry.turns.map((turn) => [turn.marker, turn]));
    for (const [index, record] of entry.records.entries()) {
      const part = 3 + index * 3;
      if (record.exec?.stdout !== undefined) {
        yield item(part, "stdout", record.exec.stdout, "REPL.Entry.Journal", record.marker);
      }
      if (record.exec?.stderr !== undefined) {
        yield item(part + 1, "stderr", record.exec.stderr, "REPL.Entry.Journal", record.marker);
      }
      const failure = turns.get(record.marker)?.failure;
      if (failure !== undefined) {
        yield item(part + 2, "promptError", failure, "REPL.Entry.Prompt", record.marker);
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

export function* searchWorkspace(
  request: SearchRequest,
  access: HostFilesAccess | undefined,
  history: ReadHistory,
): Operation<Result<SearchPage>> {
  const { query, scope = "both", after } = request;
  if (!validSearchQuery(query)) {
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
  let position: SearchPosition | undefined;
  function page(more: boolean): Result<SearchPage> {
    return Ok({
      matches,
      next: more && position !== undefined ? { query, scope, after: position } : null,
    });
  }

  if (scope !== "history" && (cursor === undefined || "path" in cursor.source)) {
    if (access === undefined) {
      return Err(new Error("Project file search is unavailable."));
    }
    const fileAfter =
      cursor !== undefined && "path" in cursor.source
        ? { path: cursor.source.path, offset: cursor.offset }
        : undefined;
    const filePage = yield* scoped(function* () {
      yield* useHostFiles({ access, excludeGitMetadata: true });
      return yield* searchProjectFiles(query, fileAfter, {
        directory: access.project,
        reader: "REPL.File.Read",
      });
    });
    if (!filePage.ok) {
      return Err(new Error("Project files could not be listed for search."));
    }
    for (const match of filePage.value.matches) {
      matches.push(match);
      position = { source: { path: match.source.path }, offset: match.offset };
    }
    if (filePage.value.next !== null) {
      return page(true);
    }
  }
  if (model?.ok) {
    for (const item of historySources(model.value)) {
      const order = cursor === undefined ? 1 : compare(item.id, cursor.source);
      if (order < 0 || !(yield* retainsOptionalText(item.text))) {
        continue;
      }
      const remaining = SEARCH_PAGE_SIZE - matches.length;
      const found = yield* searchText(
        item.text,
        query,
        order === 0 ? (cursor?.offset ?? -1) : -1,
        remaining + 1,
      );
      for (const match of found.slice(0, remaining)) {
        matches.push({
          ...match,
          source: item.label,
          ref: {
            reader: item.reader,
            args: {
              entry: item.label.entry,
              field: item.label.field,
              ...(item.label.marker === undefined ? {} : { marker: item.label.marker }),
              offset: Math.max(0, match.offset - 240),
              limit: 640,
            },
          },
        });
        position = { source: item.id, offset: match.offset };
      }
      if (found.length > remaining) {
        return page(true);
      }
    }
  }
  return page(false);
}

const historyRequest = z.strictObject({
  entry: z.int().positive(),
  field: z.string(),
  marker: z.string().optional(),
  offset: z.int().nonnegative(),
  limit: z.int().min(1).max(640),
});

export function* readHistoryWindow(
  reader: HistoryReader,
  request: Json,
  history: ReadHistory,
): Operation<Result<HistoryWindow>> {
  const parsed = historyRequest.safeParse(request);
  if (!parsed.success) {
    return Err(new Error("Use the arguments supplied with this history reference."));
  }
  const model = history();
  if (!model.ok) {
    return model;
  }
  const { entry, field, marker, offset, limit } = parsed.data;
  const item = [
    ...historySources({ ...model.value, entries: model.value.entries.slice(entry - 1, entry) }),
  ].find(
    (one) =>
      one.label.entry === entry &&
      one.reader === reader &&
      one.label.field === field &&
      one.label.marker === marker,
  );
  if (item === undefined || !(yield* retainsOptionalText(item.text))) {
    return Err(new Error("This retained history window is unavailable."));
  }
  return Ok({ source: item.label, offset, text: textWindow(item.text, offset, limit) });
}

export type ProjectFilePage = {
  source: { kind: "file"; path: string };
  changed: boolean | null;
  text: string;
};

export function* readProjectFile(
  request: Json,
  access: HostFilesAccess | undefined,
): Operation<Result<ProjectFilePage>> {
  let selection;
  try {
    selection = fileReadArguments({ request });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error("Invalid project file read."));
  }
  if (access === undefined) {
    return Err(new Error("Project file reads are unavailable."));
  }
  const page = yield* scoped(function* () {
    yield* useHostFiles({ access, excludeGitMetadata: true });
    return yield* observeFileWindow(access.project, {
      ...selection,
      limit: selection.limit ?? 640,
    });
  });
  return page.ok
    ? Ok({
        source: { kind: "file", path: selection.path },
        changed: page.value.changed,
        text: page.value.text,
      })
    : Err(new Error("This project file is unavailable."));
}
