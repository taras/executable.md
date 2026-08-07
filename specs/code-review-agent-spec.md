# Specification: `@executablemd/code-review-agent`

**Status:** Draft

This agent reviews pull requests for extraneous code, renders findings as a
GitHub comment in CI, and runs locally with Ollama. The document is the
orchestrator: it composes Markdown components, uses JavaScript eval blocks for
structured work, and crosses into Bash only for host operations with no
contextual equivalent.

## 1. Review composition

The review entrypoints share the same data path:

```
ReviewSetup
  ├─ EnsureOxlint
  └─ OxlintConfig
ReviewContext as context
  ├─ runtime exec: git diff and name-status
  ├─ runtime fetch: pull-request body in CI
  └─ parseDiff: bounded structured PR
Doctor as doctor
OxlintDiagnostics as rawDiagnostics
  ├─ runtime exec: selected Oxlint invocation
  └─ eval: parse, filter, and normalize diagnostics
parseDiagnostics(rawDiagnostics, context.pr, doctor)
  └─ policy components and provider
```

`ReviewPR.md` places this body inside one top-level `<Output>` region. A
review finding is ordinary report text. An execution failure is a raised
`ErrorSegment` that the output error mode propagates to `execute()` and the
CLI exit status.

`ReviewPR.local.md` uses the same composition with Ollama and no GitHub delivery
component. `AnalyzeRepo.md` and `AnalyzeRepoCI.md` replace `ReviewContext` with
`RepositoryInventory`, which uses contextual `glob` and `readTextFile` to
return `{ fileList, fileCount, lineCount }`.

## 2. Structured review data

`parseDiff()` accepts unified diff text, name-status text, and pull-request
metadata. It returns a JSON-compatible PR object:

```typescript
interface PR {
  files: DiffFile[];
  added: DiffLine[];
  removed: DiffLine[];
  created: DiffFile[];
  modified: DiffFile[];
  deleted: DiffFile[];
  directories: string[];
  addedSource: string;
  diffPreview: string;
  stats: {
    totalFiles: number;
    additions: number;
    deletions: number;
    totalChanges: number;
  };
  meta: { title: string; body: string; number: string };
}
```

`directories` is sorted JSON data rather than a `Set`, so a value component
can return the PR without introducing a non-serializable value. The review
context bounds `addedSource` to `diffPreview`; the prompt preview is at most
40,000 characters. The PR's parsed line and file data remains available to the
deterministic policy components.

`parseDiff()` handles unified diffs, renames, binary-file skipping, language
inference, test/config/type-declaration classification, directory discovery,
and change statistics. Its `diffPreview` is at most 40,000 characters.
`parseDiagnostics()` accepts either legacy JSON text or
the structured array returned by `OxlintDiagnostics`.

## 3. Oxlint and Doctor boundary

`Doctor` returns a validated object containing executable/config availability,
versions, type-aware availability, aggregate probe counts, import-noise counts,
available rule identifiers, the recommendation, and native-specifier counts.
The probe keeps Oxlint stdout and stderr inside a generator-local scope. It
returns no raw diagnostic, source excerpt, cause, rendered source, URL, or
arbitrary process payload.

`OxlintDiagnostics` invokes the selected type-aware or syntax-only command with
an argument array. Its generator-local parser accepts Oxlint's array or
`diagnostics` envelope and returns only:

```typescript
interface NormalizedDiagnostic {
  message: string;
  ruleId: string;
  severity: string;
  file: string;
  line: number;
  column: number;
}
```

The component filters by the supplied file list after parsing. PR review passes
changed, non-test TypeScript paths; repository analysis passes the complete
inventory. `parseDiagnostics()` performs the existing import-noise policy and
grouping on this bounded array.

`ReviewContext`, `Doctor`, `RepositoryInventory`, and `OxlintDiagnostics` are
value-returning Markdown components. Their callers use `as` and receive a
structured value through `<Return>`, rather than rendering JSON into a code
fence and parsing it again.

## 4. Providers and credentials

Provider and GitHub components read credentials with the contextual `env`
operation inside request-time generator functions. A token is never a
top-level binding. Request functions use contextual `fetch`, read only the
response text needed for the decision, and discard the response object after
normalizing its result. The journal therefore contains neither credential-
bearing headers nor full response objects.

Review entrypoints compose a `GitHubAuth` Markdown provider inside the
top-level `<Output>` region. The provider reads `GITHUB_TOKEN` once into a
private generator closure and installs one `API.Fetch` middleware around its
projected `<Content />`. It adds the shared GitHub `Accept` header and a Bearer
authorization header only for HTTPS requests whose exact hostname is
`api.github.com`. It preserves request-specific headers and bodies, delegates
missing-token and non-GitHub requests unchanged, and never returns the token as
props, rendered text, or component data. The provider's context is inherited by
projected review components and is restored when the provider exits.

Review output is posted by `GitHubComment`. Comment history and dismissal
updates use the same local request boundary. Local runs omit GitHub delivery
when the required environment is absent.

## 5. Remaining host shell boundary

`EnsureOxlint.md` uses JavaScript and `platform()` to select the pinned target,
archive URLs, and checksums. Its two small Bash blocks only download an archive,
verify its checksum with an available host checksum tool, extract it, install
the executable file, and clean up the temporary archive directory. These are
binary-transfer and executable-mode operations that the current contextual
APIs do not provide. No review document uses jq, grep, find, wc, awk, xargs,
tee, heredoc configuration generation, or temporary files to pass values
between document steps.

`DispatchRepoAnalysis.md` uses contextual GitHub HTTP requests and runtime
filesystem APIs. It retains one `gh run download` boundary only because the
current Fetch API exposes text, not binary artifact bytes; all response parsing,
polling, filtering, and artifact reading remains generator-based JavaScript.

## 6. Review components

The policy tree is intentionally compositional:

```
PrPolicyReport
  ├─ ScopePolicy
  ├─ BloatPolicy
  ├─ SlopPolicy
  ├─ RepoPolicyReport / CleanupIssues
  └─ CommentReview
```

The deterministic components inspect the parsed PR and diagnostics. LLM
providers receive bounded Markdown context and return report text. Review
findings, warnings, and requested changes do not fail a workflow; failures to
provision, acquire, parse, or render the review do.

## 7. Workflows and failure contract

Both review workflows:

1. check out the requested revision;
2. install the repository-pinned Deno version;
3. run `deno task deps`;
4. run `deno task build`;
5. execute the checked-out `./dist/xmd` binary; and
6. upload the journal/report with `if: always()`.

The CI roots use `<Output>`, not `<PrintErrors>`. They rely on `xmd run`'s
native exit status and do not parse journal close records, nested result
statuses, rendered output, or `<!-- ERROR:` markers after execution.

## 8. Verification

The prerequisite is portable across Deno, Node, and Bun. `packages/core/tests/
cli-journal.test.ts` covers:

- successful review-style `<Output>` execution with ordinary finding text;
- nonzero CLI exit for a missing component beneath `<Output>`;
- journal availability after the failed run; and
- a normalized diagnostic crossing the journal boundary while raw source,
  arbitrary fields, credential-shaped headers, and unbounded payloads remain
  local.

`packages/code-review-agent/tests/parse-diagnostics.test.ts` also covers the
structured normalized-diagnostic input path.
