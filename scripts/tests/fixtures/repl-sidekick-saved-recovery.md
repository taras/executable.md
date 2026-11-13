<WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

<Let as="ready" select="code">
```xmd
<Output>Scripted Sidekick ready.</Output>
```
</Let>
{ready}

<WhenPrompt>
{?context}The person says:

Inspect output.
</WhenPrompt>

<Let as="submission" select="code">
````xmd
<Let as="source" select="code">
```xmd
<Output>OUTPUT-BEGIN: verified
ROW01: item verified
ROW02: item verified
ROW03: item verified
ROW04: item verified
ROW05: item verified
ROW06: item verified
ROW07: item verified
ROW08: item verified
OUTPUT-END: retained</Output>
```
</Let>
<REPL.EntryInput>{source}</REPL.EntryInput>
<REPL.Submit />
````
</Let>
{submission}

<WhenPrompt template="{?receipt}OUTPUT-BEGIN: verified{?rows}OUTPUT-END: retained{?rest}" />

<!-- This deliberately unresolved component fails the ACP feedback turn. -->
<FailSavedFeedbackFixture />
