---
inputs:
  type: object
  properties:
    pr:
      type: object
    construct:
      type: string
    severity:
      type: string
      default: warning
    message:
      type: string
  required: [pr, construct, message]
  additionalProperties: false
---

```ts eval
const lines = pr.added.filter(l =>
  l.file.endsWith(".ts") || l.file.endsWith(".tsx")
);
const source = lines.map(l => l.content).join("\n");

// Anchoring the keyword to statement position (line start, after an optional
// export/declare) excludes `import { type X }` specifiers, whose `type`
// keyword sits inside braces rather than at the start of a declaration.
const declPattern = new RegExp(
  `^\\s*(?:export\\s+)?(?:declare\\s+)?${construct}\\s+(\\w+)`
);

const decls = [];
for (const line of lines) {
  const match = declPattern.exec(line.content);
  if (match) {
    decls.push({ name: match[1], file: line.file, lineNumber: line.lineNumber });
  }
}

const why =
  "referenced ≤1× within the added diff (pre-existing usages not counted)";
const unused = decls
  .map(d => ({
    ...d,
    refs: (source.match(new RegExp(`\\b${d.name}\\b`, "g")) ?? []).length,
  }))
  .filter(d => d.refs <= 1);

const rows = unused.map(u => [
  `\`${u.name}\``,
  `\`${u.file}:${u.lineNumber}\``,
  String(u.refs),
  why,
]);
const hasUnused = unused.length > 0;
const icon = severity === "error" ? "🔴" : "🟡";
const summary = icon + " " + message
  .replace("{names}", unused.map(u => u.name).join(", "))
  .replace("{count}", String(unused.length));
```

<Show when={hasUnused}>

<details>
<summary>{summary}</summary>

<Table
  headers={["Symbol", "Declared at", "Refs in diff", "Why flagged"]}
  rows={rows} />

</details>

</Show>
