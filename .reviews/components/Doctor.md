---
inputs:
  pr:
    type: object
    required: true
  tsconfigPath:
    type: string
    default: ".reviews/tsconfig.oxlint.json"
---

Checking environment for Oxlint static analysis...

<Capture as="oxlintVersion">

```bash exec
npx oxlint --version 2>/dev/null || echo "NOT_INSTALLED"
```

</Capture>

<Capture as="tsgolintVersion">

```bash exec
test -d node_modules/oxlint-tsgolint && echo "INSTALLED" || echo "NOT_INSTALLED"
```

</Capture>

<Capture as="nodeModulesCheck">

```bash exec
test -d node_modules && echo "EXISTS" || echo "MISSING"
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
  fallback='{"diagnostics":[],"stderr":""}'>

```bash exec
RESULT=$(npx oxlint --config .reviews/.oxlintrc.json --type-aware --tsconfig {tsconfigPath} --format json 2>.reviews/probe-stderr.tmp || true)
STDERR=$(cat .reviews/probe-stderr.tmp 2>/dev/null || echo "")
rm -f .reviews/probe-stderr.tmp
echo "{\"diagnostics\":$RESULT,\"stderr\":\"$STDERR\"}"
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

let probe = { diagnostics: [], stderr: "" };
try { probe = JSON.parse(probeResult); } catch { /* malformed */ }

const diagnostics = Array.isArray(probe.diagnostics)
  ? probe.diagnostics
  : (probe.diagnostics && typeof probe.diagnostics === "object"
      && Array.isArray(probe.diagnostics.diagnostics))
  ? probe.diagnostics.diagnostics
  : [];

const importNoise = diagnostics.filter(d =>
  d.message?.includes("Cannot find module")
  || d.message?.includes("cannot find")
  || d.ruleId?.includes("import")
);

const fileSet = new Set(diagnostics.map(d => d.file).filter(Boolean));
const noiseRatio = diagnostics.length > 0
  ? importNoise.length / diagnostics.length : 0;

const tsgolintCrashed = typeof probe.stderr === "string"
  && probe.stderr.includes("tsgolint")
  && (probe.stderr.includes("panic")
    || probe.stderr.includes("OOM")
    || probe.stderr.includes("fatal"));

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
  filesAnalyzed: fileSet.size,
  filesSkipped: new Set(importNoise.map(d => d.file).filter(Boolean)).size,
  importErrors: importNoise.length,
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

return JSON.stringify(doctor);
```
