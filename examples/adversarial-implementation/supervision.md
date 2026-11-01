# Supervise a live REPL phase

Read this when a workflow phase runs inside a retained REPL and its coordinator
needs progress and completion. Keep one wait open instead of repeatedly reading
result-file existence, timestamps or log tails.

## Applies to

Coordinators observing an existing live REPL. These commands run outside its
Sidekick conversation; they submit no work and call no agent. Keep the owning
parent alive and retain the original child, role conversations and counters.

## Instructions

1. Keep the original ACP invocation pending when it already waits for the work.
   Its acknowledgement supplies the exact message reference needed to reconnect.
2. If observation must reconnect, use that acknowledged message's existing
   `--follow` command. Preserve its execution, conversation and message identity;
   do not search for whichever message is latest.
3. Receive the stream's updates while that single command waits. After its
   validated joined ending, read the associated entry's journal once and inspect
   the original canonical phase or Ticket result. Retain the launch association
   between that message, entry and reserved result path.
4. Preserve incomplete or uncertain outcomes. A disconnected owner, missing
   receipt or invalid result calls for reconciliation of the original work,
   never an automatic resend or a new attempt.

An exchange that submits and waits for an entry covers that entry's completion
and cleanup. An independently running entry can remain active after an unrelated
exchange ends. Entry reads are snapshots; `entry ... --follow` is unsupported.

## Example

Replace the attachment path and all three reference fields with the original
acknowledged values. The example identities are illustrative, not live sessions:

```bash
attachment=/absolute/private/attachment.json
reference='{"execution":"saved-execution","conversation":"saved-conversation","id":"saved-message"}'
xmd sidekick read --attach "$attachment" message "$reference" --follow
```

The command emits JSON snapshots as the exchange changes and returns its joined
ending. It does not issue status polls or prompt the agent. Once it finishes,
inspect the entry recorded for that submission, replacing `14` with its actual
number:

```bash
xmd sidekick read --attach "$attachment" entry 14 journal
```

A completed exchange can contain a failed or cancelled entry. A completed entry
can return a Ticket on hold. Neither process exit nor exchange completion
replaces the workflow's own verdict or delivery checks.

### Format a received snapshot with Query

Use built-in `<Query>` to select progress from a snapshot already received. This
complete document accepts one snapshot through the aggregate `--props` JSON
argument and renders a compact summary without copying provisional reply text:

```xmd
---
props:
  type: object
  properties:
    snapshot: {type: object}
  required: [snapshot]
  additionalProperties: false
---

<Query value={props.snapshot}
  yq='{"phase": (.activity.phase // "waiting"), "response": .activity.response, "replies": (.outputs | length), "ending": .ending}'
  as="progress" />
<Output><Json value={progress} /></Output>
```

Query selects from the supplied value; it does not subscribe, read another
snapshot or wait for completion. For live formatted progress, keep one passive
reader feeding received snapshots into the rendering document. Emit a summary
when it changes and retain the exact terminal receipt separately. This avoids
starting another XMD process for every token update. The standalone Query
example above formats one value; it is not itself a streaming command.

### Run the supervisor example

[supervise.md](supervise.md) composes the existing follow command with
[progress.md](progress.md) and its [persistent reader](progress-reader.node.ts).
Query selects the progress fields. The reader feeds snapshots to that document,
prints a changed summary on stderr and forwards the original terminal receipt
once on stdout. It owns no agent or REPL.

```text
Exact message follow -> one persistent Query renderer -> compact live stderr
                     -> validated joined receipt
                     -> one entry read + one canonical-result read -> JSON
```

Save this input under a new private coordination filename. Replace paths and
identities with the original launch values; the examples are illustrative:

```json
{
  "step": {
    "xmd": ["deno", "run", "--quiet", "--allow-all", "/absolute/workflow/packages/cli/src/deno.ts"],
    "progress": [
      "deno", "run", "--quiet", "--allow-all",
      "/absolute/workflow/examples/adversarial-implementation/progress-reader.node.ts",
      "/absolute/workflow/examples/adversarial-implementation/progress.md"
    ],
    "attachment": "/absolute/private/attachment.json",
    "message": {"execution": "saved-execution", "conversation": "saved-conversation", "id": "saved-message"},
    "entry": 14,
    "resultFile": "/absolute/work/attempt/result.json",
    "resultSchema": {"type": "object"}
  }
}
```

Use the selected CLI command in `xmd` and the existing runtime launcher in
`progress`. The reader also runs with Node/tsx or Bun; it uses their Node stream
interfaces. Pass the canonical result's existing schema when available. The
default object schema establishes JSON readability, not workflow acceptance.
Then keep this invocation pending until it returns:

```bash
xmd run /absolute/workflow/examples/adversarial-implementation/supervise.md \
  --props "$(cat -- /absolute/private/supervision-input.json)" --raw
```

The root `step` object uses aggregate `--props`, not `--props-step`. The result
keeps `status` for the entry and `exchangeOutcome` for its exchange. A readable
canonical artifact appears unchanged under `result`, with `resultStatus=readable`.
Without `resultFile`, it reports `not-requested`. A missing or invalid requested
result reports `unavailable`, preserving `entryStatus` separately. The supervisor
does not poll, resend work or convert a canonical hold into a passing verdict.

An enclosing `<Let as="receipt">` can capture a foreground command's stdout
while stderr forwards live progress. A bound `exec as="receipt"` captures both
channels and displays neither. Keep the final structured result on stdout and
compact progress on stderr when composing such a supervisor. A missing or
invalid terminal receipt remains incomplete evidence even if the process exits.

## Common mistake

Resending an assignment because its observer disconnected can duplicate effects.
Detaching a passive follow releases observation and leaves the producer running;
explicit ACP cancellation is a different operation. Reconnect to the original
acknowledged exchange and reconcile its result without changing session identity,
consumed correction limits or reserved attempts.

## Read next

Read [Run a separate phase or continue a saved ticket](README.md#run-a-separate-phase-or-continue-a-saved-ticket)
for `<Phase.Run>` and `<Ticket.Continue>`. The language specification defines
[Query](../../specs/executable-mdx-spec.md#622-selecting-part-of-a-value-query)
and [foreground command channels](../../specs/executable-mdx-spec.md#36-foreground-execution-capture-and-retention).
