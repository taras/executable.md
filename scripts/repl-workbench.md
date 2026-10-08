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

Run it from the worktree root, against a session already started:

```
scripts/repl-bench.sh start --size 160x36
deno task xmd run scripts/repl-workbench.md
```

Do not pass `-j`/`--journal`. A capture is terminal content, and retaining it would
put the screen through the pre-persistence secret gate for no benefit.

## Take a frame now

The capture is bound rather than forwarded, so a non-zero exit is data here instead
of ending the run before the report below can say what went wrong.

```bash exec as="lookRun"
scripts/repl-bench.sh look report 2>&1
```

```bash exec as="journalRun"
scripts/repl-bench.sh journal 2>&1
```

## Which run this is

<File path=".bench/current" as="currentRaw" />

```ts eval
const runId = currentRaw.trim();
const runDir = `.bench/${runId}`;
const framePath = `${runDir}/latest.ansi`;
const metaPath = `${runDir}/meta.env`;
const journalPath = `${runDir}/journal.jsonl`;
```

<File path={metaPath} as="metaRaw" />

```ts eval
// meta.env is shell-quoted key=value, because the darwin journal root contains
// "Application Support" and the harness has to source it.
// Two eval rules are load-bearing here. A `ts eval` block is parsed as
// JavaScript, so a `const meta: Record<string, string>` fails at the colon. And
// an export snapshots at its declaration, so an object filled in by a later loop
// publishes as `{}` — anything prose reads has to be complete when it is bound.
const meta = Object.fromEntries(
  metaRaw.split("\n")
    .filter((line) => line.indexOf("=") > 0)
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, "")];
    }),
);
const size = `${meta.COLUMNS_}x${meta.ROWS_}`;
const replArgs = meta.REPL_ARGS;
const homeLabel = meta.HOME_MODE === "yes" ? "a real" : "an isolated";
// The three sizes the spec gives distinct screens for, and the refusal below them.
const band = Number(meta.COLUMNS_) < 72 || Number(meta.ROWS_) < 20
  ? "below the minimum — this is the refusal screen"
  : Number(meta.COLUMNS_) >= 160 && Number(meta.ROWS_) >= 36
  ? "full: sidebar, transcript, bindings, footer"
  : Number(meta.COLUMNS_) >= 120 && Number(meta.ROWS_) >= 30
  ? "narrower sidebar and inspection column"
  : "one routed surface, two surface controls, drawer and footer";
```

Run `{runId}` at **{size}** — {band}. The REPL was started with `{replArgs}`
and {homeLabel} `HOME`.

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
scripts/repl-bench.sh type '# an entry'     # literal text, through the paste path
scripts/repl-bench.sh send Enter            # named keys: Tab BTab Enter Escape Backspace
scripts/repl-bench.sh resize 72x20          # a real SIGWINCH
scripts/repl-bench.sh tape                  # every frame captured, in order
scripts/repl-bench.sh stop                  # kill this run's private server
```

`type` goes through tmux's paste buffer, not `send-keys`: tmux's parser eats a
trailing `;` even from a literal argument, which silently truncates a typed `js
eval` block and then fails as a syntax error that looks like a product bug.
