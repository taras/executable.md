# Two reviewers, one name

This document opens two agent sessions and calls them both `review`. They are not
the same session, and nothing about the name makes them one: a session is the
element that opened it, and this document has two elements.

That matters when a run is interrupted and resumed. Each site has to come back to
the conversation *it* was having — not to whichever one the name happened to
reach first.

<Agent name="codex">

<Session name="review">
<Prompt>What did the first reviewer see?</Prompt>
</Session>

<Session name="review">
<Prompt>What did the second reviewer see?</Prompt>
</Session>

</Agent>
