# Result: VIEW_ONLY

Issue #774 asked whether generic terminal-state convergence can make black-box
tmux input delivery reliable enough while provider session files supply
authoritative acceptance and completion. After the deterministic evidence and two
architecture reviews, the POC's decision is **VIEW_ONLY**.

- **Passive observation works.** A strict, read-only observer can follow a
  Claude session file and a Codex rollout file, match the exact native identity
  and project, advance a durable cursor only past a complete record, and refuse
  ambiguity, truncation, rotation, identity mismatch and unsupported shapes. That
  half is sound and is the reusable outcome.
- **Reliable dispatch is not established.** Terminal convergence can only ever
  authorize an attempt; it cannot guarantee one.

## The exact race

The controller samples the pane and the provider across an acknowledged barrier,
prepares the private file and tmux buffer, then takes one final combined sample
before recording `AttemptStarted` and pasting. Every observable change up to that
final sample refuses with zero paste.

What cannot be closed is the interval **between that final sample and the single
guarded paste**. A provider turn can open in that window. It is not observable
before the paste, and a tmux-only guard — which can atomically recheck pane
generation, process, liveness and mode, but not the provider's session file —
cannot atomically refuse it. A delivery admitted there is only ever settled as
`uncertain` after the fact, never proved safe before the bytes are sent.

Because a safe input point cannot be identified often enough to guarantee no
delivery lands on an open turn, tmux panes remain **view-only** for coordinated
work, and reliable REPL interaction stays **ACP-owned**.

## What this PR is

Evidence, not a shipped REPL. It contains:

- the deterministic RP1–RP18 matrix plus supporting boundary rows, all passing
  under Deno, Node and Bun, that prove the observation, convergence, store and
  report contracts and the safe refusals;
- the report schema and aggregator whose overall `PASS` was, by design,
  reachable only with both live provider journeys — which are not run;
- no production, architecture, specification, dependency or lockfile change.

## What was removed at closeout

The live-delivery journeys are permanently disabled. The supervisor no longer
launches a coding agent or delivers a message under any gate; it returns this
`VIEW_ONLY` conclusion. The grid launch documents and the two live proof
documents are removed. No Claude or Codex model turn was ever spent.

A production retained REPL and action store are not authorized by this result.
Should coordinated multi-agent messaging be pursued, it belongs on ACP, whose
exchanges XMD already drives reliably, rather than on black-box tmux input.
