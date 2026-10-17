# Carrying the execution's captured documentation into a generated root

Superseded by the accepted
[Architect handoff](root-evaluation-architect-handoff.md). The chosen design
uses returned host/conversation methods and keeps AgentConversationHost
ordinary. The proposal below is retained as review history.

Proposal only. Nothing in this is implemented, and the current head
`8be2d2bc3c38c4a896d0b678e121beef28e02920` still reads core's documentation
terminal, which is unforgeable but drops bootstrapped package chapters.

## What the snapshot is, and why nothing public can see it

Canonical execution collects documentation once, before root import and before
any document code (`execute.ts`, `capturedDocumentation(readAsset)`), and hands
it to `rootSyntaxReference(...)`. From there it is reachable in exactly one
way: the reference's `available(symbols)`, which keeps *this* reference's
authoring symbols and documentation index while reporting a narrowed vocabulary.
`syntax-reference.ts` says why in its own words — deriving it any other way
"would mean the evaluator recovering the raw contributions and rebuilding an
index", which is "both a hole (that list is execution-private for a reason) and
a way for the two indexes to drift."

Everything execution-private travels the same road: `ExecutionEnvironment` →
`ProtectedSite`. The site carries `syntax`, `evaluationProfile` and
`narrowComponentRouting`. Canonical `<Evaluate>` is a protected component, so it
has a site, and that is the whole reason the fragment path has never had this
problem.

`evaluateGeneratedXmdRoot()` is a public host operation called from ordinary
host code. It has no site, and I could find no other seam:

- `ExecutionEnvironment` is passed to expansion as an argument, never published.
- `getExpansion()` carries `{id, name, position}` and says of itself that it is
  "not a permission boundary".
- `ComponentApi` exposes `env` and `evalScope`; it exposes no reference.
- The `Documentation` Api is middleware by design — which is the bug just fixed.

## Why a context cannot carry it

A Core-private context set once before root import looks sufficient and is not.
An Effection context can be re-set by any descendant for its own subtree, and
the generated root is evaluated *at the position a component chose*, so the
value it reads is the value that component installed. That is the same shape as
the `Documentation` chain substitution, with a different name. Ruled out, and
the review already rules it out.

## Proposal: reach the root evaluation from the protected position core owns

The conversation element is already core's: `AgentConversationHost`, written
into a synthetic root in `conversation.ts`, selected by canonical resolution,
handed this execution's claimant. Make that declaration **protected** rather
than an ordinary identity component. Then:

1. Its body receives a `ProtectedSite`, carrying the execution's own
   `syntax` reference — the one holding the pre-import snapshot.
2. Core adds `evaluateProtectedGeneratedXmdRoot(request, site)`, the root
   sibling of the existing `evaluateProtectedGeneratedXmd(request, routing,
   syntax)`. It narrows with `site.syntax?.available(admittedSymbols(entries))`,
   exactly as `<Evaluate>` narrows at `Evaluate.ts:431`.
3. The response evaluation moves onto the conversation element's existing
   mailbox as one more job kind beside `prompt` and `options`. The owner already
   sends every turn through that queue, so what changes is where the evaluation
   runs, not who asks for it.
4. The public `evaluateGeneratedXmdRoot()` keeps its signature and its current
   behaviour for a caller with no site.

What this deletes is as useful as what it adds: `installScopedProtected` and the
root-scoped minting go away, because the site's routing already holds canonical
Syntax's body registered with the execution's own domain. The terminal-read
workaround goes away with them.

**Cost.** `AgentConversationHost` becomes protected, which the earlier decision
said to leave alone — though that was about not inventing authority for the
*routing* half, before the documentation half was known. It is core's own
declaration in core's own root, so no host gains anything by it.

**Open sub-question.** A protected site exposes `narrowComponentRouting` but not
the execution's `guarded` table, so admitting canonical Syntax from inside the
handoff needs its inert implementation from somewhere. Either the handoff is
given it by core (it is core's own declaration, so core can name it), or
`ProtectedSite` gains a narrow accessor for canonical implementations. I would
take the first; the second widens a boundary for one caller.

## The alternative I considered and would not take

Seal the contributions onto the host's `EvaluationProfile`, the way
`componentRouting.project` is already sealed onto it at `execute.ts:2630`. That
channel is genuinely non-replaceable — the host holds the object, core fills it
in before document code runs. But the generated root would then need the
profile, and the only ways to hand it over are a new request field (excluded) or
an ambient lookup (unsound, above). It also makes documentation a property of a
*fragment ceiling*, which it is not.

## What I would want agreed before implementing

1. That `AgentConversationHost` becoming protected is acceptable, given it is
   core's own declaration in core's own synthetic root.
2. Which way the open sub-question goes.
3. That the public operation keeps its present behaviour for a siteless caller,
   rather than refusing — a host that never asks for `<Syntax />` should not
   need a site to evaluate a root.

Evidence this proposal rests on is reading only. No implementation or test run
is claimed.
