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

## 2. EMA Changes (Implemented)

All EMA core changes and the full agent implementation are complete:

- **Eval block `return` as rendered output** (PR #35)
- **Eval binding interpolation in text segments** (PR #34)
- **Simplified `SampleContext`** to `{content, model?, params?, system?, componentName?}` (PR #35)
- **Removed `sample` modifier** — all LLM calls via `<Sample>` component (PR #35)
- **Renamed `Instruction.md` input** `text` → `system` for clarity
- **Fixed broken providers** — `OllamaProvider`, `LlamafileProvider`,
  `AnthropicProvider` updated to use direct `fetch()` calls
- **Component resolution** — review components resolved via
  `--componentDir .reviews/components --componentDir core/components`

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
  diffPreview: string;       // addedSource truncated to 80K chars
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
- `diffPreview`: `addedSource` truncated to 80,000 characters
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

### 4.1 `Show.md`

````markdown
---
inputs:
  when:
    type: boolean
    required: true
  fallback: ""
---

```ts eval
if (when) {
  return yield* renderChildren();
}
if (fallback) {
  return fallback;
}
```
````

### 4.2 `ReviewSection.md`

````markdown
---
inputs:
  heading:
    type: string
    required: true
  clean: "✅ No issues found."
---

```ts eval
const content = yield* renderChildren();
return content.trim().length > 0
  ? `### ${heading}\n\n${content}`
  : `### ${heading}\n\n${clean}`;
```
````

### 4.3 `Finding.md`

````markdown
---
inputs:
  when:
    type: boolean
    required: true
  severity: warning
  message:
    type: string
    required: true
---

```ts eval
const icon = severity === "error" ? "🔴" : "🟡";
```

<Show when={when}>

{icon} {message}

</Show>
````

### 4.4 `Instructions.md`

````markdown
---
inputs:
  system:
    type: string
    required: true
---

```ts persist eval
const scope = yield* useScope();
scope.around(Sample, function* ([context], next) {
  return yield* next({
    ...context,
    system,
  });
});
```

<Content />
````

### 4.5 `GitHubComment.md`

````markdown
---
inputs:
  marker: "<!-- ema-review -->"
---

```ts eval
const content = yield* renderChildren();
const body = marker + "\n" + content;

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const [owner, name] = repo.split("/");
const api = `https://api.github.com/repos/${owner}/${name}`;

const headers = {
  "Authorization": `Bearer ${token}`,
  "Accept": "application/vnd.github+json",
};

const { json: comments } = yield* fetch(
  `${api}/issues/${prNumber}/comments`, { headers }
).expect();

const existing = comments.find(c =>
  c.user.type === "Bot" && c.body.includes(marker)
);

if (existing) {
  yield* fetch(`${api}/issues/comments/${existing.id}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  }).expect();
} else {
  yield* fetch(`${api}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  }).expect();
}

return content;
```
````

### 4.6 `DeepInfraProvider.md`

````markdown
---
inputs:
  model:
    type: string
    required: true
---

```ts persist eval
const scope = yield* useScope();
scope.around(Sample, function* ([context], next) {
  if (context.model !== undefined && context.model !== model) {
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
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 4096 }),
  })
    .expect()
    .json();

  return result.choices[0].message.content;
});
```

<Content />
````

### 4.7 `OllamaProvider.md`

````markdown
---
inputs:
  model:
    type: string
    required: true
  baseUrl: "http://localhost:11434"
---

```ts persist eval
const scope = yield* useScope();
scope.around(Sample, function* ([context], next) {
  if (context.model !== undefined && context.model !== model) {
    return yield* next(context);
  }

  const messages = [];
  if (context.system) {
    messages.push({ role: "system", content: context.system });
  }
  messages.push({ role: "user", content: context.content });

  const result = yield* fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0 }),
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
inputs:
  pr:
    type: object
    required: true
  metric:
    type: string
    required: true
  op:
    type: string
    required: true
  value:
    type: number
    required: true
  severity: warning
  message:
    type: string
    required: true
---

```ts eval
const metrics = {
  totalChanges: pr.stats.totalChanges,
  totalFiles: pr.stats.totalFiles,
  additions: pr.stats.additions,
  deletions: pr.stats.deletions,
  directories: pr.directories.size,
};

const actual = metrics[metric];
const ops = {
  ">":  (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<":  (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a == b,
};

if (ops[op](actual, value)) {
  const icon = severity === "error" ? "🔴" : "🟡";
  return icon + " " + message
    .replace("{actual}", String(actual))
    .replace("{value}", String(value));
}
```
````

### 5.2 `Pattern.md`

````markdown
---
inputs:
  pr:
    type: object
    required: true
  pattern:
    type: string
    required: true
  min: 1
  excludeTests: true
  severity: warning
  message:
    type: string
    required: true
---

```ts eval
const re = new RegExp(pattern, "g");
const lines = excludeTests
  ? pr.added.filter(l => !l.isTest)
  : pr.added;
const matches = lines.filter(l => re.test(l.content));
re.lastIndex = 0;

if (matches.length >= min) {
  const icon = severity === "error" ? "🔴" : "🟡";
  return icon + " " + message
    .replace("{count}", String(matches.length));
}
```
````

### 5.3 `Ratio.md`

````markdown
---
inputs:
  pr:
    type: object
    required: true
  numerator:
    type: string
    required: true
  denominator:
    type: string
    required: true
  threshold:
    type: number
    required: true
  minDenominator: 10
  excludeTests: true
  severity: warning
  message:
    type: string
    required: true
---

```ts eval
const numRe = new RegExp(numerator, "g");
const denRe = new RegExp(denominator, "g");
const lines = excludeTests
  ? pr.added.filter(l => !l.isTest)
  : pr.added;
const source = lines.map(l => l.content).join("\n");

const numCount = (source.match(numRe) ?? []).length;
const denCount = (source.match(denRe) ?? []).length;

if (denCount >= minDenominator && numCount / denCount > threshold) {
  const ratio = (numCount / denCount * 100).toFixed(1);
  const icon = severity === "error" ? "🔴" : "🟡";
  return icon + " " + message
    .replace("{ratio}", ratio)
    .replace("{numeratorCount}", String(numCount))
    .replace("{denominatorCount}", String(denCount));
}
```
````

### 5.4 `UnusedInDiff.md`

````markdown
---
inputs:
  pr:
    type: object
    required: true
  construct:
    type: string
    required: true
  severity: warning
  message:
    type: string
    required: true
---

```ts eval
const declPattern = new RegExp(
  `(?:${construct})\\s+(\\w+)`, "g"
);
const source = pr.added.map(l => l.content).join("\n");

const names = [];
let match;
while ((match = declPattern.exec(source)) !== null) {
  names.push(match[1]);
}

const unused = names.filter(name => {
  const refs = (source.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
  return refs <= 1;
});

if (unused.length > 0) {
  const icon = severity === "error" ? "🔴" : "🟡";
  return icon + " " + message
    .replace("{names}", unused.join(", "))
    .replace("{count}", String(unused.length));
}
```
````

### 5.5 `DescriptionCheck.md`

```markdown
---
inputs:
  pr:
    type: object
    required: true
  minLength: 50
  severity: error
  message: "PR description must explain what and why."
---

<Finding when={pr.meta.body.length < minLength}
  severity={severity} message={message} />
```

### 5.6 `LinkedIssue.md`

````markdown
---
inputs:
  pr:
    type: object
    required: true
  whenLinesExceed: 0
  severity: warning
  message: "Large PR with no linked issue."
---

```ts eval
const hasIssue = /(?:#\d+|https:\/\/github\.com\/.*\/issues\/\d+)/.test(pr.meta.body);
```

<Finding when={!hasIssue && pr.stats.totalChanges > whenLinesExceed}
  severity={severity} message={message} />
````

### 5.7 `ConfigSourceMix.md`

````markdown
---
inputs:
  pr:
    type: object
    required: true
  minFiles: 5
  severity: warning
  message: "PR mixes config and source changes."
---

```ts eval
const hasConfig = pr.files.some(f => f.isConfig);
const hasSource = pr.files.some(f =>
  !f.isConfig && !f.isTest && !f.isTypeDeclaration
);
const triggered = hasConfig && hasSource && pr.stats.totalFiles > minFiles;
```

<Finding when={triggered} severity={severity} message={message} />
````

### 5.8 `AbstractionNames.md`

````markdown
---
inputs:
  pr:
    type: object
    required: true
  pattern: "factory|abstract|base|provider|strategy|adapter|helper|util"
  severity: warning
  message: "New abstraction files: {names}. Verify 3+ consumers."
---

```ts eval
const re = new RegExp(pattern, "i");
const suspicious = pr.created
  .filter(f => f.path.endsWith(".ts") && !f.isTest && !f.isTypeDeclaration)
  .filter(f => re.test(f.path));
const triggered = suspicious.length > 0;
const resolvedMessage = message.replace(
  "{names}", suspicious.map(f => f.path).join(", ")
);
```

<Finding when={triggered} severity={severity} message={resolvedMessage} />
````

### 5.9 `NewDependencies.md`

````markdown
---
inputs:
  pr:
    type: object
    required: true
  severity: warning
  message: "package.json changed without dependency justification."
---

```ts eval
const touchesPkg = pr.files.some(f =>
  f.path === "package.json" || f.path.endsWith("/package.json")
);
const mentionsDeps = pr.meta.body.toLowerCase().includes("dependenc");
const triggered = touchesPkg && !mentionsDeps;
```

<Finding when={triggered} severity={severity} message={message} />
````

### 5.10 `CommentReview.md`

````markdown
---
inputs:
  pr:
    type: object
    required: true
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

<Show when={hasPairs}>

<Sample>

Review these comment/code pairs. List ONLY obvious/redundant ones
where the comment restates what the code does.

Format: "- `<comment>` — restates `<code pattern>`"

If none are obvious: "No obvious comments found."

{pairsText}

</Sample>

</Show>
````

---

## 6. Policy Documents (zero JavaScript)

### 6.1 `ScopeCheck.md`

```markdown
---
inputs:
  pr:
    type: object
    required: true
---

<ReviewSection heading="Scope" clean="✅ PR scope looks good.">

<Threshold pr={pr} metric="totalChanges" op=">" value={800}
  severity="error"
  message="PR has {actual} lines changed. Split into focused PRs." />

<Threshold pr={pr} metric="totalChanges" op=">" value={400}
  severity="warning"
  message="{actual} lines changed. PRs under {value} receive more thorough review." />

<Threshold pr={pr} metric="totalFiles" op=">" value={20}
  severity="warning"
  message="{actual} files changed. Are all changes related?" />

<Threshold pr={pr} metric="directories" op=">" value={5}
  severity="warning"
  message="Changes span {actual} directories." />

<DescriptionCheck pr={pr} minLength={50}
  severity="error"
  message="PR description must explain what and why." />

<LinkedIssue pr={pr} whenLinesExceed={200}
  severity="warning"
  message="Large PR with no linked issue." />

<ConfigSourceMix pr={pr} minFiles={5}
  severity="warning"
  message="PR mixes config and source changes." />

<AbstractionNames pr={pr}
  severity="warning"
  message="New abstraction files: {names}. Verify 3+ consumers." />

<NewDependencies pr={pr}
  severity="warning"
  message="package.json changed without dependency justification." />

</ReviewSection>
```

### 6.2 `StructuralBloat.md`

```markdown
---
inputs:
  pr:
    type: object
    required: true
---

<ReviewSection heading="Structural" clean="✅ No structural bloat detected.">

<UnusedInDiff pr={pr} construct="type"
  severity="warning"
  message="Type declarations with no consumers: {names}." />

<UnusedInDiff pr={pr} construct="interface"
  severity="warning"
  message="Interface declarations with no consumers: {names}." />

<Ratio pr={pr}
  numerator=":\s*any\b"
  denominator=":\s*\w"
  threshold={0.05}
  minDenominator={10}
  excludeTests={true}
  severity="warning"
  message="{numeratorCount} uses of `any` ({ratio}% of annotations)." />

<Pattern pr={pr}
  pattern="(?:function\s+\w+|=>\s*)\([^)]*\)\s*\{\s*\}"
  excludeTests={true}
  severity="warning"
  message="{count} empty function bodies." />

<Pattern pr={pr}
  pattern="console\.(log|debug|info|trace)\("
  excludeTests={true}
  severity="warning"
  message="{count} console statements." />

</ReviewSection>
```

### 6.3 `VerbosityCheck.md`

```markdown
---
inputs:
  pr:
    type: object
    required: true
---

<ReviewSection heading="Verbosity" clean="✅ Comment quality looks reasonable.">

<Ratio pr={pr}
  numerator="^\s*(?://|/\*|\*)"
  denominator="^\s*\S"
  threshold={0.4}
  minDenominator={20}
  excludeTests={true}
  severity="warning"
  message="Comment ratio is {ratio}%." />

<CommentReview pr={pr} />

</ReviewSection>
```

### 6.4 `SemanticReview.md`

```markdown
---
inputs:
  pr:
    type: object
    required: true
---

<Show when={pr.stats.totalChanges > 20}
  fallback="✅ Small PR — semantic review skipped.">

<Sample>

You are reviewing a TypeScript PR for EXTRANEOUS code only.

PR: {pr.meta.title}
Description: {pr.meta.body}

Report ONLY:
1. Scope creep — changes unrelated to stated purpose
2. Speculative abstractions — new constructs with one consumer
3. Dead constructs — declarations never referenced in diff
4. Wrapper indirection — functions that only forward calls

Do NOT flag test helpers, exported types, or style preferences.

For each finding: FILE, PATTERN, CONCERN, QUESTION for the author.

If clean: "No extraneous code patterns detected."

DIFF:
{pr.diffPreview}

</Sample>

</Show>
```

Zero eval blocks.

### 6.5 `ReviewBody.md`

```markdown
---
inputs:
  pr:
    type: object
    required: true
---

## PR #{pr.meta.number}: {pr.meta.title}

**{pr.stats.totalFiles}** files, **+{pr.stats.additions}** / **-{pr.stats.deletions}**

<ScopeCheck pr={pr} />

<StructuralBloat pr={pr} />

<VerbosityCheck pr={pr} />

<SemanticReview pr={pr} />
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

      - uses: denoland/setup-deno@v2

      - uses: actions/cache@v4
        with:
          path: .reviews/journal.jsonl
          key: ema-review-${{ github.event.pull_request.head.sha }}
          restore-keys: |
            ema-review-${{ github.event.pull_request.base.sha }}

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
        run: deno task ema run .reviews/ReviewPR.md
```

### Journal caching

The journal is cached by head SHA. On re-run of the same SHA, full
replay — no git commands, no API calls, no LLM calls. On new commits,
`restore-keys` falls back to the base SHA for partial replay of
shared component imports.

---

## 9. Deterministic Analysis (separate CI jobs, unchanged)

EMA replaces the advisory/AI review layer and process enforcement.
Deterministic static analysis continues as separate CI jobs:

| Job | Tool | What it catches |
|---|---|---|
| `lint` | Oxlint `--type-aware` | Unused vars, inferrable types, empty functions, type bloat, console/debugger |
| `dead-code` | Knip | Unused exports, files, types, dependencies (cross-file) |

These block merges. The EMA review is advisory.

---

## 10. File Tree

```
.reviews/
  ReviewPR.md                    CI entry point (DeepInfra + GitHubComment)
  ReviewPR.local.md              Local entry point (Ollama + stdout)

  components/
    # Standard library
    Show.md                      Conditional rendering
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
    SemanticReview.md            Prompt template + Show + Sample
    ReviewBody.md                Composes all four checks
```

---

## 11. Eval Block Census

| Document | Eval blocks | Why |
|---|---|---|
| `Show.md` | 1 | Conditional rendering |
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

- Phase 1: EMA core (text interpolation, eval return) — PR #34, #35
- Phase 2: Infrastructure components — code-review-agent PR
- Phase 3: `@executablemd/code-review-agent` package — code-review-agent PR
- Phase 4: Rule components — code-review-agent PR
- Phase 5: Policy documents + entry points + CI — code-review-agent PR
- Phase 6: Sample modifier removal — PR #35
