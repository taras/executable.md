# Planner review: read wiring at 68d10d7d

REQUEST CHANGES at `68d10d7dfb801baeb15af5bcc20ab60344929452`, parent
`9a9d2a041e0dfb825c7f51ef0589e83616d5f86c`, branch `agent/issue-883-pr2`.
HEAD matches, the signature verifies G for tarasm@gmail.com, and the implementation
worktree is clean. One existing Environment requirement remains unmet. The
accepted Core, admission/Pause, recovery and guide increments stay closed.

## Blocking: Environment omits the command's known active plugins

The accepted [syntax-discovery amendment](syntax-discovery-amendment.md#current-environment-inspection)
requires the active entry profile/includes/plugins to be reported when known.
`assembleReplProfile(stack, plugins)` receives the command's admitted Plugin
assembly and closes the entry vocabulary over it. However, the profile exposes
no descriptive Plugin selection to `rootReads()`. At
`packages/cli/src/repl/sidekick/requests.ts:135`, its command facts contain only
component includes and Agent permission mode.

Consequently a successfully installed, known Plugin disappears from
`<REPL.Environment />`. The closing statement treats everything unlisted as
unreported; it does not supply the known selection the contract requires.

The [focused probe](pr2-environment-plugins-probe-68d10d7d.test.ts) installs
`PlannerKnownPlugin` through production `installPlugins()`, verifies that
assembly contains it, assembles the actual REPL profile, opens a real session
over InMemoryStream, and calls the production request implementation. Only the
runtime description is controlled. No provider is called and no entry is run.

The includes/permission/runtime control passes. The active-Plugin assertion
fails: the returned snapshot contains none of the Plugin's name.
[First output](pr2-environment-plugins-probe-68d10d7d.log) is preserved.

Run from the implementation worktree:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-environment-plugins-probe-68d10d7d.test.ts
```

Carry the command's selected Plugin names as descriptive immutable profile facts
and include them in Environment, with an explicit empty selection. This restores
an accepted read contract; it introduces no product or architecture decision.
The [correction prompt](pr2-environment-plugins-implementor-prompt.md) freezes the
finite correction and feedback evidence.

## Accepted implementation and requested rulings

Bindings read the current acknowledged head. The existing projection copies and
freezes retained JSON values, and entryInitialBindings constructs the root map
from that projection. The selected historical prefix and visible Bindings pane
do not supply the reply's values. A running entry's acknowledged publication is
available before its completion.

EntryOutput combines the head's entries with the running task's own key and
observed text. A retained terminal outcome wins for its entry. This fixes the
historically pinned session's overlay attribution problem without changing the
screen's overlay semantics. Its source is the execution's public output stream,
so the read does not bypass ordinary Output buffering. The complete R4 evidence
remains assigned to the production response integration.

Entry syntax uses the existing command catalog construction and canonical
renderers over this command's includes and Plugin assembly. Guide reads use the
literal shipped loader. Contextual cwd/platform and runtime-entrypoint facts keep
the accepted host boundary. No read gains route, controller, terminal or
permission authority.

The three existing test profile adaptations are accepted: supplying the required
vocabulary through entryVocabulary changes fixture construction, not an existing
behavioral assertion. Making the host description capability optional is also
accepted. A host which supplies none reaches the Api's explicit refusal; all four
production runtime entrypoints supply their descriptive facts.

Deferring ceiling construction and response-bound submit wiring to section 4's
owner is accepted as implementation ordering. That owner supplies the exact
conversation/response identity the retained controls and reservation need.
Constructing an unused ceiling in the loop would not establish that integration.
This deferral does not close section 3, complete R3/R4/R5, or relax the frozen
criteria.

The loop's queued fill applies filled() before resolving its answer and checks
human takeover at application. The new fill row exercises the semantic request
with a transition fixture; it does not exercise the program's queue through a
live conversation. Cancellation, Stop, and fill-then-submit behavior still need
their planned production-owner integration. The current increment is not credited
with that evidence.

## Independently rerun evidence

The pasted handback contained truncated command names. This review records its
exact executed selections and their captured results.

All commands below use `deno task test` in the implementation worktree:

| Files under packages/cli/tests/ | Result |
| --- | --- |
| repl-sidekick-storage.test.ts repl-sidekick-recovery.test.ts | 9 tests, 43 steps |
| repl-sidekick-controls.test.ts repl-sidekick-output.test.ts repl-history.test.ts | 17 tests, 85 steps |
| repl-agent-journey.test.ts repl-forms.test.ts repl-source-reading.test.ts | 20 tests, 117 steps |
| cli-help.test.ts repl-layout-admission.test.ts repl-presentation-style.test.ts | 20 tests, 73 steps |
| repl-journey.test.ts repl-agent-interface.test.ts | 53 tests, 111 steps |
| repl-entries.test.ts repl-composition.test.ts | 30 tests, 116 steps |

Total: 149 tests/645 steps, zero failures. Logs are
`pr2-reads-review-68d10d7d-{storage,reads,consumers,layout,journey,additional-consumers}.log`.
The separate Environment probe has one passing control and one failing step.
No production mutation, full suite or CI result informs this verdict.

## Continuity and next action

Reviewed base is 68d10d7d, above accepted 9a9d2a04. Correct the single Environment
finding and return a focused feedback commit before beginning the owner slice.
Preserve the accepted read behavior, fixture adaptations and sequencing ruling.
No new scenario matrix is assigned.

After acceptance, section 4's conversation owner also binds the deferred
section 3 ceiling and response requests, then completes the remaining R3/R4/R5
integration and R2 cases 2/5/6. R2 cases 1/3/4 remain accepted. Section 5's flags,
terminal integration and 36-frame packet remain incomplete. PR 2 remains in
progress and unpushed. This review changes only Planner artifacts.
