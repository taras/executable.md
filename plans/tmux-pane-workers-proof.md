# Persistent tmux pane workers for `<Terminal.Grid>` — proof report (#726)

**Decision recommended for #717: adopt the persistent pane-worker topology,
with the lifecycle contract narrowed as stated under _What teardown can and
cannot prove_.** Readiness, pane display, sequential reuse, job control,
reader-close detection and ordered teardown all hold; complete teardown is
provable for everything except a descendant that has left the pane's session
_and_ closed the pane's terminal _and_ outlived its parent, which no parent
process can name without operating-system containment.

## The run

| | |
|---|---|
| evidence commit | `b0fcee9f` (this branch, `spike/tmux-pane-workers`, base `a7f60c02` on `main`) |
| host | macOS `darwin 25.5.0`, `arm64` |
| tmux | 3.6a |
| Deno | 2.9.5 (stable, release, aarch64-apple-darwin) |
| command | `deno task proof:tmux-pane-workers --out <dir>` from a prepared checkout |
| result | 8/8 checks, 115 claims, `plans/tmux-pane-workers-evidence.json` (IPC tokens redacted; the pane ids, tty names, pids and socket paths in it belong to that one run and to nothing durable) |

The proof is `scripts/proofs/tmux-pane-workers/`. It ships nothing in the
binary. Run it unattended (it starts a throwaway outer tmux session of its own
so the visible attachment has a terminal), or run `deno task
proof:tmux-pane-workers -- --attach` to watch the journey on your own terminal
and close the grid yourself. `--only <check>` runs one check; `--runs N` sets
the measurement runs per pane count.

## The topology, as proven

```
xmd (parent)                                  private dir, mode 0700, short path
 ├─ pane sockets: one Unix socket + one 0600 token file per pane
 ├─ tmux server (-S <dir>/s -f /dev/null), hidden until attach
 │    └─ window: explicit row-major layout from `columns`
 │         └─ pane N: worker.ts N <dir>      ← session leader on the pane pty
 │              └─ interactive child          ← inherits the pty, same pgrp
 ├─ control client (tmux -C attach -f no-output)   %client-detached / %exit
 └─ visible client (tmux attach, stdio inherited)  the reader's view
```

Each pane's initial process is a persistent worker that tmux starts and that
owns the pane's terminal until shutdown. The worker connects to its pane's
socket, proves which pane it is with the token it read and removed, and then
serves: `display` (write bytes to the pane), `launch` (start one child that
inherits the terminal), `cancel`, `shutdown`. It never reads the terminal.
Command vectors, working directories and environments travel only over that
socket; tmux's command parser sees `deno run --allow-all worker.ts <ordinal>
<dir>` and nothing else.

Observed relationships (journey check, `hellos` and child evidence files):

- every worker: `pid == pgid`, `ppid == tmux server`, tty == `#{pane_tty}`
  for its pane, stdin/stdout/stderr all terminals;
- every interactive child: same tty as its worker, `pgid == worker pid`,
  all three streams terminals;
- the default shell (`/bin/zsh`): moved itself into a process group of its own
  and took the foreground (`tpgid == shell pgid`), put `sleep 300 &` in yet
  another group, `fg` made that group the terminal's foreground group, `^Z`
  suspended it — ordinary job control, observed through `ps -o tpgid`, not
  inferred from what the shell printed.

## Acceptance items

| acceptance item | check | result | how it was observed |
|---|---|---|---|
| workers and children on the expected pane terminal; shell has job control | journey | holds | `isatty` ×3 and tty name vs `#{pane_tty}` for 4 workers and 5 children; `ps -o pgid,tpgid` before/after `sleep &`, `fg`, `^Z` |
| missing executable never acknowledges readiness; `exit 1` acknowledges then reports 1 | readiness-boundary | holds | `/definitely/missing` → `startup-failed`, no `ready` in the pane's event log; `--mode exit1` → `ready` then `exited {exitCode: 1}`, in that order; the pane and worker pid unchanged across both |
| argv bytes unchanged | journey | holds | `["a b", "\"quoted\"", "$HOME", "x;y", "`z`", "new\nline", "it's", "#{pane_id}"]` sent over IPC, read back byte-identical from the child's evidence file |
| pane text before and after a child, not as its input; child bytes never through the parent | journey | holds | prelude/epilogue `displayed` acks; child's recorded stdin holds only the typed lines; the control client received no `%output` line (it attaches `-f no-output`); the parent reads pane content only through `capture-pane`, as evidence |
| two sequential children in one pane; concurrent second refused; distinct panes concurrent | journey | holds | child A exits 3, epilogue, child A2 `ready` on the same `#{pane_id}` and worker pid; `A-dup` → `refused busy`; A and B typed into concurrently |
| 2×2 and 5-pane `columns={2}` row-major at different sizes; no `tiled` | layout-geometry | holds | 4@2, 5@2, 8@3 at 80×24 and 200×60; `list-panes` geometry checked pairwise (below / right-of); the last short row spans its width; `tiled` recorded beside each for contrast |
| attach only after every pane is ready; startup failure exposes no grid and tears everything down | journey, startup-failure-atomic | holds | attach issued after all four `ready`; with pane 2 launching a missing executable, no attach, and the three started children, four workers and the server are all unreachable afterwards |
| detach ≠ control loss ≠ server stop; none ends pane work | signals-distinct | holds | `%client-detached <tty>` names the visible client, children keep running; detaching the control client ends its stream with `%exit` while `has-session` still answers and workers stay connected; `kill-server` closes every worker link and SIGHUPs workers and children |
| reader close and parent cancellation: stop launches, cancel children, await quiescence, stop the server, remove private paths, restore the terminal | journey, cancellation-points | holds | ordered teardown; every pid unreachable; `stty -g` identical before and after; halts at prepared / workers / ready / attached / active each leave server, workers, children gone and the private directory removed |
| negative children: ignore the interrupt and fork; escape the group | negative-children | holds, with a recorded limit | see _What teardown can and cannot prove_ |
| timings for 2, 4, 8 panes over 20 runs | measurements | measured | table below |
| cancellation at preparation, readiness, attachment, active child; one named scope and finalizer per resource | cancellation-points | holds | the ownership diagram below is the code's resource structure |

## What teardown can and cannot prove

The interactive-process resource escalates SIGINT → 2 s → SIGKILL on the
child, then reaches what the child left behind from a snapshot taken _before_
the first signal: the child's descendants by parent links, plus every member
of the pane's process group other than the worker. At shutdown the worker
additionally lists every process still holding the pane's terminal (`lsof -t
/dev/ttysN`) and kills it. Outcomes, with ground truth from the children's own
records of the pids they forked:

| descendant | found by | stopped |
|---|---|---|
| in the inherited process group, parent ignoring SIGINT (`sh -c "trap '' INT; exec sleep 600"`) | ancestry and group snapshot | yes (`method: killed`) |
| `setsid()` away, terminal still open, parent alive at cancel | ancestry snapshot | yes |
| `setsid()` away, terminal closed, parent alive at cancel | ancestry snapshot | yes |
| `setsid()` away, terminal still open, **parent already exited** (reparented to launchd) | worker's shutdown terminal sweep | yes |
| `setsid()` away, terminal closed, **parent already exited** | nothing | **no** — recorded, then killed by the check from the child's own record |

Two facts fix where each sweep has to live:

- once the worker exits, tmux marks the pane dead and closes the pty master,
  and macOS revokes the slave; after that `lsof` names nobody. A provider-level
  sweep before `kill-server` found nothing. The terminal sweep is the
  worker's, at its own shutdown, while it still holds the pane open;
- a descendant's parent link is gone the moment the parent exits, so the
  ancestry snapshot must precede the first signal, and a child that exits on
  its own is swept then, before `exited` is reported — `exited` is what makes
  the pane free, and a sweep running beside a new child would reach that child
  too (they share the group).

So the contract #717 can carry is: **teardown proves that nothing remains in
any pane's process group, nothing is a descendant of any child that was alive
when teardown began, and nothing holds any pane's terminal.** A process that
has left the session, closed the terminal and lost its parent is outside every
fact a parent process can observe on this platform; the contract should say
that boundary rather than claim more. A PID, a timeout or the visible client
leaving is not treated as any of it.

Cancellation during provider preparation has one unprovable window of its own:
between `tmux new-session` forking the server and that server listening, a
`kill-server` finds nothing to kill. The proof's "prepared" cancellation lands
after the first pane exists (the server is up), which is the earliest point a
halt can be proven complete; the window before it is recorded here rather than
tested.

## Measurements

Medians with (min–max) over 20 runs per pane count, milliseconds, on the host above. Each run is one complete lifecycle: hidden server and layout, workers connected, every child's `spawn` event, visible attach, `detach-client` issued and `%client-detached` observed, then cancel, shutdown, `kill-server`, and every pid proven unreachable.

| panes | server + layout | workers connected | all children ready | attach | reader-close detected | teardown |
|---|---|---|---|---|---|---|
| 2 | 322 (269–1858) | 439 (371–2046) | 442 (374–2054) | 46 (33–163) | 34 (27–50) | 895 (826–1098) |
| 4 | 624 (451–1519) | 762 (526–1637) | 767 (529–1641) | 86 (44–215) | 41 (28–129) | 1835 (1578–3239) |
| 8 | 1053 (840–3225) | 1153 (969–3225) | 1159 (975–3253) | 106 (68–848) | 44 (30–220) | 3889 (3342–5045) |

The first three columns are cumulative from the start of the run; attach, reader-close detection and teardown are each measured from their own trigger. Startup is Deno starting one worker per pane (the child `spawn` event follows the workers by tens of milliseconds, because readiness is the spawn, not the child's own startup). Teardown is dominated by the worker's terminal-holder sweep — `lsof -t` costs about 0.4 s per pane on this host and contends when eight run at once — plus the 500 ms settle window after SIGKILL; the interactive children here exit on SIGINT at once. No pass threshold is proposed; these are the numbers.

## Findings a Planner should not have to rediscover

1. **tmux hands panes to layout leaves in window-list order and ignores the
   pane ids written in a layout string.** Authored order is imposed afterwards
   with `swap-pane`; the explicit layout string sets the cells. The first
   attempt came out column-major.
2. **A missing executable is a live pane to tmux.** Multi-argument pane
   commands run without a shell and leave `pane_dead_status=1`; a single
   argument goes through `sh -c` and leaves 127. Both have a `pane_pid`. The
   `spawn`/`error` events of `node:child_process` are the readiness boundary,
   and `exited` is separate from it.
3. **Attach-client exit codes do not classify a close**: 0 after
   `detach-client`, 0 after `kill-session`, 1 after `kill-server`. The
   control-mode client does (`%client-detached <tty>`, `%sessions-changed`,
   `%exit`, EOF), and `-f no-output` keeps pane bytes out of it.
4. **Effection's `main()` binds SIGINT to its own shutdown (exit 130).** A
   pane worker, and any child that must survive `^C`, has to be started with
   `run()`; the first journey run lost its worker to the first `^C`.
5. **The worker must ignore SIGINT, SIGQUIT and SIGTSTP with handlers**, since
   it shares the pane's foreground process group with the child; handlers are
   reset across `exec`, so the child still gets defaults. `detached: true`
   would break job control and is not an option.
6. **Unix socket paths are limited to 104 bytes on macOS.** The private
   directory lives directly under `$TMPDIR` (49 characters here).
7. **The tmux socket file outlives the server**; "gone" is the server pid
   unreachable and `has-session` refusing, not the file's absence.
8. **The visible client must be asked to detach before it is signalled.** A
   SIGKILLed `tmux attach` cannot restore the terminal; the attach resource
   registers `detach-client` ahead of the process escalation, which took
   attached-phase teardown from ~2.3 s to under 0.5 s.
9. **A parent that dies of SIGHUP orphans the hidden servers.** The proof turns
   SIGHUP into SIGTERM so `main()` tears down; the same applies to `xmd run`
   losing its terminal while a grid is up.
10. The default shell needs ~1.5 s to read its rc files; readiness is the
    shell process, not its prompt.

## Resource ownership

```
proof scope
└─ workspace (resource)
   ├─ private directory ─────────── ensure: rm -rf
   ├─ pane sockets (resource) ───── ensure: destroy connections, close servers
   │    └─ admission task per connection (halted with the scope)
   ├─ tmux grid (resource) ──────── ensure: kill-server, wait for pid + has-session
   │    ├─ control client (exec in a spawned task; SIGTERM on halt)
   │    └─ visible client (interactive-process resource)
   │         ├─ ensure: detach-client, wait for the client to leave
   │         └─ ensure: SIGINT → SIGKILL → descendant sweep
   └─ reader task per pane (halted with the scope)

worker (tmux pane process, own program)
└─ run()
   └─ per launch: spawned task
        └─ interactive-process resource ── ensure: SIGINT → SIGKILL → snapshot sweep
   shutdown: quiesce → terminal-holder sweep → bye → exit
```

## The smallest interfaces the evidence supports

```ts
// The pane worker protocol (over an invocation-private Unix socket).
type ToWorker =
  | { type: "display"; seq: number; text: string }
  | { type: "launch"; id: string; argv: string[]; cwd: string; env: Record<string, string> }
  | { type: "cancel"; id: string }
  | { type: "shutdown" };
type FromWorker =
  | { type: "hello"; ordinal: number; token: string; pid: number; pgid: number; tty: string; isatty: [boolean, boolean, boolean] }
  | { type: "displayed"; seq: number }
  | { type: "ready"; id: string; pid: number }            // the spawn event, nothing earlier
  | { type: "startup-failed"; id: string; reason: string } // the error event; never after ready
  | { type: "refused"; id: string; reason: "busy" }
  | { type: "exited"; id: string; exitCode?: number; signal?: string } // after the pane's sweep
  | { type: "quiescent"; id?: string; proof: QuiescenceProof }
  | { type: "bye"; ttyHolders: { pid: number; gone: boolean }[] };

// The interactive child, derived from packages/runtime/launcher.ts.
interface InteractiveProcess {
  ready: Operation<Result<number>>;   // Ok(pid) on spawn, Err on error
  exited: Operation<{ exitCode?: number; signal?: string }>;
  stop(): Operation<QuiescenceProof>; // idempotent; also the scope's ensure
}
interface QuiescenceProof {
  method: "exited" | "interrupted" | "killed";
  childGone: boolean;
  descendants: { pid: number; inGroup: boolean; delivery: "delivered" | "absent" | "refused"; gone: boolean }[];
  survivors: number[];
}

// The provider seam core would own.
interface TerminalGridProvider {
  prepare(layout: { columns: number; panes: number }): Operation<PreparedGrid>; // hidden; workers connected
  attach(grid: PreparedGrid): Operation<VisibleClient>;                         // after every pane is ready
  close: ControlEvents;                 // client-detached | control-lost | server-stopped, kept distinct
  stop(grid: PreparedGrid): Operation<StopProof>;                               // server pid gone, socket unreachable
}
```

Nothing tmux-specific crosses those boundaries: socket paths, session and
pane ids, client names and the server pid stay inside the provider, and appear
in this report's evidence only because a proof records them.

## Decision for #717

Adopt the persistent pane-worker topology. The Planner can take the measured
lifecycle boundary above and the interfaces as the shape of the work. The
Architect should narrow the lifecycle contract's teardown claim to what the
table under _What teardown can and cannot prove_ supports — group, ancestry
at teardown start, and terminal holders — and state the SIGHUP and
`run()`-not-`main()` obligations for the worker and the host.
