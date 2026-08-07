---
props:
  type: object
  properties:
    files:
      type: array
      items:
        type: string
    typeAware:
      type: boolean
      default: false
    tsconfigPath:
      type: string
      default: ".reviews/tsconfig.oxlint.json"
  required: [files]
  additionalProperties: false
returns:
  type: array
  items:
    type: object
    properties:
      message: { type: string }
      ruleId: { type: string }
      severity: { type: string }
      file: { type: string }
      line: { type: number }
      column: { type: number }
    required: [message, ruleId, severity, file, line, column]
    additionalProperties: false
---

```ts eval
import { exec } from "@executablemd/runtime";

function entries(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object" && Array.isArray(value.diagnostics)) {
    return value.diagnostics;
  }
  return [];
}

function* runOxlint() {
  const command = [
    ".reviews/.oxlint/oxlint",
    "--config",
    ".reviews/.oxlintrc.json",
  ];
  const environment = {};
  if (typeAware) {
    command.push("--type-aware", "--tsconfig", tsconfigPath);
    environment.OXLINT_TSGOLINT_PATH = ".reviews/.oxlint/tsgolint";
  }
  command.push("--format", "json", ...files);

  const result = yield* exec({ command, env: environment });
  const raw = result.stdout;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const changed = new Set(files);
  return entries(parsed).flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const message = typeof entry.message === "string" ? entry.message : "";
    const ruleId = typeof entry.ruleId === "string"
      ? entry.ruleId
      : typeof entry.code === "string" ? entry.code : "unknown";
    const severity = entry.severity === "error" ? "error" : "warning";
    const file = typeof entry.file === "string"
      ? entry.file
      : typeof entry.filename === "string" ? entry.filename : "";
    const labels = Array.isArray(entry.labels) ? entry.labels : [];
    const first = labels[0];
    const span = first && typeof first === "object" && first.span && typeof first.span === "object"
      ? first.span
      : {};
    const line = typeof entry.line === "number"
      ? entry.line
      : typeof span.line === "number" ? span.line : 0;
    const column = typeof entry.column === "number"
      ? entry.column
      : typeof span.column === "number" ? span.column : 0;
    if (!changed.has(file)) {
      return [];
    }
    return [{ message, ruleId, severity, file, line, column }];
  });
}

const diagnostics = yield* runOxlint();
```

<Return value={diagnostics} />
