<WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

<Let as="ready" select="code">
```xmd
<Output>Scripted Sidekick ready.</Output>
```
</Let>
{ready}

<WhenPrompt>
{?context}The person says:

Run the fixture entry.
</WhenPrompt>

<Let as="submission" select="code">
````xmd
<Let as="entry" select="code">
```xmd
<Output>Fixture entry ran.</Output>
```
</Let>
<REPL.EntryInput>{entry}</REPL.EntryInput>
<REPL.Submit />
<REPL.Entry.Output entry={1} />
````
</Let>
{submission}

<WhenPrompt template={"{?before}## REPL.Submit\n\nEntry entry-1 completed.{?receipt}## REPL.Entry.Output\n\n```json\n{\n  \"entry\": 1,\n  \"status\": \"completed\",\n  \"text\": \"Fixture entry ran.\"{?after}"} />

<Let as="done" select="code">
```xmd
<Output>Scripted Sidekick received the entry result.</Output>
```
</Let>
{done}
