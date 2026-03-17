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
