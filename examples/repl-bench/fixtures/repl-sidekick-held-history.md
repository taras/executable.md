<WhenPrompt template="{?context}Initialize this Sidekick for an ACP attachment.{?rest}" />

<Let as="ready" select="code">
```xmd
<Output>Scripted Sidekick ready.</Output>
```
</Let>
{ready}

<WhenPrompt>
{?context}The person says:

question
</WhenPrompt>

<Let as="question" select="code">
```xmd
<Elicit as="answer" schema={{type:"object",properties:{value:{type:"string"}},required:["value"],additionalProperties:false}}>Held question 00
Held question 01
Held question 02
Held question 03
Held question 04
Held question 05
Held question 06
Held question 07
Held question 08
Held question 09
Held question 10
Held question 11
Held question 12
Held question 13
Held question 14
Held question 15
Held question 16
Held question 17
Held question 18
Held question 19
Held question 20
Held question 21
Held question 22
Held question 23
Held question 24
Held question 25
Held question 26
Held question 27
Held question 28
Held question 29
Held question 30
Held question 31
Held question 32
Held question 33
Held question 34
Held question 35
Held question 36
Held question 37
Held question 38
Held question 39
Held question 40
Held question 41
Held question 42
Held question 43
Held question 44</Elicit>
```
</Let>
{question}
