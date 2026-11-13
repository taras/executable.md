<WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

<Let as="ready" select="code">
```xmd
<Output>Scripted Sidekick ready.</Output>
```
</Let>
{ready}

<WhenPrompt template={"{?context}The person says:\n\n{?message}"} as="request" />

<Let as="question" select="code">
```xmd
<Output>
Retained chat row 01.
Retained chat row 02.
Retained chat row 03.
Retained chat row 04.
Retained chat row 05.
Retained chat row 06.
Retained chat row 07.
Retained chat row 08.
Retained chat row 09.
Retained chat row 10.
Retained chat row 11.
Retained chat row 12.
Retained chat row 13.
Retained chat row 14.
Retained chat row 15.
Retained chat row 16.
Retained chat row 17.
Retained chat row 18.
Retained chat row 19.
Retained chat row 20.
Retained chat row 21.
Retained chat row 22.
Retained chat row 23.
Retained chat row 24.
Retained chat row 25.
Retained chat row 26.
Retained chat row 27.
Retained chat row 28.
Retained chat row 29.
Retained chat row 30.
Retained chat row 31.
Retained chat row 32.
Retained chat row 33.
Retained chat row 34.
Retained chat row 35.
Retained chat row 36.
Retained chat row 37.
Retained chat row 38.
Retained chat row 39.
Retained chat row 40.
Retained chat row 41.
Retained chat row 42.
Retained chat row 43.
Retained chat row 44.
Retained chat row 45.
</Output>
<Elicit as="answer" schema={{type:"object",properties:{decision:{type:"string",enum:["keep-answer"]}},required:["decision"],additionalProperties:false}}>Save this decision?</Elicit>
```
</Let>

<Let as="continuation" select="code">
```xmd
<Output>Fresh instruction reached the same chat.</Output>
```
</Let>

```js eval
if (request.message.trim() === "RECOVERY-1269-FRESH" &&
    request.context.includes("Earlier feedback acceptance remains unknown.")) {
  return continuation;
}
return question;
```

<WhenPrompt template="{?feedback}" as="old" />

```js eval
if (old.feedback.includes("RECOVERY-1269-FRESH")) {
  if (!old.feedback.includes("Earlier feedback acceptance remains unknown.")) {
    return "<Output>Missing recovery context.</Output>";
  }
  if (old.feedback.split("The person says:").at(-1)?.trim().split("\n")[0] !== "RECOVERY-1269-FRESH") {
    return "<Output>Unexpected recovery instruction.</Output>";
  }
  return continuation;
}
yield* sleep(60_000);
return "";
```

<WhenPrompt template="This scenario has no additional expected instruction." />
