# Specification: Oxlint Static Analysis Sensor

**Extends**: `@executablemd/code-review-agent` spec  
**Scope**: Oxlint as a structured signal source for the executable.md review
pipeline, environment compatibility analysis, and import specifier
enforcement for Deno/tsgo interoperability.

---

## 1. Concept

Oxlint runs through the typed `OxlintDiagnostics` component after
`ReviewContext` has constructed the diff. Its bounded diagnostic value becomes
a structured input to the review pipeline. The LLM receives both the diff and
the diagnostic map, interpreting the density and pattern of violations rather
than individual hits.

Oxlint runs permissively — all bloat-relevant rules enabled at
`"warn"`, zero rules at `"error"`. It collects signals, not
verdicts. The executable.md agent decides what matters.

Individual Oxlint violations are weak signals. The composite
metric is **density**: `diagnostics.total / pr.stats.additions`
(violations per added line). A few `no-inferrable-types` hits in a
large PR are noise. But clusters of `no-unused-vars` +
`no-empty-function` + `no-unnecessary-type-assertion` concentrated
in the same files suggest unreviewed generated code.

---

## 2. Architecture

```
ReviewPR.md
  ├─ <Output> → execution failures fail the document
  ├─ <GitHubAuth> → scoped exact-host GitHub authentication
  ├─ ReviewContext → git diff and PR metadata → pr
  ├─ Doctor (as="doctor")
  │    ├─ Check: oxlint binary
  │    ├─ Check: tsgolint binary
  │    ├─ Check: node_modules/
  │    ├─ Check: tsconfig
  │    ├─ Scan: scheme specifiers (jsr:, npm:)
  │    └─ Probe: type-aware test run
  ├─ OxlintDiagnostics (as="rawDiagnostics")
  ├─ eval: buildDiagnostics(rawDiagnostics) → diagnostics
  │
  └─ DeepInfraProvider (or OllamaProvider)
       └─ Instructions
            └─ GitHubComment (or stdout)
                 └─ ReviewBody
                      ├─ ScopeCheck         (unchanged from base spec)
                      ├─ StructuralBloat    (+ OxlintSignals)
                      ├─ VerbosityCheck     (unchanged)
                      ├─ OxlintSummary      (new)
                      └─ SemanticReview     (+ diagnostics context)
```

Three layers of concern:

| Layer | What | Components |
|---|---|---|
| Environment | Can Oxlint run? How much of it? | `Doctor.ts`, `ReviewSetup` |
| Collection | Run Oxlint, normalize output | `OxlintDiagnostics`, `buildDiagnostics` |
| Interpretation | LLM reads signals + diff | `SemanticReview`, `OxlintSummary` |

---

## 3. Deno/tsgo Compatibility

### 3.1 The problem

Oxlint's type-aware backend (tsgolint) uses typescript-go (tsgo),
which resolves imports through standard Node module resolution.
Two things Deno projects commonly lack that tsgo requires:

1. **`tsconfig.json`** — Deno uses `deno.json` `compilerOptions`
   instead. tsgo doesn't read `deno.json`.

2. **Bare specifiers** — Deno-native scheme specifiers (`jsr:`,
   `npm:`) in source files are invisible to tsgo's resolver.
   Every unresolvable import produces a "Cannot find module"
   diagnostic that drowns useful signals.

### 3.2 The fix: generated tsconfig

The review workflow generates a `tsconfig.json` in `.reviews/`
that mirrors Deno's defaults. Not committed to the repo —
generated fresh each run, journaled via `durableExec`.

The effectionx monorepo uses `nodeModulesDir: "auto"` in
`deno.json`, which means `deno install` creates a real
`node_modules/` tree. tsgo resolves bare specifiers through
this tree.

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "lib": ["ESNext", "DOM"],
    "types": []
  },
  "include": ["packages/*/src/**/*.ts", "packages/*/*.ts"],
  "exclude": ["node_modules", "dist", ".vendor", "**/*.test.ts"]
}
```

`moduleResolution: "bundler"` is the closest standard setting to
Deno's resolution — allows extensionless imports and `package.json`
exports. `DOM` in `lib` covers `fetch`, `crypto.subtle`, `URL` and
other web APIs Deno provides natively. `types: []` prevents tsgo
from auto-including `@types/node`.

### 3.3 The fix: bare specifiers via import map

Source files must use bare specifiers (`@std/assert`) not scheme
specifiers (`jsr:@std/assert`). The mapping lives in `deno.json`
`imports`:

```json
{
  "imports": {
    "@std/assert": "jsr:@std/assert",
    "express": "npm:express@4"
  }
}
```

Both Deno (via import map) and tsgo (via `node_modules/`) resolve
bare specifiers. This is the only import syntax compatible with
both resolvers.

### 3.4 Lint plugin: `no-scheme-specifiers`

A Deno lint plugin that flags `jsr:` and `npm:` scheme specifiers
in source files and auto-fixes them to bare specifiers. Requires
Deno 2.2+.

#### File: `lint-plugins/no-scheme-specifiers.ts`

```typescript
const plugin: Deno.lint.Plugin = {
  name: "no-scheme-specifiers",
  rules: {
    "no-scheme-specifiers": {
      create(context) {
        function checkSource(
          node: { source: { value: string } | null },
        ) {
          if (!node.source) return;
          const source = node.source.value;
          if (
            typeof source === "string"
            && (source.startsWith("jsr:")
              || source.startsWith("npm:"))
          ) {
            const bare = source
              .replace(/^jsr:/, "")
              .replace(/^npm:/, "")
              .replace(/@[\d^~>=<.*]+$/, "");

            context.report({
              node: node.source,
              message:
                `Use bare specifier "${bare}" instead of `
                + `"${source}". Add "${bare}": "${source}" `
                + `to deno.json "imports".`,
              fix(fixer) {
                return fixer.replaceText(
                  node.source,
                  `"${bare}"`,
                );
              },
            });
          }
        }

        return {
          ImportDeclaration: checkSource,
          ExportNamedDeclaration: checkSource,
          ExportAllDeclaration: checkSource,
        };
      },
    },
  },
};

export default plugin;
```

#### What it catches

| Source | Flagged | Suggested bare specifier |
|---|---|---|
| `import { x } from "jsr:@std/assert"` | Yes | `@std/assert` |
| `import { x } from "npm:express@4"` | Yes | `express` |
| `export { y } from "jsr:@std/path"` | Yes | `@std/path` |
| `export * from "npm:lodash"` | Yes | `lodash` |
| `import { x } from "@std/assert"` | No — already bare |
| `import { x } from "node:fs"` | No — builtin |
| `import { x } from "./foo.ts"` | No — relative |

#### Why not `no-external-import`

Deno's built-in `no-external-import` was designed for `https://`
URL imports. It also flags `node:` and `bun:` builtins (open issue
denoland/deno_lint#1366). The custom plugin is precise: it flags
only `jsr:` and `npm:` scheme specifiers.

#### Auto-fix behavior

`deno lint --fix` replaces the specifier string in the source
file. It does NOT modify `deno.json`. The developer must add the
corresponding import map entry manually. The diagnostic message
tells them exactly what to add.

#### `deno.json` configuration

```jsonc
{
  "lint": {
    "plugins": ["./lint-plugins/no-scheme-specifiers.ts"],
    "rules": {
      "include": ["no-scheme-specifiers/no-scheme-specifiers"]
    }
  }
}
```

---

## 4. Oxlint Configuration (Sensor Mode)

### 4.1 `.oxlintrc.json`

This config enables all bloat-relevant rules at `"warn"` severity.
It is the sensor config — NOT the CI enforcement config. No rule
is `"error"`. Oxlint always exits 0.

```jsonc
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",

  "plugins": ["typescript", "unicorn", "import"],

  "categories": {
    "correctness": "warn",
    "suspicious": "warn",
    "pedantic": "warn",
    "style": "warn"
  },

  "rules": {
    "eslint/no-unused-vars": ["warn", {
      "args": "all",
      "argsIgnorePattern": "^_",
      "varsIgnorePattern": "^_",
      "caughtErrorsIgnorePattern": "^_",
      "destructuredArrayIgnorePattern": "^_",
      "ignoreRestSiblings": true
    }],
    "typescript/no-inferrable-types": "warn",
    "typescript/no-empty-object-type": "warn",
    "typescript/no-useless-empty-export": "warn",
    "typescript/no-unnecessary-type-constraint": "warn",
    "typescript/no-unnecessary-parameter-property-assignment": "warn",
    "unicorn/no-static-only-class": "warn",
    "eslint/no-empty-function": "warn",
    "eslint/no-console": ["warn", { "allow": ["warn", "error"] }],
    "eslint/no-debugger": "warn",

    "eslint/func-style": "off",
    "eslint/no-magic-numbers": "off",
    "eslint/require-yield": "off",
    "eslint/sort-keys": "off",
    "eslint/sort-imports": "off",
    "import/exports-last": "off",
    "import/group-exports": "off",
    "import/no-named-export": "off",
    "import/prefer-default-export": "off",
    "import/consistent-type-specifier-style": "off",
    "unicorn/filename-case": "off",

    "typescript/no-unnecessary-type-arguments": "warn",
    "typescript/no-unnecessary-type-assertion": "warn",
    "typescript/no-redundant-type-constituents": "warn",
    "typescript/no-unnecessary-boolean-literal-compare": "warn"
  },

  "overrides": [
    {
      "files": ["**/*.test.ts", "**/*.spec.ts", "**/test/**"],
      "rules": {
        "eslint/no-console": "off",
        "eslint/no-empty-function": "off"
      }
    }
  ]
}
```

### 4.2 Rule catalog

The sensor collects the bloat-relevant rules that are compatible with the
repository's component and generator conventions. It excludes filename-case,
named-export, export-order, function-style, generator-yield, import-order,
key-order, and magic-number rules from its advisory report. These exclusions apply only to
the review sensor; the normal lint gate remains unchanged.

The remaining bloat-relevant rules are split into two groups by whether they
require type information:

**Syntax-only (10 rules, always available):**

| Rule | What it catches |
|---|---|
| `no-unused-vars` | Unused variables, functions, imports, types |
| `no-inferrable-types` | `const x: string = "hello"` |
| `no-empty-function` | Empty function bodies, scaffold stubs |
| `no-empty-object-type` | `interface Foo {}`, `type Foo = {}` |
| `no-useless-empty-export` | Redundant `export {}` |
| `no-unnecessary-type-constraint` | `<T extends unknown>` |
| `no-unnecessary-parameter-property-assignment` | Redundant `this.name = name` in constructor |
| `no-static-only-class` | Classes with only static members |
| `no-console` | `console.log` in production code |
| `no-debugger` | `debugger` statements |

**Type-aware (4 rules, require tsgolint + tsconfig):**

| Rule | What it catches | Requires |
|---|---|---|
| `no-unnecessary-type-assertion` | `str as string` when already string | `--type-aware` |
| `no-redundant-type-constituents` | `string \| unknown`, `string \| never` | `--type-aware` |
| `no-unnecessary-type-arguments` | Generic args matching defaults | `--type-aware` |
| `no-unnecessary-boolean-literal-compare` | `x === true` when `x: boolean` | `--type-aware` |

### 4.3 Two uses of Oxlint in CI

| Role | Config | Severity | Blocks merge | Output |
|---|---|---|---|---|
| **Sensor** (executable.md review job) | All 14 rules, `"warn"` | Advisory | No | JSON → LLM |
| **Gate** (separate lint job) | Curated subset, `"error"` | Blocking | Yes | Human-readable |

---

## 5. New Exports in `@executablemd/code-review-agent`

### 5.1 `Diagnostics` type

```typescript
interface OxlintDiagnostic {
  ruleId: string;
  severity: "error" | "warning";
  message: string;
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

interface DiagnosticGroup {
  ruleId: string;
  count: number;
  files: string[];
  instances: OxlintDiagnostic[];
}

interface Diagnostics {
  groups: DiagnosticGroup[];
  total: number;
  fileCount: number;
  ruleCount: number;
  byCategory: {
    structural: DiagnosticGroup[];
    verbosity: DiagnosticGroup[];
    typeAware: DiagnosticGroup[];
    other: DiagnosticGroup[];
  };
  summary: string;
  density: number;
}
```

### 5.2 `parseDiagnostics`

```typescript
function parseDiagnostics(
  rawJson: string,
  pr: PR,
  doctor: DoctorResult,
): Diagnostics;

function buildDiagnostics(
  diagnostics: OxlintDiagnostic[],
  pr: PR,
  doctor: DoctorResult,
): Diagnostics;
```

**Rule categorization:**

| Category | Rule IDs |
|---|---|
| `structural` | `no-unused-vars`, `no-empty-function`, `no-empty-object-type`, `no-static-only-class`, `no-useless-empty-export`, `no-unnecessary-type-constraint`, `no-unnecessary-parameter-property-assignment`, `no-unnecessary-type-arguments`, `no-unnecessary-type-assertion`, `no-redundant-type-constituents`, `no-unnecessary-boolean-literal-compare` |
| `verbosity` | `no-inferrable-types`, `no-console`, `no-debugger` |
| `typeAware` | All rules requiring `--type-aware` |
| `other` | Everything else |

Rules may appear in multiple categories.

**Noise filtering:** When `doctor.recommendation === "type-aware-filtered"`,
`buildDiagnostics` drops diagnostics matching import resolution
noise (`"Cannot find module"`, `"cannot find"`) before grouping.

`parseDiagnostics` retains the published tolerant parser contract: malformed
JSON and unsupported JSON shapes produce an empty `Diagnostics` value. The
review execution path uses `normalizeOxlintOutput` first; that boundary is
strict and fails malformed output or an unexpected process exit before a
document binding is created.

**Coverage annotation:** When `doctor.bloatRulesMissing.length > 0`,
summary appends:

```
Note: {N} type-aware rules unavailable ({rules}). Density may be understated.
```

When `doctor.nativeSpecifiers.count > 0`, summary appends:

```
Note: {N} source files use scheme specifiers (jsr:, npm:).
Run `deno lint --fix` with no-scheme-specifiers plugin to migrate.
```

**Summary generation:**

```
Oxlint: 23 diagnostics across 8 files (7 rules)
Density: 0.12 violations/added-line

  no-unused-vars (7): src/foo.ts, src/bar.ts, src/baz.ts
  no-inferrable-types (5): src/foo.ts, src/helpers.ts
  no-empty-function (4): src/services/auth.ts, src/services/db.ts
  no-unnecessary-type-assertion (3): src/api.ts
  no-console (2): src/handlers/webhook.ts
  no-unnecessary-type-arguments (1): src/types.ts
  no-redundant-type-constituents (1): src/types.ts
```

### 5.3 `parseDoctorResult`

```typescript
function parseDoctorResult(json: string): DoctorResult;
```

`parseDoctorResult` remains a published tolerant parser. It applies defaults
to missing fields and returns the default Doctor value for malformed or
non-object JSON. The typed `Doctor` component returns its structured result
directly and does not serialize it for this parser.

### 5.4 `DoctorResult` type

```typescript
interface DoctorResult {
  oxlintInstalled: boolean;
  oxlintVersion: string;
  tsgolintInstalled: boolean;
  tsgolintVersion: string;
  tsconfigExists: boolean;
  nodeModulesExists: boolean;
  typeAwareAvailable: boolean;
  filesAnalyzed: number;
  filesSkipped: number;
  importErrors: number;
  bloatRulesAvailable: string[];
  bloatRulesMissing: string[];
  recommendation: "type-aware" | "type-aware-filtered" | "syntax-only";
  nativeSpecifiers: {
    count: number;
    files: string[];
    jsr: number;
    npm: number;
  };
}
```

### 5.5 Doctor helpers

```typescript
function summarizeDoctorProbe(input: DoctorProbeInput): DoctorProbeSummary;
function buildDoctorResult(
  environment: DoctorEnvironment,
  probe: DoctorProbeSummary,
): DoctorResult;
```

These helpers accept only the bounded diagnostic representation. The typed
`Doctor` function component keeps process output local and returns the
validated Doctor object directly.

### 5.6 Package structure

```
packages/code-review-agent/
  src/
    parse-diff.ts
    parse-diagnostics.ts
    parse-doctor.ts
    parse-oxlint.ts
    doctor.ts
    categories.ts
    types.ts
  mod.ts
```

---

## 6. Components

### 6.1 `Doctor.ts`

Compatibility analysis for the Oxlint static analysis sensor.
Probes the environment to determine which Oxlint capabilities are
available, scans for import specifier compatibility issues, and
recommends a run mode. The typed function component returns the bounded
Doctor object directly.

Contextual `stat`, `exec`, `glob`, and `readTextFile` operations provide the
observations. Pure parsing and classification live in
`@executablemd/code-review-agent`; raw process output does not become a
document binding.

**Checks performed:**

| Check | What | Why |
|---|---|---|
| Oxlint binary | contextual `exec --version` | May not be installed. Without it, all static analysis signals are unavailable. |
| tsgolint binary | contextual `exec --version` | Separate Go binary for type-aware linting via typescript-go. Without it, 4 type-dependent rules are unavailable. |
| `node_modules/` | contextual `stat` | tsgolint resolves imports through Node module resolution. Created by `deno task setup`. |
| Generated tsconfig | contextual `stat` | tsgolint requires tsconfig. Generated by the typed `OxlintConfig` component. |
| Scheme specifiers | `glob` + `readTextFile` | These break tsgo resolution. Doctor reports them and explains the fix. |
| Type-aware probe | Full `oxlint --type-aware` run | Measures what actually works — noise ratio, crash detection, file coverage. |

**Recommendations:**

| Value | Meaning |
|---|---|
| `"type-aware"` | All prerequisites met, probe clean, noise < 30%. All 14 bloat rules. |
| `"type-aware-filtered"` | Type-aware works but noise ≥ 30%. Run type-aware, filter import noise in `parseDiagnostics`. |
| `"syntax-only"` | Prerequisites missing or probe crashed. 10 syntax-only rules, 4 type-aware missing. |

Doctor is the production typed function component. It obtains observations
through contextual `stat`, `exec`, `glob`, and `readTextFile` operations,
passes bounded diagnostics to the package helpers, and returns a structured
Doctor result. A missing prerequisite or recognized type-aware crash selects
`syntax-only`; malformed output and unexpected process exits fail the
enclosing `<Output>`.

### 6.2 `OxlintSignals.md`

Per-category signal summaries embedded in existing policy documents.

````markdown
---
props:
  type: object
  properties:
    groups:
      type: array
    label:
      type: string
  required: [groups, label]
  additionalProperties: false
---

```ts eval
if (groups.length === 0) return;

const lines = groups.map(g =>
  `- \`${g.ruleId}\` ×${g.count}: ${g.files.slice(0, 3).join(", ")}${g.files.length > 3 ? ` (+${g.files.length - 3})` : ""}`
);

return `**Oxlint ${label}:**\n${lines.join("\n")}`;
```
````

### 6.3 `OxlintSummary.md`

Deterministic summary of diagnostics with doctor status.

```markdown
---
props:
  type: object
  properties:
    diagnostics:
      type: object
    doctor:
      type: object
  required: [diagnostics, doctor]
  additionalProperties: false
---

<ReviewSection heading="Static Analysis"
  clean="✅ Oxlint found no issues.">

<If condition={!doctor.oxlintInstalled}>

🟡 Oxlint not installed. Static analysis skipped.

</If>

<If condition={doctor.oxlintInstalled && diagnostics.total > 0}>

{diagnostics.summary}

</If>

<If condition={doctor.bloatRulesMissing.length > 0
            && doctor.oxlintInstalled}>

*{doctor.bloatRulesMissing.length} type-aware rules unavailable
— install `oxlint-tsgolint` for full coverage.*

</If>

</ReviewSection>
```

---

## 7. Updated Policy Documents

### 7.1 `ReviewBody.md`

```markdown
---
props:
  type: object
  properties:
    pr:
      type: object
    diagnostics:
      type: object
    doctor:
      type: object
  required: [pr, diagnostics, doctor]
  additionalProperties: false
---

## PR #{pr.meta.number}: {pr.meta.title}

**{pr.stats.totalFiles}** files, **+{pr.stats.additions}** / **-{pr.stats.deletions}**

<ScopeCheck pr={pr} />

<StructuralBloat pr={pr} diagnostics={diagnostics} />

<VerbosityCheck pr={pr} />

<OxlintSummary diagnostics={diagnostics} doctor={doctor} />

<SemanticReview pr={pr} diagnostics={diagnostics} doctor={doctor} />
```

### 7.2 `StructuralBloat.md`

The only change from the base spec: `<OxlintSignals>` appended.
The existing regex checks remain — they operate on the diff (what
was added), while Oxlint operates on the full file (current state).
Both perspectives are complementary.

```markdown
---
props:
  type: object
  properties:
    pr:
      type: object
    diagnostics:
      type: object
  required: [pr, diagnostics]
  additionalProperties: false
---

<ReviewSection heading="Structural"
  clean="✅ No structural bloat detected.">

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

<OxlintSignals groups={diagnostics.byCategory.structural}
  label="structural signals" />

</ReviewSection>
```

### 7.3 `SemanticReview.md`

The LLM prompt includes `diagnostics.summary` and
`diagnostics.density`, and instruction #5 tells it to look for
signal clusters. The LLM correlates Oxlint's structured data with
the raw diff.

```markdown
---
props:
  type: object
  properties:
    pr:
      type: object
    diagnostics:
      type: object
    doctor:
      type: object
  required: [pr, diagnostics, doctor]
  additionalProperties: false
---

<If condition={pr.stats.totalChanges > 20}>

<Sample>

You are reviewing a TypeScript PR for EXTRANEOUS code only.

PR: {pr.meta.title}
Description: {pr.meta.body}

STATIC ANALYSIS SIGNALS:
{diagnostics.summary}
Violation density: {diagnostics.density} per added line.

Interpret these signals in context. A few inferrable-type warnings
in a large PR are noise. But clusters of unused-vars +
empty-functions + unnecessary-type-assertions concentrated in the
same files suggest unreviewed generated code.

Report ONLY:
1. Scope creep — changes unrelated to stated purpose
2. Speculative abstractions — new constructs with one consumer
3. Dead constructs — declarations never referenced in diff
4. Wrapper indirection — functions that only forward calls
5. Signal clusters — files where multiple Oxlint rules fire together

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

---

## 8. Entry Points

### 8.1 `ReviewPR.md` (CI with DeepInfra)

The production entrypoint keeps the workflow hierarchy in Markdown. The
contextual components own Git and GitHub I/O, while root eval blocks only
select files and adapt bounded package values:

```markdown
<Output>
  <GitHubAuth>
    <ReviewSetup />
    <ReviewContext as="context" />
    <Doctor pr={context.pr} as="doctor" />
    <OxlintDiagnostics
      files={context.changedFilePaths}
      typeAware={doctor.recommendation !== "syntax-only"}
      as="diagnostics"
    />
    <DeepInfraProvider model="Qwen/Qwen3-30B-A3B">
      <GitHubComment>
        <PrPolicyReport pr={context.pr} diagnostics={diagnostics} doctor={doctor} />
      </GitHubComment>
    </DeepInfraProvider>
  </GitHubAuth>
</Output>
```

The root keeps only short eval adapters: it selects changed TypeScript
paths and calls `buildDiagnostics` on the bounded return from
`OxlintDiagnostics`. Git, configuration, Oxlint execution, and normalization
remain in the typed components. `DeepInfraProvider` and `GitHubComment` stay
inside the same `<GitHubAuth>` scope.

### 8.2 `ReviewPR.local.md` (local with Ollama)

The local entrypoint has the same component composition and replaces
`DeepInfraProvider`/`GitHubComment` with `OllamaProvider`. Its root eval
adapters select files and build the bounded diagnostics value; no shell
capture or raw Oxlint JSON crosses the document boundary.

---

## 9. CI Workflow

The review workflow checks out the requested revision, installs the pinned
Deno toolchain, runs `deno task setup`, and executes that checkout's
`./dist/xmd` binary. It passes credentials through the workflow environment
to the lexically scoped `GitHubAuth` component. The root is inside
`<Output>`, so execution failures produce a nonzero CLI exit while ordinary
review findings remain report text. The journal is uploaded with `if: always()`
and Actions performs no journal or rendered-output postflight parsing.

### Separate enforcement jobs (unchanged from base spec)

| Job | Tool | Blocks merge |
|---|---|---|
| `lint` | Oxlint `--type-aware --max-warnings 0` | Yes |
| `dead-code` | Knip | Yes |

---

## 10. What Oxlint Provides That Regex Cannot

The base spec's `Pattern`, `Ratio`, and `UnusedInDiff` components
operate on added lines in the diff. They are fast and deterministic
but have hard limits:

| Capability | Regex (base spec) | Oxlint (this spec) |
|---|---|---|
| Unused vars in added code | `UnusedInDiff` (name-counting heuristic) | Full scope analysis |
| Unused vars in existing code touched by PR | No | Lints whole file |
| Type system analysis | No | Via tsgolint |
| Redundant type assertions | No | `no-unnecessary-type-assertion` |
| Redundant type constituents | No | `no-redundant-type-constituents` |
| Unnecessary type arguments | No | `no-unnecessary-type-arguments` |
| Empty function detection | Regex pattern (approximate) | AST-aware (exact) |
| Console statements | Regex pattern | Rule with `allow` list |
| Inferrable types | No | `no-inferrable-types` |
| Cross-scope unused detection | Single-pass name counting | Full lexical scoping |

Both views are complementary: regex sees the diff (what was added),
Oxlint sees the full file (current state). A file can be clean in
aggregate but the diff added extraneous code, or vice versa.

---

## 11. Density as the Key Metric

The `density` field (`diagnostics.total / pr.stats.additions`) is
the composite metric the LLM should weight most heavily.

Calibration thresholds:

| Density | Interpretation |
|---|---|
| < 0.02 | Clean — experienced contributor, reviewed code |
| 0.02–0.08 | Normal — minor issues, typical development |
| > 0.10 | Elevated — likely unreviewed generated code |

The executable.md journal is the natural calibration mechanism: after
sufficient reviews, examine the journal to correlate density values
with human reviewer agreement. Adjust thresholds based on observed
false positive and false negative rates.

---

## 12. File Tree

```
.reviews/
  ReviewPR.md               CI entry point
  ReviewPR.local.md         Local entry point
  tsconfig.oxlint.json      Generated (not committed)
  journal.jsonl

  components/
    # Base spec components (unchanged)
    Finding.md
    ReviewSection.md
    Instructions.md
    GitHubComment.md
    DeepInfraProvider.md
    OllamaProvider.md
    Threshold.md
    Pattern.md
    Ratio.md
    UnusedInDiff.md
    DescriptionCheck.md
    LinkedIssue.md
    ConfigSourceMix.md
    AbstractionNames.md
    NewDependencies.md
    CommentReview.md
    ScopeCheck.md
    StructuralBloat.md        Updated (+ OxlintSignals)
    VerbosityCheck.md
    SemanticReview.md          Updated (+ diagnostics)
    ReviewBody.md              Updated (+ diagnostics, doctor)

    # New components (this spec)
    Doctor.ts                  Compatibility analysis
    ReviewContext.ts           PR context and GitHub body
    RepositoryInventory.ts     Repository file inventory
    OxlintDiagnostics.ts       Bounded Oxlint execution
    OxlintSignals.md           Per-category signal list
    OxlintSummary.md           Diagnostic summary + doctor status

lint-plugins/
  no-scheme-specifiers.ts     Deno lint plugin

.oxlintrc.json                Sensor config (all warn)

packages/code-review-agent/
  src/
    parse-diff.ts              Unchanged
    parse-diagnostics.ts       New
    doctor.ts                  New
    parse-oxlint.ts            New
    categories.ts              New
    types.ts                   Updated
  mod.ts
```

---

## 13. Eval Block Census (Additions)

| Document | Eval blocks | Change |
|---|---|---|
| `Doctor.ts` | 0 | Typed contextual probe and bounded result |
| `ReviewContext.ts` | 0 | PR diff and metadata acquisition |
| `RepositoryInventory.ts` | 0 | File and line inventory |
| `OxlintDiagnostics.ts` | 0 | Bounded Oxlint execution |
| `OxlintSignals.md` | 1 | **New** |
| `OxlintSummary.md` | 0 | **New** |
| `ReviewPR.md` | 2 | Modified (composition and binding adapters) |
| `ReviewPR.local.md` | 2 | Modified (same as above) |
| `ReviewBody.md` | 0 | Modified (added diagnostics, doctor props) |
| `StructuralBloat.md` | 0 | Modified (added OxlintSignals) |
| `SemanticReview.md` | 0 | Modified (added diagnostics to prompt) |

The new contextual components contain no Markdown eval blocks. Root documents
retain only short binding adapters; prompt and policy composition remains
Markdown.

---

## 14. Test Plan

### Lint plugin: `no-scheme-specifiers`

| # | Test | Verify |
|---|------|--------|
| NS1 | `jsr:` import flagged | `from "jsr:@std/assert"` → diagnostic |
| NS2 | `npm:` import flagged | `from "npm:express@4"` → diagnostic |
| NS3 | `jsr:` export flagged | `export { y } from "jsr:@std/path"` → diagnostic |
| NS4 | `export *` flagged | `export * from "npm:lodash"` → diagnostic |
| NS5 | Bare specifier clean | `from "@std/assert"` → no diagnostic |
| NS6 | `node:` clean | `from "node:fs"` → no diagnostic |
| NS7 | Relative clean | `from "./foo.ts"` → no diagnostic |
| NS8 | Fix strips `jsr:` | `"jsr:@std/assert"` → `"@std/assert"` |
| NS9 | Fix strips `npm:` + version | `"npm:express@4"` → `"express"` |
| NS10 | Fix preserves scoped packages | `"npm:@types/node@22"` → `"@types/node"` |
| NS11 | Message includes deno.json instruction | Contains `deno.json "imports"` |

### Doctor component

| # | Test | Verify |
|---|------|--------|
| DR1 | Oxlint installed | Version captured, `oxlintInstalled: true` |
| DR2 | Oxlint missing | `NOT_INSTALLED` captured, `oxlintInstalled: false` |
| DR3 | tsgolint installed | Version captured, `tsgolintInstalled: true` |
| DR4 | tsgolint missing | `recommendation: "syntax-only"` |
| DR5 | node_modules exists | `nodeModulesExists: true` |
| DR6 | node_modules missing | Probe skipped, `recommendation: "syntax-only"` |
| DR7 | tsconfig exists | `tsconfigExists: true` |
| DR8 | tsconfig missing | Probe skipped |
| DR9 | Scheme specifiers found | `nativeSpecifiers.count > 0`, files listed |
| DR10 | No scheme specifiers | `nativeSpecifiers.count === 0` |
| DR11 | Probe clean, low noise | `recommendation: "type-aware"` |
| DR12 | Probe noisy (>30%) | `recommendation: "type-aware-filtered"` |
| DR13 | tsgolint crash | `recommendation: "syntax-only"` |
| DR14 | Full replay | No commands re-run, stored doctor result returned |

### parseDiagnostics

| # | Test | Verify |
|---|------|--------|
| PD1 | Groups by ruleId | Same ruleId diagnostics grouped together |
| PD2 | Computes density | `total / pr.stats.additions` |
| PD3 | Categorizes rules | `no-unused-vars` in structural, `no-console` in verbosity |
| PD4 | Filters noise when filtered mode | Import noise diagnostics dropped |
| PD5 | Annotates missing rules | Summary includes missing rule note |
| PD6 | Annotates scheme specifiers | Summary includes migration note |
| PD7 | Empty input | `total: 0`, `density: 0`, clean summary |
| PD8 | Malformed JSON | The diagnostic boundary fails rather than hiding an invocation error |

### Integration

| # | Test | Verify |
|---|------|--------|
| INT1 | Full pipeline: diff + doctor + oxlint + LLM | ReviewBody renders with all sections |
| INT2 | Doctor fallback: no oxlint | OxlintSummary shows "not installed" |
| INT3 | Doctor fallback: syntax-only | 4 type-aware rules listed as missing |
| INT4 | Signal clusters in SemanticReview prompt | LLM prompt contains diagnostics.summary |
| INT5 | Replay: full journal | No commands, no oxlint, no LLM calls |
| INT6 | Replay: partial (new commit) | Doctor and oxlint re-run for new diff |

---

## 15. What This Does NOT Cover

| Gap | Why | Mitigation |
|---|---|---|
| `no-unnecessary-type-parameters` | 1 of 2 missing tsgolint rules | LLM detection in SemanticReview prompt |
| Comment quality analysis | No linter rule exists | `CommentReview.md` (LLM-based, base spec) |
| Cross-file unused exports | Requires project-wide graph | Knip CI job (base spec §9) |
| Effection correctness | `yield` vs `yield*`, `async function*` | Separate correctness policy |
| `https://` URL imports | Different problem from scheme specifiers | Deno's built-in `no-external-import` rule |

## 16. Current document boundary

The production sensor keeps Markdown responsible for composition and uses
typed function components for contextual I/O:

```markdown
<ReviewSetup />
<Doctor pr={pr} as="doctor" />
<OxlintDiagnostics files={files} typeAware={doctor.recommendation !== "syntax-only"} as="diagnostics" />
```

`Doctor` uses `stat`, `exec`, `glob`, and `readTextFile`; its parsing,
classification, import-noise aggregation, and result construction live in
`@executablemd/code-review-agent`. `OxlintDiagnostics` invokes Oxlint only
when its file list is nonempty and passes stdout through
`normalizeOxlintOutput`, which retains only `message`, `ruleId`, `severity`,
`file`, `line`, and `column`. It filters changed files in that package.
`buildDiagnostics` consumes that structured result without serializing it back
to JSON. A malformed JSON result, crash, or unexpected invocation exit fails the enclosing
`<Output>` instead of becoming an empty diagnostic list. A valid diagnostic
exit may contain zero diagnostics.

The workflow provisions the checked-out binary through `deno task setup` and
executes `./dist/xmd`. It relies on the CLI exit status, keeps the journal
artifact under `if: always()`, and performs no journal-result or rendered-error
postflight parsing.
