<WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

<Let as="ready" select="code">
```xmd
<Output>Scripted Sidekick ready.</Output>
```
</Let>
{ready}

<WhenPrompt>
{?context}The person says:

What should I know?
</WhenPrompt>

<Let as="reads" select="code">
```xmd
<Guide.Lifetimes />
<REPL.Environment />
```
</Let>
{reads}

<WhenPrompt template="## Guide.Lifetimes{?gap}# Lifetimes{?chapter}## REPL.Environment{?environment}- working directory:{?after}" />

<Let as="done" select="code">
```xmd
<Output>Read both.</Output>
```
</Let>
{done}


<WhenPrompt>
{?context}The person says:

Ask the human.
</WhenPrompt>

<Let as="question" select="code">
```xmd
<Elicit schema={{type:"object",properties:{decision:{type:"string",enum:["approve","reject"]}},required:["decision"],additionalProperties:false}} as="answer">Approve the fixture?</Elicit>
<Output><Json value={answer} /></Output>
```
</Let>
{question}
