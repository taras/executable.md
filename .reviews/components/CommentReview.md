---
props:
  type: object
  properties:
    pr:
      type: object
  required: [pr]
  additionalProperties: false
---

<CommentReviewData pr={props.pr} as="reviewData" />

<Let as="classificationResult">
<If condition={reviewData.hasRepliesToClassify}>

<Sample>

For each reply to an automated code review suggestion, classify the
user's intent. They are replying to a suggestion to remove a redundant
code comment.

DISMISS — the user wants to keep the comment (any reason)
ACCEPT — the user agrees the comment should be removed

Format: [index] DISMISS or [index] ACCEPT

{reviewData.repliesText}

</Sample>

</If>
</Let>

<Let as="sampleResult">
<If condition={reviewData.hasPairs}>

<Sample>

Review these comment/code pairs. List ONLY obvious/redundant ones
where the comment restates what the code does.

Format each finding as: REDUNDANT[index]: comment text

If none are obvious: "No obvious comments found."

{reviewData.pairsText}

</Sample>

</If>
</Let>

<CommentReviewState
  pr={props.pr}
  data={reviewData}
  classificationResult={classificationResult}
  sampleResult={sampleResult}
  as="state"
 />

<If condition={state.hasFindings}>

<SuggestRemoval findings={state.pendingFindings} dismissedReplies={state.newDismissReplies} />

</If>

<If condition={state.hasChecklist}>

{state.checklistMd}

</If>
