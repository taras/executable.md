---
inputs:
  pr:
    type: object
    required: true
  diagnostics:
    type: object
    required: false
  doctor:
    type: object
    required: false
---

<ReviewSection heading="Semantic" clean="✅ Small PR — semantic review skipped.">

<Show when={pr.stats.totalChanges > 20}>

<Sample>

You are reviewing a TypeScript PR for EXTRANEOUS code only.

PR: {pr.meta.title}
Description: {pr.meta.body}

<Show when={!!diagnostics && !!diagnostics.summary}>

STATIC ANALYSIS SIGNALS:
{diagnostics.summary}
Violation density: {diagnostics.density} per added line.

Interpret these signals in context. A few inferrable-type warnings
in a large PR are noise. But clusters of unused-vars +
empty-functions + unnecessary-type-assertions concentrated in the
same files suggest unreviewed generated code.

</Show>

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

</Show>

</ReviewSection>
