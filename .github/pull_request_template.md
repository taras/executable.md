## Why

<!-- What problem does this solve, and who or what is affected? Keep this brief. -->

## What changes

<!-- Describe the observable difference between the old and new behavior. -->

Before:

<!-- What happened previously? -->

After:

<!-- What happens with this change? -->

## How it works

<!--
Explain the path from entry point to result. Focus on behavior and relationships,
not a file-by-file summary. Delete this section when the change is self-explanatory.
-->

```text
<entry point> → <main behavior> → <result>
```

## Review guide

<!-- Delete this section when the change is small. -->

**Start with:** `<file, test, or symbol>`

**Then review:**

1. `<public behavior or contract>`
2. `<main implementation>`
3. `<state, lifecycle, persistence, or other sensitive behavior>`
4. `<supporting changes>`

**Look carefully at:**

- `<important error, concurrency, compatibility, or cleanup behavior>`

## What must stay true

<!--
List important rules this change must preserve, how they are enforced, and how
they are verified. Delete this section when ordinary correctness is sufficient.
-->

- `<Rule>` — enforced by `<mechanism>` and checked by `<test>`.

## How to verify it

<!--
Describe what each important test proves and what plausible defect it would
catch. Include a manual command or procedure when useful.
-->

- `<Scenario>` proves `<expected behavior>` and fails if `<plausible defect>`.

## Scope

### Included

- `<Behavior included in this PR>`

### Intentionally unchanged

<!-- Mention related behavior that might otherwise look accidentally omitted. -->

- `<Related behavior deliberately left unchanged>`

## New abstractions

<!-- Delete this section when none are introduced. -->

- `<Type, interface, or helper>` exists because `<concrete need and consumers>`.
- [ ] Each new abstraction has multiple concrete uses or a clear justification.
- [ ] No speculative functionality is included.

## New dependencies

<!-- Delete this section when none are introduced. -->

- Package: `<name and version>`
- Used for: `<specific purpose>`
- Why existing dependencies are insufficient: `<reason>`

## Generated or mechanical changes

<!--
Delete this section when not applicable. Identify files reviewers can skim and
the source that generated them.
-->

- `<Generated file>` comes from `<generator or source>`.
- `<Mechanical change>` contains no intended behavior change.

## Risks and limitations

<!--
State known limitations or areas needing careful review. Do not hide work
required for this PR as a follow-up. Delete this section when not applicable.
-->

- `<Risk or limitation>`
- Recovery or rollback: `<procedure, when relevant>`

## Scope confirmation

- [ ] Every changed file supports the purpose described above.
- [ ] Unrelated cleanup and formatting changes are excluded.
- [ ] Generated or mechanical changes are clearly identified.
- [ ] The description matches the final diff and test results.
