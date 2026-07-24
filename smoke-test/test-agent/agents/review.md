<WhenPrompt
  as="review"
  template="Review {?subject} at revision {?revision}"
/>

The review of **{review.subject}** at `{review.revision}` passed.

<WhenPrompt template="Summarize {review.subject}" />

The review of **{review.subject}** passed.
