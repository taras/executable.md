# Issue titles

An issue title helps a reader decide which open work matters without first
opening the issue. It appears in lists, boards, references, release notes and
dependency maps without the body that explains it. Write it as the smallest
standalone statement of the outcome, not as a summary of the implementation
plan.

This guide governs story titles and Quest titles. A Quest is a coordinating
story with dependency-ordered sub-issues. When reviewing a corpus, review open
stories and open Quests unless the requested scope says otherwise; closed
issues are historical records rather than active navigation.

Every agent reads this guide before creating an issue or changing a Story or
Quest title. The refinement interview is required for a set of titles; its
title and metadata rules also apply to a single issue created during ordinary
planning, architecture or maintenance work.

## Rules

1. **Name the outcome.** State what becomes possible, changes, or is established:
   “Add the `xmd upgrade` command,” not “Upgrade XMD using standalone releases.”
2. **Use the most recognizable product surface.** Prefer `xmd workflow start`,
   `<Elicit>`, shell blocks, the README or Markdown tests over an internal module,
   retained descriptor, AST or provider layer.
3. **Describe functionality before machinery.** Snapshots, hashes, transactions,
   shims, pinned commits and verification mechanisms belong in the body unless
   one is itself the capability a user selects.
4. **Choose a verb that matches the change.** Use **Add** for a new command,
   component, entrypoint or capability; **Make** for a changed property of an
   existing surface; and **Require** for an obligation another implementation
   must satisfy. Use specific verbs such as **Run**, **Execute**, **Test**,
   **Measure**, **Ensure**, **Generate**, **Shift** or **Refine** when they name
   the outcome more directly.
5. **Do not use permission language for new functionality.** “Allow” and “Let”
   imply that the capability already exists and only permission changes. Use
   them only when authorization is genuinely the subject.
6. **Use design verbs only for design deliverables.** “Design,” “define,”
   “specify” and “codify” are appropriate when the lasting result is an accepted
   design, definition or rule. When the issue adds behavior, name the behavior.
7. **Prefer testable language to abstract proof language.** Say what is tested,
   measured or ensured. Use “prove” only when producing a proof artifact is the
   actual outcome.
8. **Keep the distinguishing context.** A concise title must still say what it
   acts on and where. “Make every test file safe for parallel execution” stands
   alone; “Make tests safe” does not.
9. **Move constraints out of the title.** Safety properties, acceptance details,
   supported runtimes, fixture choices and implementation boundaries stay in the
   body unless they distinguish this story from another plausible one.
10. **Move history and sequencing out of the title.** Commit IDs, PR numbers,
    prerequisites, former locations, delivered slices and suspected causes
    belong in the body. A title names the work, not how it was discovered.
11. **Do not encode delivery status.** “Future work,” “remaining slice,”
    “incomplete design,” “later phase” and similar qualifiers become stale. The
    issue state, body and dependency map carry delivery status. A timing word is
    appropriate when it distinguishes observable sequence, such as delivering
    an answer for later resumption.
12. **Use exact, understandable terms.** Preserve public spellings such as
    `xmd validate`, `<Call>` and `.xmd`. Replace internal umbrella terms with the
    concrete object or action a reader recognizes. Explain necessary project
    vocabulary in the body.
13. **Narrow broad nouns.** “Markdown” alone may mean a document, a test, a code
    fence or the language. Name the relevant surface when the distinction
    matters.
14. **Use relationship words deliberately.** “Against” names a reference or
    benchmark; “with” usually names an ingredient or enhancement. Choose the
    preposition that states the actual relationship.
15. **Avoid misleading double meanings.** A compact title may carry two readings
    only when both are accurate. If one reading promises different behavior,
    make the object or relationship explicit.
16. **Use observable language for durable concepts.** Prefer “run and resume” or
    another consequence over “retained” when the storage term is not necessary
    for a reader to distinguish the work.
17. **Use code formatting for literal product names.** Commands, components,
    props and extensions use their authored spelling. Ordinary concepts remain
    prose.
18. **Use no decorative emoji.** Architecture, security, documentation,
    enhancement and cleanup are labels, not title prefixes.
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

## Check the issue before editing its title

A title review is also a live-work audit. Do not polish an issue whose correct
state is closed or whose scope belongs to another story.

Before proposing a title:

1. Read the body and latest owner comments.
2. Check linked and named pull requests, current implementation, tests,
   architecture and specifications for delivery evidence.
3. Decide whether the issue is still active, implemented on an unmerged branch,
   completed, superseded, or a coordinating Quest.
4. Separate a stale title from a stale contract. If the intended work changed,
   update the body or authoritative issue first; do not make the title conceal
   the disagreement.

Close completed work as completed when its acceptance and delivery condition
are satisfied. When another issue owns the complete outcome, move any unique
remaining requirement into that issue and close the narrower issue as
superseded. An implementation complete on an open pull request remains open
until its stated delivery condition occurs; its title still names the lasting
outcome rather than “merge” or “closeout.”

## Refinement interview

Refine a set of titles as an interview between the owner of the current work and
a reader scanning the issue list. The interview separates the issue contract
from its wording, turns one editorial decision into a corpus-wide rule, and
exposes completed or duplicated work before a bulk rename hides it.

### Prepare the pass

1. Inventory every open issue whose body declares a Story and every open issue
   carrying the `quest` label. Deduplicate the two sets and record the count.
2. Read each issue's current body, latest decisions, delivery references and the
   repository evidence needed to establish its status.
3. Group related stories so established terminology carries across a family,
   but review one issue at a time.
4. Agree whether accepted titles will be applied immediately and whether body,
   label and closure corrections are in scope.

### Review one issue

Present exactly four things:

1. **Current:** quote the exact GitHub title in a fenced `text` block so inline
   Markdown cannot disguise its literal formatting.
2. **Intent:** explain the user or repository outcome in plain language and
   include the evidence that the issue is still active, complete or overlapping.
3. **Proposed:** show one exact replacement title in a fenced `text` block, or
   recommend closure/consolidation when no replacement is appropriate.
4. **Feedback:** ask one focused question about the unresolved wording or scope,
   or ask for approval when none remains.

Do not move to the next issue until the reader answers. Apply an accepted title
immediately and verify the exact title GitHub retained. Apply an accepted Quest
classification to both the `Quest:` prefix and `quest` label. Keep a visible
count of completed entries.

### Carry feedback through the corpus

When feedback establishes a general rule, name it and use it in every later
proposal. Revisit an earlier approved title when the new rule affects it; do not
change it silently.

Check a disputed word against the product contract. A reader's confusion may
show that the issue uses unrecognizable architecture vocabulary, or it may show
that the issue's purpose has changed. Fix the appropriate source rather than
defending the current title.

Treat title wording, issue status and issue scope as separate decisions:

- a wording improvement changes only the title;
- a factual correction updates the body or authoritative contract;
- a completed issue closes with delivery evidence; and
- a duplicate moves its unique requirements before closing as superseded.

Dependencies, examples and acceptance evidence can explain a title choice, but
do not promote them into the title merely because they were important during
the interview.

### Finish the pass

1. Rebuild the open Story/Quest inventory and reconcile it with the prepared
   count, accounting for created and closed issues.
2. Read the titles as one list. Check that each stands alone, related surfaces
   use consistent terms, and concision has not removed the object or context.
3. Scan for decorative emoji, status language, unexplained internal vocabulary,
   implementation mechanisms and classification words that belong in labels.
4. Verify that every Quest has both the prefix and label, and that ordinary
   stories have neither.
5. Verify every edited issue's exact title, state, state reason and material body
   or label correction against GitHub.
6. Record the corpus count, closures, consolidations, newly created stories and
   any issue whose accepted title remained unchanged.
