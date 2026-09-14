---
props:
  type: object
  properties:
    path:
      type: string
      default: ".reviews/tsconfig.oxlint.json"
  additionalProperties: false
description: >-
  Write the TypeScript configuration the Oxlint sensor's type-aware pass reads.
  `<OxlintConfig />` generates it in the checkout, so a type-aware run has a project
  to resolve against.
---

```ts eval
import { ensureDir, writeTextFile } from "@executablemd/runtime";

yield* ensureDir(".reviews");
yield* writeTextFile(props.path, JSON.stringify({
  compilerOptions: {
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "bundler",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    lib: ["ESNext", "DOM"],
    types: [],
  },
  include: [
    "packages/*/src/**/*.ts",
    "packages/*/*.ts",
    "durable-effects/**/*.ts",
  ],
  exclude: ["node_modules", "dist", ".vendor", "**/*.test.ts"],
}, null, 2));
```
