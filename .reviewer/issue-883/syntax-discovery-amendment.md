# Syntax discovery amendment for #883

The initial Sidekick prompt gives an agent enough XMD to ask for help and act
correctly. It names available guides and the two syntax destinations. Detailed
language teaching, environment explanations and component documentation are
read on demand through XMD components and returned to the same conversation.

The Product Owner accepts progressive disclosure, the Guide.* chapter names,
the separate REPL.Environment inspection and the reusable
[writing-for-agents rules](../../.agents/agent-writing.md). This amendment
replaces the earlier requirement to deliver both full syntax references before
the first turn and supersedes the proposed monolithic primer. The revised
[instruction design](sidekick-instructions-proposal.md) defines the bootstrap
and required guide coverage.

The amendment extends the response read ceiling and designated feedback set.
Its structural consequence is explicit: these new pinned read components may
execute in a generated response and send their results to its conversation.
It grants no entry, filesystem, process, network or native-provider permission.
The three accepted Core host interfaces and two-PR delivery order remain the
governing implementation boundaries. The #881 delivery prerequisite is satisfied
as recorded in the [base refresh](base-refresh.md).

## Before the first response

Supply these items to each new conversation:

1. The short bootstrap: automatic XMD evaluation, top-level Output, restricted
   response expressions, the separate entry context, literal draft source,
   feedback/continuation and the important shared-draft/Stop constraints.
2. A discoverable guide index with each exact invocation, purpose, context and
   a short indication of when to read it.
3. A compact description of admitted response controls and their forms/inputs,
   derived from canonical installed metadata; it includes the help requests an
   unfamiliar agent can make immediately.
4. The current shared draft and the person's request.

Identify **Sidekick response syntax** and **REPL entry syntax** explicitly.
Teach the exact entry lookup `<REPL.Syntax />` and selected documentation lookup
`<REPL.Syntax names={["Elicit"]} />`. The agent can discover entry vocabulary
when its task needs it. Do not insert the full entry catalog, all component
documentation or every guide chapter into the initial prompt.

Build the compact response description and guide index from the actual trusted
registrations and Core's canonical syntax metadata. An index is a projection of
that metadata, not a second component catalog. Preserve origin-only reporting
for entry components whose inspection cannot safely describe their signatures.
No initial provider turn is required to discover the help protocol itself.

## Chapter reads

All six components are trusted, self-closing Sidekick response reads with no
component-specific props. Each returns its chapter as a Markdown string through
designated operation feedback. Engine-owned as capture keeps its ordinary
meaning. Multiple reads in one response return under their component headings
in invocation order, after that response finishes and joins.

| Component | Read when | Required scope |
| --- | --- | --- |
| `<Guide.Entries />` | Preparing an entry for the first time or needing the authoring pattern. | Response versus entry syntax, props/data/interpolation, literal source capture, executable versus passive fences, real shared draft and Submit. |
| `<Guide.Bindings />` | Reading or reusing values, or carrying state between entries. | Response-local bindings, current acknowledged root snapshots, capture/return distinctions, local scopes and JSON state inherited by later entries. |
| `<Guide.Effection />` | Writing eval code that performs asynchronous work. | Generator operations, yield*, imports/capabilities supported by the host, cancellation and the boundary between entry eval and restricted responses. |
| `<Guide.Lifetimes />` | Starting processes, connections or background work. | Block/component/entry ownership, persist, resource teardown and the absence of live resource transfer between entries. |
| `<Guide.Recovery />` | Continuing interrupted or reopened work. | Conversation history versus entry History, retained outcomes, explicit continuation, non-repetition of completed effects and unknown-state refusals. |
| `<Guide.Environment />` | Needing to understand the host's capabilities or path/permission behavior. | Stable execution rules, subprocess isolation, environment inspection, workspace policy versus language rules and the limits of reported facts. |

For example, the following is a complete response asking for two chapters:

```xmd
<Guide.Effection />
<Guide.Lifetimes />
```

Only these designated reads generate feedback. Canonical Syntax retains its
ordinary render/capture contract; arbitrary component returns are not routed
to the agent. Output selects person-facing text and is not needed to request
documentation. A response containing only documentation reads still causes the
next provider turn after its feedback is ready.

Reading a chapter performs no entry submission, example execution, shell
command, network request or interactive question. Tags, braces and executable
fences in examples are literal returned text. Documentation does not grant the
ability to execute a component it describes. Keep the read identity and exact
returned chapter in the ordinary retained operation records.

## Current environment inspection

`<REPL.Environment />` is a separate trusted, self-closing response read with
no component-specific props. It returns a Markdown snapshot of host-known facts
as designated operation feedback. Guide.Environment teaches how to interpret
that snapshot; it does not embed changing facts in its static chapter.

Report the current working directory, runtime/version when known, active entry
profile/includes/plugins, relevant configured timeouts and permission facts
that the host can actually describe. Distinguish Sidekick's absent native tools,
entry Agent permission mode and any known host restrictions; one is not proof
of another. Identify supplied workspace instructions separately from XMD rules.
Say when a fact, executable's availability or restriction is unknown.

Use the existing contextual host/profile/configuration sources. Add no native
tool, command probe, automatic dependency installation, unrestricted environment
variable dump or implicit workspace-instruction crawler. The runtime entrypoint
may supply descriptive facts it owns through the existing host assembly;
shared production code does not detect the runtime. Report only facts allowed
through existing disclosure policy and retain the actual observed snapshot.
Cold reopening does not refresh it or replay a prior environment read.

## Ownership and canonical references

Ship the bootstrap, chapter assets and trusted guide registrations with the CLI
Sidekick feature. Keep them private to that feature's profile and response
ceiling; their names do not automatically register them in ordinary entries.
Use Core's component registration, pinned admission, canonical syntax and
documentation mechanisms, rather than a second evaluator or discovery service.
Core's accepted host signatures require no additional public method.

Keep chapter prose focused on language and execution concepts. Resolve component
signatures and selected documentation through the owning packages' canonical
reference machinery. Chapter assets follow the approved agent-writing rules,
including complete examples, explicit contexts and exact related invocations.
The earlier monolithic primer is a content inventory for those chapters, not
the initial prompt.

Retain the exact bootstrap, index/metadata version and references actually
supplied to each canonical turn. Retain requested chapter and environment values
through ordinary control outcomes and feedback delivery. Reopening alone sends
nothing. Each explicitly selected new conversation receives its own bootstrap.

A compatible metadata or guide change refreshes the relevant initial index or
orientation context before the next explicitly requested turn in the same
conversation; detailed chapters and entry references remain on-demand reads of
the active captured profile/assets. Retain which version was delivered. A
reference refresh does not widen the pinned response ceiling or provider
creation policy; incompatible creation policy keeps the established refusal
and explicit-new-conversation behavior.

## Amended journey 10 and focused evidence

Journey 10 now proves that a new Sidekick can discover syntax and request the
teaching it needs from the initial orientation. It replaces the earlier
requirement for full first-turn references. R5 remains the integration-evidence
group in planner-handoff.md; the existing focused command includes its test file.

Use the real profile, generated root, operation records and provider feedback:

- Inspect the first provider request: it contains the orientation, guide index,
  compact canonical response surface and both destination labels, rather than
  all six chapters and the full entry reference.
- Request each guide through its actual registered component, including two in
  one response. Compare the exact chapter feedback, invocation order and owning
  conversation. Verify that examples remain literal, entry count/draft do not
  change, and no native tool or interactive question is invoked.
- Read REPL.Environment against controlled contextual host facts, including one
  unavailable fact. Compare its delivered/retained snapshot with those facts
  and prove that Guide.Environment is static teaching, not a stale fact cache.
- Use REPL.Syntax and its names lookup for an entry-only plugin component.
  Compare with canonical installed metadata; the same component remains refused
  in response source. Prepare and submit its source through literal EntryInput
  under ordinary entry permissions.
- Exercise compatible index/reference refresh before another explicit message,
  a newly selected conversation's own bootstrap and a cold reopen with zero
  provider traffic, reusing the existing recovery/configuration fixtures.

These observations prove discovery plumbing and truthful context delivery.
Review the guide prose against the approved writing rules and walk an unfamiliar
agent through a task using the documented initial context to assess whether it
can choose the needed chapter and produce a valid entry. A scripted transport
alone does not establish that the teaching is sufficient.

The amendment requires no new terminal frame, general help router, package,
dependency, settings panel, persistence format or automatic guide-loading loop.
The existing read/feedback record families carry the new observations.
