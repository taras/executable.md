---
props:
  type: object
  properties:
    heading:
      type: string
    clean:
      type: string
      default: "\u2705 No issues found."
  required: [heading]
  additionalProperties: false
description: >-
  Render one section of a review, or say it found nothing. `<ReviewSection
  heading="Scope">…</ReviewSection>` prints the heading with whatever its content
  rendered, and prints the `clean` message when the content rendered nothing — so a
  section of quiet rules reads as a pass rather than as a blank.
context: >-
  The findings that belong to this section.
---

```ts eval
const content = yield* renderChildren();
return content.trim().length > 0
  ? `### ${props.heading}\n\n${content}`
  : `### ${props.heading}\n\n${props.clean}`;
```
