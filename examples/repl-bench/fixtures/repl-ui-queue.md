<WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

<Let as="ready" select="code">
```xmd
<Output>Queue fixture ready.</Output>
```
</Let>
{ready}

<WhenPrompt template={"{?context}The person says:\n\nStart the held checkout round."} />

<Let as="submit" select="code">
`````xmd
<Let as="entry" select="code">
````xmd
```sh exec
printf '%s\n' 'Queue gate held'
while [ ! -f queue-release ]; do sleep 0.05; done
printf '%s\n' 'Queue gate released'
```
````
</Let>
<REPL.EntryInput>{entry}</REPL.EntryInput>
<REPL.Submit />
`````
</Let>
{submit}

<WhenPrompt template={"{?before}## REPL.Submit\n\nEntry entry-1 completed.{?receipt}The person says:\n\nWait for tax check."} />

<Let as="follow" select="code">
`````xmd
<Let as="entry" select="code">
````xmd
```sh exec
printf '%s\n' 'Follow gate held'
while [ ! -f queue-final-release ]; do sleep 0.05; done
printf '%s\n' 'Follow gate released'
```
````
</Let>
<REPL.EntryInput>{entry}</REPL.EntryInput>
<REPL.Submit />
`````
</Let>
{follow}

<WhenPrompt template={"{?before}## REPL.Submit\n\nEntry entry-2 completed.{?after}"} />

<Let as="done" select="code">
```xmd
<Output>Follow fixture settled.</Output>
```
</Let>
{done}
