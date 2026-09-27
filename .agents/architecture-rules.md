# Architecture rules

This rulebook records reusable decisions about system layers, ownership,
cross-package APIs, package responsibilities, shared terminology and patterns
future features should reuse. `architecture.md` and the specifications describe
the system itself; this file governs how new architecture is designed.

## Approved rules

1. Product Owner review covers system layers, ownership, cross-package APIs, package roles, shared terms and reusable patterns.
2. Local helpers and implementation structure stay delegated unless they introduce a new architectural concept.
3. Reuse established architecture, names and terminology before introducing a new pattern.
4. Do not copy an inconsistent existing pattern merely because it already exists.
5. Correct debt only when the feature changes that surface or cannot remain coherent without the correction.
6. Record adjacent debt as a proposed follow-up Story instead of expanding the feature.
7. Each package exports its consumer-facing contextual APIs and their types from /api; consumers depend on that package and import them from /api.
8. Feature-specific runtime APIs stay with their feature package and are not collected into a central runner context.
9. Immutable view data flows down and typed semantic actions flow up; the root alone owns route intent, selection and rebuildable application state.
10. A component lifetime may own a node; a render body may not create or own one.
11. View data and placement cross the direct parent-child boundary and no other.
12. Normalized host input is decided once and dispatched through the target's own ancestry; a host names a target and an event shape, never an action.
13. Freedom alone owns focus; an overlay is a mounted branch, not a second tree.
14. Keyed descriptions reconcile into one mounted tree; validate the complete desired set before mutating any of it.
15. An absent description leaves no node, input, focus, frame contribution or output behind.

The Architect applies these rules without another approval when they settle a
design. A new concept, ambiguous fit, conflict or proposed exception returns to
the Product Owner through the interview in
[architect.md](architect.md).

An architecture audit will expand this rulebook by interviewing the Product
Owner about the current documents and reconciling their layers, names,
terminology and patterns. Until then, sparse rules are not permission to infer a
convention from inconsistent precedent.
