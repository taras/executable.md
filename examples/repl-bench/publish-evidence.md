---
props:
  mode: { enum: [dry-run, publish] }
  receipt: { type: string, minLength: 1 }
required: [mode, receipt]
returns:
  type: object
  additionalProperties: true
---
# Publish REPL UI evidence

The receipt pins the checkout, acceptance rounds, screenshots and timing report.
Version 2 also records the design reference and visual comparison for each
designed checkpoint.
See [Publish evidence on a draft](README.md#publish-evidence-on-a-draft) for the
receipt format and recovery steps.

<Evidence.Prepare mode={props.mode} receipt={props.receipt} as="evidence" />

<If condition={evidence.kind === "dry-run"}>
  <Return value={evidence} />
<Else>
  <If condition={evidence.target.kind === "create"}>
    <Git.Push />
    <PullRequest title={evidence.target.title} base={evidence.pins.baseBranch} draft={true} as="draft">{evidence.target.body}</PullRequest>
    <Evidence.Publish receipt={evidence.receipt} identity={evidence.identity} receiptSha256={evidence.receiptSha256} number={draft.number} as="created" />
    <Return value={created} />
  <Else>
    <Evidence.Publish receipt={evidence.receipt} identity={evidence.identity} receiptSha256={evidence.receiptSha256} number={evidence.target.number} as="updated" />
    <Return value={updated} />
  </Else>
  </If>
</Else>
</If>
