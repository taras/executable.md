# Ask an agent what it needs to see, and let it see only that

This workflow gives an agent no files. It has no working directory you would
recognise, no checkout, and no tool it is allowed to call. Everything it learns
about this run, it learns because this document asked it a question and rendered
an answer back into the next question.

Every example below is written in a fenced block on purpose. An element written
as prose in this document is an element this document runs — writing
`<File path="…" />` outside a fence to *show* the agent the shape would read the
file here, and put its contents in the prompt.

The way it asks to see something is by writing a small fragment of Executable
Markdown — **generated XMD**. That fragment is data, not permission: this
document hands it to `<Evaluate>`, which admits it only if every element in it
is one this host pinned in advance, and performs it against the run's own
Workspace. A fragment naming anything else performs nothing at all.

The conversation is bounded here, in the document, where you can read the bound.

<Let as="observation" value={null} />

<Agent name="codex">
<Session name="review">

<Loop name="observations" max={4}>

Each turn asks for one of exactly two answers, and says so in the reply itself:
an **observation**, which is a fragment this run should perform and show back;
or a **proposal**, which is the agent's final answer and the end of the
conversation.

<Prompt as="reply">
You are reviewing a change in a workspace you cannot open.

Reply with one JSON object and nothing else. It is either

```json
{"kind": "observation", "source": "<one XMD element>"}
```

to ask for something to be read, or

```json
{"kind": "proposal", "source": "<your final answer>"}
```

when you have seen enough.

The only element an observation may use is a self-closing file read, written
exactly like this:

```md
<File path="notes.md" />
```

What the previous observation returned, if there was one. `observations` holds
one entry per element the fragment performed, in the order it performed them,
and `output` is whatever the fragment rendered — usually nothing:

<Json value={observation} />
</Prompt>

<Parse as="turn" schema={{"oneOf":[{"type":"object","properties":{"kind":{"const":"observation"},"source":{"type":"string"}},"required":["kind","source"],"additionalProperties":false},{"type":"object","properties":{"kind":{"const":"proposal"},"source":{"type":"string"}},"required":["kind","source"],"additionalProperties":false}]}}>{reply}</Parse>

A proposal ends the conversation. Nothing is performed on the way out: a
proposal is text this run keeps, and if it happens to describe a change, making
that change is a separate decision nobody has taken here.

<If condition={turn.kind === "proposal"}>
<Break />
</If>

An observation is performed instead. `<Evaluate>` reads the whole fragment
before it does anything, so a fragment whose second element is not admitted
performs nothing — not even the part of it that was fine.

What comes back is a value rather than text: each element's own result, in the
order they ran. That matters because most observations render nothing at all — a
`<Fetch>` written without a binding has nowhere to put its response — so reading
the fragment's rendered output would tell the agent nothing. It is bound rather
than rendered here, because the reader of this run wants the agent's answer, not
the file it happened to open.

<Evaluate source={turn.source} as="observation" />

</Loop>

The loop is allowed to end without a proposal, so the last thing this document
does is insist on one. Reaching the bound leaves the final reply an observation,
and this refuses it — which is how exhaustion becomes a failure you can read,
with the turns that led to it still in the run's history.

<Parse as="final" schema={{"type":"object","properties":{"kind":{"const":"proposal"},"source":{"type":"string"}},"required":["kind","source"],"additionalProperties":false}}>{reply}</Parse>

</Session>
</Agent>

<Output>
The agent proposed:

{final.source}
</Output>
