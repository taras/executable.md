---
inputs:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
---

<ReviewSection heading="Scope" clean="✅ PR scope looks good.">

<Threshold pr={pr} metric="totalChanges" op=">" value={800}
  severity="error"
  message="PR has {actual} lines changed. Split into focused PRs." />

<Threshold pr={pr} metric="totalChanges" op=">" value={400}
  severity="warning"
  message="{actual} lines changed. PRs under {value} receive more thorough review." />

<Threshold pr={pr} metric="totalFiles" op=">" value={20}
  severity="warning"
  message="{actual} files changed. Are all changes related?" />

<Threshold pr={pr} metric="directories" op=">" value={5}
  severity="warning"
  message="Changes span {actual} directories." />

<DescriptionCheck pr={pr} minLength={50}
  severity="error"
  message="PR description must explain what and why." />

<LinkedIssue pr={pr} whenLinesExceed={200}
  severity="warning"
  message="Large PR with no linked issue." />

<ConfigSourceMix pr={pr} minFiles={5}
  severity="warning"
  message="PR mixes config and source changes." />

<AbstractionNames pr={pr}
  severity="warning"
  message="New abstraction files: {names}. Verify 3+ consumers." />

<NewDependencies pr={pr}
  severity="warning"
  message="package.json changed without dependency justification." />

</ReviewSection>
