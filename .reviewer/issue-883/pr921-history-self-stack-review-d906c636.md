# History stacks over itself and makes Close appear ineffective

Confirmed at d906c6360533aaf894f5424dd4689aceedf08c3b in the PR #921
implementation worktree. No implementation changes were made by this diagnostic.

The supplied location contains seven consecutive `/+history` segments. The
decoder preserves seven History drawers. Only the innermost drawer is drawn.
Closing it removes one route member, leaving six identical drawers; the frame
still says History and still shows Close. This makes a working Close action
look like it did nothing.

The product can create this location itself. The footer's History control stays
available inside the History modal (application.ts:5804), and open-drawer always
appends to the existing stack when the surface stays the same
(application.ts:1859). Close removes exactly one member
(application.ts:1904). There is no same-History guard or visible stack-depth cue.

The mounted probe `pr921-history-self-stack-probe-d906c636.test.ts` drives the
real program and both pointer controls. Seven History activations followed by
one Close retain six `/+history` segments and leave the modal visible. The
one-opening control closes to zero. No prompt is sent in either arm.

```text
opened  closes  drawers left  History still visible  agent prompts
7       1       6             yes                    0
1       1       0             no                     0
```

Command, from .claude/worktrees/issue-883-pr2:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr921-history-self-stack-probe-d906c636.test.ts
```

Result: 1 passed, 2 steps, zero failures. First output is preserved in
`pr921-history-self-stack-probe-d906c636-first.log`.

Immediate recovery: press Escape once per retained History drawer (seven from
the supplied location, fewer if some were already closed). Alternatively remove
only all seven `/+history` path segments before reopening; keep the complete
query, including draft, unchanged. The `at=entry-4:close:root&inspect` members
still select a frozen entry position after the drawer is gone; returning to the
head is the separate Live action.

Correction boundary: opening History while that same History drawer is already
presented must not push another identical modal. The existing repeated-drawer
locations also need an explicit recovery policy rather than an invisible stack
of indistinguishable screens. Preserve opening History from other drawers,
their return paths, the frozen position, both composers and no-agent/no-write
behavior. This diagnostic does not choose a codec rewrite or a new close-all
action on the user's behalf.

The supplied execution was not present at this machine's default macOS data
path. I did not run its draft, reopen its live history or contact its agent.
The reproduction uses the existing isolated mounted fixture, not the user's
stored conversation. The local installed `xmd --version` reports 0.13.0; the
verified source revision is the PR worktree stated above.

At the final status check, independent uncommitted Bindings-padding changes had
appeared in application.ts and repl-presentation-style.test.ts. Their source
hunk is confined to sidekickBody(), below the History paths examined here.
Those changes were left untouched; the History open/close implementation remains
the head revision's. This diagnostic makes no clean-worktree claim at handback.
