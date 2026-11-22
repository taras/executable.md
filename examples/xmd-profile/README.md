# XMD Profile

Use the XMD Profile plugin to see where an XMD document spends CPU time. Wrap
the work you want measured in `<Profile>`, then read the capture with
`<Profile.Report>` or set two captures side by side with `<Profile.Compare>`.
Start from a checkout prepared with `deno task setup`.

[Capture and report](#capture-a-profile-and-read-it) · [Between two points](#capture-between-two-points) · [REPL](#profile-a-repl-session) · [Compare](#compare-two-captures) · [Evidence](#read-the-evidence) · [Limits](#what-a-profile-shows-and-what-it-leaves-out) · [Exercises](#write-an-exercise) · [Tests](#run-the-tests) · [Plugin components](#plugin-components)

## Capture a profile and read it

Select the plugin when you run a document. Run from the root of the prepared
checkout.

```text
deno run --allow-all --cached-only --frozen --node-modules-dir=none \
  packages/cli/src/deno.ts run --plugin ./examples/xmd-profile/plugin.ts exercise.md
```

`<Profile>` samples the XMD process while its content expands and stops when
the content finishes. With `as`, it binds the capture receipt and renders
nothing, so the report is the only output.

```xmd
<Let as="items" value={[1, 2, 3, 4, 5, 6, 7, 8]} />
<Profile label="each-8" as="capture">
  <Each in={items} let="item">
    <Json value={item} />
  </Each>
</Profile>
<Profile.Report path={capture.profile} />
```

The report opens with the sampled, active, idle and profiler time, then gives
four tables: active time by layer, top functions by self time, top XMD frames
by inclusive time, and top source files. The inclusive table leaves out a frame that hands at
least 98% of its time to one callee, so it shows where time fans out. An `Each` over 800 `Json` components
produced this layer table on one run:

```text
| Layer               | Self ms | Share of active |
| `effection`         |   501.8 |           46.8% |
| `xmd core`          |   190.8 |           17.8% |
| `effectionx`        |    89.3 |            8.3% |
| `deno runtime`      |    80.9 |            7.5% |
| `garbage collector` |    61.7 |            5.8% |
```

A layer names where a frame's source came from: `xmd <package>` for this
repository's packages, `effection` and `effectionx`, `npm <name>` for other
dependencies, `deno runtime` and `node builtin` for runtime code, `eval block`
for code a document evaluated, `wasm` for WebAssembly modules, and `native` for runtime operations with no
script behind them.

Add `focus` to see what calls one function. The report gains two tables for
it: its immediate callers, and every frame from this repository's packages
above it on the stack, nearest first, each with the time that reaches the
function through it.

```xmd
<Profile.Report path={capture.profile} focus="expandListSegments" />
```

## Capture between two points

Use `<Profile.Start>` and `<Profile.Stop>` when the work to measure is not the
content of one element. The capture covers everything the process does between
them.

```xmd
<Profile.Start label="span" />
<Each in={[1, 2, 3, 4]} let="item">
  <Json value={item} />
</Each>
<Profile.Stop label="span" as="capture" />
<Profile.Report path={capture.profile} />
```

## Profile a REPL session

A REPL launched with the plugin keeps a capture open across entries, so the
capture covers what the interface does between them. Submit
`<Profile.Start label="typing" />` as one entry, use the REPL, then submit
`<Profile.Stop label="typing" />` as a later entry.

Drive the REPL from [ReplBench](../repl-bench/README.md) to repeat the same
actions on every run. Its `XMD.Repl` takes a `plugins` array, and
[repl-typing.test.md](journeys/repl-typing.test.md) is the worked example: it
submits the start entry, types into the Sidekick composer, submits the stop
entry and reads the capture from the test. Run it from the root of the
checkout, where its plugin path and capture directory resolve.

## Compare two captures

Capture the same exercise twice, then name both profiles. Rows are ordered by
the size of the change, so the largest movement in either direction comes
first.

```xmd
<Profile.Compare
  baseline="captures/baseline/each-800.cpuprofile"
  candidate="captures/candidate/each-800.cpuprofile"
/>
```

Compare captures taken on the same host at similar load, with the same
workload and sampling interval. The receipt beside each profile records the
load average at the start of its capture.

## Read the evidence

Each capture writes two files into `dir`, which defaults to `.bench/profile`
under the contextual working directory.

- `<label>.cpuprofile` is the V8 CPU profile. Chrome DevTools loads it in the
  Performance panel for a flame chart.
- `<label>.json` is the receipt: `label`, `profile`, `startedAt`, `durationMs`,
  `intervalUs`, `samples`, `nodes`, `bytes` and `loadAverage`.

A capture whose content fails still writes both files, and the failure
continues to the caller.

## What a profile shows and what it leaves out

A profile attributes sampled time to the JavaScript frame that was running in
the XMD process. State these limits in an exercise that would otherwise depend
on them.

- **Native work has no frames below it.** File system calls, terminal writes
  and other runtime operations appear as `native` or `deno runtime` rows.
- **Other processes are absent.** An agent, an `exec` child and a nested `xmd`
  command each run outside the profiled process.
- **Waiting is not work.** Idle time is reported in the opening line and kept
  out of every share.
- **The profiler measures itself.** Starting and stopping a capture costs about
  0.2 seconds, reported as profiler time and kept out of active time. Size a
  workload so its active time is well above that.
- **Load moves the numbers.** A busy host stretches every row. Trust ratios
  between runs taken at similar load over absolute milliseconds.
- **A TypeScript position is a script line.** The runtime profiles the
  transpiled script and gives the profiler no source map, so a row for a `.ts`
  file says `script line`. Find the function by its name.
- **Short functions are statistical.** The default interval is 200
  microseconds, so a function faster than that appears only in proportion to
  how often it runs.

## Write an exercise

Give these, and a result can be trusted:

1. **The expectation**, in one falsifiable sentence about where time goes.
2. **The workload and its size**, and why that size.
3. **The build**: the checkout and its exact revision.
4. **What to read off the report**: which layer, function or frame, and
   whether the expectation is about self or inclusive time.
5. **The discriminating control**: a second size at which the time must scale,
   or a variant in which the named frame must not appear. An expectation that cannot
   fail has not been verified.

## Run the tests

```sh
deno test --allow-all --cached-only --frozen --node-modules-dir=none examples/xmd-profile/tests
deno run --allow-all --cached-only --frozen --node-modules-dir=none \
  packages/cli/src/deno.ts test examples/xmd-profile/journeys
```

The journeys use the plugins declared in `examples/xmd-profile/xmd.json`: this
one and ReplBench, which the REPL journey drives through a Bun PTY.

## Plugin components

The plugin registers its components for `xmd run`, `xmd test` and `xmd repl`.

| Component | Contract |
| --- | --- |
| `Profile` | A paired invocation captures a CPU profile of its content. `label` names the files; it starts with a letter or digit and may contain letters, digits, `.`, `_` and `-`, up to 64 characters. `dir` is relative to the contextual working directory. `interval` is the sampling interval in microseconds, at least 50, default 200. Without `as` it renders its content. `as` binds the receipt. Reusing a label replaces that capture. |
| `Profile.Report` | Reads the profile at `path` and renders the report. `top` limits the function, frame and source tables, default 12. `focus` names a function and adds its callers; a name the profile never ran fails. `as` binds the summary, with times in microseconds. |
| `Profile.Compare` | Reads the profiles at `baseline` and `candidate` and renders the change in active time, by layer and by function. `top` limits the function table, default 12. `as` binds the comparison. |
| `Profile.Start` | Starts a capture named `label` that stays open after this element. It takes the same `label`, `dir` and `interval` as `Profile`. A label that is already open fails. |
| `Profile.Stop` | Stops the open capture named `label` and writes its files. `as` binds the receipt. A label with no open capture fails. |
