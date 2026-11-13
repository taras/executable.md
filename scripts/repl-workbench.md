---
props:
  run:
    type: string
    pattern: '^tmux\.[a-zA-Z0-9]+$'
required: [run]
---

# The REPL workbench

This reads one live `xmd repl` invocation and says what is actually on its screen.

It exists because the REPL's own record cannot answer that question. A journal
holds ordinary `DurableEvent`s — what a document imported, evaluated, asked and
answered — and `specs/repl-spec.md` makes it a rule that no keystroke, focus move,
drawer, resize or rendered cell ever reaches it. So a claim about the interface has
to be read off a terminal, and `scripts/repl-bench.sh` allocates one.

Every capture that matters arrives here as a **file**, never as command output.
`Process.join()` may settle before the stdout pumps do, so bytes a child writes as
it exits may never be received (effectionx #244) — and a frame lost that way would
read as a REPL defect rather than as a lost frame. The harness redirects into
`.bench/<run>/`, and this document reads those paths.

From the assigned worktree, start an interactive run and capture its screen
and journal. Pass its printed `tmux.…` ID as `--props-run`.

```sh
./scripts/repl-bench.sh start --tmux --size 160x36
read -r run  # Enter the printed tmux run ID.
./scripts/repl-bench.sh look "$run" report
./scripts/repl-bench.sh journal "$run"
deno task xmd run scripts/repl-workbench.md --props-run "$run"
```

Keep this report outside a retained journal. Its output contains terminal content.

## Which run this is

<Let as="runDir" value={".bench/" + props.run} />
<Let as="framePath" value={runDir + "/latest.ansi"} />
<Let as="journalPath" value={runDir + "/journal.jsonl"} />

Run `{props.run}`. Its launch details are in `{runDir}/meta.env`.

## What the screen shows

<File path={framePath} as="frameRaw" />

```ts eval
// Rows are reported with their screen index, because a claim about the History
// band or the footer is a claim about which row drew it. capture-pane trims
// trailing blank lines, so an empty footer reads as a short capture: count from
// the top, never from the bottom.
const rows = frameRaw.replace(/\n$/, "").split("\n");
const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
const rowReport = plain
  .map((r, i) => `${String(i).padStart(2, " ")} │ ${r.replace(/\s+$/, "")}`)
  .join("\n");
const widest = Math.max(...plain.map((r) => r.length));
```

{plain.length} rows captured, widest {widest} columns.

{rowReport}

## What colour it is in

Since #878 every row carries a role, a 24-bit foreground, a weight and a surface,
so a row's meaning is in its cells. This reads the palette back off the capture —
a report with no colours in it means the capture lost the escape sequences, not
that the screen was grey.

```ts eval
const PALETTE = {
  source: 0xc8d2d9, output: 0xe6ecf1, heading: 0xcfe0ea, muted: 0x7b858d,
  success: 0x5aa87c, failure: 0xc2766e, waiting: 0xc99a3f, focus: 0x7fd3e8,
  selectedSurface: 0x122026, historical: 0xc9a86a, historySurface: 0x08090b,
  draftSurface: 0x0a0d0f, fieldSurface: 0x090c0e, drawerSurface: 0x0e1316,
  centreSurface: 0x0c0e11, sideSurface: 0x090b0c, bindingsSurface: 0x0a0c0e,
  edge: 0x161c21,
};
const triple = (v) => `${(v >> 16) & 0xff};${(v >> 8) & 0xff};${v & 0xff}`;
// The parameter string, not the whole escape sequence. Testing `ESC[1m` for a
// leading or `;`-prefixed `1` never matches, because `[` precedes the digit —
// which reported bold absent while the screen carried five of them. A colour
// substring match survives that mistake; a parameter match does not.
const sgrParams = [...frameRaw.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]);
const present = Object.entries(PALETTE)
  .filter(([, v]) => sgrParams.some((pp) => pp.includes(triple(v))))
  .map(([name, v]) => `- \`${name}\` — ${triple(v)}`);
const boldLabel = sgrParams.some((pp) => pp.split(";").includes("1")) ? "in use" : "absent";
const colourReport = present.length > 0
  ? present.join("\n")
  : "**No palette colour found.** The capture carries no SGR sequence, so it cannot support any claim about emphasis.";
```

{sgrParams.length} escape sequences, {present.length} of the palette's roles on screen,
bold {boldLabel}.

{colourReport}

## What this run did

The journal is the other half, and it answers a different question: not what drew,
but what ran. A submitted entry appears as an `import_component` record named
`__root__`, and its terminal outcome as the root `close`.

<File path={journalPath} as="journalRaw" />

```ts eval
const records = journalRaw
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l, i) => {
    try {
      const o = JSON.parse(l);
      const d = o.description ?? {};
      return `${i + 1}. \`${o.type}\` ${d.type ?? "—"} \`${d.name ?? ""}\` → ${o.result?.status}`;
    } catch {
      // A record this cannot parse is reported, not skipped: a silently dropped
      // line would make the journal look shorter than it is.
      return `${i + 1}. **unparseable record**`;
    }
  });
// An empty journal is the honest state of a session that has submitted nothing —
// the execution file exists before anything is typed.
const journalReport = records.length > 0
  ? records.join("\n")
  : "No records yet. The execution file exists from the start; nothing has been submitted.";
```

{journalReport}

## Driving it without hands

To reproduce a state before capturing it, rather than typing it each time:

```
scripts/repl-bench.sh type "$run" '# an entry'     # literal text, through the paste path
scripts/repl-bench.sh send "$run" Enter            # named keys: Tab BTab Enter Escape Backspace
scripts/repl-bench.sh resize "$run" 72x20          # a real SIGWINCH
scripts/repl-bench.sh tape "$run"                  # every frame captured, in order
scripts/repl-bench.sh stop "$run"                  # kill this run's private server
```

`type` goes through tmux's paste buffer, not `send-keys`: tmux's parser eats a
trailing `;` even from a literal argument, which silently truncates a typed `js
eval` block and then fails as a syntax error that looks like a product bug.
