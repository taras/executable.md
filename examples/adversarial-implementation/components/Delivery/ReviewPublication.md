---
description: 'Verify a saved review comment or publish it from its validated receipt. Use <Delivery.ReviewPublication target={target} review={review} publish={false} as="publication" />.'
props:
  type: object
  properties:
    target: {type: object}
    review: {type: object}
    publish: {type: boolean}
  required: [target, review, publish]
  additionalProperties: false
returns: {type: object}
---

<Let as="url" value={"https://github.com/" + props.target.repository + "/pull/" + props.target.number} />
<Try>
<PullRequest.Comments url={url} as="comments" />
<Delivery.ReviewComment target={props.target} review={props.review} publish={props.publish} allowPost={props.publish} comments={comments} as="publication" />
<If condition={publication.state === "readback"}>
<PullRequest.Comments url={url} as="readback" />
<Delivery.ReviewComment target={props.target} review={props.review} publish={true} allowPost={false} comments={readback} as="publication" />
</If>
<Return value={publication} />
<Catch>
<Return value={{state:"pending",reason:"Could not read pull request comments. Check the GitHub host allowlist and retry from the saved receipt."}} />
</Catch>
</Try>
