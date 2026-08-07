---
props:
  type: object
  properties:
    pr:
      type: object
    tsconfigPath:
      type: string
      default: ".reviews/tsconfig.oxlint.json"
  required: [pr]
  additionalProperties: false
---

Checking environment for Oxlint static analysis...

<EnsureOxlint />

<Capture as="oxlintVersion">

```bash exec
.reviews/.oxlint/oxlint --version 2>/dev/null || echo "NOT_INSTALLED"
```

</Capture>

<Capture as="tsgolintVersion">

```bash exec
test -x .reviews/.oxlint/tsgolint && echo "INSTALLED" || echo "NOT_INSTALLED"
```

</Capture>

<Capture as="nodeModulesCheck">

```bash exec
test -x .reviews/.oxlint/oxlint && echo "EXISTS" || echo "MISSING"
```

</Capture>

<Capture as="tsconfigCheck">

```bash exec
test -f {tsconfigPath} && echo "EXISTS" || echo "MISSING"
```

</Capture>

```ts eval
const oxlintInstalled = !oxlintVersion.includes("NOT_INSTALLED");
const tsgolintInstalled = !tsgolintVersion.includes("NOT_INSTALLED");
const nodeModulesExists = nodeModulesCheck.trim() === "EXISTS";
const tsconfigExists = tsconfigCheck.trim() === "EXISTS";

const canProbeTypeAware = oxlintInstalled && tsgolintInstalled
  && nodeModulesExists && tsconfigExists;
```

Scanning source files for scheme specifiers (jsr:, npm:)...

<Capture as="specifierScan">

```bash exec
grep -rn --include='*.ts' --include='*.tsx' -E '^\s*(import|export)\s.*from\s+['"'"'"](jsr:|npm:)' packages/ src/ 2>/dev/null | head -50 || echo "NONE"
```

</Capture>

```ts eval
const hasNativeSpecifiers = specifierScan.trim() !== "NONE"
  && specifierScan.trim().length > 0;

const specifierLines = hasNativeSpecifiers
  ? specifierScan.trim().split("\n") : [];

const specifierFiles = [...new Set(
  specifierLines.map(l => l.split(":")[0]).filter(Boolean)
)];

const jsrCount = specifierLines.filter(l => l.includes("jsr:")).length;
const npmCount = specifierLines.filter(l => l.includes("npm:")).length;
```

Running type-aware probe to test Oxlint compatibility...

<Capture as="probeResult">

<Show when={canProbeTypeAware}
  fallback='{"diagnosticCount":0,"importNoiseCount":0,"filesAnalyzed":0,"filesSkipped":0,"importErrors":0,"availableRuleIds":[],"tsgolintCrashed":false}'>

```bash exec
RESULT=$(OXLINT_TSGOLINT_PATH=.reviews/.oxlint/tsgolint .reviews/.oxlint/oxlint --config .reviews/.oxlintrc.json --type-aware --tsconfig {tsconfigPath} --format json 2>.reviews/probe-stderr.tmp || true)
STDERR=$(cat .reviews/probe-stderr.tmp 2>/dev/null || echo "")
rm -f .reviews/probe-stderr.tmp
if [ -n "$RESULT" ] && printf '%s' "$RESULT" | jq -c --arg stderr "$STDERR" '
  def entries:
    if type == "array" then .
    elif (.diagnostics? | type) == "array" then .diagnostics
    else []
    end;
  def file:
    if (.file? | type) == "string" then .file
    elif (.filename? | type) == "string" then .filename
    else ""
    end;
  def rule:
    if (.ruleId? | type) == "string" then .ruleId
    elif (.code? | type) == "string" then .code
    else "unknown"
    end;
  def message:
    if (.message? | type) == "string" then .message else "" end;
  def import_noise:
    ((.message | ascii_downcase | contains("cannot find module"))
      or (.ruleId | ascii_downcase | contains("import")));
  def crashed($value):
    ($value | ascii_downcase) as $lower
    | ($lower | contains("tsgolint"))
      and (($lower | contains("panic"))
        or ($lower | contains("oom"))
        or ($lower | contains("fatal")));
  entries
  | map({file: file, ruleId: rule, message: message}) as $diagnostics
  | {
      diagnosticCount: ($diagnostics | length),
      importNoiseCount: ([$diagnostics[] | select(import_noise)] | length),
      filesAnalyzed: ([$diagnostics[].file | select(length > 0)] | unique | length),
      filesSkipped: ([$diagnostics[] | select(import_noise) | .file | select(length > 0)] | unique | length),
      importErrors: ([$diagnostics[] | select(import_noise)] | length),
      availableRuleIds: ([$diagnostics[].ruleId | select(length > 0)] | unique),
      tsgolintCrashed: crashed($stderr)
    }
'; then
  :
else
  jq -cn --arg stderr "$STDERR" '
    def crashed($value):
      ($value | ascii_downcase) as $lower
      | ($lower | contains("tsgolint"))
        and (($lower | contains("panic"))
          or ($lower | contains("oom"))
          or ($lower | contains("fatal")));
    {
      diagnosticCount: 0,
      importNoiseCount: 0,
      filesAnalyzed: 0,
      filesSkipped: 0,
      importErrors: 0,
      availableRuleIds: [],
      tsgolintCrashed: crashed($stderr)
    }
  '
fi
```

</Show>

</Capture>

```ts eval
const BLOAT_RULES = [
  "no-unused-vars", "no-inferrable-types", "no-empty-function",
  "no-empty-object-type", "no-useless-empty-export",
  "no-unnecessary-type-constraint",
  "no-unnecessary-parameter-property-assignment",
  "no-static-only-class", "no-console", "no-debugger",
  "no-unnecessary-type-assertion", "no-redundant-type-constituents",
  "no-unnecessary-type-arguments",
  "no-unnecessary-boolean-literal-compare",
];
const TYPE_AWARE_RULES = [
  "no-unnecessary-type-assertion", "no-redundant-type-constituents",
  "no-unnecessary-type-arguments",
  "no-unnecessary-boolean-literal-compare",
];

let probe = {
  diagnosticCount: 0,
  importNoiseCount: 0,
  filesAnalyzed: 0,
  filesSkipped: 0,
  importErrors: 0,
  availableRuleIds: [],
  tsgolintCrashed: false,
};
try { probe = { ...probe, ...JSON.parse(probeResult) }; } catch { }

const diagnosticCount = typeof probe.diagnosticCount === "number"
  ? probe.diagnosticCount : 0;
const importNoiseCount = typeof probe.importNoiseCount === "number"
  ? probe.importNoiseCount : 0;
const noiseRatio = diagnosticCount > 0
  ? importNoiseCount / diagnosticCount : 0;

const tsgolintCrashed = probe.tsgolintCrashed === true;

const typeAwareAvailable = canProbeTypeAware && !tsgolintCrashed;

let recommendation = "syntax-only";
if (typeAwareAvailable && noiseRatio < 0.3) {
  recommendation = "type-aware";
} else if (typeAwareAvailable && noiseRatio >= 0.3) {
  recommendation = "type-aware-filtered";
}

const bloatRulesAvailable = typeAwareAvailable
  ? BLOAT_RULES
  : BLOAT_RULES.filter(r => !TYPE_AWARE_RULES.includes(r));
const bloatRulesMissing = typeAwareAvailable
  ? []
  : TYPE_AWARE_RULES;

const doctor = {
  oxlintInstalled,
  oxlintVersion: oxlintVersion.trim(),
  tsgolintInstalled,
  tsgolintVersion: tsgolintVersion.trim(),
  tsconfigExists,
  nodeModulesExists,
  typeAwareAvailable,
  filesAnalyzed: typeof probe.filesAnalyzed === "number" ? probe.filesAnalyzed : 0,
  filesSkipped: typeof probe.filesSkipped === "number" ? probe.filesSkipped : 0,
  importErrors: typeof probe.importErrors === "number" ? probe.importErrors : 0,
  availableRuleIds: Array.isArray(probe.availableRuleIds)
    ? probe.availableRuleIds : [],
  bloatRulesAvailable,
  bloatRulesMissing,
  recommendation,
  nativeSpecifiers: {
    count: hasNativeSpecifiers ? specifierLines.length : 0,
    files: specifierFiles,
    jsr: jsrCount,
    npm: npmCount,
  },
};

return '```json\n' + JSON.stringify(doctor) + '\n```';
```
