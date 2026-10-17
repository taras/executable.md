# Controls and profile review at dc87c5fd

REQUEST CHANGES at `dc87c5fdf0358f40933dd66bd388c041194296de`, parent
`8b4efe911041a5769e32818347717c7f8298c4de`.

The names-array finding is closed at `80a2c4b6`. Canonical Syntax remains open;
the [subsequent review](pr2-controls-profile-planner-review-80a2c4b6.md) corrects
the implementation direction to include the confirmed Core integration seam.

The thin semantic requests, intent/outcome ordering, pinned forms and accepted
passive draft-fill path fit this review section. Two syntax choices contradict
the settled contract and fail through the production profile and Core evaluator.
Neither finding depends on the future root admission gate or conversation owner.

## P1: Canonical Syntax is missing from the response ceiling

`sidekickResponseCeiling()` in `packages/cli/src/repl/sidekick/profile.ts:63`
includes only the custom observations. No canonical Syntax entry is supplied.
`repl-sidekick-controls.test.ts:269` explicitly asserts that absence, which
mistakes exclusion from designated feedback for exclusion from admission.

The accepted table in [remaining-architecture.md](remaining-architecture.md),
section 1, includes self-closing Syntax in the read class. It describes the
current response vocabulary, renders or captures its ordinary text, and is not
intercepted as automatic operation feedback. The
[syntax discovery amendment](syntax-discovery-amendment.md) preserves that
ordinary contract. Admission and designated feedback are separate decisions.

Reproduction under the submitted profile:

```xmd
<Output>
<Syntax />
</Output>
```

Core returns `GeneratedXmdRootError: a generated fragment names a component
this host did not admit.` The current profile therefore prevents the agreed
response-context syntax read altogether.

Use Core's existing canonical Syntax admission entry and reference machinery;
do not implement a CLI replacement. Include it in the derived response surface
while keeping it outside designated operation feedback. Correct the test and
prose that equate being absent with preserving an ordinary return.

## P1: The approved names-array lookup is rejected

`packages/cli/src/repl/sidekick/controls.ts:215` declares `names` as a string;
lines 218–222 split that string into names. R3f exercises this new spelling
instead of the accepted one.

The syntax amendment explicitly teaches this complete response:

```xmd
<REPL.Syntax names={["Elicit"]} />
```

The accepted architecture requires reuse of Syntax's established schema and
reference semantics. The canonical schema is an optional non-empty array of
unique strings, not a comma-separated string. The submitted control rejects
the approved source with `Prop validation failed for <REPL.Syntax />:
"/names" must be string` before the semantic request runs.

Restore the canonical names-list contract and pass the names through unchanged
to `entrySyntax`. Keep ordinary capture and designated REPL.Syntax feedback.
Replace the string-based R3f evidence with the agreed array invocation. The
bare read remains the positive control.

## Independent evidence

Working directory for both commands:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.

```sh
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
```

PASS: 13 tests, 69 steps. These include the twelve submitted R3 rows. Their
green result does not establish the two accepted syntax paths above.

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-controls-dc87c5fd.probe.ts
```

FAIL: two failed steps, one passed control. Canonical Syntax and the array
lookup fail independently; bare REPL.Syntax succeeds. The probe uses the real
submitted ceiling and Core root evaluator, with the same request/journal fixture
as R3. Its first output is preserved in
[pr2-controls-dc87c5fd.probe.log](pr2-controls-dc87c5fd.probe.log); the unchanged
source is [pr2-controls-dc87c5fd.probe.ts](pr2-controls-dc87c5fd.probe.ts).

HEAD and parent match the handback. The implementation worktree is clean.
No production files were edited; no CI or GitHub state was inspected or changed.

## Revision prompt

Correct the controls/profile slice at dc87c5fd against the already accepted
syntax contract. Admit canonical self-closing Syntax through Core's existing
entry so it describes the actual response context and keeps ordinary
render/capture behavior without designated operation feedback. Restore
REPL.Syntax's optional canonical names-array schema and pass the array unchanged
to the semantic request. Correct R3a/R3b, R3f and the accompanying prose so they
prove those contracts instead of the rejected alternatives. Run the unchanged
Planner probe and the four focused Sidekick tiers above. Commit the correction
once that evidence passes and return the exact SHA/parent and commands/results.
Do not delay this correction for the future guide assets, root gate or owner.

## Continuity

The earlier storage, projector, actual-process case-1 recovery and pure output
reviews remain accepted. This review requests correction of two implemented
syntax paths; it adds no new product behavior or architecture decision.

Root-owned Submit reservation, separate input revisions, takeover/liveness
checks and the remaining R3 and R2 cases 3/4 remain the next integration work
after this correction. Elicit/conversation ownership and the other recovery
cases remain in their planned section. The full CLI PR 2 and terminal capture
packet are incomplete. No GitHub-write authorization is added.
