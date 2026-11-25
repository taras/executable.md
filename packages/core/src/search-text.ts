import { sleep } from "effection";
import type { Operation } from "effection";

export const SEARCH_PAGE_SIZE = 20;
const SEARCH_CHUNK = 64 * 1024;

export function validSearchQuery(query: string): boolean {
  return (
    query.length > 0 && query.length <= 320 && [...query].length <= 160 && !/[\r\n]/.test(query)
  );
}

export type TextMatch = {
  readonly offset: number;
  readonly line: number;
  readonly excerpt: string;
};

function* findLiteral(text: string, query: string, start: number): Operation<number> {
  for (let base = start; base < text.length; base += SEARCH_CHUNK) {
    const end = base + SEARCH_CHUNK + query.length - 1;
    const found = text.slice(base, end).indexOf(query);
    if (found >= 0) {
      return base + found;
    }
    if (end < text.length) {
      yield* sleep(0);
    }
  }
  return -1;
}

export function* searchText(
  text: string,
  query: string,
  after: number,
  limit: number,
): Operation<TextMatch[]> {
  const matches: TextMatch[] = [];
  let offset = 0;
  let line = 1;
  let scanned = 0;
  let nextYield = SEARCH_CHUNK;
  for (
    let index = yield* findLiteral(text, query, 0);
    index >= 0;
    index = yield* findLiteral(text, query, index + query.length)
  ) {
    for (const point of text.slice(scanned, index)) {
      offset += 1;
      if (point === "\n") {
        line += 1;
      }
      if (offset === nextYield) {
        yield* sleep(0);
        nextYield += SEARCH_CHUNK;
      }
    }
    scanned = index;
    if (offset <= after) {
      continue;
    }
    const before = text.slice(Math.max(0, index - 160), index);
    const end = index + query.length;
    const following = text.slice(end, end + 160);
    matches.push({
      offset,
      line,
      excerpt: [...before].slice(-80).join("") + query + [...following].slice(0, 80).join(""),
    });
    if (matches.length === limit) {
      break;
    }
  }
  return matches;
}
