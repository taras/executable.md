import type { Operation } from "effection";
import { glob, readTextFile } from "@executablemd/runtime";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const returns = {
  type: "object",
  properties: {
    fileList: { type: "array", items: { type: "string" } },
    fileCount: { type: "number" },
    lineCount: { type: "number" },
  },
  required: ["fileList", "fileCount", "lineCount"],
  additionalProperties: false,
};

interface RepositoryInventoryValue {
  fileList: string[];
  fileCount: number;
  lineCount: number;
}

function lineCount(source: string): number {
  return source.length === 0 ? 0 : source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
}

export default function* RepositoryInventory(
  _props: Record<string, unknown>,
): Operation<RepositoryInventoryValue> {
  const entries = yield* glob({
    root: ".",
    patterns: ["durable-effects/**/*.ts", "packages/**/*.ts"],
    exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
  });
  const fileList = entries
    .filter((entry) => entry.isFile)
    .map((entry) => entry.path)
    .sort();
  let totalLines = 0;
  for (const path of fileList) {
    totalLines += lineCount(yield* readTextFile(path));
  }
  return { fileList, fileCount: fileList.length, lineCount: totalLines };
}
