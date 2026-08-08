import { glob, readTextFile } from "@executablemd/runtime";
import type { Operation } from "effection";

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
  if (source.length === 0) {
    return 0;
  }
  const lines = source.split(/\r?\n/u);
  if (source.endsWith("\n")) {
    return lines.length - 1;
  }
  return lines.length;
}

function filePaths(entries: { isFile: boolean; path: string }[]): string[] {
  return entries
    .filter((entry) => entry.isFile)
    .map((entry) => entry.path)
    .toSorted();
}

function* totalLineCount(paths: string[]): Operation<number> {
  let total = 0;
  for (const path of paths) {
    total += lineCount(yield* readTextFile(path));
  }
  return total;
}

export default function* RepositoryInventory(
  _props: Record<string, unknown>,
): Operation<RepositoryInventoryValue> {
  const entries = yield* glob({
    root: ".",
    patterns: ["durable-effects/**/*.ts", "packages/**/*.ts"],
    exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
  });
  const fileList = filePaths(entries);
  const totalLines = yield* totalLineCount(fileList);
  return { fileList, fileCount: fileList.length, lineCount: totalLines };
}
