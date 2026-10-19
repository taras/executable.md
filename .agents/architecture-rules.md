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
11. View data and layout cross the direct parent-child boundary and no other.
12. Normalized host input is decided once and dispatched through the target's own ancestry; a host names a target and an event shape, never an action. Text is its own event shape carrying what the terminal decoded, and a modified chord is dropped whole rather than read off its physical key code.
13. Freedom alone owns focus; an overlay is a mounted branch, not a second tree.
14. Keyed descriptions reconcile into one mounted tree; validate the complete desired set before mutating any of it.
15. An absent description leaves no node, input, focus, frame contribution or output behind.
16. The mounted tree is the only source of renderable nodes and frame targets; a frame map names the live node behind each drawn element and is valid only for the tree revision that drew it.
17. One acknowledged host frame stream carries presentation time; subscriptions are owned by lifetimes, an advance waits for every subscriber to acknowledge applying the last one rather than receiving it, and a settled tree schedules nothing.
18. The nearest common mounted ancestor owns an animation that spans components.
19. Renderer output is copied out of the engine before returning, and a refused frame is redrawn on a renderer rebuilt for that frame's dimensions without changing selection, focus, actions or the frame itself.
20. A contextual adapter owns terminal modes, listeners and readers, registers their release before taking them, and restores them exactly once on every exit.
21. A narrow surface displays the one route selected; every other surface is absent from the frame, its map and its targets rather than hidden within them.
22. Never mutate `next` or attach metadata to it; keep the continuation callable unchanged.
23. Use methods on an owned handle for operations tied to that instance.
24. Use a Context to select a scoped service; capture it for any lifetime that requires a fixed provider.
25. Use middleware when per-call interception or transformation is an intended extension point.
26. Installed plugins, providers, middleware and TypeScript components are trusted application code; XMD does not contain malicious extensions.
27. Generated evaluation treats its input as untrusted and enforces the host's allowed operations before performing effects.
28. Documents explicitly selected for execution are trusted programs that run with the access their host and runtime permit.
29. Validate external data where its owning API interprets it; internal code may rely on the validated contract.
30. Validate saved history for format, supported version and run/effect consistency; deliberate rewriting of local storage is outside the threat model.
31. Protect credentials and explicitly identified secrets from accidental disclosure; paths and ordinary error details are not inherently secret.
32. Justify defensive complexity with an in-scope threat or consequential failure, and use the simplest sufficient implementation and evidence.
33. Before hooks receive no continuation; returning normally proceeds automatically, while throwing prevents the operation.
34. After hooks observe outcomes without replacing them; hook failures leave completed effects unchanged and never trigger an automatic retry.
35. When an operation and its after hook both fail, keep the operation's failure primary and report the hook failure alongside it.
36. Before hooks run from outer to inner; after hooks run from inner to outer.
37. Registered after hooks run on unwind, including before-hook rejection; one failing after hook does not prevent the remaining hooks from running.
38. A call owns its hooks and waits for their cleanup; after hooks observe cancellation explicitly and cancellation remains cancellation.
39. createHooks uses unchanged createApi and returns the named operation plus independent before/after registration functions.
40. After hooks receive Effection Result<T>; cancellation carries a dedicated cancellation error while the call continues to unwind as cancelled.

Rules 23–25 choose the API by ownership and intended composition. A captured
service keeps provider selection fixed for its consumer's lifetime; its mutable
configuration still follows that service's own update contract. A Context
selects a trusted service, while authorization, durable identity,
reconciliation and canonical outcomes stay with their owners.

Rule 26 sets the [extension trust boundary](../architecture.md#security-model).
Defending against deliberately malicious installed extension code does not
justify a security mechanism or an adversarial test. Trusted code can still
contain bugs; supported API behavior remains part of each feature's contract.

Rule 27 applies at generated-evaluation entry points such as `<Evaluate>`.
A read-only evaluation refuses a generated file write or shell command before
any effect. The admitted component implementations remain trusted under rule 26.

Rule 28 applies to documents a caller chooses to run, such as
`xmd run document.md`, including their `exec` and `eval` blocks. Choosing a
document requires trusting its contents. Text passed to generated evaluation
remains subject to rule 27.

Rule 29 covers service responses, file contents and saved records. Security
tests exercise inputs the boundary can receive: missing fields and invalid
values in a JSON response, for example. Deliberately malicious JavaScript
getters require executable code and fall under rule 26.

Rule 30 protects continuation from corrupted or mismatched records. XMD makes
no authenticity guarantee against someone who can rewrite the underlying local
database and construct a consistent replacement history.

Rule 31 allows useful paths and ordinary error details in diagnostics. An
absolute path is not sensitive merely because it is absolute; a path explicitly
identified as sensitive still receives protection. Relative-path formats can
also serve portability and compatibility independently of secrecy.

Rule 32 includes reliability requirements such as correct replay, preventing
duplicate external writes and completing cancellation cleanup. Additional
adversarial tests cover distinct failure paths that matter under the security
model or a supported reliability contract.

Rule 33 keeps invocation control with the operation's owner. A hook does not
receive `next` and cannot omit or repeat a delegation. It can refuse execution
by throwing before the underlying operation begins.

Rules 34–35 keep the operation's outcome separate from a hook's failure. An
after hook receives success or failure and returns no replacement value. If
the operation succeeded and an after hook fails, the call reports the hook
failure while the completed effect and its saved result remain unchanged.

Rule 36 orders each independently registered set of callbacks around the
operation, matching middleware's nesting order.

Rules 37–38 cover success, failure, cancellation and refusal by any before
hook. After callbacks observe a before-hook rejection even though the underlying
operation never starts. A before hook interrupted partway through uses its own
Effection cleanup for anything it acquired. Independent registrations have no
matching-pair requirement.

Rule 39 gives `createHooks<"expand", TArgs, TResult>(...)` the returned members
`expand`, `beforeExpand` and `afterExpand`. The registration functions accept
handlers returning `Operation<void>` and give them neither `next` nor a
replacement return channel. The adapter keeps its middleware private;
operations offering continuation control retain their existing `.around(...)`.

Rule 40 uses `Ok(value)` for success and `Err(error)` for a before-hook
rejection or implementation failure. Cancellation uses the same `Err` channel
with a dedicated error type. This is the after-hook notification; it does not
turn cancellation into an ordinary returned failure. All after hooks receive
the outcome selected before they run, independent of other after-hook failures.

The Architect applies these rules without another approval when they settle a
design. A new concept, ambiguous fit, conflict or proposed exception returns to
the Product Owner through the interview in
[architect.md](architect.md).

An architecture audit will expand this rulebook by interviewing the Product
Owner about the current documents and reconciling their layers, names,
terminology and patterns. Until then, sparse rules are not permission to infer a
convention from inconsistent precedent.
