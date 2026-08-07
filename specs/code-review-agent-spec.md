# Specification: `@executablemd/code-review-agent`

**Status:** Draft  
**Scope:** An Executable Markdown Agent that reviews pull requests for extraneous code, posts findings as GitHub comments, and runs locally via Ollama or in CI via DeepInfra.

---

## 1. Architecture

A PR review is an executable markdown document. The document gathers
the diff, parses it into a structured object, passes it through
composable check components, optionally sends it to an LLM for
semantic analysis, and posts the rendered output as a GitHub comment.

```
ReviewPR.md
  ├─ Capture: git diff → rawDiff
  ├─ Capture: git diff --name-status → rawFiles
  ├─ eval: parseDiff(rawDiff, rawFiles) → pr
  │
  └─ DeepInfraProvider (or OllamaProvider)
       └─ Instructions (system prompt)
            └─ GitHubComment (or stdout)
                 └─ ReviewBody
                      ├─ ScopeCheck
                      │    ├─ Threshold (×4)
                      │    ├─ DescriptionCheck
                      │    ├─ LinkedIssue
                      │    ├─ ConfigSourceMix
                      │    ├─ AbstractionNames
                      │    └─ NewDependencies
                      ├─ StructuralBloat
                      │    ├─ UnusedInDiff (×2)
                      │    ├─ Ratio
                      │    └─ Pattern (×2)
                      ├─ VerbosityCheck
                      │    ├─ Ratio
                      │    └─ CommentReview → Sample
                      └─ SemanticReview → Sample
```

Three layers of concern, three layers of middleware:

| Layer | Component | Responsibility |
|---|---|---|
| Transport | `DeepInfraProvider` / `OllamaProvider` | Send HTTP request, return response |
| Policy | `Instructions` | Set system prompt |
| Delivery | `GitHubComment` | Post rendered output as PR comment |

The review logic (`ReviewBody` and its children) knows nothing about
which model runs, what system prompt is set, or where the output goes.

---

## 2. executable.md Changes (Implemented)

All executable.md core changes and the full agent implementation are complete:

- **Eval block `return` as rendered output** (PR #35)
- **Eval binding interpolation in text segments** (PR #34)
- **Simplified `SampleContext`** to `{content, model?, params?, system?, componentName?}` (PR #35)
- **Removed `sample` modifier** — all LLM calls via `<Sample>` component (PR #35)
- **Renamed `Instruction.md` input** `text` → `system` for clarity
- **Fixed broken providers** — `OllamaProvider`,
  `AnthropicProvider` updated to use direct `fetch()` calls
- **Component resolution** — review components resolved via
  `--component-dir .reviews/components --component-dir packages/core/components`
- **AST-based user import extraction** (DEC-93) — eval blocks can use
  standard `import` declarations; extracted via acorn's
  `allowImportExportEverywhere` and hoisted to module level
- **Projected children expression prop scoping** (DEC-91, DEC-92) —
  children substituted via `<Content />` carry the caller's eval env.
  Expression props on projected children resolve against merged env
  (all ancestor bindings propagated through multi-level nesting)

---

## 3. Package: `@executablemd/code-review-agent`

One export: `parseDiff`. Takes raw `git diff` and `git diff --name-status`
output, returns a typed `PR` object.

### 3.1 `PR` type

```typescript
interface PR {
  files: DiffFile[];
  added: DiffLine[];
  removed: DiffLine[];
  created: DiffFile[];
  modified: DiffFile[];
  deleted: DiffFile[];
  directories: Set<string>;
  addedSource: string;
  diffPreview: string;       // addedSource truncated to 40K chars
  stats: {
    totalFiles: number;
    additions: number;
    deletions: number;
    totalChanges: number;
  };
  meta: {
    title: string;
    body: string;
    number: string;
  };
}

interface DiffFile {
  path: string;
  status: "A" | "M" | "D" | "R" | "C";
  hunks: DiffHunk[];
  language: string;
  isTest: boolean;
  isConfig: boolean;
  isTypeDeclaration: boolean;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  file: string;
  lineNumber: number;
  isTest: boolean;
}
```

### 3.2 `parseDiff` signature

```typescript
function parseDiff(
  rawDiff: string,
  rawFiles: string,
  meta: { title: string; body: string; number: string },
): PR;
```

### 3.3 What `parseDiff` handles

- Standard unified diff format
- Rename detection (R status)
- Binary file detection (skipped)
- Language inference from file extension
- Test file detection: `*.test.ts`, `*.spec.ts`, `__tests__/`, `test/`
- Config file detection: `*.config.*`, `.*rc`, `tsconfig*`, `package.json`
- Type declaration detection: `*.d.ts`
- `diffPreview`: `addedSource` truncated to 40,000 characters so the
  correctness prompt stays within the provider context limit on large PRs
- `directories`: unique top-level dirs at depth 2

### 3.4 Package structure

```
packages/code-review-agent/
  src/
    parse-diff.ts
    types.ts
  mod.ts
```

Zero dependencies beyond Deno stdlib.

---

## 4. Standard Library Components

Conditional rendering is not among them. `<If>` and `<Else>` are expansion-engine
directives (executable-mdx-spec §6.5), so the components below branch with them
directly instead of wrapping a conditional of their own.

### 4.1 `ReviewSection.md`

````markdown
---
props:
  type: object
  properties:
    heading:
      type: string
    clean:
      type: string
      default: "✅ No issues found."
  required: [heading]
  additionalProperties: false
---

```ts eval
const content = yield* renderChildren();
return content.trim().length > 0
  ? `### ${props.heading}\n\n${content}`
  : `### ${props.heading}\n\n${props.clean}`;
```
````

### 4.2 `Finding.md`

````markdown
---
props:
  type: object
  properties:
    when:
      type: boolean
    severity:
      type: string
      default: warning
    message:
      type: string
  required: [when, message]
  additionalProperties: false
---

```ts eval
const icon = props.severity === "error" ? "🔴" : "🟡";
```

<If condition={props.when}>

{icon} {props.message}

</If>
````

### 4.3 `Instructions.md`

````markdown
---
props:
  type: object
  properties:
    system:
      type: string
  required: [system]
  additionalProperties: false
---

```ts persist eval
const scope = yield* useScope();
scope.around(Sample, function* ([context], next) {
  return yield* next({
    ...context,
    system: props.system,
  });
});
```

<Content />
````

### 4.4 `GitHubComment.md`

````markdown
---
props:
  type: object
  properties:
    marker:
      type: string
      default: "<!-- xmd-review -->"
  additionalProperties: false
---

```ts eval
const content = yield* renderChildren();
const body = props.marker + "\n" + content;

const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const [owner, name] = repo.split("/");
const api = `https://api.github.com/repos/${owner}/${name}`;

function githubHeaders() {
  return {
    "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
  };
}

const { json: comments } = yield* fetch(
  `${api}/issues/${prNumber}/comments`, { headers: githubHeaders() }
).expect();

const existing = comments.find(c =>
  c.user.type === "Bot" && c.body.includes(props.marker)
);

if (existing) {
  yield* fetch(`${api}/issues/comments/${existing.id}`, {
    method: "PATCH",
    headers: { ...githubHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  }).expect();
} else {
  yield* fetch(`${api}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: { ...githubHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  }).expect();
}

return content;
```
````

### 4.5 `DeepInfraProvider.md`

````markdown
---
props:
  type: object
  properties:
    model:
      type: string
  required: [model]
  additionalProperties: false
---

```ts persist eval
const scope = yield* useScope();
scope.around(Sample, function* ([context], next) {
  if (context.model !== undefined && context.model !== props.model) {
    return yield* next(context);
  }

  const messages = [];
  if (context.system) {
    messages.push({ role: "system", content: context.system });
  }
  messages.push({ role: "user", content: context.content });

  const result = yield* fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.DEEPINFRA_TOKEN}`,
    },
    body: JSON.stringify({ model: props.model, messages, temperature: 0, max_tokens: 4096 }),
  })
    .expect()
    .json();

  return result.choices[0].message.content;
});
```

<Content />
````

### 4.6 `OllamaProvider.md`

````markdown
---
props:
  type: object
  properties:
    model:
      type: string
    baseUrl:
      type: string
      default: "http://localhost:11434"
  required: [model]
  additionalProperties: false
---

```ts persist eval
const scope = yield* useScope();
scope.around(Sample, function* ([context], next) {
  if (context.model !== undefined && context.model !== props.model) {
    return yield* next(context);
  }

  const messages = [];
  if (context.system) {
    messages.push({ role: "system", content: context.system });
  }
  messages.push({ role: "user", content: context.content });

  const result = yield* fetch(`${props.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: props.model, messages, temperature: 0 }),
  })
    .expect()
    .json();

  return result.choices[0].message.content;
});
```

<Content />
````

---

## 5. Rule Components

### 5.1 `Threshold.md`

````markdown
---
props:
  type: object
  properties:
    pr:
      type: object
    metric:
      type: string
    op:
      type: string
    value:
      type: number
    severity:
      type: string
      default: warning
    message:
      type: string
  required: [pr, metric, op, value, message]
  additionalProperties: false
---

```ts eval
const metrics = {
  totalChanges: props.pr.stats.totalChanges,
  totalFiles: props.pr.stats.totalFiles,
  additions: props.pr.stats.additions,
  deletions: props.pr.stats.deletions,
  directories: props.pr.directories.size,
};

const actual = metrics[props.metric];
const ops = {
  ">":  (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<":  (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a == b,
};

if (ops[props.op](actual, props.value)) {
  const icon = props.severity === "error" ? "🔴" : "🟡";
  return icon + " " + props.message
    .replace("{actual}", String(actual))
    .replace("{value}", String(value));
}
```
````

### 5.2 `Pattern.md`

````markdown
---
props:
  type: object
  properties:
    pr:
      type: object
    pattern:
      type: string
    min:
      type: number
      default: 1
    excludeTests:
      type: boolean
      default: true
    severity:
      type: string
      default: warning
    message:
      type: string
  required: [pr, pattern, message]
  additionalProperties: false
---

```ts eval
const re = new RegExp(props.pattern, "g");
const lines = props.excludeTests
  ? props.pr.added.filter(l => !l.isTest)
  : props.pr.added;
const matches = lines.filter(l => re.test(l.content));
re.lastIndex = 0;

if (matches.length >= props.min) {
  const icon = props.severity === "error" ? "🔴" : "🟡";
  return icon + " " + props.message
    .replace("{count}", String(matches.length));
}
```
````

### 5.3 `Ratio.md`

````markdown
---
props:
  type: object
  properties:
    pr:
      type: object
    numerator:
      type: string
    denominator:
      type: string
    threshold:
      type: number
    minDenominator:
      type: number
      default: 10
    excludeTests:
      type: boolean
      default: true
    severity:
      type: string
      default: warning
    message:
      type: string
  required: [pr, numerator, denominator, threshold, message]
  additionalProperties: false
---

```ts eval
const numRe = new RegExp(props.numerator, "g");
const denRe = new RegExp(props.denominator, "g");
const lines = props.excludeTests
  ? props.pr.added.filter(l => !l.isTest)
  : props.pr.added;
const source = lines.map(l => l.content).join("\n");

const numCount = (source.match(numRe) ?? []).length;
const denCount = (source.match(denRe) ?? []).length;

if (denCount >= props.minDenominator && numCount / denCount > props.threshold) {
  const ratio = (numCount / denCount * 100).toFixed(1);
  const icon = props.severity === "error" ? "🔴" : "🟡";
  return icon + " " + props.message
    .replace("{ratio}", ratio)
    .replace("{numeratorCount}", String(numCount))
    .replace("{denominatorCount}", String(denCount));
}
```
````

### 5.4 `UnusedInDiff.md`

````markdown
---
props:
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
const lines = props.pr.added.filter(l =>
  l.file.endsWith(".ts") || l.file.endsWith(".tsx")
);
const source = lines.map(l => l.content).join("\n");

// Anchoring the keyword to statement position (line start, after an optional
// export/default/declare prefix) excludes `import { type X }` specifiers,
// whose `type` keyword sits inside braces rather than at the start of a
// declaration.
const declPattern = new RegExp(
  `^\\s*(?:export\\s+)?(?:default\\s+|declare\\s+)?${props.construct}\\s+(\\w+)`
);

const decls = [];
for (const line of lines) {
  const match = declPattern.exec(line.content);
  if (match) {
    decls.push({ name: match[1], file: line.file, lineNumber: line.lineNumber });
  }
}

const unused = decls
  .map(d => ({
    ...d,
    refs: (source.match(new RegExp(`\\b${d.name}\\b`, "g")) ?? []).length,
  }))
  .filter(d => d.refs <= 1);

const hasUnused = unused.length > 0;
const icon = props.severity === "error" ? "🔴" : "🟡";
const summary = icon + " " + props.message
  .replace("{names}", unused.map(u => u.name).join(", "))
  .replace("{count}", String(unused.length));
```

<If condition={hasUnused}>

<details>
<summary>{summary}</summary>

| Symbol | Declared at | Refs in diff | Why flagged |
| --- | --- | --- | --- |
<Each in={unused} let="u">| `{u.name}` | `{u.file}:{u.lineNumber}` | {u.refs} | referenced ≤1× within the added diff (pre-existing usages not counted) |
</Each>

</details>

</If>
````

Findings render as a `<details>` disclosure: the summary carries the terse
message, and the body is a per-symbol table giving the declaration
`file:lineNumber`, the added-diff reference count, and why the symbol was
flagged. The declaration matcher is anchored to statement position, so
`import { type X }` specifiers are not mistaken for declarations. Reference
counts cover added diff lines only — a symbol used elsewhere in the file
still reports a low count, which the "why flagged" column states.

### 5.5 `DescriptionCheck.md`

```markdown
---
props:
  type: object
  properties:
    pr:
      type: object
    minLength:
      type: number
      default: 50
    severity:
      type: string
      default: error
    message:
      type: string
      default: "PR description must explain what and why."
  required: [pr]
  additionalProperties: false
---

<Finding when={props.pr.meta.body.length < props.minLength}
  severity={props.severity} message={props.message} />
```

### 5.6 `LinkedIssue.md`

````markdown
---
props:
  type: object
  properties:
    pr:
      type: object
    whenLinesExceed:
      type: number
      default: 0
    severity:
      type: string
      default: warning
    message:
      type: string
      default: "Large PR with no linked issue."
  required: [pr]
  additionalProperties: false
---

```ts eval
const hasIssue = /(?:#\d+|https:\/\/github\.com\/.*\/issues\/\d+)/.test(props.pr.meta.body);
```

<Finding when={!hasIssue && props.pr.stats.totalChanges > props.whenLinesExceed}
  severity={props.severity} message={props.message} />
````

### 5.7 `ConfigSourceMix.md`

````markdown
---
props:
  type: object
  properties:
    pr:
      type: object
    minFiles:
      type: number
      default: 5
    severity:
      type: string
      default: warning
    message:
      type: string
      default: "PR mixes config and source changes."
  required: [pr]
  additionalProperties: false
---

```ts eval
const hasConfig = props.pr.files.some(f => f.isConfig);
const hasSource = props.pr.files.some(f =>
  !f.isConfig && !f.isTest && !f.isTypeDeclaration
);
const triggered = hasConfig && hasSource && props.pr.stats.totalFiles > props.minFiles;
```

<Finding when={triggered} severity={props.severity} message={props.message} />
````

### 5.8 `AbstractionNames.md`

````markdown
---
props:
  type: object
  properties:
    pr:
      type: object
    pattern:
      type: string
      default: "factory|abstract|base|provider|strategy|adapter|helper|util"
    severity:
      type: string
      default: warning
    message:
      type: string
      default: "New abstraction files: {names}. Verify 3+ consumers."
  required: [pr]
  additionalProperties: false
---

```ts eval
const re = new RegExp(props.pattern, "i");
const suspicious = props.pr.created
  .filter(f => f.path.endsWith(".ts") && !f.isTest && !f.isTypeDeclaration)
  .filter(f => re.test(f.path));
const triggered = suspicious.length > 0;
const resolvedMessage = props.message.replace(
  "{names}", suspicious.map(f => f.path).join(", ")
);
```

<Finding when={triggered} severity={props.severity} message={resolvedMessage} />
````

### 5.9 `NewDependencies.md`

````markdown
---
props:
  type: object
  properties:
    pr:
      type: object
    severity:
      type: string
      default: warning
    message:
      type: string
      default: "package.json changed without dependency justification."
  required: [pr]
  additionalProperties: false
---

```ts eval
const touchesPkg = props.pr.files.some(f =>
  f.path === "package.json" || f.path.endsWith("/package.json")
);
const mentionsDeps = props.pr.meta.body.toLowerCase().includes("dependenc");
const triggered = touchesPkg && !mentionsDeps;
```

<Finding when={triggered} severity={props.severity} message={props.message} />
````

### 5.10 `CommentReview.md`

````markdown
---
props:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
---

```ts eval
const pairs = [];
const lines = pr.added.filter(l => !l.isTest);

for (let i = 0; i < lines.length - 1; i++) {
  const current = lines[i].content.trim();
  const next = lines[i + 1].content.trim();
  if (current.startsWith("//") && !next.startsWith("//") && next.length > 0) {
    pairs.push({ comment: current, code: next });
  }
}

const hasPairs = pairs.length >= 3;
const pairsText = hasPairs
  ? pairs.slice(0, 20).map(p =>
      `COMMENT: ${p.comment}\nCODE: ${p.code}`
    ).join("\n---\n")
  : "";
```

<If condition={hasPairs}>

<Sample>

Review these comment/code pairs. List ONLY obvious/redundant ones
where the comment restates what the code does.

Format: "- `<comment>` — restates `<code pattern>`"

If none are obvious: "No obvious comments found."

{pairsText}

</Sample>

</If>
````

---

## 6. Policy Documents (zero JavaScript)

### 6.1 `ScopeCheck.md`

```markdown
---
props:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
---

<ReviewSection heading="Scope" clean="✅ PR scope looks good.">

<Threshold pr={props.pr} metric="totalChanges" op=">" value={800}
  severity="error"
  message="PR has {actual} lines changed. Split into focused PRs." />

<Threshold pr={props.pr} metric="totalChanges" op=">" value={400}
  severity="warning"
  message="{actual} lines changed. PRs under {value} receive more thorough review." />

<Threshold pr={props.pr} metric="totalFiles" op=">" value={20}
  severity="warning"
  message="{actual} files changed. Are all changes related?" />

<Threshold pr={props.pr} metric="directories" op=">" value={5}
  severity="warning"
  message="Changes span {actual} directories." />

<DescriptionCheck pr={props.pr} minLength={50}
  severity="error"
  message="PR description must explain what and why." />

<LinkedIssue pr={props.pr} whenLinesExceed={200}
  severity="warning"
  message="Large PR with no linked issue." />

<ConfigSourceMix pr={props.pr} minFiles={5}
  severity="warning"
  message="PR mixes config and source changes." />

<AbstractionNames pr={props.pr}
  severity="warning"
  message="New abstraction files: {names}. Verify 3+ consumers." />

<NewDependencies pr={props.pr}
  severity="warning"
  message="package.json changed without dependency justification." />

</ReviewSection>
```

### 6.2 `StructuralBloat.md`

```markdown
---
props:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
---

<ReviewSection heading="Structural" clean="✅ No structural bloat detected.">

<UnusedInDiff pr={props.pr} construct="type"
  severity="warning"
  message="Type declarations with no consumers: {names}." />

<UnusedInDiff pr={props.pr} construct="interface"
  severity="warning"
  message="Interface declarations with no consumers: {names}." />

<Ratio pr={props.pr}
  numerator=":\s*any\b"
  denominator=":\s*\w"
  threshold={0.05}
  minDenominator={10}
  excludeTests={true}
  severity="warning"
  message="{numeratorCount} uses of `any` ({ratio}% of annotations)." />

<Pattern pr={props.pr}
  pattern="(?:function\s+\w+|=>\s*)\([^)]*\)\s*\{\s*\}"
  excludeTests={true}
  severity="warning"
  message="{count} empty function bodies." />

<Pattern pr={props.pr}
  pattern="console\.(log|debug|info|trace)\("
  excludeTests={true}
  severity="warning"
  message="{count} console statements." />

</ReviewSection>
```

### 6.3 `VerbosityCheck.md`

```markdown
---
props:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
---

<ReviewSection heading="Verbosity" clean="✅ Comment quality looks reasonable.">

<Ratio pr={props.pr}
  numerator="^\s*(?://|/\*|\*)"
  denominator="^\s*\S"
  threshold={0.4}
  minDenominator={20}
  excludeTests={true}
  severity="warning"
  message="Comment ratio is {ratio}%." />

<CommentReview pr={props.pr} />

</ReviewSection>
```

### 6.4 `SemanticReview.md`

```markdown
---
props:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
---

<If condition={props.pr.stats.totalChanges > 20}>

<Sample>

You are reviewing a TypeScript PR for EXTRANEOUS code only.

PR: {props.pr.meta.title}
Description: {props.pr.meta.body}

Report ONLY:
1. Scope creep — changes unrelated to stated purpose
2. Speculative abstractions — new constructs with one consumer
3. Dead constructs — declarations never referenced in diff
4. Wrapper indirection — functions that only forward calls

Do NOT flag test helpers, exported types, or style preferences.

For each finding: FILE, PATTERN, CONCERN, QUESTION for the author.

If clean: "No extraneous code patterns detected."

DIFF:
{props.pr.diffPreview}

</Sample>

<Else>

✅ Small PR — semantic review skipped.

</Else>
</If>
```

Zero eval blocks.

### 6.5 `ReviewBody.md`

```markdown
---
props:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
---

## PR #{props.pr.meta.number}: {props.pr.meta.title}

**{props.pr.stats.totalFiles}** files, **+{props.pr.stats.additions}** / **-{props.pr.stats.deletions}**

<ScopeCheck pr={props.pr} />

<StructuralBloat pr={props.pr} />

<VerbosityCheck pr={props.pr} />

<SemanticReview pr={props.pr} />
```

Zero eval blocks.

---

## 7. Entry Points

### 7.1 `.reviews/ReviewPR.md` (CI with DeepInfra)

````markdown
---
title: PR Review
---

```ts eval
const BASE_SHA = process.env.BASE_SHA ?? "HEAD~1";
const HEAD_SHA = process.env.HEAD_SHA ?? "HEAD";
```

<Capture as="rawDiff">

```bash exec
git diff {BASE_SHA}...{HEAD_SHA}
```

</Capture>

<Capture as="rawFiles">

```bash exec
git diff --name-status {BASE_SHA}...{HEAD_SHA}
```

</Capture>

```ts eval
import { parseDiff } from "@executablemd/code-review-agent";

const pr = parseDiff(rawDiff, rawFiles, {
  title: process.env.PR_TITLE ?? "",
  body: process.env.PR_BODY ?? "",
  number: process.env.PR_NUMBER ?? "",
});
```

<DeepInfraProvider model="Qwen/Qwen3-30B-A3B">
  <Instructions system="You are a precise TypeScript code review assistant for the effectionx monorepo. Be concise. Report only findings, not praise.">
    <GitHubComment>
      <ReviewBody pr={pr} />
    </GitHubComment>
  </Instructions>
</DeepInfraProvider>
````

### 7.2 `.reviews/ReviewPR.local.md` (local with Ollama)

````markdown
---
title: PR Review (local)
---

```ts eval
const BASE_SHA = process.env.BASE_SHA ?? "HEAD~1";
const HEAD_SHA = process.env.HEAD_SHA ?? "HEAD";
```

<Capture as="rawDiff">

```bash exec
git diff {BASE_SHA}...{HEAD_SHA}
```

</Capture>

<Capture as="rawFiles">

```bash exec
git diff --name-status {BASE_SHA}...{HEAD_SHA}
```

</Capture>

```ts eval
import { parseDiff } from "@executablemd/code-review-agent";

const pr = parseDiff(rawDiff, rawFiles, {
  title: process.env.PR_TITLE ?? "",
  body: process.env.PR_BODY ?? "",
  number: process.env.PR_NUMBER ?? "",
});
```

<OllamaProvider model="qwen3:30b-a3b">
  <Instructions system="You are a precise TypeScript code review assistant. Be concise. Report only findings, not praise.">
    <ReviewBody pr={pr} />
  </Instructions>
</OllamaProvider>
````

Output goes to stdout. No `<GitHubComment>` wrapper.

---

## 8. CI Workflow

### `.github/workflows/review.yml`

```yaml
name: PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - uses: denoland/setup-deno@e95548e56dfa95d4e1a28d6f422fafe75c4c26fb # v2.0.3
        with:
          deno-version: v2.9.5

      - name: Install dependencies
        run: deno task deps

      - name: Build the checked-out xmd binary
        run: deno task build

      - name: Run review
        env:
          PR_NUMBER: ${{ github.event.pull_request.number }}
          PR_TITLE: ${{ github.event.pull_request.title }}
          PR_BODY: ${{ github.event.pull_request.body }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          DEEPINFRA_TOKEN: ${{ secrets.DEEPINFRA_TOKEN }}
        run: |
          ./dist/xmd run .reviews/ReviewPR.md \
            --component-dir .reviews/components \
            --component-dir .reviews/policies \
            --component-dir packages/core/components \
            -j .reviews/journal.jsonl \
            --verbose

      - name: Verify review result
        if: always()
        run: |
          test -f .reviews/journal.jsonl
          ROOT_CLOSE=$(jq -c 'select(.type == "close" and .coroutineId == "root")' .reviews/journal.jsonl | tail -n 1)
          test -n "$ROOT_CLOSE"
          test "$(printf '%s' "$ROOT_CLOSE" | jq -r '.result.status // "missing"')" = ok
          test "$(printf '%s' "$ROOT_CLOSE" | jq -r '.result.value.status // "ok"')" = ok
          ROOT_OUTPUT=$(printf '%s' "$ROOT_CLOSE" | jq -r '.result.value.output? // .result.value.value? // .result.value? // "" | tostring')
          test "${ROOT_OUTPUT/<!-- ERROR:/}" = "$ROOT_OUTPUT"
```

### Journal artifact

The workflow uploads `.reviews/journal.jsonl` as an artifact keyed by the
pull request head SHA after each review, including failed runs. The checked-out
binary and review documents therefore produce one inspectable journal for the
revision under review.

The review workflow fails closed after XMD finishes. It requires a root
`close` record, requires both the close result and its nested output status to
be successful, and rejects root output containing an XMD `<!-- ERROR:` marker.
The repository-analysis workflow applies the same postcondition to its root
close record. Both workflows upload their journals with `if: always()`.

---

## 9. Deterministic Analysis (separate CI jobs, unchanged)

executable.md replaces the advisory/AI review layer and process enforcement.
Deterministic static analysis continues as separate CI jobs:

| Job | Tool | What it catches |
|---|---|---|
| `lint` | Oxlint `--type-aware` | Unused vars, inferrable types, empty functions, type bloat, console/debugger |
| `dead-code` | Knip | Unused exports, files, types, dependencies (cross-file) |

These block merges. The executable.md review is advisory.

---

## 10. File Tree

```
.reviews/
  ReviewPR.md                    CI entry point (DeepInfra + GitHubComment)
  ReviewPR.local.md              Local entry point (Ollama + stdout)

  components/
    # Standard library
    Finding.md                   Severity icon + message
    ReviewSection.md             Heading + children or clean message
    Instructions.md              System prompt middleware
    GitHubComment.md             Post/update PR comment
    DeepInfraProvider.md         DeepInfra Sample Api provider
    OllamaProvider.md            Ollama Sample Api provider

    # Rule primitives (one eval block each, written once)
    Threshold.md                 Numeric comparison
    Pattern.md                   Regex match on added lines
    Ratio.md                     Ratio of two regex counts
    UnusedInDiff.md              Declarations with no references
    DescriptionCheck.md          PR body length
    LinkedIssue.md               Issue linkage
    ConfigSourceMix.md           Config + source mixing
    AbstractionNames.md          Suspicious file names
    NewDependencies.md           Dependency justification
    CommentReview.md             Pair extraction + LLM review

    # Policy documents (zero JavaScript)
    ScopeCheck.md                Composes Threshold, Finding checks
    StructuralBloat.md           Composes Pattern, Ratio, UnusedInDiff
    VerbosityCheck.md            Composes Ratio, CommentReview
    SemanticReview.md            Prompt template + If + Sample
    ReviewBody.md                Composes all four checks
```

---

## 11. Eval Block Census

| Document | Eval blocks | Why |
|---|---|---|
| `Finding.md` | 1 | Icon selection |
| `ReviewSection.md` | 1 | renderChildren + heading |
| `Instructions.md` | 1 persist | Middleware install |
| `GitHubComment.md` | 1 | renderChildren + GitHub API |
| `DeepInfraProvider.md` | 1 persist | Provider middleware |
| `OllamaProvider.md` | 1 persist | Provider middleware |
| `Threshold.md` | 1 | Comparison logic |
| `Pattern.md` | 1 | Regex matching |
| `Ratio.md` | 1 | Ratio computation |
| `UnusedInDiff.md` | 1 | Declaration scanning |
| `DescriptionCheck.md` | 0 | Uses `<Finding>` |
| `LinkedIssue.md` | 1 | Regex test for `<Finding>` |
| `ConfigSourceMix.md` | 1 | File classification for `<Finding>` |
| `AbstractionNames.md` | 1 | Name pattern for `<Finding>` |
| `NewDependencies.md` | 1 | Dependency check for `<Finding>` |
| `CommentReview.md` | 1 | Pair extraction |
| **`ScopeCheck.md`** | **0** | |
| **`StructuralBloat.md`** | **0** | |
| **`VerbosityCheck.md`** | **0** | |
| **`SemanticReview.md`** | **0** | |
| **`ReviewBody.md`** | **0** | |
| `ReviewPR.md` | 2 | Env vars + parseDiff |
| `ReviewPR.local.md` | 2 | Env vars + parseDiff |

17 eval blocks across 17 reusable components. 5 policy documents
and `ReviewBody` have zero. The documents a team edits day-to-day
contain no JavaScript.

---

## 12. Implementation Order (All Complete)

All phases have been implemented across PRs #34, #35, and the
code-review-agent PR:

- Phase 1: executable.md core (text interpolation, eval return) — PR #34, #35
- Phase 2: Infrastructure components — code-review-agent PR
- Phase 3: `@executablemd/code-review-agent` package — code-review-agent PR
- Phase 4: Rule components — code-review-agent PR
- Phase 5: Policy documents + entry points + CI — code-review-agent PR
- Phase 6: Sample modifier removal — PR #35

---

## 13. Extension: Oxlint Sensor (v2)

**Full spec:** `oxlint-sensor-spec-v2.md`

Oxlint runs as a structured signal source inside the review pipeline.
Its JSON output becomes a density metric the LLM uses alongside the
diff to detect quality deficits that correlate with unreviewed AI
output. All rules at `"warn"` — Oxlint collects signals, not verdicts.

### 13.1 Sensor configuration

`.reviews/.oxlintrc.json` — committed config with `pedantic: "warn"`
and `style: "warn"` enabled (14 bloat-relevant rules). All oxlint
invocations in capture blocks reference this config via
`--config .reviews/.oxlintrc.json`.

### 13.2 Environment detection (`Doctor.md`)

The Doctor component probes the environment before oxlint runs:
oxlint binary, tsgolint binary, `node_modules/`, tsconfig, scheme
specifier scan (`jsr:`, `npm:`), and a type-aware test run. Outputs
a recommendation: `type-aware`, `type-aware-filtered`, or
`syntax-only`. Includes prose narration for local visibility.
Its JSON output is wrapped in a `` ```json `` code fence and
extracted via `<Capture select="code[lang=json]">` (see executable.md spec
§6.5), isolating the structured data from surrounding narration.

The probe does not emit the Oxlint result itself. The executable command
reduces it before stdout to aggregate counts, file counts, import-noise
counts, crash state, and available rule identifiers. The diagnostic capture
uses the same boundary discipline: it emits only `message`, `ruleId`,
`severity`, `file`, `line`, and `column`. PR review filters those records to
the changed TypeScript files; repository analysis retains records for all
files. Source excerpts, causes, rendered source, URLs, and other Oxlint
payload fields never enter the durable stream.

### 13.3 PR-scoped analysis

PR entry points (`ReviewPR.md`, `ReviewPR.local.md`) scope oxlint
to changed `.ts`/`.tsx` files only via `git diff --name-only` +
`xargs`, then normalize the result with `jq` before the capture emits it.
The normalized records contain only `message`, `ruleId`, `severity`, `file`,
`line`, and `column`; the final map selects the changed paths. Density against
`pr.stats.additions` is only meaningful when diagnostics come from the same
files the additions are in.
Repo analysis entry points run on everything.

GitHub API credentials are read inside a non-serializable header factory at
each request. The credential-bearing header object is never assigned to an
eval binding, so default-on secret detection does not reject or persist it.

### 13.4 Density calibration

| Density | Interpretation |
|---|---|
| < 0.020 | Clean — experienced contributor, reviewed code |
| 0.020–0.080 | Normal — minor issues, typical development |
| > 0.100 | Elevated — likely unreviewed generated code |

3 decimal places to preserve signal in the narrow normal band.

### 13.5 Policy updates

- `ExtraneousCodePolicy.md` — density calibration thresholds,
  interpretation rules, Rule of Three, and object literal assertion
  detection added to LLM prompt
- `BloatPolicy.md`, `SlopPolicy.md` — `diagnostics` changed from
  optional to required; defensive guards removed
- `RepoCleanupPolicy.md` — Rule of Three and YAGNI principles
  added to LLM prompt

### 13.6 Import specifier enforcement

`lint-plugins/no-scheme-specifiers.ts` — Deno lint plugin that
flags `jsr:` and `npm:` scheme specifiers in source files and
auto-fixes them to bare specifiers. Required for tsgo/Oxlint
compatibility since tsgo uses Node module resolution.

### 13.7 Process enforcement

`.github/pull_request_template.md` — scope confirmation, Rule of
Three checklist for new abstractions, dependency justification.

### 13.8 Cleanup issues (`CleanupIssues.md`)

The repo analysis pipeline creates idempotent GitHub issues for
the top 5 file clusters ranked by `buildCleanupAnalysis()`.

**Identity:** Each issue body contains a marker comment
`<!-- xmd-cleanup:{file} -->`. The component searches open issues
with the `cleanup` label for matching markers before creating.

**Lifecycle:**

| Existing issue? | File in top 5? | Action |
|---|---|---|
| No | Yes | Create new issue |
| Yes | Yes | Update title + body with latest stats |
| Yes | No | Close with resolution comment |

Issues are driven entirely by deterministic cluster data — file
path, score, violation count, co-occurring rule count, category
breakdown. No LLM output parsing.

Local runs skip issue creation (no `GITHUB_TOKEN` → return empty).

### 13.9 Additional files

```
.reviews/
  .oxlintrc.json                   Sensor config (committed)
  components/
    CleanupIssues.md               Idempotent GitHub issue lifecycle

.github/
  pull_request_template.md         Process enforcement

lint-plugins/
  no-scheme-specifiers.ts          Deno lint plugin
```
