# Effection

Read this before writing entry code that performs asynchronous work — a wait, a
subprocess, a file read, anything that does not finish immediately.

## Applies to

REPL entries only. Executable fences are unavailable in a Sidekick response, so
nothing in this chapter runs in your reply; your reply only prepares it.

## Instructions

- An executable fence is one whose modifiers say so: `exec` or `eval`. A
  language label alone is passive text.
- There are three fence layers to keep apart, and conflating them is the one
  mistake that stops a response dead:
  1. the fence this documentation is displayed in;
  2. the **passive** fence your response captures, with no `exec` or `eval` on
     it, which is what makes its contents text;
  3. the **executable** fence inside that captured text, which belongs to the
     future entry and runs only when that entry is submitted.
  Each layer needs more backticks than the one inside it.
- Entry code is written as generator operations, not as `async`/`await`. Wait
  for something with `yield*`.
- Every eval block already has `sleep`, `spawn`, `call`, `resource`, `useScope`,
  `createChannel`, `each`, `suspend` and `createSignal` from Effection, plus
  `when` and `fetch`. You do not import them; confirm anything beyond them with
  `<REPL.Syntax />` rather than assuming it exists.
- An operation that is waited for is also an operation that can be cancelled.
  When a person stops an entry, work suspended at a `yield*` is unwound through
  the same path it was acquired by, so acquire what you need where you need it.
- Declarations in an eval block become bindings the rest of that entry can
  interpolate, which is how a value computed asynchronously reaches `<Output>`.

## Example

A complete response. It captures passive source and fills the draft with it:

`````xmd
<Let as="code" select="code">
````xmd
```js eval
const steps = ["started"];
yield* sleep(1);
steps.push("resumed");
const order = steps.join(" then ");
```

<Output>{order}</Output>
````
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
`````

Your response evaluated none of that. The ```` ```js eval ```` fence sits inside
a passive four-backtick fence, so to your reply it is text; `select="code"`
captures that block's contents, and `<REPL.EntryInput>` puts them in the shared
draft as literal source. The draft now holds a two-element program: an
executable block and an `<Output>`.

Submitted, that entry runs the block, suspends at `yield* sleep(1)`, resumes,
and prints:

```text
started then resumed
```

## Common mistake

Putting the `eval` fence directly in your response — one layer short — instead
of inside a passive fence. That fence is then yours rather than the entry's, and
it is refused. Because the whole response is checked before any control runs,
the refusal stops every control in it: the draft is not filled, nothing is
submitted, and `select="code"` never gets to extract anything.

## Read next

Read `<Guide.Lifetimes />` before starting a process, a connection or background
work, and `<Guide.Entries />` for the draft-filling pattern on its own.
