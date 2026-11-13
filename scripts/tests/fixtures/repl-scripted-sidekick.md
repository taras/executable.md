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
````
</Let>
{submission}

<WhenPrompt template="{?before}Entry entry-1 completed.{?details}Fixture entry ran.{?after}" />

<Let as="done" select="code">
```xmd
<Output>Scripted Sidekick received the entry result.</Output>
```
</Let>
{done}
