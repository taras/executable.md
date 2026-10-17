# Canonical turn vocabulary interview request

Resolved by [the accepted vocabulary decisions](pr2-recovery-turn-vocabulary-decisions.md).
The interview below is retained as the original request; its proposed names are
not the final assignment. Both interviews are complete.

Returned to the Planner against `87b25a40915a697a580e619072d433c9c676fec0`,
parent `14ee0d8ed2cf98468e8968fa766f2fb5bfafecf9`, on agent/issue-883-pr2. The
implementation worktree is clean at that signed revision.

The three wordings recorded from
[the first interview](pr2-recovery-message-vocabulary-interview.md) — **message
ID**, **feedback/reference text**, **records for this request** — are applied and
unblock that half. This asks about the other half of the same distinction.
`message ID` is defined *against* something, and that something is what I have
been calling a **canonical turn** without asking. The function that looks one up
is called `canonicalTurn` and I wrote it.

No implementation, passing verification or test result is claimed here. No
production code changed; the in-progress work is set aside outside the
repository, as before. Nothing in the Architect decision, the frozen MC1–MC4
evidence or the unresolved-acceptance refusal is disputed.

## Inventory

Counted at `87b25a40`. "Registry entry" means a row of the Terminology table.

| Noun | Registry entry | On `origin/main` before this PR | This PR's Sidekick source | Decision | Handoff |
| --- | --- | --- | --- | --- | --- |
| turn | no | 284 specs · 213 core · 299 acp · 407 cli | 367 | many | many |
| canonical turn | no | **1** (`core/src/agent/publication.ts`) | 33 | 14 | 8 |
| Prompt — the journaled exchange | **entry exists, different meaning** | 13 specs · 8 core | 3 | — | — |

Three different situations, so three decisions.

## Decision 1 of 3: is `turn` already covered?

`turn` is everywhere and is not mine: 1,200-odd occurrences across accepted
specs, Core, ACP and CLI before this PR touched anything. Rule 1 admits "words
already defined in the spec and code", and on any ordinary reading that covers
it.

**I am not asking to use `turn`.** I am asking whether the Product Owner wants
it *registered*, because it is the load-bearing noun of this whole feature and
of the Agent API beneath it, and because the first interview established that a
word being common in the prose is not the same as it being described.

**Options.**

1. Leave it. Rule 1 covers it; the registry stays small.
2. Register `turn` with a description — roughly *one exchange with a provider:
   what was sent, what came back, and how it ended, journaled under its own
   durable name*.

**My recommendation: option 2, but only if the Product Owner wants the registry
to carry the feature's central nouns.** If the registry is meant for terms that
are easy to get wrong rather than terms that are merely important, option 1 is
right and I will stop raising it.

## Decision 2 of 3: the compound `canonical turn`

This is the one that is substantially new. It existed once on `origin/main`,
in `publication.ts`; there are now 33 occurrences in this PR's source and 22
across the two governing documents.

**What it names.** The turn as the canonical journal holds it — the
`agent_prompt` record under the durable name `turn:N`, carrying what was sent
and how it ended — as opposed to a number this host wrote down beforehand. The
whole accepted amendment is the distinction between the two, so the pair needs
both halves named: `message ID` on one side, and this on the other.

**Options.**

1. Register `canonical turn` with that description, and keep the word.
2. Drop the adjective and rely on `turn` alone, distinguishing by context —
   "the turn the records hold" versus "the message ID".
3. A different adjective the Product Owner prefers.

**My recommendation: option 1.** The amendment exists because two numbers were
being confused, and the adjective is doing the work of keeping them apart in
every sentence that mentions both. Option 2 would re-open exactly the ambiguity
the Architect decision was written to close.

## Decision 3 of 3: `Prompt` means two things, and the registry picked one

This one I would not have found without looking, and it is not mine.

The registry says:

> | Prompt | a person's original request, in ordinary natural language.
> `xmd plan` takes exactly one |

Accepted Core and the specs use the same word for the journaled provider
exchange: `AGENT_PROMPT`, the durable type `agent_prompt`, "the canonical
Prompt record", "Core's own Prompt reader". That is 13 occurrences in specs and
8 in `core/src` on `origin/main`, and 3 in my Sidekick prose that lean on it.

So a reader who learns `Prompt` from the registry and then reads "the canonical
Prompt record holds its status and whatever it streamed" will take it to mean
the person's request to `xmd plan`. Both usages are in accepted material and
neither is wrong by itself.

**Options.**

1. Narrow the registry entry to say which one it defines, and add the other —
   e.g. `Prompt` for the person's request and `Prompt record` for the journaled
   exchange.
2. Leave the entry and have this feature's prose avoid the bare capitalised
   word, saying "the canonical turn's record" where it currently says "the
   canonical Prompt record". Three sentences in my code; the specs and Core are
   untouched.
3. Rule that the collision is pre-existing, out of this PR's scope, and should
   be swept separately.

**My recommendation: option 2 for this PR, then option 1 or 3 as a separate
sweep.** The collision is older and wider than this feature, so repairing it
here would be a sweep across Core and the specs that this amendment did not
ask for — but I can stop adding to it in three lines.

## State and what is blocked

Clean at `87b25a40`. The message-correlation work — `retainedRequests`, the
`message`/`turn` person variant, the record documentation, `nextTurn` reading
message IDs, the nullable `SidekickTurn.turn` and the no-guessed-publication
refusal — is set aside as a patch and a file copy outside the repository, not
committed and not in the shared stash, and I verified it re-applies cleanly. So
any command the Planner runs here reflects `87b25a40` exactly.

One finding from that work the Planner should have regardless of the wording,
because it is about the frozen evidence rather than about prose: **R2d's fixture
describes a history this writer cannot produce.** It jumps from a message record
to a second canonical turn with no retained feedback text between them, so under
the Architect's rule 2 both canonical turns fall among one message's records and
the ambiguity refusal fires. I adapted the fixture by inserting the
`turn: null` feedback record production always writes before a feedback turn,
which keeps R2d's claim — the acknowledgement plus the exact input establishes
the delivery — exactly as it was, and makes the fixture a history the writer
produces. Reported here so it is reviewed as an adaptation rather than
discovered in a diff.

Not blocked, and I will finish on request: the bounded live lookup, the
unresolved-acceptance refusal, MC1–MC4 and the controls. Blocked: committing,
because a feedback commit carries the prose and, for decision 2, a function
name.

Creation-policy compatibility remains a separate unresolved Architect return.
R2 is not complete and is not claimed to be.
