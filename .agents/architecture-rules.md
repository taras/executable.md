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

The Architect applies these rules without another approval when they settle a
design. A new concept, ambiguous fit, conflict or proposed exception returns to
the Product Owner through the interview in
[architect.md](architect.md).

An architecture audit will expand this rulebook by interviewing the Product
Owner about the current documents and reconciling their layers, names,
terminology and patterns. Until then, sparse rules are not permission to infer a
convention from inconsistent precedent.
