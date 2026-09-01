# Issue writing

An issue is active navigation and a durable contract for unfinished work. Its
title helps a reader decide whether the work matters without opening it. Its
description lets an unfamiliar reader understand the outcome and decide whether
an implementation satisfies it without reconstructing the discussion that
produced it.

This guide governs open Stories and Quests. A Quest is a coordinating story with
dependency-ordered child issues. Closed issues are historical records; do not
rewrite them merely to match current editorial style.

Every agent reads this guide before creating an issue or changing a Story or
Quest title, description, or classification. The title and description rules
apply to a single issue. The refinement interview applies when reviewing a set.

## Check the issue first

Writing review is also a live-work audit. Do not polish an issue whose correct
state is closed or whose outcome belongs to another story.

Before proposing a title or description:

1. Read the current title, body, latest owner comments, labels, and dependency
   map.
2. Check linked pull requests, implementation, tests, architecture, and
   specifications for delivery evidence.
3. Decide whether the issue is active, implemented on an unmerged branch,
   completed, superseded, duplicated, or a coordinating Quest.
4. Separate stale wording from a stale contract. When the intended work changed,
   correct the body or authoritative source instead of making the title conceal
   the disagreement.
5. Check whether another issue owns the complete outcome. Move unique accepted
   requirements before closing or consolidating the narrower issue.

Close delivered work when its acceptance and delivery condition are satisfied.
An implementation complete on an open pull request remains open until its stated
delivery condition occurs.

### Protect active implementation contracts

Do not rewrite a description that is the accepted plan or exact handoff for work
already in development merely to improve its style. Moving that contract while
an Implementor or reviewer is working makes their target unstable.

For an active implementation:

- verify that the issue still names the correct outcome and delivery condition;
- leave decision-bearing detail unchanged unless the product contract changes;
- defer editorial improvements that are not needed to prevent a factual error;
  and
- update the handoff and notify the active role when a substantive correction is
  required.

Before removing unique accepted detail, confirm that it lives in an authoritative
specification, architecture document, current issue, or active handoff.

## Titles

A title appears in lists, boards, references, release notes, and dependency maps
without its description. Write the smallest standalone statement of the outcome,
not a summary of the implementation plan.

### Title rules

1. **Name the outcome.** State what becomes possible, changes, or is established:
   “Add the `xmd upgrade` command,” not “Upgrade XMD using standalone releases.”
2. **Use the most recognizable product surface.** Prefer `xmd workflow start`,
   `<Elicit>`, shell blocks, the README, or Markdown tests over an internal
   module, descriptor, AST, or provider layer.
3. **Describe functionality before machinery.** Snapshots, hashes, transactions,
   shims, pinned commits, and verification mechanisms belong in the description
   unless one is itself the capability a user selects.
4. **Choose a verb that matches the change.** Use **Add** for a new command,
   component, entrypoint, or capability; **Make** for a changed property of an
   existing surface; and **Require** for an obligation another implementation
   must satisfy. Use **Run**, **Execute**, **Test**, **Measure**, **Ensure**,
   **Generate**, **Shift**, or **Refine** when one names the outcome more
   directly.
5. **Do not use permission language for new functionality.** “Allow” and “Let”
   imply that the capability already exists and only permission changes. Use
   them only when authorization is genuinely the subject.
6. **Use design verbs only for design deliverables.** “Design,” “define,”
   “specify,” and “codify” are appropriate when the lasting result is an accepted
   design, definition, or rule. When the issue adds behavior, name the behavior.
7. **Prefer testable language to abstract proof language.** Say what is tested,
   measured, or ensured. Use “prove” only when producing a proof artifact is the
   actual outcome.
8. **Keep the distinguishing context.** A concise title must still say what it
   acts on and where. “Make every test file safe for parallel execution” stands
   alone; “Make tests safe” does not.
9. **Move constraints out of the title.** Safety properties, acceptance details,
   supported runtimes, fixture choices, and implementation boundaries stay in
   the description unless they distinguish this story from another plausible
   one.
10. **Move history and sequencing out of the title.** Commit IDs, pull-request
    numbers, prerequisites, former locations, delivered slices, and suspected
    causes belong in the description. A title names the work, not how it was
    discovered.
11. **Do not encode delivery status.** “Future work,” “remaining slice,”
    “incomplete design,” “later phase,” and similar qualifiers become stale. The
    issue state, description, and dependency map carry delivery status. A timing
    word is appropriate when it distinguishes observable sequence, such as
    delivering an answer for later resumption.
12. **Use exact, understandable terms.** Preserve public spellings such as
    `xmd validate`, `<Call>`, and `.xmd`. Replace internal umbrella terms with the
    concrete object or action a reader recognizes. Explain necessary project
    vocabulary in the description.
13. **Narrow broad nouns.** “Markdown” alone may mean a document, a test, a code
    fence, or the language. Name the relevant surface when the distinction
    matters.
14. **Use relationship words deliberately.** “Against” names a reference or
    benchmark; “with” usually names an ingredient or enhancement. Choose the
    preposition that states the actual relationship.
15. **Avoid misleading double meanings.** A compact title may carry two readings
    only when both are accurate. If one reading promises different behavior,
    make the object or relationship explicit.
16. **Use observable language for durable concepts.** Prefer “run and resume” or
    another consequence over “retained” when storage is not necessary to
    distinguish the work.
17. **Use code formatting for literal product names.** Commands, components,
    props, and extensions use their authored spelling. Ordinary concepts remain
    prose.
18. **Use no decorative emoji.** Architecture, security, documentation,
    enhancement, and cleanup are labels, not title prefixes.
19. **Mark coordinating stories consistently.** A dependency-owning umbrella
    begins with `Quest:` and carries the `quest` label. Do not use the prefix for
    an ordinary large story, and do not rely on an emoji as the Quest signal.
20. **End without a period.** The title is an index entry, not a paragraph.

A useful title normally has this shape:

```text
<specific action> <recognizable surface> <context needed to distinguish it>
```

Examples:

```text
Add shell command mocking in Markdown tests
Make executable document entrypoints configurable
Keep secrets from `<Elicit>` out of journals and verbose output
Refine `xmd plan` against hand-authored reference workflows
Quest: Export workflow runs as portable `.xmd` files
```

## Descriptions

A description is the durable contract for an unfamiliar reader. It preserves
the outcome, observable behavior, consequential constraints, and discriminating
evidence rather than the transcript of how the design was discovered.

### Description rules

1. **Write for understandability.** A reader should grasp the practical outcome
   without already knowing the repository's architecture vocabulary or issue
   history.
2. **Lead with the observable outcome.** Begin with a Story and the smallest
   concrete example or common path. Show what a person writes, runs, sees, or can
   rely on before explaining how the system provides it.
3. **Explain the current gap.** State what happens today and why it does not meet
   the Story. Do not make readers infer the problem from a proposed design.
4. **Organize in comprehension order.** Use this default sequence: Story,
   example or common path, current gap, contract, consequential architecture and
   security boundaries, acceptance, evidence, dependencies, and out of scope.
   Omit sections that add no information.
5. **Explain terms where they first appear.** Prefer ordinary product language.
   When a necessary term such as Workspace, provider, replay frontier, or ACP
   adapter appears, connect it immediately to the experience or guarantee it
   names.
6. **Use recognizable product surfaces.** Name `xmd plan`, `<Call>`, Markdown
   tests, the README, workflow runs, journals, or shell commands before internal
   modules, descriptors, protocols, transactions, or storage layouts.
7. **Use precise ordinary words.** Say **specified** for a value supplied by an
   author or caller. Use **named** only when identity through a name is part of
   the contract. Say **a** for an ordinary instance and **one** only when exact
   cardinality matters.
8. **Describe workflow behavior through actions.** Prefer start, interrupt,
   resume, fork, export, and **workflow run** over the adjective **retained**
   when persistence is only an implementation consequence. Use retain or
   preserve when storage itself is the contract.
9. **Define the relevant alternative.** A qualifier such as in-process,
   standalone, external, portable, or static belongs only when the description
   explains the neighboring alternative and why the distinction changes use or
   acceptance.
10. **State the lasting contract, not the discovery transcript.** Preserve
    settled decisions, observable behavior, surprising constraints, and only the
    rationale needed to keep them from being undone. Remove benchmark dates,
    superseded alternatives, review dialogue, and implementation chronology
    unless they establish current status.
11. **Keep hypotheses conditional.** A measurement or evaluation story defines
    the measured object, controlled comparison, and decisions for each possible
    result. It does not present an unmeasured explanation as fact.
12. **Explain what learning changes.** An evaluation story says how discrepancies
    are classified and which may become product improvements, documentation
    corrections, best-practice definitions, prompt changes, or reference-workflow
    corrections. Evaluation is not scorekeeping.
13. **Make acceptance observable.** Each criterion states a behavior, refusal,
    invariant, or artifact another person can inspect. Avoid acceptance that
    merely repeats implementation tasks.
14. **Name verification entrypoints.** If acceptance tells someone to run or
    rerun a check, give the recognizable command, target, document, or test
    entrypoint. Do not leave verification as an abstract obligation.
15. **Include discriminating evidence.** State the positive path and the negative
    control, mutation, failure case, or comparison that would fail if the claimed
    behavior were absent.
16. **Put security guarantees before enforcement machinery.** Describe what is
    protected, from which action or authority, and the exact limitation before
    discussing scanners, adapters, namespaces, transactions, or lint rules.
17. **Show complex lifecycle boundaries in sequence.** For orchestration,
    concurrency, replay, or ownership stories, first show the reader-visible
    sequence. Then assign authority and state to its components.
18. **Separate final outcome from the first slice.** A proof of concept or first
    delivery slice explains which part of the Story it establishes and which
    acceptance remains for the complete outcome.
19. **Describe present contracts in the present tense.** Use delivery status only
    in a clearly status-bearing section. Do not let a future-tense plan
    masquerade as shipped product documentation.
20. **Keep issue roles distinct.** The description owns the product or repository
    contract. Architecture and specifications own normative system details; an
    Implementor handoff owns exact files, commands, and commit protocol. Link to
    those sources instead of copying them wholesale.

A description is complete when an unfamiliar reader can answer:

- What becomes possible or guaranteed?
- What fails or is missing today?
- What is the common path?
- What boundaries must remain true?
- How will we distinguish success from a plausible incomplete implementation?

### Story shape

Use the smallest subset of this shape that makes the contract understandable:

```md
## Story

As a ..., I want ..., so ...

## Example

The smallest recognizable invocation and result.

## Current gap

What happens today and why it is insufficient.

## Contract

Observable behavior first, followed by consequential boundaries.

## Acceptance

- A discriminating outcome.
- A refusal or negative control.

## Evidence

The recognizable test, command, document, or comparison.
```

Do not add headings merely to satisfy the template. A short, clear story may
need only Story, Current gap, and Acceptance. A decision-complete architecture
story may need additional Security, Replay, Lifecycle, or Out of scope sections.

### Quest descriptions

A Quest description begins with the end-to-end outcome a user or repository
experiences. It then gives a current child map in dependency order.

For each child or delivered slice, state:

- the recognizable capability it owns;
- whether it is open, implemented on an open pull request, or delivered;
- what must precede it; and
- how its completion advances the Quest outcome.

Introduce architecture terms only after the practical workflow is clear. Keep
the Quest's completion condition separate from the acceptance of its first
slice. Reconcile the map whenever a child closes, moves, splits, or becomes an
independent follow-up.

## Refinement interview

Refine a set of issues as an interview between the owner of the work and an
unfamiliar reader. The interview separates the contract from its wording, turns
one editorial judgment into a corpus-wide rule, and exposes stale work before a
bulk rewrite hides it.

### Prepare the pass

1. Inventory every open issue whose body declares a Story and every open issue
   carrying the `quest` label. Deduplicate the sets and record the count.
2. Read each issue's current description, latest decisions, delivery references,
   and repository evidence needed to establish its status.
3. Group related stories so accepted terminology carries across a family, but
   review one issue at a time.
4. Agree whether accepted changes will be applied immediately and whether title,
   description, label, status, closure, and consolidation corrections are in
   scope.

### Review one issue

Present exactly five things:

1. **Current:** show the exact title in a fenced `text` block. Summarize the
   description's structure and quote only the wording under discussion.
2. **Intent:** explain the user or repository outcome and live status in ordinary
   language without defending the current wording.
3. **Understandability:** name what an unfamiliar reader cannot yet recognize,
   connect, or verify.
4. **Proposed:** show the exact replacement title in a fenced `text` block and,
   when the description changes, provide the complete replacement. Recommend no
   change, closure, or consolidation when appropriate.
5. **Feedback:** ask one focused question about the unresolved product, scope,
   or wording judgment, or ask for approval when none remains.

Do not move to the next issue until the reader answers. Apply an accepted change
immediately and verify the exact title, body, and labels GitHub retained. Apply
an accepted Quest classification to both the `Quest:` prefix and `quest` label.
Keep a visible count of completed entries.

When the reader explicitly accepts all recommendations and asks the reviewer to
finish without asking, continue autonomously. Apply established rules
consistently, preserve active implementation contracts, and report every change
and no-change decision in the final audit.

### Carry feedback through the corpus

When feedback establishes a general rule, name it and use it in every later
proposal. Revisit an earlier approved issue when the rule affects it; do not
change it silently.

Check disputed wording against the product contract. Reader confusion can expose
unrecognizable vocabulary, a missing example, or a changed product purpose.
Correct the appropriate source rather than polishing prose around a disagreement.

Treat these as separate decisions:

- a title improvement changes only the title;
- a description improvement changes only the durable explanation;
- a factual correction changes the issue or authoritative contract;
- delivery evidence may close the issue;
- overlap may consolidate issues after unique requirements move; and
- Quest classification changes both title and label.

Dependencies, examples, and acceptance evidence can explain a title choice, but
do not promote them into the title merely because they were important during the
interview.

### Finish the pass

1. Rebuild the open Story/Quest inventory and reconcile it with the prepared
   count, accounting for created and closed issues.
2. Read titles as one list. Check that each stands alone, related surfaces use
   consistent terms, and concision has not removed the object or context.
3. Read each complete description in comprehension order and scan the corpus for
   vocabulary rules established during the interview.
4. Scan titles for decorative emoji, status language, unexplained internal
   vocabulary, implementation mechanisms, and classification words that belong
   in labels.
5. Verify every Quest has both the prefix and label, and ordinary stories have
   neither.
6. Verify every edited issue's exact title, body, state, state reason, labels,
   and delivery status against GitHub.
7. Confirm active implementations retain their accepted contracts and every
   intentionally unchanged issue has a stated reason.
8. Record the corpus count, rewrites, unchanged issues, closures,
   consolidations, Quest corrections, and remaining status-sensitive
   follow-ups.
