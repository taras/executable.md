# U4 revision prompt

```text
You are .agents/implementor.md. Revise U4 feedback commit 2824855c742b966628bd0d467997efec46a1362b in the existing authorized agent/upstream-u4-generated-owners worktree. Planner verdict: REQUEST CHANGES.

Read the exact review and executable probe:
  /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/upstream-u4-review-2824855c/planner-review.md
  /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/upstream-u4-review-2824855c/metadata-probe.mjs

The accepted handoff and U4-1–U4-12 remain unchanged. Reproduce the probe before editing.

R1: Validate metadata and declared forms at every live generated admission path. Direct pinned observations/mutations must not bypass validation: a definition accepting only paired form currently runs <Probe />, and an invalid URL is appended as an admission before being rejected as unreadable history. Provider publication also currently accepts forms: "paired" and ["self-closing", "unknown"], because acceptedForms treats malformed values as omission or silently filters them. Only genuine omission means both forms. Refuse malformed declarations before generated admission/effects, retaining the Json composition exception and existing ordinary behavior.

R2: Fix registration's validate-then-recopy gap. A nested identity accessor returning a valid URL and then not-a-url is currently registered successfully with the invalid value. Capture once into owned data, validate and retain that same data; or reject the accessor-shaped input consistently. Commit a focused regression and preserve all-or-nothing batch installation. Check matching metadata-construction paths for this same defect without broadening unrelated APIs.

R3: Supply the frozen U4-7 positive independently loaded provider case. Existing loaded-copy suites protect foreign Syntax/Evaluate implementations but never have independently loaded provider code call the handed request.answer(definition). Add that case to the selected Deno-only suite, proving invocation/output and the current URL record; keep existing refusal cases.

Add discriminating regressions to the existing selected suites, with valid controls and no admissions/body effects on refused input. Run reversible controls proving the assertions fail when these defects return. Update component-answers.ts's stale header/member descriptions to answer(definition) and origin-as-provenance.

No new public protocol, registry, dependency, compatibility schema or U5 work is authorized. The current fixed record marker and per-form schema choices need no redesign for this feedback.

Rerun affected evidence and the frozen feedback commands for the resulting revision. Commit promptly when they pass, and return exact signed SHA/tree/base, clean status, row map, commands/results and first failure/control output. No repeated implementation authorization is required for these corrections.

Do not push, open a PR, inspect CI, clean up preservation refs/worktrees, or modify the immutable prerequisite preservation copy. U5 and #902 remain held.
```
