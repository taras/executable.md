# Large retained readings fail during width measurement

The reported command fails before a usable frame is drawn, inside the finished
reading-row measurement. This is separate from History stacking over itself.

Examined head: ff0e52c643c21ad7dde34908a18a112add6312c7, parent d906c636,
branch agent/issue-883-pr2. Worktree is clean. The Bindings-padding correction
does not change fitting.ts or renderer.ts. This diagnostic changes no production
source and does not execute the user's draft or contact an agent.

## What the stack identifies

fitting.ts:440–443 flattens every fitted source/output row of the retained entry
and asks widths() to measure them all together. widths():307–318 creates one
root and one element/text pair per nonempty row, with matching closes, and sends
the entire operation list to the engine in one render.

The installed @bomb.sh/tty 0.9.0 engine's term-native.js declares an 8,192-element
budget. A finished reading can exceed this regardless of how few rows the chat
or Transcript viewport shows. The current measurement batch is unbounded.

## Reproduction

The same UNBALANCED_OPEN_CLOSE exception is reproducible with balanced
operations. Every child is closed, followed by the root's close. A direct real
renderer measurement succeeds at 4,000 short text rows and fails at 5,000.
The failed instance reports the unbalanced error rather than an element-capacity
error; renderer.ts therefore treats it as a non-capacity refusal and returns it.
Rebuilding an engine of the same capacity would not bound this request anyway.

The second probe reaches the actual prepareReading() / fitGeometry() /
widths() path from the report:

```text
short fitted rows    reading preparation
4,000                succeeds, all 4,000 rows retained
4,096                fails with UNBALANCED_OPEN_CLOSE
```

Each nonempty candidate consumes an element and a text element in addition to
the roots. The nominal element budget is not a promise that exactly 4,096 rows
fit; the root and engine-owned elements also consume capacity.

Preserved probes and outputs:

- pr921-reading-measurement-capacity-probe-ff0e52c6.test.ts — direct balanced
  operation batches, six sizes pass and 5,000 fails. Output:
  pr921-reading-measurement-capacity-probe-ff0e52c6-resolved-first.log.
- pr921-large-retained-reading-probe-ff0e52c6.test.ts — the production reading
  fitter, 4,000 control passes / 4,096 regression fails. Output:
  pr921-large-retained-reading-probe-ff0e52c6-paired-first.log.

Commands, from .claude/worktrees/issue-883-pr2:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr921-reading-measurement-capacity-probe-ff0e52c6.test.ts
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr921-large-retained-reading-probe-ff0e52c6.test.ts
```

Probe construction notes: the direct probe's first attempt could not resolve
the CLI-private @bomb.sh/tty import from the reviewer directory. It now names
the same pinned npm version as packages/cli/deno.json; no dependency was changed
or installed. The first reader boundary probe tried 4,095 as a control, but that
also exceeded the effective budget. That first output remains preserved; the
paired probe uses the independently passing 4,000-row control. Neither adjustment
is a production fix or evidence of intermittence.

## Correction boundary

Bound width-measurement batches independently of total reading length. Copy
each batch's measured answers before the next engine render and return answers
in the input's original order. Keep all prepared rows, exact text, grapheme
cuts, status reservations and existing fitting reuse. The reading must not be
truncated to make the engine accept it, and the engine's structural-error
validator must not be disabled or reclassified wholesale.

Regression evidence should pass the large reading through the real fitter,
assert every row and its original order/text, and retain the short-reading
control. The focused existing source-reading and presentation tests hold the
width, grapheme, geometry and reuse boundaries. This assessment is not a release
of an unrelated renderer rewrite, vendor patch or cache/dependency change.

## Limits and user state

I have not measured the supplied execution's own reading: that ID is not present
under this machine's default macOS REPL repository. The synthetic production-path
probe reproduces the exact exception and establishes one concrete failure
mechanism; it does not establish the user's precise row count or terminal size.
An optional request for `stty size` is pending to match the terminal geometry.

Removing duplicate History segments addresses the earlier modal-stack problem,
not this unbounded reading measurement. No saved history or draft was edited.
No source mutation, Git commit, push, GitHub write, CI inspection or capture
occurred.
