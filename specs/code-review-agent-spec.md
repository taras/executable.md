# Specification: `@executablemd/code-review-agent`

**Status:** Draft  
**Scope:** An Executable Markdown Agent that reviews pull requests for extraneous code, posts findings as GitHub comments, and runs locally via Ollama or in CI via DeepInfra.

---

## 1. Architecture

A PR review is an executable Markdown document. Typed function components
gather the diff, environment observations, and bounded diagnostics. Markdown
then composes the policy components, model provider, and optional GitHub
delivery.

```
ReviewPR.md
  ├─ <Output> → execution failures fail the document
  ├─ <GitHubAuth> → scoped exact-host GitHub authentication
  ├─ ReviewContext → git diff and PR metadata → pr
  ├─ Doctor → bounded environment recommendation
  ├─ OxlintDiagnostics → normalized diagnostics
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

The review composition has three layers of concern:

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

The package exports the published diff, diagnostics, Oxlint normalization, and
Doctor parsing helpers. `parseDiff` takes raw `git diff` and
`git diff --name-status` output and returns a typed `PR` object. Existing
`parseDoctorResult` and tolerant `parseDiagnostics` behavior remains stable;
strict Oxlint validation belongs to `normalizeOxlintOutput` at the review
component boundary.

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
  ? `### ${heading}\n\n${content}`
  : `### ${heading}\n\n${clean}`;
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
const icon = severity === "error" ? "🔴" : "🟡";
```

<If condition={when}>

{icon} {message}

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
    system,
  });
});
```

<Content />
````

### 4.4 `GitHubComment.md`

CI roots place this component inside `<GitHubAuth>` and `<Output>`. `GitHubAuth`
reads `GITHUB_TOKEN` once in a private generator closure and installs
`@effectionx/fetch`'s `FetchApi` middleware around its projected content. It
adds authorization only to HTTPS requests whose exact hostname is
`api.github.com`, preserves request headers and bodies, and forwards the
`shouldExpect` argument unchanged. Missing credentials and non-GitHub requests
delegate unchanged. `GitHubComment` therefore keeps only request-specific
headers such as `Content-Type`; it requires repository and PR metadata instead
of silently returning an empty report.

`GitHubComment.md` renders the report, reads the configured repository and PR
metadata through contextual environment access, and uses the fluent
`fetch().expect()` operations to create or update the marked comment. It
requires its metadata and validates the comments payload. Authentication is
inherited from the surrounding `GitHubAuth` provider; the component supplies
only request-specific headers such as `Content-Type`.

### 4.5 `DeepInfraProvider.md`

`DeepInfraProvider` is a Markdown provider for the `Sample` API. It keeps
request construction and response validation in its scoped middleware. The
token is read through contextual environment access and stays in the private
request operation; a successful 2xx response without model content fails the
provider.

### 4.6 `OllamaProvider.md`

`OllamaProvider` uses the same `Sample` provider contract with its configured
local base URL. It validates that a successful response contains model
content and otherwise fails the enclosing document.

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
const lines = pr.added.filter(l =>
  l.file.endsWith(".ts") || l.file.endsWith(".tsx")
);
const source = lines.map(l => l.content).join("\n");

// Anchoring the keyword to statement position (line start, after an optional
// export/default/declare prefix) excludes `import { type X }` specifiers,
// whose `type` keyword sits inside braces rather than at the start of a
// declaration.
const declPattern = new RegExp(
  `^\\s*(?:export\\s+)?(?:default\\s+|declare\\s+)?${construct}\\s+(\\w+)`
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
const icon = severity === "error" ? "🔴" : "🟡";
const summary = icon + " " + message
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

<Finding when={pr.meta.body.length < minLength}
  severity={severity} message={message} />
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
const hasIssue = /(?:#\d+|https:\/\/github\.com\/.*\/issues\/\d+)/.test(pr.meta.body);
```

<Finding when={!hasIssue && pr.stats.totalChanges > whenLinesExceed}
  severity={severity} message={message} />
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
const touchesPkg = pr.files.some(f =>
  f.path === "package.json" || f.path.endsWith("/package.json")
);
const mentionsDeps = pr.meta.body.toLowerCase().includes("dependenc");
const triggered = touchesPkg && !mentionsDeps;
```

<Finding when={triggered} severity={severity} message={message} />
````

### 5.10 `CommentReview.md`

`CommentReview.md` keeps the authored `<Sample>`, `<Capture>`, and `<Show>`
composition. `CommentReviewData.ts` performs pair extraction and bounded
GitHub response parsing, while `CommentReviewState.ts` parses model responses
and constructs the checklist and pending findings. Both are typed function
components with explicit schemas; no procedural eval block crosses the
Markdown boundary.

```markdown
<CommentReviewData pr={pr} as="reviewData" />
<Capture as="sampleResult">
  <Show when={reviewData.hasPairs}>
    <Sample>{reviewData.pairsText}</Sample>
  </Show>
</Capture>
<CommentReviewState
  pr={pr}
  data={reviewData}
  classificationResult={classificationResult}
  sampleResult={sampleResult}
  as="state"
 />
```

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
props:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
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
props:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
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
props:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
---

<If condition={pr.stats.totalChanges > 20}>

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

The CI and local roots keep workflow composition in Markdown. Both use
`ReviewSetup`, `ReviewContext`, `Doctor`, and `OxlintDiagnostics`; the CI root
places the complete review inside `<Output>` and wraps it in `GitHubAuth`.
The local root uses the same composition without `GitHubComment`.

```markdown
<Output>
<GitHubAuth>
<ReviewSetup />
<ReviewContext as="context" />
<Doctor pr={context.pr} as="doctor" />
<OxlintDiagnostics
  files={changedTsFiles}
  typeAware={doctor.recommendation !== "syntax-only"}
  as="rawDiagnostics"
/>
```ts eval
import { buildDiagnostics } from "@executablemd/code-review-agent";
const diagnostics = buildDiagnostics(rawDiagnostics, context.pr, doctor);
```
<DeepInfraProvider model="Qwen/Qwen3-30B-A3B">
  <GitHubComment>
    <PrPolicyReport pr={context.pr} diagnostics={diagnostics} doctor={doctor} />
  </GitHubComment>
</DeepInfraProvider>
</GitHubAuth>
</Output>
```

The two eval blocks in the checked-in roots only select bounded values and
adapt package results. Git, GitHub, Oxlint execution, configuration, and
normalization live in typed function components or package modules.

## 8. CI Workflow

The review workflow checks out the requested revision, installs the pinned
Deno toolchain, runs `deno task setup`, and executes that checkout's
`./dist/xmd` binary with the review component directories. Credentials stay
in the workflow environment and are consumed by the scoped `GitHubAuth`
provider. The CI root uses `<Output>` so execution errors fail the CLI while
ordinary review findings remain successful report text. The journal is
uploaded under `if: always()`; Actions does not parse journal records or
rendered error markers.

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
    CommentReview.md             Prompt composition for comment review
    CommentReviewData.ts         Pair extraction + GitHub response parsing
    CommentReviewState.ts        Model-response and checklist state

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
| `CommentReview.md` | 0 | Prompt and capture composition |
| `CommentReviewData.ts` | 0 | Pair extraction and GitHub response parsing |
| `CommentReviewState.ts` | 0 | Model-response and checklist state |
| **`ScopeCheck.md`** | **0** | |
| **`StructuralBloat.md`** | **0** | |
| **`VerbosityCheck.md`** | **0** | |
| **`SemanticReview.md`** | **0** | |
| **`ReviewBody.md`** | **0** | |
| `ReviewPR.md` | 2 | Changed-file selection + diagnostic grouping |
| `ReviewPR.local.md` | 2 | Changed-file selection + diagnostic grouping |

The authored Markdown keeps the review prompts and policy composition. The
procedural components are typed TypeScript modules, while only short binding
adapters remain in the two root documents.

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

`.reviews/.oxlintrc.json` — committed review-sensor config with
`pedantic: "warn"` and `style: "warn"` enabled. All oxlint invocations
reference this config via `--config .reviews/.oxlintrc.json`. The sensor
turns off rule families that conflict with repository conventions: component
filename casing, named-export and export-order rules, generator/function
style rules, and mechanical import/key-order and magic-number rules (including
`sort-imports`, `sort-keys`, and `no-magic-numbers`). The normal repository
lint configuration remains authoritative for those rules; this
review-only exclusion prevents the advisory report from treating required
component structure as a finding.

### 13.2 Environment detection (`Doctor.ts`)

The Doctor component probes the environment before oxlint runs:
oxlint binary, tsgolint binary, `node_modules/`, tsconfig, scheme
specifier scan (`jsr:`, `npm:`), and a type-aware test run. Outputs
a recommendation: `type-aware`, `type-aware-filtered`, or
`syntax-only`. The typed function component returns the bounded Doctor
object directly; raw process output never becomes a document binding.

### 13.3 PR-scoped analysis

PR entry points (`ReviewPR.md`, `ReviewPR.local.md`) pass the parsed changed
`.ts`/`.tsx` paths to the typed `OxlintDiagnostics` component. Density against
`pr.stats.additions` is only meaningful when diagnostics come from the same
files the additions are in. Repo analysis entry points run on everything.

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

## 14. Current review-infrastructure boundary

The CI entrypoints are declarative compositions. Their executable shape is:

```markdown
<Output>
  <GitHubAuth>
    <ReviewSetup />
    <ReviewContext as="context" />
    <Doctor pr={context.pr} as="doctor" />
    <OxlintDiagnostics files={changedTsFiles} as="diagnostics" />
    <!-- provider and policy composition -->
  </GitHubAuth>
</Output>
```

`Doctor`, `ReviewContext`, `RepositoryInventory`, and `OxlintDiagnostics` are
typed function components. They use contextual runtime operations directly;
their props and return schemas stay explicit at the module boundary. Git and
GitHub calls use argument-array `exec` and the fluent
`fetch().expect().json()` operations. The code-review-agent package owns diff,
Oxlint normalization, Doctor classification, and structured result
construction. Raw process output, response objects, and credentials remain
inside generator-local variables; only bounded values become document
bindings. Markdown remains responsible for the visible composition and
provider hierarchy.

The review workflow runs `deno task setup` and then `./dist/xmd`, so the binary
and executable Markdown are from the same checkout. The two CI roots use
`<Output>` error mode: execution failures return a failed document result and a
nonzero CLI exit, while ordinary finding text remains successful output. The
journal is uploaded with `if: always()` and is not parsed by Actions.
