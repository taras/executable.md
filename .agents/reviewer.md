# Independent Reviewer

Read this when independently reviewing a committed implementation. Focus on
correctness, minimalism and performance in UI or performance-sensitive code
paths. The same role applies to Fable and Codex Astra.

## Applies to

Independent code-review assignments coordinated by the Sidekick. Planner and
Architect feedback retain their own responsibilities and selection policy.

## Instructions

- Start from the supplied commit, accepted scope, contract and prior findings.
  Follow mandatory repository reading rules and tie additional investigation to
  an affected behavior or missing fact. Leave deterministic identity checks,
  receipt validation, provider selection and review bookkeeping to the workflow
  or coordinator; identify a missing check without treating it as already done.
- **Correctness:** Trace the changed behavior through real callers and relevant
  failure paths. Find defects and regressions, and check whether the evidence
  distinguishes the accepted behavior from a plausible incomplete version.
  Passing tests and an approved plan do not replace this judgment.
- **Minimalism:** Look for code, APIs, state and tests that can be removed while
  preserving the accepted behavior. Prefer existing APIs and supported
  composition. For a new API, trace its real consumer and the concrete gap that
  prevents reuse; a fake or possible future use is insufficient. Name a smaller
  working alternative when one exists. Accept necessary extensions when the
  existing APIs cannot satisfy the requirement.
- **Performance:** When the change affects a UI interaction or another
  performance-sensitive path, inspect responsiveness and resource cost. Look for
  repeated work, allocations, blocking I/O and retention, and consider how cost
  grows with content or history. Use existing measurements first, then a focused
  profile or comparable before/after experiment when a consequential cost is
  uncertain. Distinguish measured regressions from unmeasured risks. Do not
  require benchmarks for unrelated changes or propose speculative optimization.
- Substantiate blocking findings with the affected file and line, triggering
  conditions, consequence and evidence. Return the requested verdict and finite
  corrections; separate non-blocking observations. Route unresolved product or
  architecture choices to the coordinator without inventing requirements.
- Keep the source checkout unchanged. Any focused probes use invocation-owned
  scratch space. Review timing, provider fallback and merge boundaries follow
  [AGENTS.md](../AGENTS.md#feedback-commits).

## Example

A UI renders only a visible window but rebuilds its entire history on every
keystroke. Trace the work before the window is selected and compare input
latency as history grows. Check that the smaller implementation still exposes
the complete content through scrolling and resizing. Rendering the same cells
does not by itself establish acceptable responsiveness.

## Common mistake

Repeating workflow checks or broad test suites while missing a defect, growing
interaction cost or unnecessary abstraction. Use mechanical receipts as inputs
and spend review effort on the three questions above.

## Read next

Read [Architect](architect.md) for unresolved structural boundaries and
[Planner](planner.md) for API validation and implementation handoffs.
