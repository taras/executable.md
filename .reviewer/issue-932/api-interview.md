# #932: entry inspection API interview

Status: design interview, not an implementation assignment. Follow-up issue:
https://github.com/taras/executable.md/issues/932.

## Accepted naming direction

The Product Owner specifies the REPL.Entry namespace with singular component
names:

```xmd
<REPL.Entry.Source />
<REPL.Entry.Prompt />
<REPL.Entry.Output />
```

This replaces the Architect's initial EntrySource/EntryPrompts naming proposal.
Output is the namespaced direction for the existing output reader; migration
of that existing surface and its documentation belongs in the eventual plan.
No implementation or compatibility alias is introduced by this record.

## Accepted Journal purpose

The Product Owner accepts a Journal component exposing actual structured saved
execution records, with Prompt as a focused view of the same evidence:

```xmd
<REPL.Entry.Journal entry={22} />
```

Read bounded actual saved execution records for that entry. Include recorded
component operations, agent prompt outcomes, and the root terminal as applicable.
Prompt is a focused projection of the same saved evidence, not another store
or a new provider request. Source is the exact admitted program; Output is the
entry's rendered text.

Journal reads do not rerun, resume, modify records, or contact a provider. An
unfinished entry exposes only acknowledged records observed at the read. Reads
and continuation instructions identify the exact entry so pagination does not
move to a newer entry. Keep large source and reply bodies bounded.

Still to settle: record shape and selection/filtering, payload bounds and
pagination, Prompt selection and fields,
entry selector spelling/defaults, summary/status access, and error behavior.
The initial standalone REPL.Entry overview has not been accepted. The Journal
purpose and name are accepted; it is not an existing control or a frozen final
signature.

## Next proposal: browse an index before fetching record bodies

Propose a bounded compact index when Journal has no record selector, with
specific record selection for the actual saved body. An index identifies event
kind, operation name/source location where recorded, and exact entry-local
record number. It does not copy large inputs, sources or replies into every row.
Keep durable result status and an agent prompt's own status distinct; a durable
operation can successfully record a failed agent prompt.

The full-record view, record numbering, byte/character bounds and continuation
shape remain to be reviewed. The index-first default is not yet accepted.

## Shared query follow-up

The Product Owner proposes a common query attribute alongside `as`, or a query
embedded in the binding name. The Architect recommends a separate attribute
and jq expressions for filtering and reshaping structured values. These public
spellings and the capture/rendering behavior are not frozen.

The Product Owner requests a separate ticket and reports an agent is porting
yq to Rust. Created and independently verified #934:
https://github.com/taras/executable.md/issues/934.

#934 owns shared querying and JSON/YAML result formatting, coordination with
the Rust port, and the remaining syntax/value-flow decisions. #932 continues
to own saved-entry diagnostic access. A query over one returned page cannot
claim to search an entire journal; query extent and bounds still need agreement.
Neither the record-number selector nor the index-first default is accepted.
