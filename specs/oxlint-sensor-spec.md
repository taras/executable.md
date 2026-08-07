# Specification: Oxlint sensor for review documents

**Status:** Draft

The Oxlint sensor supplies bounded static-analysis signals to the review
documents. It follows the executable-document precedence:

1. Markdown components compose and branch.
2. JavaScript eval generators parse, filter, aggregate, and construct values.
3. Bash is limited to host operations unavailable through contextual APIs.

## 1. Data flow

```
ReviewSetup
  ├─ EnsureOxlint
  └─ OxlintConfig
Doctor as doctor
  ├─ stat: executable/config checks
  ├─ exec: version and compatibility probe
  └─ glob + readTextFile: native-specifier scan
OxlintDiagnostics as diagnostics
  ├─ exec: one argument-array invocation
  └─ eval: JSON parse, file filter, field normalization
parseDiagnostics(diagnostics, pr, doctor)
```

`Doctor` and `OxlintDiagnostics` are value-returning Markdown components. They
use `<Return>` and `as`; no JSON code fence is used as a data transport.

## 2. Doctor contract

Doctor uses contextual `stat` for:

- `.reviews/.oxlint/oxlint`;
- `.reviews/.oxlint/tsgolint`;
- `.reviews/tsconfig.oxlint.json`; and
- `node_modules/`.

When the prerequisites exist, contextual `exec` runs the pinned Oxlint binary
with `OXLINT_TSGOLINT_PATH` in its scoped process environment. Oxlint stdout
and stderr stay inside the generator that performs the probe. The generator
extracts only aggregate values:

```typescript
{
  diagnosticCount: number;
  importNoiseCount: number;
  filesAnalyzed: number;
  filesSkipped: number;
  importErrors: number;
  availableRuleIds: string[];
  tsgolintCrashed: boolean;
}
```

It then returns the validated Doctor object:

```typescript
{
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
  availableRuleIds: string[];
  bloatRulesAvailable: string[];
  bloatRulesMissing: string[];
  recommendation: "type-aware" | "type-aware-filtered" | "syntax-only";
  nativeSpecifiers: { count: number; files: string[]; jsr: number; npm: number };
}
```

The recommendation is `syntax-only` when prerequisites are absent or tsgolint
crashes, `type-aware` when import noise is below 30%, and
`type-aware-filtered` otherwise. The import-noise ratio is calculated from the
aggregate probe, not from durable raw output.

The native-specifier scan uses `glob` over TypeScript source and
`readTextFile` for each candidate. JavaScript identifies import/export lines,
counts `jsr:` and `npm:`, and returns at most 50 diagnostic source locations.

## 3. Normalized diagnostics

`OxlintDiagnostics` receives a file list and a `typeAware` choice. Markdown
selects the choice from `doctor.recommendation`; JavaScript constructs the
argument array:

```typescript
const command = [
  ".reviews/.oxlint/oxlint",
  "--config", ".reviews/.oxlintrc.json",
  "--format", "json",
  ...files,
];
if (typeAware) {
  command.push("--type-aware", "--tsconfig", tsconfigPath);
}
const result = yield* exec({ command, env });
```

The raw `stdout` and `stderr` variables are function-local. A parser accepts
either Oxlint's array form or its `diagnostics` envelope and discards every
field except:

```typescript
{
  message: string;
  ruleId: string;
  severity: string;
  file: string;
  line: number;
  column: number;
}
```

The normalized array is filtered against the supplied file list before it is
returned. PR review supplies changed non-test TypeScript paths, capped at 200;
repository analysis supplies the full source inventory. The repository path is
not filtered because repository analysis is intentionally whole-tree.

`parseDiagnostics()` accepts the normalized array directly. Its legacy string
input remains for library callers, but review documents use the structured
boundary. It groups by rule, categorizes signals, removes import noise in
`type-aware-filtered` mode, and computes density against PR additions.

## 4. Signal categories

The sensor recognizes these categories:

| Category | Representative rules |
| --- | --- |
| structural | `no-unused-vars`, `no-empty-function`, `no-empty-object-type`, `no-static-only-class` |
| verbosity | `no-console`, `no-debugger`, `no-inferrable-types` |
| typeAware | `no-unnecessary-type-assertion`, `no-redundant-type-constituents`, `no-unnecessary-type-arguments`, `no-unnecessary-boolean-literal-compare` |
| other | all remaining identifiers |

Density is `diagnostics.total / pr.stats.additions`, rounded to three decimal
places. The review prompt treats density as a signal, not as an automatic
failure. It reports clusters, scope concerns, speculative abstractions, dead
constructs, and forwarding wrappers; it does not report style preferences or
test helpers.

## 5. Provisioning

`EnsureOxlint` uses `platform()` to select the pinned Oxlint and tsgolint
archives, checksums, and target names. The only Bash blocks in the document
download the selected archives, verify their checksums, extract them, install
executable mode, and remove their temporary archive directory. Checksum
selection, platform mapping, path existence, and branching happen in
JavaScript/Markdown.

The provisioning blocks fail closed. A missing or tampered archive raises an
execution error. CI does not add a second provisioning assertion because the
root `<Output>` error mode propagates the component failure to `xmd run`.

## 6. Durable boundary

The journal may contain the normalized diagnostic array and Doctor object. It
must not contain:

- complete Oxlint JSON;
- source excerpts, causes, rendered source, URLs, or arbitrary diagnostic
  fields;
- unbounded stdout or stderr;
- GitHub or model credentials;
- credential-bearing request headers; or
- full HTTP response objects.

Provider and GitHub components obtain credentials with contextual `env` inside
request-time generator functions. They construct request headers locally and
discard the response object after extracting the bounded value needed by the
document.

`packages/core/tests/cli-journal.test.ts` proves that a normalized diagnostic
is present while constructed raw source, arbitrary fields, a bearer-shaped
value, and an authorization field are absent. The test also proves that a
successful finding report does not fail and that a missing component below
`<Output>` exits nonzero while leaving its configured journal.

Review roots install GitHub authentication through the review-scoped
`GitHubAuth` Markdown provider. Its private `API.Fetch` middleware injects a
Bearer token only for HTTPS requests to the exact `api.github.com` hostname.
Projected children inherit the middleware, while unrelated and lookalike hosts
are delegated unchanged. Request headers and bodies remain request-specific;
the token is not part of any durable value or rendered report.

## 7. Workflow contract

`.github/workflows/review.yml` and `.github/workflows/repo-analysis.yml`:

1. install the repository-pinned Deno version;
2. run `deno task deps`;
3. run `deno task build`;
4. execute `./dist/xmd` from the checked-out revision; and
5. upload reports and journals with `if: always()`.

The CI roots are enclosed in `<Output>`. Workflow steps rely on the native
nonzero exit from `xmd run`; they do not parse journal close records, nested
result status, rendered output, or `<!-- ERROR:` markers. Finding text remains
ordinary output and does not fail the job.

## 8. Repository analysis

`RepositoryInventory` uses contextual `glob` for `durable-effects/**/*.ts` and
`packages/**/*.ts`, excludes tests/specs and `node_modules`, reads each file
with `readTextFile`, and returns sorted `fileList`, `fileCount`, and `lineCount`.
No temporary file bridges the inventory and the sensor.

`ReviewContext` uses contextual `exec` with argument arrays for the two Git
diff calls and contextual `fetch` for the PR body. It parses the diff once and
returns the structured PR and paths. No second shell diff is run to decide
which files Oxlint sees.
