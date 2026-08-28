# A run whose agent this build carries no snapshot for

Everything about carrying a patched Codex adapter is about Codex. This document
asks Gemini two questions, which is a thing a workflow was always allowed to do,
and the point of it is that carrying an adapter for somebody else changed
nothing here.

Two Prompts rather than one, so that an interrupted attempt leaves a committed
turn behind it and the resume has something to restore rather than something to
repeat.

<Agent name="gemini">
<Session name="review">

<Prompt as="first">
Reply with one sentence about the release.
</Prompt>

<Prompt as="second">
Given what you just said, reply with one more sentence.
</Prompt>

</Session>
</Agent>

<Output>
The agent said:

{first}

{second}
</Output>
