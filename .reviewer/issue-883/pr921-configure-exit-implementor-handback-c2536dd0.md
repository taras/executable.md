# Configure closes with Escape, and says scroll

Implementor handback for
[the Configure exit handoff](pr921-configure-exit-planner-handoff-6ca23952.md),
based on the reviewed silent-reply successor `2ac3cb28`. The preserved probe
passes unchanged and both assigned selections are green. Nothing pushed,
nothing rebased.

## The successor

```
SHA     c2536dd0494d0744d9af851c9bd60dd06f607e32
parent  2ac3cb28778c19d25c2b98e540469c2aa9e9b784
tree    cc39e06b5b36b49421fa3f96ed22576de44db5c5
sig     G, tarasm@gmail.com
subject 💄 Close the REPL's Configure drawer with Escape, and say scroll (#883)
```

Worktree clean, nothing untracked. `agent/issue-883-pr2-main-integration` now
`c2536dd0`. Every safety ref unmoved — `agent/issue-883-pr1-main-integration`
`85da74b9`, `agent/issue-883-pr1` `79d404d0`, `agent/issue-883-pr2` `d4b0e326`,
`agent/issue-883-pr2-isolated` `99c27d92`,
`pre-integration/issue-883-pr2-d4b0e326` `d4b0e326` — and `2ac3cb28`,
`6ca23952` and `85da74b9` are all still reachable from this head.

## Results

| Command | Result |
| --- | --- |
| 1 — the preserved probe, unchanged | **1 passed (2 steps), 0 failed**, exit 0 ([log](pr921-configure-exit-cmd1.log)) |
| 2 — sidekick configuration, presentation, lifecycle | **37 passed (144 steps), 0 failed**, exit 0 ([log](pr921-configure-exit-cmd2.log)) |
| 3 — repl journey, forms, layout-admission | **55 passed (139 steps), 0 failed**, exit 0 ([log](pr921-configure-exit-cmd3.log)) |

`deno task check` exit 0, `deno task lint` exit 0 (warnings only, dead-code gate
included, [log](pr921-configure-exit-lint.log)), `deno task validate:docs`
complete. All three were run on the committed tree.

**The source change produced exactly one pre-existing failure**, captured before
it was touched ([first output](pr921-configure-exit-cmd2-first.log)): CFG6's
many-choice scroll row, which clicks Configure's own scroll control by label.
Selection 3 was green on its first run, and the probe's Escape path went from
the recorded failure to passing with no edit to the probe.

## What changed, and where the two paths had disagreed

Three edits in `application.ts`, which is the whole production scope.

- **One frame-derived fact.** The reducer already received `presented`, the
  frame's own answer to which of the Sidekick's drawers was drawn, and already
  used it for Configure's one text destination. That local is now named
  `configuring` and carries all three decisions. The held `configuring.open`
  flag is never consulted for ownership, so a Configure behind another pane,
  another tab or a route drawer consumes nothing.
- **`closedConfigure(state)`**, extracted from the `close-configure` branch and
  called from both it and `close-drawer`. The duplicate would have been the
  defect itself: two exits that disagreed about what closing means would make
  the outcome depend on how somebody found the exit. Its body is unchanged —
  discard the unapplied choice, keep what the agent advertised, restore focus to
  the opener, write nothing.
- **`SCROLL_UP` / `SCROLL_DOWN`**, used by `drawerFor()` only while Configure is
  the presented drawer. `EARLIER`/`LATER` and the actions, their order, their
  ownership and their scrolling are untouched everywhere else, the Sidekick
  question form included.

Route-drawer precedence needed no change and is now asserted: `close-drawer`
returns early for a route drawer, and `presentedConfiguring()` already answers
`undefined` while one is open, so the first Escape pops History and the second
finds Configure presented.

## CX1–CX4 mapping

| Row | Where | Observed |
| --- | --- | --- |
| CX1 | `repl-sidekick-configuration.test.ts` Tier CFG, two arms over one body | Typed text in both composers and a real unapplied model choice, then the drawer closed — one arm by feeding Escape through the real input path, the other by Tab until the committed focus marker says `[close]` holds focus and then Enter. Each arm: the pane comes back and `[refresh]` is gone; no new chat record, no `preferences` record, `savedPreference` still none; `configCalls`, `ensured` and `prompts` all unchanged; both composers hold exactly what was typed; focus is on `[configure scribe]`; and reopening shows no `(x) Speed` and `Requested: none`, which is the discard rule observed rather than asserted of the reducer. No action is dispatched in either arm. |
| CX2 | same tier | At **120x30** with the existing 24-model fixture: the last choice is genuinely below the window, is reached through the real scroll control, is selected, and then Apply is below the window too — and `[close]` is still on screen and still reached by real Tab traversal from wherever the scrolling left focus. Closing that way saves nothing. Then the same exit with a real message **held** in flight: Configure opens over a working Sidekick (which refuses to inspect, as established — the drawer is what is waited for, not its choices), traversal passes `[stop]` without pressing it, Close closes the drawer only, the command is still running, the released turn finishes with `Done at last.`, and the draft still reads `kept draft`. |
| CX3 | `repl-sidekick-presentation.test.ts` Tier CFG | History opened over a partly edited Configure. One Escape closes History — confirmed by `[close]` leaving the pane-local rectangle — and Configure is still in the pane with `(x) Fast` still chosen. The next Escape closes Configure under its own rule: nothing saved, and reopening shows the choice gone. The draft was never the destination of either key. The existing pointer-close row beside it stays green as the control. |
| CX4 | same tier | One program, resized rather than mounted twice. At **160x36 and 120x30**: both `[↑ scroll up]` and `[↓ scroll down]` are drawn in Configure's pane *and* targetable there, neither `[↑ earlier]` nor `[↓ later]` appears anywhere in that pane, and the Sessions sidebar in the same frame still shows `[↑ earlier]` — the scope control keeping its own vocabulary is asserted in the same breath as Configure losing it. Then a real scroll each way: a choice below the window is reached through `[↓ scroll down]` and is a real choice once there, and `[↑ scroll up]` brings the list back to its first row. |

## Break-it control

Both edits reverted together, with the tests left alone:

| | Reverted | Fixed |
| --- | --- | --- |
| probe, Escape | FAILED | ok |
| CX1 Escape arm | FAILED | ok |
| CX1 Close arm | **ok** | ok |
| CX2 | FAILED | ok |
| CX3 | FAILED | ok |
| CX4 | FAILED | ok |

The Close arm passing under the revert is the point of having it: it is the
control the handoff asked for, it was already healthy, and it must not move when
the Escape path is repaired.

## Adaptations

- `repl-sidekick-presentation.test.ts` — CFG6's many-choice scroll row clicks
  `SCROLL_DOWN` instead of the literal `[↓ later]`. One label, inside Configure.
  Every other `EARLIER_CONTROL` / `LATER_CONTROL` use in that file is a chat,
  Sessions or question-form control and is untouched.
- CX2 and CX4 open Configure with a bare click rather than the tier's
  `configure()` / `openConfigure()` helper, because that helper asserts
  `[refresh]` is visible and with 24 choices it is below the window — the state
  both rows are about. CFG6 already opens that fixture the same way.
- CX4 drives two sizes by resizing one program. Two `useMountedRepl()` calls in
  one scope raise `ComponentRegistrationError: two registrations for
  "AgentProvider"`, and the sibling multi-size rows resize for the same reason.

## Not reproduced

**The reported inability to Tab to Close did not reproduce**, in the fresh probe
or in any row here: traversal reached `[close]` at 160x36, at 120x30, past a
deeply scrolled list, and with a turn in flight. I have not declared every
Configure state healthy on that basis — CX2 is the bounded overflow and busy
evidence the handoff assigned, and it found no traversal or presentation defect.
If the report came from a state none of those cover, the next step is the exact
terminal size and what was on the screen.

## Limitations

- **The pending-question interaction is covered by the existing pointer row**,
  not by an Escape-specific one. `closedConfigure` touches only `configuring`,
  `restore` and `refusal`, and `presentedAsking`/`presentedConfiguring` are
  mutually exclusive, so an Escape over Configure cannot reach a held question;
  CFG6's half-filled-question row still passes. A keyboard version would need
  that row's `Elicit` fixture, and the frozen table did not ask for one.
- **`[close]`'s reachability is asserted through real traversal, not by
  measuring its row against the window.** That is what the handoff's "real
  traversal" asks for, and it is the weaker of the two claims: it proves the
  control was reached in these states rather than that no list length could ever
  push it away. The control is mounted outside the settings window by
  construction in `drawerFor()`.

## Next

Stopping for review of `c2536dd0`. On acceptance PR2's delivery source is the
three reviewed successors — padding `6ca23952`, silent replies `2ac3cb28` and
this one — and delivery follows
[the updated handoff](pr890-pr921-final-delivery-implementor-handoff-27da762b.md):
recheck current main, rebase PR1 first, carry PR2's commits through all three,
complete the delivery gates and the EH1/UI10 obligation, and publish through
#890/#921.
