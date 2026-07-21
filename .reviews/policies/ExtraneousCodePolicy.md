---
inputs:
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

<ReviewSection heading="Correctness"
  clean="✅ Small PR — correctness review skipped.">

<Show when={pr.stats.totalChanges > 20}>

<Sample>

You are reviewing a TypeScript PR for EXTRANEOUS code only.

PR: {pr.meta.title}
Description: {pr.meta.body}

STATIC ANALYSIS SIGNALS:
{diagnostics.summary}
Violation density: {diagnostics.density} per added line.

DENSITY CALIBRATION:
- Below 0.020: clean — experienced contributor, reviewed code
- 0.020–0.080: normal — minor issues, typical development
- Above 0.100: elevated — likely unreviewed generated code
Adjust judgment based on specific patterns, not number alone.

INTERPRETATION RULES:
- A few inferrable-type warnings in a large PR are noise.
- Clusters of unused-vars + empty-functions + unnecessary-type-
  assertions in the SAME FILES suggest unreviewed generated code.
- Files with both high comment density AND multiple Oxlint
  structural violations are the strongest slop signal.

Report ONLY:
1. Scope creep — changes unrelated to stated purpose
2. Speculative abstractions — fewer than 3 consumers (Rule of
   Three: don't abstract until third use)
3. Dead constructs — declarations never referenced in diff
4. Wrapper indirection — functions that only forward calls
5. Signal clusters — files where multiple Oxlint rules fire
6. Object literal assertions — `{} as Type` hiding missing props

Do NOT flag test helpers, exported types, or style preferences.

For each finding: FILE, PATTERN, CONCERN, QUESTION for author.

If clean: "No extraneous code patterns detected."

DIFF:
{pr.diffPreview}

</Sample>

</Show>

</ReviewSection>
