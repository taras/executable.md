# Core owns canonical Syntax in a generated root

Superseded by the accepted
[root evaluation interface amendment](root-evaluation-architect-handoff.md).
This earlier decision did not settle captured package documentation and must
not be used as the current implementation handoff.

Decision against `80a2c4b604e039cdacec663efdef60b063484b74`:
choose A. `evaluateGeneratedXmdRoot()` supplies the canonical protected
implementation and reference its root needs. AgentConversationHost stays an
ordinary host component; it does not supply authority for response evaluation.

This completes the already accepted root contract. It adds no host API or
request member. Architecture rules 2 and 3 delegate the internal structure and
require reuse of established machinery.

## The site comes from expansion

A caller of the host operation does not need a ProtectedSite. Expansion already
constructs that site for each protected invocation from its explicit routing
and reference inputs. The missing root work is to supply those inputs and admit
the exact canonical Syntax implementation. Do not manufacture a caller site or
make the conversation owner protected to obtain one.

Use the existing canonical Syntax declaration, identity installation and guarded
dispatch machinery. The generated root owns the scoped installation it needs;
a normal root-scoped instance of that existing identity mechanism is allowed.
Do not introduce a new claimant type, identity API, public protected component,
second Syntax body or dispatch mechanism. This does not start another document
execution or journal.

Keep the installation private to Core's root operation. Establish cleanup before
activation and expansion; revoke its domains and routing on success, refusal,
failure and cancellation after owned work has joined. Wrapper projection and
invocation issuance use the existing guarded route. A retained wrapper cannot
remain callable after its root ends. The conversation lifetime does not extend
that authority.

## Admission and reference

Include self-closing canonical Syntax in the generated root's read selection
only, using its existing canonical identity and metadata. Include that entry in
the root's retained policy comparisons. Existing collision, form and permission
checks still apply; admitting Syntax does not admit Evaluate or any ambient
component.

Build `syntaxReference(admittedSymbols(entries))` from the complete final root
admission table, including Syntax itself. Hand the reference and guarded route
to shared expansion through Core-private arguments. Both bare Syntax and named
documentation describe this root's admitted vocabulary. Ordinary rendering,
`as` capture and retained Syntax text remain canonical behavior. Syntax does not
become designated Sidekick feedback.

Leave `evaluateGeneratedXmd()`, canonical Evaluate's protected handoff and the
fragment's enclosing-authoring reference behavior unchanged.

## The environment comment

The comment at `execute.ts:2646` guards `resolveComponentImport`, the
execution-private import terminal. It does not forbid every routing field:
the private ExecutionEnvironment already carries `componentRouting`. This is
not permission to publish the guarded table or import terminal. The correction
needs only the root-owned route and reference passed through the existing
private expansion seam, with no ambient context lookup for authority.

## Delivery evidence

Make this a Core-focused correction commit on the current PR 2 branch, as the
[Planner handoff](pr2-controls-profile-planner-review-80a2c4b6.md) specifies.
Keep its focused commands and unchanged probe. The root regression must exercise
the public host operation without a protected caller, show the actual admitted
vocabulary and ordinary capture, and check that a selection without read refuses
Syntax before any component runs. Cover route revocation with focused lifecycle
evidence and preserve the released fragment regressions.

Update the affected architecture/specification text and remove the temporary
CLI omission note with the fix. This record resolves the seam; it does not claim
implementation or verification has passed.
