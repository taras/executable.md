import { createDurableOperation } from "@executablemd/durable-streams";
import { isJsonObject, parseJson } from "../json.ts";
import type { Json } from "../types.ts";
import type { Operation } from "effection";
import { searchProjectFiles } from "../project-search.ts";
import type { FileCursor } from "../project-search.ts";

export const props = {
  type: "object",
  properties: { query: { type: "string" }, after: { type: "object" } },
  required: ["query"],
  additionalProperties: false,
};

export default function* (input: Record<string, Json>): Operation<Json> {
  if (typeof input.query !== "string") {
    throw new Error("Give a Workspace.Search query.");
  }
  let after: FileCursor | undefined;
  if (input.after !== undefined) {
    const cursor = input.after;
    if (
      !isJsonObject(cursor) ||
      typeof cursor.path !== "string" ||
      typeof cursor.offset !== "number" ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    ) {
      throw new Error("Use the continuation returned by Workspace.Search.");
    }
    after = { path: cursor.path, offset: cursor.offset };
  }
  const query = input.query;
  const result: unknown = yield createDurableOperation<Json>(
    { type: "workspace-search", name: "project-files", ...input },
    function* () {
      const page = yield* searchProjectFiles(query, after);
      if (!page.ok) {
        throw page.error;
      }
      return page.value;
    },
  );
  return parseJson(result);
}
