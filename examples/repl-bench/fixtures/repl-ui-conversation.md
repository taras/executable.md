<WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

<Let as="ready" select="code">
```xmd
<Output>Conversation fixture ready.</Output>
```
</Let>
{ready}

<WhenPrompt template={"{?context}The person says:\n\nReview checkout."} />

<Let as="read" select="code">
```xmd
<REPL.Environment />
```
</Let>
{read}

<WhenPrompt template="Host facts, as they stand at this moment:{?environment}- working directory:{?after}" />

<Let as="submit" select="code">
````xmd
<Let as="entry" select="code">
```xmd
<Output>Checkout output witness.</Output>
```
</Let>
<REPL.EntryInput>{entry}</REPL.EntryInput>
<REPL.Submit />
````
</Let>
{submit}

<WhenPrompt template="{?before}Entry entry-1 completed.{?details}Checkout output witness.{?after}" />

<Let as="done" select="code">
```xmd
<Output>Checkout review complete.</Output>
```
</Let>
{done}
