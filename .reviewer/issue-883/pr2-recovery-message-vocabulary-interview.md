# Message correlation vocabulary interview request

Resolved through individual Product Owner interviews. Accepted wording is
message ID, feedback text/reference text, and records for this request, recorded
in pr2-recovery-message-vocabulary-decisions.md. The alternatives and pending
state below are historical; vocabulary no longer blocks the feedback commit.

Returned to the Planner against `87b25a40915a697a580e619072d433c9c676fec0`,
parent `14ee0d8ed2cf98468e8968fa766f2fb5bfafecf9`, on agent/issue-883-pr2. The
implementation worktree is clean at that signed revision.

**This is not a design objection.** The
[Architect decision](pr2-recovery-message-correlation-architect-decision.md) and
the [Planner handoff](pr2-recovery-message-correlation-planner-handoff.md) are
decision-complete and I can implement them as written. What I cannot do is
name the things they describe, because three of the nouns they use are not
described anywhere and `architecture.md`'s Terminology section says I must ask
before using one.

No implementation, passing verification or test result is claimed here. No
production code changed. Nothing in the frozen MC1–MC4 evidence or the
unresolved-acceptance refusal is disputed.

## Why this comes back now

The Product Owner's standing rule, recorded in the Terminology preamble
(`architecture.md` lines 7–12):

> 1. Only use concepts and words described here or already defined in the spec
>    and code.
> 2. If a concept or term is missing, ask for permission before using it; using
>    it requires adding it here first.

I did not ask. I used `claim` as the name of a retained thing in this PR's
code, it passed review, and the two governing documents above use it too — so
it spread instead of being caught. The Product Owner caught it. Two further
nouns are in the same position. The exact counts are below so the Planner can
see the size of the sweep either answer implies.

## What is and is not at stake

Settled by the Architect and unaffected by this interview: the field is
`message`, the association is `turn`, `MessageRecord.turn` keeps its bytes and
schema, `SidekickTurn.turn` becomes `number | null`, the live lookup is bounded
by the initiating record, and reference content is verified through the
associated message. **No identifier in the decision depends on the outcome.**

What does depend on it: prose and doc comments in `model.ts`, `owner.ts` and
`history.ts`, the two affected sentences in `architecture.md` and
`specs/repl-spec.md`, one private type name and one private union member.

## Inventory

Counted at `87b25a40` and in the governing documents. "Registry entry" means a
row of the Terminology table; "registry prose" means the word appears inside
another entry's definition as ordinary English.

| Noun | Registry entry | Registry prose | This PR's code | Architect decision | Planner handoff | Elsewhere on `origin/main` |
| --- | --- | --- | --- | --- | --- | --- |
| claim | no | 7 | 53 | 9 | 9 | ~580 (≈90 as `a/the claim`) |
| offer | no | 3 | 23 | 4 | 3 | ~275 (≈10 as `the offer`) |
| interval / request interval | no | 0 | 0 | 13 | 10 | 6 |

Two observations the Planner should weigh:

- `claim` and `offer` are long-established *ordinary* words in this
  repository's prose, hundreds of occurrences old, none of them mine. Rule 1's
  "already defined in the spec and code" may well cover them, in which case the
  answer is "carry on" and the sweep is zero.
- `interval` is almost absent and arrives new with this amendment, so it is the
  one I am least willing to introduce on my own judgment.

## Decision 1 of 3: the retained local message number

**The concept.** The number this CLI writes beside a person's message before
the turn it will become, never rewritten afterwards, scoped to its
conversation, not promised to be contiguous, and never a canonical turn
identity. It is exactly what the decision separates from the canonical turn.

**What the documents call it.** "the retained local message claim", "the
existing local claim", "derive the next local claim", "Do not count nullable
`person.turn` as the message claim".

**Options.**

1. Register `claim` with that description, and the word stands everywhere it
   already is. Smallest change; adds one entry.
2. Describe it without a noun — "the local message number this history
   retained", "the number written before the turn". No registry change; I
   rewrite the prose in three source files and two documents.
3. Register a different noun the Product Owner prefers for the same
   description.

**My recommendation: option 1.** The decision's own argument is that the two
numbers mean different things and must be told apart, and a thing that must be
told apart from another thing is easier to keep straight with a name than with
a phrase repeated forty times. If the registry is meant to stay small, option 2
is clean and costs only prose.

## Decision 2 of 3: the record written before a delivery turn

**The concept.** A `feedback` record with `turn: null` — text composed for a
response and about to be sent, asserting nothing about whether any turn took
it. It is what lets a reopened process know what a dead one was sending, and
it is one of the two records that begins a request.

**What the documents call it.** "null-turn feedback offer", "A feedback offer
(`kind: feedback`, `turn: null`) opens a feedback request interval", "A
recovered-feedback offer".

**Options.**

1. Register `offer`, scoped to this: a composed delivery that claims no turn.
   Note the existing `reference` record is also described as an "offer" of
   orientation in accepted prose, so one entry would cover both or the entry
   must say which it means.
2. Describe it by its record shape — "the delivery record that names no turn".
   Accurate and unambiguous; longer at every use.
3. A different noun.

**My recommendation: option 1, with the entry naming both uses** — the
orientation record and the delivery record are the same idea (this host wrote
down what it meant to send, and claimed nothing by it), and splitting them
would be two entries for one concept.

## Decision 3 of 3: the span that owns a canonical turn

**The concept.** The span between one initiating record and the next in the
same conversation, which owns at most one canonical turn. It is the ownership
boundary that replaces text matching and ordinal equality, and it is the whole
mechanism of the amendment.

**What the documents call it.** "request ownership", "begins an interval", "the
current initiating record's interval", "its own request interval", "one-prompt
interval", "an exact ownership boundary".

**Options.**

1. Register `request interval` with that description. `request` is already
   ordinary vocabulary here and `launch request` is already an entry, so the
   compound reads consistently.
2. Register `request` alone for the span, and rely on "its interval"
   informally.
3. Describe it without a noun at every use.

**My recommendation: option 1.** This is the one genuinely new concept of the
three, it has no existing word in the repository, and it is the thing every
sentence in the amendment turns on. Option 3 would make those sentences
unreadable.

## A fourth question, if the Planner wants it asked

Does the Terminology rule reach CLI-private read shapes at all, or only
cross-package concepts? The decision calls these "CLI-private projection and
bookkeeping changes" and says the storage contract delegates private schema
names. If private vocabulary is out of scope, all three answers are "carry on"
and this interview closes with no registry change — which is a legitimate
outcome and would also tell me not to bring the next one back.

## State and what is blocked

The worktree is clean at `87b25a40`. The interval mechanics I had begun are set
aside as a patch outside the repository rather than committed or stashed, so
any command the Planner runs here reflects `87b25a40` exactly and the shared
stash is untouched.

Not blocked, and I will continue on request: the request-interval mechanics,
the nullable association, the bounded live lookup, the no-guessed-publication
refusal, the unresolved-acceptance refusal and MC1–MC4, all of which are
decision-complete. Only the naming and the prose wait on this.

Blocked: committing anything, because a feedback commit would carry the prose.

Creation-policy compatibility remains a separate unresolved Architect return
and is not touched here. R2 is not complete and is not claimed to be.
