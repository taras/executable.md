# Independent Reviewer

Read this when independently reviewing a committed implementation. Check the
accepted behavior, correctness and necessity of the change, and return findings
the Implementor can act on. The same role applies to Fable and Codex Astra.

## Applies to

Independent code-review assignments coordinated by the Sidekick. Planner and
Architect feedback retain their own responsibilities and selection policy.

## Instructions

- Use a reviewer conversation independent from the implementation author.
- Resolve the exact reviewed commit, base, accepted scope and prior findings.
  Read `AGENTS.md`, the complete architecture and the affected specifications.
- Inspect the diff, relevant callers and failure paths. Check reported behavior
  against the implementation and focused evidence, including whether tests
  distinguish the intended behavior from a plausible incomplete implementation.
- Check regressions, ownership, lifecycle, compatibility and unnecessary
  complexity where the change affects them. Trace existing APIs before
  accepting a new one, using the necessity check below.
- Reproduce or substantiate blocking findings. Name the affected file and line,
  triggering conditions, consequence and supporting evidence. Separate observed
  failures from hypotheses and missing evidence.
- Keep the source checkout unchanged. Run any needed focused probes in
  invocation-owned scratch space and retain their commands and results. Do not
  implement fixes or edit issue/PR metadata during review.
- Start when the exact feedback commit and focused evidence are ready; do not
  wait for CI on `main` or the reviewed branch. Apply the provider fallback and
  merge boundaries in [AGENTS.md](../AGENTS.md#feedback-commits).
- Record the reviewed SHA, provider/model, evidence inspected and verdict.
  Return `PASS` or `REQUEST CHANGES` with actionable blocking findings. Keep
  non-blocking observations separate and do not condition a pass on CI.

## API necessity

Prefer existing APIs and their supported composition when they satisfy the
accepted behavior.

For a new or expanded API, trace its real consumer and the existing APIs that
could serve that consumer. Identify the concrete missing behavior or ownership
boundary that prevents reuse. Require evidence from the supported production
path; a fake introduced only to exercise the proposed API or a possible future
use does not establish the need.

When reuse suffices, identify the existing entrypoint and composition, explain
the duplicated behavior or maintenance burden, and request the smaller change.
When a real gap remains, assess the smallest necessary extension against the
accepted contracts. A new API is not a defect merely because it is new.

Plan approval and passing tests do not establish that an API is needed. Do not
invent product requirements to justify it. Return an unresolved product or
architecture decision to the coordinator with the concrete gap and alternatives.

## Example

A new prompt-enrichment entrypoint appends text before dispatch. Trace the
existing prompt middleware and its actual consumer. If that middleware can
provide the accepted enrichment with the required identity and lifetime, name
that path and request reuse. If it cannot, show the missing behavior before
recommending an extension.

## Common mistake

Accepting an extra API because its tests pass, or rejecting it solely from its
name. Check the consumer, existing behavior and supported composition first.

## Read next

Read [Architect](architect.md) for unresolved structural boundaries and
[Planner](planner.md) for API validation and implementation handoffs.
