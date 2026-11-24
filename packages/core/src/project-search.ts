import { createContext, Err, Ok } from "effection";
import type { Context, Operation, Result } from "effection";
import { cwd } from "@executablemd/runtime";
import { fileRevision } from "./file-window.ts";
import { globFiles } from "./files.ts";
import { observeFile } from "./file-observation.ts";
import { SEARCH_PAGE_SIZE, searchText, validSearchQuery } from "./search-text.ts";
import type { TextMatch } from "./search-text.ts";

export const SearchProject: Context<string | undefined> = createContext<string | undefined>(
  "executablemd.searchProject",
  undefined,
);

export function* searchDirectory(): Operation<string> {
  return (yield* SearchProject.get()) ?? (yield* cwd());
}

export type FileSearchHit = TextMatch & {
  source: { kind: "file"; path: string };
  ref: {
    reader: "File" | "REPL.File.Read";
    args: { path: string; offset: number; limit: number; revision: string };
  };
};

function* matchProjectFile(
  directory: string,
  path: string,
  query: string,
  after: number,
  limit: number,
  reader: FileSearchHit["ref"]["reader"],
): Operation<FileSearchHit[]> {
  const result = yield* observeFile<FileSearchHit[]>(directory, path, true, {
    miss: [],
    *match(text) {
      if (text.includes("\0")) {
        return undefined;
      }
      const hits = yield* searchText(text, query, after, limit);
      if (hits.length === 0) {
        return undefined;
      }
      return () => {
        const revision = fileRevision(text);
        return hits.map((hit) => ({
          ...hit,
          source: { kind: "file", path },
          ref: {
            reader,
            args: { path, revision, offset: Math.max(0, hit.offset - 240), limit: 640 },
          },
        }));
      };
    },
  });
  return result.ok ? result.value : [];
}

export type FileCursor = { path: string; offset: number };
export type FileSearchPage = {
  matches: FileSearchHit[];
  next: { query: string; after: FileCursor } | null;
};

export function* searchProjectFiles(
  query: string,
  after?: FileCursor,
  options?: { directory: string; reader: FileSearchHit["ref"]["reader"] },
): Operation<Result<FileSearchPage>> {
  if (!validSearchQuery(query)) {
    return Err(new Error("Search needs a single-line literal of 1 to 160 characters."));
  }
  const directory = options?.directory ?? (yield* searchDirectory());
  const listed = yield* globFiles({
    cwd: directory,
    projectSearch: true,
    include: ["**/*"],
    exclude: [".git", "**/.git/**"],
  });
  if (!listed.ok) {
    return listed;
  }
  const matches: FileSearchHit[] = [];
  for (const path of listed.value) {
    if (after !== undefined && path < after.path) {
      continue;
    }
    const remaining = SEARCH_PAGE_SIZE - matches.length;
    const found = yield* matchProjectFile(
      directory,
      path,
      query,
      after?.path === path ? after.offset : -1,
      remaining + 1,
      options?.reader ?? "File",
    );
    matches.push(...found.slice(0, remaining));
    if (found.length > remaining) {
      const last = matches[matches.length - 1];
      return Ok({
        matches,
        next: { query, after: { path: last.source.path, offset: last.offset } },
      });
    }
  }
  return Ok({ matches, next: null });
}
