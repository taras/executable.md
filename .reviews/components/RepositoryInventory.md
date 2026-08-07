---
returns:
  type: object
  properties:
    fileList:
      type: array
      items:
        type: string
    fileCount:
      type: number
    lineCount:
      type: number
  required: [fileList, fileCount, lineCount]
  additionalProperties: false
---

```ts eval
import { glob, readTextFile } from "@executablemd/runtime";

function lineCount(source) {
  if (source.length === 0) {
    return 0;
  }
  return source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
}

function* collectInventory() {
  const entries = yield* glob({
    root: ".",
    patterns: ["durable-effects/**/*.ts", "packages/**/*.ts"],
    exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
  });
  const fileList = entries.filter((entry) => entry.isFile).map((entry) => entry.path).sort();
  let lineCountTotal = 0;
  for (const path of fileList) {
    lineCountTotal += lineCount(yield* readTextFile(path));
  }
  return { fileList, fileCount: fileList.length, lineCount: lineCountTotal };
}

const inventory = yield* collectInventory();
```

<Return value={inventory} />
