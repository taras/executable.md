An unhandled `<Parse>` failure should fail document execution, so a rejected
value cannot leave `xmd run` or a REPL entry reporting success. Authors who want
to inspect invalid input and continue use `<SafeParse>` or an explicit error
recovery boundary.

## Reproduction

Save this as `parse-failure.md` and run `xmd run parse-failure.md`. No agent or
external input is involved.

```md
<Output>
Before invalid ballot.
<Each in={["Mara"]} let="name">
<Parse schema={{ type: "object", properties: { worry: { type: "string" } }, required: ["worry"] }} as="ballot">
{}
</Parse>
<Json value={ballot} />
</Each>
After invalid ballot.
</Output>
```

The value is missing the required `worry` field. Replacing `{}` with
`{"worry":` exercises malformed JSON instead. Both should fail the document.
Replacing it with `{"worry":"winter"}` is the successful control.

## Current gap

Both invalid cases leave a settled REPL entry whose saved terminal status is
`ok`. The execution operation also completes successfully. Parse's diagnostic
becomes printed error text rather than an unhandled failure; the subsequent
read has no validated `ballot` binding.

Core's `Parse.ts` declares its function with `printErrors(...)`. That installs a
printing boundary around its own validation failure. The REPL forwards Core's
recorded outcome; changing a REPL badge would leave the underlying outcome wrong.

The existing Core parsing tests check diagnostic wording but do not assert
failed execution in the relevant invalid-input cases. Checking only rendered
error text therefore misses the defect.

## Acceptance

- Malformed JSON and schema-invalid input to `<Parse>` produce failed execution
  and a failed saved REPL entry when no explicit recovery handles the failure.
- Later executable work does not begin after that unhandled failure. Existing
  partial-output and cleanup behavior remain intact.
- Valid `<Parse>` input still binds the exact validated value and succeeds.
- `<SafeParse>` still returns its documented invalid-input result, letting an
  authored branch handle it and complete successfully.
- Explicit error recovery remains supported. Do not classify every printed
  error or diagnostic-looking string as a failed run.
- Normalized validation details remain available. Reopening a newly recorded
  failure does not repeat its effects or rewrite older completed outcomes.

## Evidence and scope

An agent-free REPL regression at `940249af47159a3bbd960b8ca8df3f10bb53811c`
has two failing invalid-input cases (`expected "err", received "ok"`) and two
passing controls: valid input and an explicit `<SafeParse>` failure branch.
Its original local entrypoint was
`packages/cli/tests/repl-component-error-status.test.ts`. The uncommitted probe
is preserved with the deferred reviewer evidence outside the PR worktree, so
it is not presented as a committed test or an active PR gate. The self-contained
source above preserves its reproduction.

The `Parse.ts` and `SafeParse.ts` blobs are identical on local `main` at
`e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`, PR #921's base
`79d404d04d02c3840892473b6f1b2cf540f3edd1`, and the examined PR branch at
`940249af47159a3bbd960b8ca8df3f10bb53811c`. This is a pre-existing Core defect
discovered while using the REPL, not introduced by #921.

Track and fix this independently after the current Sidekick work. It does not
block #883 or PR #921. The eventual correction should follow the parsing
contract in `specs/executable-mdx-spec.md` §6.12 and the existing failure and
recovery rules. A broad rewrite of unrelated component failure policies is out
of scope.

Related delivered contracts: #193 (`<Parse>` / `<SafeParse>`) and #249
(function-component failure handling).
