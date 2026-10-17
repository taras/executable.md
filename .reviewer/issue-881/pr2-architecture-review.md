# PR 2 — architecture review

Against the seven frozen structural checks in `pr2-planner-handoff.md`, at
`9d8bc463`.

The handoff asks the Implementor for this: its documentation-and-handback
section says to return "all review/control/cold evidence", and constrains this
one — "the architecture review uses the seven frozen checks in
pr2-planner-handoff.md; it adds no speculative permutation." So it is written
here, by the person who wrote the code, and it says so rather than pretending
otherwise.

**What that means for how to read it.** Authorship is mine; confirmation is
not. An author reviewing himself finds what he was already looking for, so
every "met" below is a claim with its evidence attached, offered for the
Planner to confirm or reject — not a verdict that closes anything. Where I
think a check is met, the test or control that would fail if it were not is
named, so confirming it is reading a named thing rather than re-deriving the
diff.

No criterion is added. Ordinary visual correctness and evidence sufficiency are
the Planner's, and a new structural criterion would need an architecture
amendment rather than a review that quietly grew one.

Where a check rests on a test, the test is named; where it rests on a control,
the control is named and its record is in `pr2-evidence/.controls.json`.

---

## 1. Core retains canonical execution, delegation, bindings and outcome

**Met.**

`ComponentApi.expand` is an observation seam and nothing else. The request Core
issues carries a private-field brand and is claimed once; a handler that
delegates a copy, a counterfeit, the same request twice, a request from another
expansion or no request at all runs no body
(`component-expansion.test.ts` CX1 ×4). What middleware returns is discarded:
the chain's return value reaches no decision, and `Result<void>` is the whole of
what a phase carries, so there is no shape in which an observer could supply an
outcome.

Failure selection stays Core's. A handler that catches what canonical expansion
raised does not rescue it — the failure is recorded at the point it propagated,
not at the point somebody stopped it (CX3, control **K5**). Bindings never cross
the seam: a phase has a phase name, a `Result<void>` and, on failure, a detached
frozen `Error` with no `cause` chain into the original.

## 2. Owners and cleanup order intact; consumers neither deadlock nor outlive

**Met.**

`withInvocation`'s three ordered teardown stages are unchanged; the observation
is a `settled?` callback told the body's own outcome *before* those stages run,
registered after them so it runs first. It is an observer, not a participant:
nothing it does changes the outcome and it cannot see what the body produced.
An element whose body returned therefore stays in EXIT while its own cleanup
runs (CX2), and cleanup that fails still completes the element as a failure
(CX2).

The terminal phase follows the whole dispatch, middleware cleanup included — so
a consumer joined inside the handler would wait for the handler. Consumers are
started before the delegation on an owner that outlives it, which is what the
REPL's `lifecycle.ts` does with the session scope. Three cases decide the rest:
a reader that never reads delays nothing, one that takes a phase and stops
delays nothing, and one whose scope is cancelled mid-expansion cancels nothing
(CX4 ×3). Session teardown clears the reading and revives nothing: an entry that
closes takes its observations with it, and a late producer update cannot bring
them back (`repl-lifecycle.test.ts` L3).

## 3. Generated execution keeps narrowed capabilities; presentation grants none

**Met.**

The presentation lineage is an ordinary `Context` bound around the delegation,
which a descendant may rebind — which is exactly why nothing authoritative reads
it. It decides where a call is *shown* and nothing else: no permission, no
durable identity, no reconciliation authority and no capability travels with it.
A generated fragment inherits where it is being shown while its capability
environment stays as narrow as it was (`repl-lifecycle.test.ts` L1).

The reading is detached and immutable at every hand-off, so a consumer holding
one cannot reach back into the session's state.

## 4. Inspection uses canonical parsing and runs nothing; replacement is anchored

**Met.**

`inspectSource` is the scanner's own walk with an element collector threaded
through it — not a second grammar. A fence, an inline code span, a quoted `>`, a
tag-like expression and an incomplete tag are decided by the same code that
decides them for execution, so the two cannot disagree
(`source-inspection.test.ts`, 12 cases including CRLF, BOM, non-ASCII and header
offsets). No name is resolved, no schema compiled, no prop evaluated, no module
loaded and no component invoked.

The document envelope is read lexically, and `parseSource` asserts the two agree
— a divergence is loud rather than a quiet offset drift.

Replacement is anchored in retained ownership and exact ranges: exactly one
`Evaluate` opening at the owner's canonical recorded position, substituting only
`opening.end..closing.start` so the enclosure bytes stay as authored. A refused,
absent or ambiguous admission keeps the producer, and nothing is matched by name
or sibling order (`repl-source-reading.test.ts` S1 ×5, control **K3**).

## 5. No persistence change; observed and unobserved runs are identical

**Met.**

No record type, no field and no write path changed. The claim is decided by
comparison rather than by inspection: an observed run and an unobserved one are
serialized and compared byte for byte — the same elements, the same identities,
the same positions and the same rendered result, through a success, a failure
and a durable eval in one document (CX3). `repl-lifecycle.test.ts` L3 makes the
same comparison through a real session.

Nothing of the reading reaches the Journal: no offset, width, phase or probe is
retained, and a cold process reconstructs none of it.

## 6. Inspected content is prefix-only; cold reads do nothing; output has an owner

**Met.**

A reading belongs to an entry and its observations are matched on the entry key,
the recorded source position and the fragment that position belongs to — so a
retained prefix, whose lifecycle reading is empty, shows every element as
unobserved rather than borrowing a live one (S4). Live text belongs to the entry
producing it, which is the last the prefix admitted; a reader looking at an
earlier entry is given that entry's retained reading
(`repl-entries.test.ts` EU1).

Output's owner is read from the typed record, never from the text: a document
whose prose contains `failed` is still output, and a root that closed `err` is a
failure whatever it rendered (S3). Nothing is attributed to an `<Elicit>` or
`<File>`, reconstructed by concatenating block results, or invented as a receipt
for a bound value that emitted nothing.

Cold reads perform no provider activity and no source load: reopening the
settled head left the Journal at 49 022 bytes and the provider log at 8 014,
both with the same SHA-256 before and after (`cold-before.json` /
`cold-after.json`).

## 7. View data and actions use the existing measured boundary; absent rows cost nothing

**Met.**

The reading produces immutable view data through the existing description,
reconciliation, admission and frame-target path. It introduces no second
rendering route: a row is composed as token runs on an ordinary description, and
the runs are drawn by the presentation that already existed. The engine-fit
preparation is measured with independent probe elements under their own
structural ids and its bytes are discarded; it creates no child reader and is
never called from a pure description.

Windowed-out rows have no node, no target and no Tab stop, because they are not
described — `shown()` slices the admitted range. The two window controls sit
outside the moving content and consume their capacity in the pass that measures
the window, which is what keeps the admitted count and the drawn rows one list.
A narrow frame publishes one routed outlet holding the catalog and the reading,
each with its own measured window, and the surface the route did not choose is
described nowhere — so its rows contribute no resource and no target.

Inspection owns no execution: `inspectSource` is a pure function over text, and
the reading calls it.

---

## Superseded

The Planner's `pr2-independent-architecture-review.md` returned REQUEST CHANGES
on checks 1, 4 and 5 at the reviewed commit — a terminal accepting another
invocation's request, a lexical envelope disagreeing with the installed
extractor, and mutable published observations. This file said all seven were
met; on those three it was wrong, which is what a self-review is for the
Planner to catch and did.

All three are fixed. Read the independent review for the findings and the
handback for the corrections; read this only for the evidence it names.
