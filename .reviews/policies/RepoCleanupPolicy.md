---
inputs:
  type: object
  properties:
    diagnostics:
      type: object
    doctor:
      type: object
    fileList:
      type: string
    cleanupAnalysis:
      type: object
  required: [diagnostics, doctor, fileList]
  additionalProperties: false
---

<ReviewSection heading="Cleanup Policy"
  clean="✅ No code health issues detected.">

<Show when={diagnostics.total > 0 && !!cleanupAnalysis}>

<Sample>

You are reviewing pre-scored cleanup clusters from a TypeScript monorepo.
Oxlint provided the raw signals. The system ranked files by co-occurrence
of distinct rule violations, weighted toward production code.

Your job is NOT to re-analyze diagnostics. The ranking is already done.
Your job IS to explain why each top cluster matters and what specific
cleanup action to take.

PRINCIPLES:
- Rule of Three: flag any abstraction with fewer than 3 consumers.
  Single-consumer abstractions should be inlined.
- YAGNI: flag code that exists "just in case" with no current caller.

{cleanupAnalysis.promptContext}

For each of the top 5 clusters above, produce exactly this format:

### [rank]. [file path]
- **Why**: [1-2 sentences explaining what the co-occurring signals mean together]
- **Action**: [specific verb: remove, inline, delete, extract, add try/finally, etc.]
- **Scope**: [mechanical | review-required]
- **Confidence**: [high | medium | low]

Rules:
- "mechanical" means a maintainer can fix it without design decisions.
- "review-required" means the fix depends on intent not obvious from signals.
- Do NOT restate raw counts only; focus on what to DO.
- Do NOT add items outside ranked clusters. If fewer than 5 clusters, report fewer.
- If a file is test/demo, call it lower priority unless the same pattern appears in production.

Example of a good item:

### 1. durable-streams/operations.ts
- **Why**: 4 distinct rules fire here (type assertions, empty functions, unused vars, floating promises), indicating mechanical scaffolding that was not cleaned up.
- **Action**: Remove unnecessary type assertions first, then audit empty function stubs for dead code.
- **Scope**: mechanical
- **Confidence**: high

</Sample>

</Show>

<Show when={diagnostics.total > 0 && !cleanupAnalysis}>

{diagnostics.summary}

</Show>

</ReviewSection>
