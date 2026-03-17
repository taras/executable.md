---
inputs:
  diagnostics:
    type: object
    required: true
  doctor:
    type: object
    required: true
  fileList:
    type: string
    required: true
---

<ReviewSection heading="Code Health Analysis"
  clean="✅ No code health issues detected.">

<Show when={diagnostics.total > 0}>

<Sample>

You are analyzing a TypeScript monorepo for code health issues using
Oxlint static analysis results.

STATIC ANALYSIS SIGNALS:
{diagnostics.summary}

Violation density: {diagnostics.density} per source line.

SOURCE FILES:
{fileList}

Analyze the diagnostic distribution and report:

1. **Hotspots** — files with disproportionate violation density
   compared to the repo average
2. **Dead code clusters** — concentrations of no-unused-vars that
   suggest unused modules or abandoned features
3. **Cleanup opportunities** — areas with multiple rule violations
   suggesting unreviewed or generated code
4. **Architecture signals** — patterns across multiple files in
   the same package (e.g., many empty functions, excessive type
   assertions)

For each finding: PACKAGE/FILE, PATTERN, CONCERN, SUGGESTED ACTION.

If the repo is clean: "No code health issues detected."

</Sample>

</Show>

</ReviewSection>
