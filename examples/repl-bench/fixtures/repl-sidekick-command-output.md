<WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

<Let as="ready" select="code">
```xmd
<Output>Scripted Sidekick ready.</Output>
```
</Let>
{ready}

<WhenPrompt>
{?context}The person says:

Run the probe.
</WhenPrompt>

<Let as="submission" select="code">
`````xmd
<Let as="entry" select="code">
````xmd
```sh exec as="result"
printf 'PROBE\033[2JTAIL\rEND'
```
{result.stdout}
````
</Let>
<REPL.EntryInput>{entry}</REPL.EntryInput>
<REPL.Submit />
`````
</Let>
{submission}

<WhenPrompt template="{?receipt}Entry entry-1 completed.{?rest}" />

<Let as="done" select="code">
```xmd
<Output>Probe completed.</Output>
```
</Let>
{done}
