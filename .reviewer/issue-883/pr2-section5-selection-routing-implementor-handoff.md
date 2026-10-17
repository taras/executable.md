# Section 5, first increment: select the Sidekick agent and retain the view

Read this to implement the first section 5 increment after the accepted name
correction. These instructions apply to CLI and REPL host code, not to source
written in a Sidekick response or REPL entry.

Implement from accepted signed
`6e3a7b37de43e66d99c8ff9836e6f7e2fa3dd969`, parent 68547603, on
agent/issue-883-pr2. The implementation worktree is clean, with nothing in
flight. This is a bounded implementation assignment under the accepted section
5 contract, not an implementation PASS or permission to deliver the complete PR.

This assignment supersedes the earlier correction prompts' section 5 hold only
for the work below. Push, GitHub mutation and CI inspection remain outside the
assignment. Creation-policy compatibility remains separately with the Architect;
do not invent its value, retention or comparison, or declare R2 complete.

## Outcome and boundary

The command accepts the settled Sidekick-specific agent flag, and a printed
location can retain the independent selected reading and right tab. These are
preparation for the mounted Sidekick surface. This increment does not mount that
surface, acquire a conversation owner or claim terminal interaction evidence.

The accepted flag is **--sidekit-agent**, not --sidekick-agent. This spelling is
explicit in architect-handoff.md section 8, core-interfaces-proposal.md's agent
member, remaining-architecture.md J9 and planner-handoff.md section 5. It is not
an invitation to add an alias.

The creation-policy ruling concerns strict continuation of an established
provider conversation. Parsing a name, retaining it as command data, and reading
or writing a location make no provider continuation. They can therefore proceed
without choosing that policy. Existing accepted owner behavior stays closed.

## 1. Parse and carry the independent agent selection

Extend cli.ts's replConfig, REPL_VALUES pre-parser, help and diagnostics with
--sidekit-agent <name>. Support the value forms already supported for the
existing valued REPL options. A missing or empty explicit value refuses before
history paths, terminal acquisition or provider work. Preserve the value as an
agent name; do not turn it into a shell command or probe its availability here.

Fresh Sidekick selection is the explicit flag, then contextual DEFAULT_AGENT_NAME,
then ACP's existing package default. An explicit --default-agent remains the
entry Agent default and never becomes the Sidekick fallback. Both still use the
one selected --agent-provider. Preserve the shared permission flags and their
current exclusions. No entry permission setting grants a native Sidekick tool.

Carry the resolved Sidekick name as immutable command/profile data to the
runReplProgram boundary, separately from the entry stack's default. This is a
name, not a provider, installation authority, route field or durable selection.
Use the existing contextual environment API and package default; do not repeat
their values in a new catalogue or use runtime-specific environment access.
The ordinary helper and parameter structure remains delegated. Keep the actual
CLI-to-profile-to-program connection reviewable, rather than testing a helper
whose answer the command discards.

No second provider stack or Sidekick installation policy is introduced in this
increment. Resolve no agent command, inspect no options and open no session as
a consequence of parsing or profile assembly. Availability belongs to explicit
Sidekick work in the later mounted integration. On reopen this command data
does not override the history's active conversation agent; the accepted owner
already enforces that rule, and its saved-agent control stays unchanged.

Adapt existing manually constructed profile fixtures mechanically if carrying
the name changes their shape. Report those edits. Preserve every behavioral
assertion; no fixture may silently change which agent its established owner uses.

## 2. Retain the independent location choices

Extend route.ts's existing codec with optional view=sidekick and
right=bindings|sidekick. Keep the entries/sessions path surface: it remains the
saved left surface, rather than adding a third path spelling.

An omitted view selects the existing surface; an omitted right means the
Sidekick tab when presentation is integrated. Preserve those omissions in the
codec so old locations round-trip byte-for-byte. Preserve the canonical order
of all existing query members, then append view and right in that order when
present. Refuse unknown, empty or duplicate values through the existing route
grammar. These fields carry no agent, provider, request or focus authority.

Carry the members through initial state, stateFor, navigation and the printed
reopen location without altering entry/scopes, History position, inspection,
draft or conversation filtering. New sessions have no explicit Sidekick reading;
the later narrow layout will therefore begin on Entries. Resize does not rewrite
either member. Sidekick question and Configure drawers remain process-local;
add no location spelling for them.

At the state/reduction boundary, preserve the accepted transition rules:

- Selecting Sidekick sets view=sidekick and right=sidekick while preserving the
  saved entries/sessions surface, entry/scopes and History.
- Selecting Entries or Sessions clears view and selects that surface.
- Selecting Bindings sets right=bindings and clears an explicit Sidekick reading
  back to the saved surface.

Use the existing typed semantic-action and immutable state path for these
transitions. Local action/helper names remain delegated. This increment prepares
those state transitions; it does not bind invisible controls or claim focus for
a body that is not mounted. No presentation store, dispatcher or renderer is added.

## 3. Keep the mounted integration together

Do not acquire useSidekickOwner in program.ts merely to create an unused call
site. Its acquisition, immutable reading, live updates and actual message action
will land together with the mounted Sidekick surface in a subsequent assignment.
The already accepted rootReads, fill queue, admission reservation and response
ceiling are not rewritten here.

Do not create repl-sidekick-presentation.test.ts solely to house codec tests.
R8 requires the real mounted tree, commit and grid; its destination will be used
when that boundary exists. This increment supplies part of R7 and the location
preconditions for R8. It completes neither row. The 36-frame packet, mounted
R5/R6/R7, pane-local drawers, Configure, Send/Stop, focus and Exit/Control-C
integration remain outside this increment.

## Frozen evidence

Use the existing test destinations. These representative observations and the
code-review checks below are the finite threshold; no new permutation or crash
matrix is assigned.

| Observation | Evidence destination |
| --- | --- |
| Real CLI help names --sidekit-agent independently of --default-agent. A nonempty value is accepted in the existing valued-option forms; missing and empty values refuse with the flag's diagnostic before terminal/history effects. Existing shared options and the one-location grammar retain their claims. | cli-help.test.ts; extend its real command subprocess cases |
| Fresh selection uses an explicit Sidekick name independently of a different entry default; without it, the contextual environment wins; without either, the exported package default wins. The production selection/assembly result retains the independent name. No session or options call is needed. | repl-sidekick-configuration.test.ts; production selection/assembly with contextual test environment |
| An existing location keeps its exact spelling. A location carrying view and right round-trips with the existing draft, History and session fields. Invalid and duplicate new members refuse. | repl-route.test.ts |
| State transitions implement explicit Sidekick selection, return to the saved surface through Bindings, and Entries/Sessions selection without losing the entry, History or draft. Fresh state has no explicit Sidekick reading. | repl-route.test.ts using the existing application reduction fixtures |
| The current saved-agent reopen control remains unchanged. No new creation-policy behavior or terminal claim is substituted for it. | existing repl-sidekick-configuration.test.ts control |

Code review traces the real command's parsed value through immutable assembly
to program input, independent of entry --default-agent. It also checks that no
owner/provider is started, route members survive existing navigation/encoding,
and no hidden body gains a focus or input target. Codec/reducer evidence is not
reported as mounted focus or cold-provider integration evidence.

Run exactly these focused commands from the implementation worktree:

```text
deno task test packages/cli/tests/cli-help.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts
deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-history.test.ts
deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts
```

The last command preserves the existing live route, printed reopen location and
mounted entry/focus consumers of application changes. This slice needs no PTY
capture, full suite, lint, typecheck or CI prerequisite for feedback. If it cannot
be delivered within the stated data/codec boundary, return the concrete conflict
before broadening it; do not change accepted journey expectations to fit it.

Align the affected cli.ts documentation, specs/repl-spec.md and architecture.md
with implemented flag/selection and location semantics. State the implemented
behavior in present tense, and make no claim that Sidekick terminal controls are
already mounted. No guide/chapter rewrite or terminology registry addition is assigned.

## Feedback and continuity

Commit promptly once the frozen evidence passes. Return exact signed SHA,
parent, branch, clean/dirty status, every focused command and result, mapping of
the observations above, and any mechanical fixture adaptations. Preserve first
failures and report environment restrictions separately. Stop for Planner review
before starting the mounted surface or a new recovery correction.

Exact base and latest accepted correction: 6e3a7b37. Produced artifact: this
handoff, linked from planner-handoff.md. The flag spelling, independent name
selection, route semantics and UI ownership are already accepted; this handoff
opens their first section 5 increment and narrows its evidence. Creation-policy
compatibility remains with the Architect. R2 and the complete CLI slice remain
incomplete. No production code changed while planning; no push, GitHub write,
CI inspection or memory restructuring is authorized.
