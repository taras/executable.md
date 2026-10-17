# Proposed first-turn XMD primer

Superseded as an initial-prompt proposal by the accepted
[syntax discovery amendment](syntax-discovery-amendment.md). The text below is
retained as a content inventory for on-demand guides; do not load it as a full
first-turn primer.

Status: proposed for Product Owner review. This supplements the accepted
[Sidekick instructions](sidekick-instructions-proposal.md); it changes no
execution permission or component contract. It is teaching text, not an
implemented production prompt.

## Prompt assembly

Supply the primer below before the accepted operating instructions. Follow
those instructions with the two canonical references, clearly labeled
**Sidekick response syntax** and **REPL entry syntax**, and the current draft
and person's request. Deliver all of this before the first provider response.
The references supply actual installed signatures and documentation; this
primer supplies the language concepts needed to use them. Examples are source
to learn from, not instructions to execute during initialization.

## Exact proposed primer

You write XMD: Markdown with components that perform work and produce text or
values. The host interprets the components. Although the tags resemble JSX,
your response is not a React program. A successful complete response is itself
an XMD program; the host evaluates it automatically. Write the program directly,
without enclosing your whole reply in a code fence or an Evaluate tag.

### Start with a message

Put the Markdown the person should see inside a direct, top-level Output:

```xmd
<Output>
I can prepare the program. Which result would you like it to produce?
</Output>
```

Output selects visible text; it does not send a result to you. In Sidekick,
text outside Output is not shown as chat. Controls outside Output still run.
For conditional messages, put the condition inside Output: Output itself must
remain top-level. An Output-only response finishes your turn and waits for the
person.

### Read tags and their inputs

A component reference tells you its name, accepted inputs (called props),
whether it is self-closing or has a body, and what it returns. Use the listed
form and exact prop names. A paired component's body is Markdown that the
component consumes according to its documentation.

Quoted props are strings: `as="code"`. Braced props supply data:
`limit={16384}`, `entry={-2}`, `names={["Elicit"]}`, or
`schema={{type: "string", enum: ["Prepare only", "Run now"]}}`.

In a Sidekick response, braced props accept JSON literals, previously created
response bindings, arrays, objects and object shorthand. They do not accept
JavaScript computation: no function calls, property access, indexing,
operators, template literals or arrow functions. For example, `value={choice}`
can pass an existing binding; `value={choice.answer}` and
`value={items.map(format)}` cannot. The entry reference describes the separate
language available inside a submitted program.

### Bind a value before using it

A binding is a name for a value. Let can create one directly:

```xmd
<Let as="greeting" value="Hello" />
<Output>{greeting}!</Output>
```

The program runs in document order, so greeting exists after Let. In text,
`{greeting}` inserts its string representation; it does not execute JavaScript
or reparse the inserted string as XMD. Interpolating an object is not JSON
serialization. Escape an opening brace as `\{` when you need a literal text
reference. Inline backticks alone do not prevent interpolation.

On a component, `as="name"` captures its return for later use. A text component
then binds its rendered text and emits no text at that location. A value
component renders nothing and binds its returned value. Read **Returns** and
**as** in its reference; do not assume every component returns a string.
**Captures**, when listed, describe special input props evaluated by that
component; they are different from capturing its return with as.

Each response starts without bindings from earlier responses or the REPL.
Conversation feedback is information you can reason about, not an automatic
XMD variable. Read current REPL values with REPL.Bindings when needed. An
explicit as capture can make a control's return available within this response.
Bindings inside a component body or Each iteration do not automatically escape
to later siblings; use the construct's documented return/capture behavior.

### Keep an entry program literal while preparing it

Your response and the program you put into the REPL are two different XMD
documents. A component allowed in the REPL entry is not thereby allowed to run
in your response. Consult the appropriately labeled reference.

A fenced block with no exec or eval modifier is passive text, including its
tags and braces. Use Let with `select="code"` to extract the source inside that
fence, then insert the resulting string into EntryInput:

````xmd
<Let as="code" select="code">
```xmd
<Let as="names" value={["Ada", "Lin"]} />
<Output>
<Each in={names} let="name">
Hello, {name}!
</Each>
</Output>
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
````

This fills the shared draft and runs none of the entry source. The names binding
belongs to the future entry; code belongs to this response. Let's select prop
extracts the first matching code block without its fence. Its rendered-content
capture trims trailing whitespace; use a direct string value when exact string
boundaries matter. If the entry contains fenced blocks, use a longer enclosing
fence. Omit exec and eval on that enclosing fence.

Add `<REPL.Submit />` after EntryInput only when the person's request calls for
execution. Submit runs the actual shared draft and waits for that entry to
finish and release its resources. It returns status and instructions for
reading output, not the output itself. Use `<REPL.EntryOutput />` to inspect
the result when useful.

In an ordinary entry, exec and eval modifiers make a fenced block executable;
the language label alone does not. Those executable fences are unavailable in
your Sidekick response. Use the active entry reference for supported languages,
modifiers and components rather than assuming a capability exists.

### Ask for a structured answer

Elicit asks the person and waits for an answer validated against its JSON
Schema. The schema defines the available answers; there are no implicit approve
or cancel choices. For example:

```xmd
<Elicit schema={{type: "string", enum: ["Prepare only", "Run now"]}} as="choice">
Should I prepare the program for review, or run it?
</Elicit>
<Output>You chose: {choice}.</Output>
```

The body is the question. The validated answer is bound as choice after Elicit
finishes. In Sidekick, the host presents this question in its chat drawer.
Output can explain a question but does not collect the answer.

### Continue from actual results

REPL controls and Elicit return their designated results to this conversation
after the response program finishes. The host then requests your next response.
Ordinary rendering and an arbitrary component return do not automatically
become feedback. If you are finished, respond with Output and no further
operations.

The entire response is checked before any of its controls execute. Invalid
syntax or a prohibited construct can therefore prevent all controls from
running, even when it appears in an unselected branch. A later runtime failure
does not undo earlier successful effects. Correct the actual failure without
repeating work that already happened.

## Review findings

The accepted operating instructions explain the workflow and its safeguards,
but they do not yet teach the basic language. The canonical syntax renderer
prints component and structural entries; it does not prepend a language primer.
These are the consequential gaps this proposal fills:

- JSX-like appearance hides the restricted response expression grammar.
- Attribute data, text interpolation and passive fenced source are three
  different interpretations of braces.
- Component return values, rendering, as binding and operation feedback are
  distinct paths.
- Evaluation order and local binding scope matter even without JavaScript.
- A language-labeled fence is passive until its modifiers make it executable.
- A schema reference alone does not show a first-time author how to ask a
  complete Elicit question.

The entry example is self-contained rather than assuming a pre-existing names
binding. The existing operating instructions remain necessary for draft
takeover, read limits, Stop, error recovery, provider failure and preview.

## Implementation alignment to preserve

The accepted literal EntryInput pattern needs interpolation of bindings created
within the generated response. At this checkout, generic fragment preflight
rejects text interpolation altogether (`generated-xmd.ts`, walk's text case).
The new generated-root seam must implement the accepted local-binding pattern
without weakening the existing fragment seam or importing entry bindings.
This is an existing contract to prove, not a new permission proposed by this
primer.

The instructions' sentence saying syntax-change recognition is pending is
outdated relative to the completed handoff: a compatible reference update is
delivered before the next explicitly requested turn in the same conversation.
Reopening alone starts no turn. Replace that stale sentence when assembling
the reviewed production prompt.

## Sources checked

- [Accepted operating instructions](sidekick-instructions-proposal.md)
- [Completed handoff](planner-handoff.md)
- [Accepted literal-source rationale](architecture-review.md#literal-source-through-existing-xmd)
- [Canonical reference renderer](../../packages/core/src/syntax-markdown.ts)
- [Generated expression grammar](../../packages/core/src/generated-expressions.ts)
- [Generated fragment preflight](../../packages/core/src/generated-xmd.ts)
- [Text interpolation](../../packages/core/src/eval-interpolate.ts)
- [Language specification](../../specs/executable-mdx-spec.md): executable
  fences, component returns, Let/as, expression props, Each, Output and Elicit.
